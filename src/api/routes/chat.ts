/**
 * Chat 路由（docs/04 §9–§11、§45、§46）
 *
 *   POST /api/v1/chat          一次返回完整回答
 *   POST /api/v1/chat/stream   以 SSE 逐 token 返回
 *
 * 【两条路共用同一个 ChatService】
 *   区别只在于「有没有传 onToken」。Agent Loop 内部据此选
 *   provider.generate 还是 provider.stream —— 因此边界检查、工具累积、
 *   截断收尾这些逻辑只有一份，不会在两条路上漂移。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { LLMError, type LLMProvider } from '../../llm/provider.js';
import {
  chat,
  ConversationDeletedError,
  ConversationNotFoundError,
  type ChatResult,
  type ChatServiceDeps,
} from '../../conversation/chat-service.js';
import type { ContextMemory } from '../../conversation/context-builder.js';
import { retrieveMemories } from '../../memory/retriever.js';
import {
  getDefaultExtractionTrigger,
  type ExtractionTrigger,
} from '../../conversation/extraction-trigger.js';
import { ok } from '../errors.js';
import { chatRequestSchema, toChatParams } from '../schemas.js';
import { fingerprintChat, IdempotencyStore } from '../idempotency.js';
import { parseIdempotencyKey, SseStream } from '../sse.js';

export interface ChatRouteDeps {
  /** 幂等存储。缺省为模块级单例（进程内共享） */
  idempotency?: IdempotencyStore<ChatResult>;
  /** 抽取触发器。缺省为进程单例 */
  extractionTrigger?: ExtractionTrigger;
  /** 覆盖 LLM Provider。生产不传，测试注入假实现 */
  provider?: LLMProvider;
  /**
   * 覆盖记忆检索。
   *
   * 缺省接真实的 retrieveMemories（向量 + 关键词 + 结构化三通道）。
   * 测试传一个固定返回，避免依赖 embedding 服务与库里的真实数据。
   *
   * ⚠️ 传 null 表示**显式关闭**检索（performed=false）。
   *    与「不传」的区别：不传会用真实检索，传 null 才是关掉。
   */
  retrieveMemories?: ChatServiceDeps['retrieveMemories'] | null;
}

let defaultIdempotency: IdempotencyStore<ChatResult> | undefined;

function idempotencyOf(deps: ChatRouteDeps): IdempotencyStore<ChatResult> {
  if (deps.idempotency) return deps.idempotency;
  defaultIdempotency ??= new IdempotencyStore<ChatResult>();
  return defaultIdempotency;
}

/**
 * 默认的记忆检索实现。
 *
 * 把检索结果映射成 Context Builder 需要的形状（ContextMemory），
 * 只保留注入需要的最小字段 —— Content Builder 不该看到 status / 向量等内部细节。
 *
 * ⚠️ 这里**不抛错**：retrieveMemories 自身已把各种依赖失败降级为
 *    「返回空 + 记录 degradation」，因此聊天不会因检索出问题而失败（§45 的同类原则）。
 */
async function defaultRetrieve(params: {
  userId: string;
  query: string;
}): Promise<ContextMemory[]> {
  const result = await retrieveMemories({ userId: params.userId, query: params.query });

  if (result.diagnostics.degradations.length > 0) {
    /**
     * 只记录降级类型与耗时，**不记录查询词与记忆正文**（docs/03 §29.1）。
     * 降级必须可见：否则「Agent 今天怎么想不起我了」永远查不出原因。
     */
    console.info(
      `[retrieval] 降级：${result.diagnostics.degradations.join(',')} ` +
        `命中 向量${result.diagnostics.channelHits.vector}/` +
        `关键词${result.diagnostics.channelHits.keyword}/` +
        `槽位${result.diagnostics.channelHits.slot}，` +
        `返回 ${result.diagnostics.returned} 条，耗时 ${result.diagnostics.timings.total}ms`
    );
  }

  return result.memories.map((m) => ({
    id: m.id,
    content: m.content,
    type: m.type,
    validFrom: m.validFrom,
    importanceScore: m.importanceScore,
  }));
}

