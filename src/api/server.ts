/**
 * Fastify 服务器（docs/04 §2、§41–§43、§49）
 *
 * 【日志纪律】（docs/03 §29.1）
 *   请求体与响应体里都是用户的私密内容，**绝不能进日志**。
 *   因此：
 *     · Fastify 的 logger 不开 body 序列化
 *     · 不记录 request.body / reply payload
 *     · 只记 method / url / status / 耗时 / request_id
 *   这条不是性能或风格问题，是隐私要求，改代码时不要"顺手"加上 body 日志。
 *
 * 【只绑回环】（docs/03 §29）
 *   默认 HOST=127.0.0.1。放到 0.0.0.0 会让整个记忆库在局域网内可读写。
 */
import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { env } from '../shared/env.js';
import { LLMError, type LLMProvider } from '../llm/provider.js';
import {
  ConversationDeletedError,
  ConversationNotFoundError,
} from '../conversation/chat-service.js';
import type { ExtractionTrigger } from '../conversation/extraction-trigger.js';
import { HttpError, internalError, ok, validationError } from './errors.js';
import { IdempotencyConflictError } from './idempotency.js';
import { registerChatRoutes, type ChatRouteDeps } from './routes/chat.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerMemoryRoutes } from './routes/memories.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTimelineRoutes } from './routes/timeline.js';
import { registerLifeReviewRoutes } from './routes/life-review.js';
import { registerGoalRoutes } from './routes/goals.js';
import type { IdempotencyStore } from './idempotency.js';
import type { ChatResult } from '../conversation/chat-service.js';

export interface BuildServerOptions {
  /** 覆盖日志级别（测试用 'silent'） */
  logLevel?: string;
  /** 在测试中注入幂等存储，避免用例之间互相影响 */
  chatIdempotency?: IdempotencyStore<ChatResult>;
  /**
   * 覆盖 LLM Provider。
   *
   * 生产环境不传，走 env 配置的默认 Provider。
   * 测试传假 Provider —— 这是让 HTTP 层「可被断言」的关键：
   * 否则每个用例都要真调一次模型，既慢又不稳定。
   *
   * 同时也是将来做「模型 A/B 对比」的现成入口（架构 §34 的可替换性）。
   */
  provider?: LLMProvider;
  /** 覆盖抽取触发器（测试传一个不真跑的） */
  extractionTrigger?: ExtractionTrigger;
  /**
   * 覆盖记忆检索。
   *
   * 缺省接真实检索（向量 + 关键词 + 结构化三通道）。
   * 测试传函数以避免依赖 embedding 服务，传 null 显式关闭。
   */
  retrieveMemories?: ChatRouteDeps['retrieveMemories'];
}

/**
 * 组装 Fastify 实例。**不监听端口** —— 便于测试里用 inject() 直接打请求。
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options.logLevel ?? env.LOG_LEVEL,
      /**
       * 显式关掉请求/响应体序列化。
       *
       * Fastify 默认不记录 body，但这里显式声明，避免将来有人
       * 「为了调试」打开它 —— 那会把用户对话写进日志文件。
       */
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            // ⚠️ 不含 headers（有 Authorization）与 body（有对话内容）
            remoteAddress: request.ip,
          };
        },
        res(reply) {
          return { statusCode: reply.statusCode };
        },
      },
    },
    // 请求体上限（docs/04 §49：对 JSON Payload 设置大小限制）
    bodyLimit: 1 * 1024 * 1024,
    // 关闭 Fastify 自带的请求 id 生成，改用带前缀的格式（docs/04 §42）
    genReqId: () => `req_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    // 信任代理头仅在明确部署在反代之后时才应开启；本地默认关闭
    trustProxy: false,
  });

  // ---------- 统一响应头 ----------
  app.addHook('onSend', async (request, reply, payload) => {
    // 把 request id 回给客户端，便于用户报错时引用（docs/04 §42）
    reply.header('X-Request-Id', request.id);
    // 本项目保存私密数据，禁止被任何中间层或爬虫缓存
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // ---------- 统一错误处理（docs/04 §4、§5）----------
  app.setErrorHandler((err, request, reply) => {
    const mapped = mapError(err);

    /**
     * 日志分两档：
     *   4xx 是客户端问题，用 warn（不记 stack，避免噪音与被滥用的日志膨胀）
     *   5xx 是服务端问题，用 error 并带 stack
     * 两档都**只带 err.message**，不带 body。
     */
    if (mapped.status >= 500) {
      request.log.error({ err, code: mapped.code }, '请求处理失败');
    } else {
      request.log.warn({ code: mapped.code, message: mapped.message }, '请求被拒绝');
    }

    reply.code(mapped.status).send({
      success: false,
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details !== undefined ? { details: mapped.details } : {}),
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: `接口不存在：${request.method} ${request.url}` },
    });
  });

  // ---------- 健康检查 ----------
  /**
   * 不查数据库、不查 LLM：健康检查要轻，
   * 且「依赖挂了」与「本进程挂了」应当能被区分开。
   * 依赖状态由 /api/v1/settings 这类实际调用暴露。
   */
  app.get('/health', async () => ok({ status: 'ok' }));

  // ---------- 业务路由 ----------
  await app.register(
    async (v1) => {
      await registerChatRoutes(v1, {
        ...(options.chatIdempotency !== undefined
          ? { idempotency: options.chatIdempotency }
          : {}),
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
        ...(options.extractionTrigger !== undefined
          ? { extractionTrigger: options.extractionTrigger }
          : {}),
        ...(options.retrieveMemories !== undefined
          ? { retrieveMemories: options.retrieveMemories }
          : {}),
      });
      await registerConversationRoutes(v1);
      await registerMemoryRoutes(v1);
      await registerSettingsRoutes(v1);
      await registerTimelineRoutes(v1);
      await registerLifeReviewRoutes(v1, {
        ...(options.provider !== undefined ? { provider: options.provider } : {}),
      });
      await registerGoalRoutes(v1);
    },
    { prefix: '/api/v1' }
  );

  /**
   * ⚠️ 这里**不**注册关连接池的钩子。
   *
   * 服务器有多个实例（生产一个、测试每个用例一个），
   * 而连接池是进程级单例 —— 任一个实例关闭都把池关掉，
   * 其余实例的后续查询会全部失败。关闭池属于进程生命周期，
   * 由入口脚本（src/api/main.ts）负责。
   */

  return app;
}

/**
 * 把任意错误映射成 HTTP 语义。
 *
 * 集中一处的原因：同一类错误在不同 route 里各映射一次，迟早会不一致。
 * 映射顺序很重要 —— 越具体的越靠前。
 */
export function mapError(err: unknown): HttpError {
  // 已经是 HTTP 语义错误，原样返回
  if (err instanceof HttpError) return err;

  // Zod 校验失败 → 422（docs/04 §5 把参数校验失败归为 422 而不是 400）
  if (err instanceof ZodError) {
    return validationError(
      '请求参数校验失败',
      err.issues.map((i) => ({
        path: i.path.join('.') || '(root)',
        message: i.message,
      }))
    );
  }

  if (err instanceof LLMError) {
    /**
     * 不把供应商的原始错误透给用户（docs/04 §44）：
     * 它可能包含请求地址、模型名，甚至上游返回的片段。
     * 只区分「可重试」与「不可重试」两类，给不同状态码。
     */
    return err.options.retryable
      ? new HttpError('SERVICE_UNAVAILABLE', 'AI 服务暂时不可用，请稍后重试')
      : new HttpError('LLM_ERROR', 'AI 服务调用失败');
  }

  /**
   * 业务错误 —— 必须在这里映射，否则会掉进最后的 500 分支。
   *
   * ⚠️ 这曾经真的漏了（实测：不存在的会话返回 500 INTERNAL_ERROR 而不是 404）。
   *    教训是「新增业务错误类型时，必须同时在这里加映射」——
   *    因此这些错误类型都来自 chat-service 的显式导出，
   *    而不是各处随手 new Error()。
   */
  if (err instanceof ConversationNotFoundError) {
    return new HttpError('NOT_FOUND', err.message);
  }
  if (err instanceof ConversationDeletedError) {
    // 409 而不是 404：会话存在但状态不允许这个操作，
    // 语义上属于「与当前资源状态冲突」（docs/06 的 P2-6 同样把这类归 409）
    return new HttpError('CONFLICT', err.message);
  }
  if (err instanceof IdempotencyConflictError) {    /**
     * 同一个键被用于不同内容。
     *
     * 这里返回 409 而不是「重放上一个结果」：后者会让用户以为新消息发出去了，
     * 而实际上什么都没发生 —— 静默的错误比显式的失败更糟。
     */
    return new HttpError('CONFLICT', err.message);
  }

  /**
   * 数据库约束冲突 → 409。
   *
   * ⚠️ 这一类曾经漏掉：POST /memories 在同槽位重复时返回了 500，
   *    而 uq_memories_current_slot 拦下它是**设计意图**（§13.11），
   *    不是服务端故障。500 会让前端以为系统坏了，也不会提示用户
   *    「这个槽位已有记忆，应走替代语义」。
   *
   * 只映射「唯一约束 / 排他约束」，不把 CHECK 与 NOT NULL 也算进来 ——
   * 那些属于**调用方传了非法值**，应该走 422 而不是 409；
   * 但它们在当前实现里会先被 Zod 拦下，因此这里不额外处理。
   */
  const pgCode = postgresErrorCode(err);
  if (pgCode === '23505' || pgCode === '23P01') {
    return new HttpError('CONFLICT', '该操作与已有数据冲突', {
      constraint: postgresConstraintName(err),
    });
  }

  // Fastify 的 JSON 解析错误 → 400（请求格式本身就不对）
  if (isFastifyError(err) && typeof err.statusCode === 'number' && err.statusCode < 500) {
    return new HttpError('BAD_REQUEST', err.message);
  }

  // 其余一律 500，且**不暴露原始 message**（可能是 SQL 语句或连接串片段）
  return internalError();
}

function isFastifyError(err: unknown): err is Error & { statusCode: number } {
  return (
    err instanceof Error &&
    'statusCode' in err &&
    typeof (err as { statusCode?: unknown }).statusCode === 'number'
  );
}

/**
 * 从错误链里取 PostgreSQL 的 SQLSTATE 码。
 *
 * 为什么要顺着 cause 链找：Drizzle 会把驱动抛出的错误包一层
 *   Error: Failed query: insert into ...
 *     [cause]: error: duplicate key value violates unique constraint "..."
 * 直接看最外层是拿不到 code 的。
 *
 * 23xxx 是完整性约束冲突类：
 *   23505 unique_violation
 *   23P01 exclusion_violation
 */
function postgresErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (typeof cur === 'object' && cur !== null) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === 'string' && /^23\d{3}$/.test(code)) return code;
      cur = (cur as { cause?: unknown }).cause;
    } else {
      return undefined;
    }
  }
  return undefined;
}

function postgresConstraintName(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (typeof cur === 'object' && cur !== null) {
      const name = (cur as { constraint?: unknown }).constraint;
      if (typeof name === 'string') return name;
      cur = (cur as { cause?: unknown }).cause;
    } else {
      return undefined;
    }
  }
  return undefined;
}