export async function registerChatRoutes(
  app: FastifyInstance,
  deps: ChatRouteDeps = {}
): Promise<void> {
  const idempotency = idempotencyOf(deps);
  const extractionTrigger = deps.extractionTrigger ?? getDefaultExtractionTrigger();

  /**
   * ChatService 的依赖。抽成常量避免两个 route 里各写一份而漂移。
   *
   * retrieveMemories 的三态：显式 null（关闭）/ 显式函数（覆盖）/ 缺省（用真实检索）
   */
  const retrieveMemories =
    deps.retrieveMemories === null ? undefined : (deps.retrieveMemories ?? defaultRetrieve);

  const serviceDeps: ChatServiceDeps = {
    extractionTrigger,
    ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
    ...(retrieveMemories !== undefined ? { retrieveMemories } : {}),
  };

  // ==========================================================
  // POST /api/v1/chat
  // ==========================================================
  app.post('/chat', async (request, reply) => {
    const body = chatRequestSchema.parse(request.body);
    const params = toChatParams(body);

    /**
     * 幂等（docs/04 §46）：客户端因网络超时重试时，
     * 不应产生两条相同的用户消息。
     *
     * 取消信号的取舍：**重放时不复用原始请求的 signal**。
     * 第一次请求的 signal 往往已因客户端断开而 abort，
     * 复用它会让重放直接失败；而缓存的是已完成结果，本来也不需要信号。
     */
    const idempotencyKey = parseIdempotencyKey(request.headers);
    const signal = abortSignalOf(request);

    const result = await idempotency.run(idempotencyKey, fingerprintChat(params), () =>
      chat({ ...params, signal }, serviceDeps)
    );

    if (result.replayed) {
      // 明确告知这是重放结果，便于前端与排查区分（不改变数据形状）
      reply.header('Idempotency-Replayed', 'true');
    }

    return ok(result.value);
  });

  // ==========================================================
  // POST /api/v1/chat/stream   （SSE）
  // ==========================================================
  app.post('/chat/stream', async (request, reply) => {
    /**
     * 校验必须在建立 SSE 连接**之前**做。
     *
     * 一旦写了 200 + text/event-stream 的响应头，就再也改不了 HTTP 状态码 ——
     * 参数错误只能变成流里的一个 error 事件，前端要额外处理。
     * 因此校验失败要在这里就以普通 JSON 422 返回（由 server 的 errorHandler 完成）。
     */
    const body = chatRequestSchema.parse(request.body);
    const params = toChatParams(body);

    /**
     * 流式刻意**不做幂等重放**。
     *
     * 理由：重放要求把上次的 token 序列原样再放一遍，缓存整段流不划算；
     * 而流式请求的失败在客户端是可感知的（连接断了就是断了），
     * 不像普通 POST 那样存在「服务端已处理但客户端不知道」的窗口。
     *
     * ⚠️ 这是与 docs/04 §46 的口径差异，已在交付说明中回报。
     */
    const controller = new AbortController();
    const stream = new SseStream(reply.raw, {
      // 客户端断开 → 中止 LLM 调用，别继续烧 token
      onClose: () => controller.abort(),
    });

    try {
      const result = await chat(
        { ...params, signal: controller.signal },
        {
          ...serviceDeps,
          onToken: (token) => stream.write({ type: 'token', content: token }),
        }
      );

      /**
       * 消息 id 单独发。
       *
       * docs/04 §11 只定义了 token 与 done，而 done 里没有 id ——
       * 前端拿不到 message_id 就无法做引用、反馈、重新生成这些后续动作。
       * 因此这里补充 message 事件（不改动 token/done 的既有语义）。
       */
      stream.write({
        type: 'message',
        role: 'user',
        message_id: result.userMessage.id,
        conversation_id: result.conversation.id,
      });
      stream.write({
        type: 'message',
        role: 'assistant',
        message_id: result.assistantMessage.id,
        conversation_id: result.conversation.id,
      });
      stream.write({
        type: 'meta',
        data: {
          conversation_id: result.conversation.id,
          conversation_created: result.conversation.created,
          model: result.meta.model,
          iterations: result.meta.iterations,
          tool_calls_executed: result.meta.toolCallsExecuted,
          finish_reason: result.meta.finishReason,
          ...(result.meta.truncatedBy !== undefined
            ? { truncated_by: result.meta.truncatedBy }
            : {}),
          usage: result.meta.usage,
          context: result.meta.context,
        },
      });
      stream.write({ type: 'done' });
    } catch (err) {
      /**
       * 流已经开始，改不了状态码，只能把错误作为事件发出去。
       * ⚠️ 不发送原始 message：可能是 SQL 或上游返回的片段（docs/04 §44）。
       */
      request.log.error({ err }, 'SSE 对话失败');
      stream.write({ type: 'error', code: sseErrorCode(err), message: sseErrorMessage(err) });
    } finally {
      stream.close();
    }

    // 已手动接管 reply.raw，告诉 Fastify 不要再尝试发送响应
    return reply;
  });
}

// ============================================================
// 内部
// ============================================================

/**
 * 把请求的断开事件转成 AbortSignal。
 *
 * Fastify 的 request.raw 是 Node 的 IncomingMessage，'close' 在连接关闭时触发。
 * 用 readableEnded 区分「客户端提前走了」与「请求正常读完」——
 * 后者不该中止任何事。
 */
function abortSignalOf(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  request.raw.on('close', () => {
    if (!request.raw.readableEnded) controller.abort();
  });
  return controller.signal;
}

/** SSE 流的错误码。与 docs/04 §5 的错误码保持一致 */
function sseErrorCode(err: unknown): string {
  if (err instanceof LLMError) return err.options.retryable ? 'SERVICE_UNAVAILABLE' : 'LLM_ERROR';
  if (err instanceof ConversationNotFoundError) return 'NOT_FOUND';
  if (err instanceof ConversationDeletedError) return 'CONFLICT';
  return 'INTERNAL_ERROR';
}

function sseErrorMessage(err: unknown): string {
  if (err instanceof LLMError) {
    return err.options.retryable ? 'AI 服务暂时不可用，请稍后重试' : 'AI 服务调用失败';
  }
  if (err instanceof ConversationNotFoundError) return err.message;
  if (err instanceof ConversationDeletedError) return err.message;
  // 其余不暴露细节
  return '服务内部错误';
}
