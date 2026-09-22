/**
 * OpenAI 兼容的 LLM Provider 实现
 *
 * DeepSeek / Qwen(DashScope 兼容模式) / OpenAI / 各类中转都使用同一套
 * Chat Completions 协议，因此只实现一次，用配置区分厂商（架构 §34）。
 *
 * 只用 Node 内置的 fetch，不引入 axios / openai SDK：
 *   - 少一个依赖
 *   - 对重试、超时、中止的控制更直接（架构 §39 要求可控的错误处理）
 */
import { LLMError, type GenerateInput, type LLMProvider } from './provider.js';
import type {
  LLMGenerateResult,
  LLMMessage,
  LLMStreamChunk,
  LLMTokenUsage,
  LLMToolCall,
} from './types.js';

export interface OpenAICompatibleConfig {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  timeoutMs: number;
}

/** 厂商原始响应的最小形状。只取我们用到的字段，其余忽略 */
interface RawChatResponse {
  model?: string;
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: RawToolCall[];
      /** 推理模型的思维链。deepseek-flash / deepseek-v4-pro 会返回 */
      reasoning_content?: string | null;
    };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** 推理模型：其中用于思维链的 token 数 */
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; code?: string; type?: string };
}

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export class OpenAICompatibleProvider implements LLMProvider {
  readonly providerName: string;
  readonly defaultModel: string;

  constructor(private readonly cfg: OpenAICompatibleConfig) {
    this.providerName = cfg.providerName;
    this.defaultModel = cfg.defaultModel;
  }

  async generate(input: GenerateInput): Promise<LLMGenerateResult> {
    const body = this.buildBody(input, false);

    const res = await this.request('/chat/completions', body, input.signal);
    const json = (await res.json()) as RawChatResponse;

    const choice = json.choices?.[0];
    if (!choice) {
      throw new LLMError('LLM 返回中没有 choices', {
        retryable: true,
        ...(json.error?.code !== undefined ? { providerCode: json.error.code } : {}),
      });
    }

    const content = choice.message?.content ?? '';
    const toolCalls = mapToolCalls(choice.message?.tool_calls);
    const finishReason = mapFinishReason(choice.finish_reason);
    const usage = mapUsage(json.usage);
    const reasoningContent = choice.message?.reasoning_content ?? undefined;

    assertNotEmptyAnswer({ content, toolCalls, finishReason, usage });

    return {
      content,
      toolCalls,
      usage,
      model: json.model ?? input.model ?? this.defaultModel,
      finishReason,
      ...(reasoningContent !== undefined && reasoningContent !== ''
        ? { reasoningContent }
        : {}),
    };
  }

  async *stream(input: GenerateInput): AsyncIterable<LLMStreamChunk> {
    const body = this.buildBody(input, true);

    let res: Response;
    try {
      res = await this.request('/chat/completions', body, input.signal);
    } catch (err) {
      // 请求阶段失败：可以抛出，调用方还没开始往客户端写数据
      throw err;
    }

    if (!res.body) {
      yield { type: 'error', error: 'LLM 流式响应没有 body', retryable: true };
      return;
    }

    // 累积状态：流式返回的 tool_calls 是按 index 分片到达的
    let content = '';
    let model = input.model ?? this.defaultModel;
    let finishReason: LLMGenerateResult['finishReason'] = 'unknown';
    let usage: LLMTokenUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    let reasoningContent = '';
    const toolCallAcc = new Map<number, { id: string; name: string; args: string }>();

    try {
      for await (const data of parseSSE(res.body)) {
        if (data === '[DONE]') break;

        let evt: RawChatResponse & {
          choices?: {
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
            };
            finish_reason?: string | null;
          }[];
        };

        try {
          evt = JSON.parse(data) as typeof evt;
        } catch {
          // 单个分片解析失败不应中断整个流；记录后继续
          continue;
        }

        // 有些厂商把错误放在 200 的流里
        if (evt.error) {
          yield {
            type: 'error',
            error: 'LLM 流中返回错误',
            retryable: RETRYABLE_STATUS.has(Number(evt.error.code) || 0),
          };
          return;
        }

        if (evt.model) model = evt.model;
        if (evt.usage) usage = mapUsage(evt.usage);

        const choice = evt.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;

        if (delta?.content) {
          content += delta.content;
          yield { type: 'token', content: delta.content };
        }

        // 推理模型的思维链增量：累积但不作为 token 块产出 ——
        // 它面向模型自用，不应进入用户可见的输出流
        if (delta?.reasoning_content) {
          reasoningContent += delta.reasoning_content;
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const acc = toolCallAcc.get(idx) ?? { id: '', name: '', args: '' };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            toolCallAcc.set(idx, acc);

            yield {
              type: 'tool_call_delta',
              index: idx,
              ...(tc.id !== undefined ? { id: tc.id } : {}),
              ...(tc.function?.name !== undefined ? { name: tc.function.name } : {}),
              ...(tc.function?.arguments !== undefined
                ? { argumentsDelta: tc.function.arguments }
                : {}),
            };
          }
        }

        if (choice.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason);
        }
      }
    } catch (err) {
      // 流中途失败：SSE 的 200 头已发出，只能以 error 块告知
      const retryable = !(err instanceof LLMError) || err.options.retryable;
      yield {
        type: 'error',
        error: err instanceof LLMError ? err.message : 'LLM 流式读取失败',
        retryable,
      };
      return;
    }

    const result: LLMGenerateResult = {
      content,
      toolCalls: [...toolCallAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.args })),
      usage,
      model,
      finishReason,
      ...(reasoningContent !== '' ? { reasoningContent } : {}),
    };

    yield { type: 'done', result };
  }

  // ----------------------------------------------------------

  private buildBody(input: GenerateInput, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: input.model ?? this.defaultModel,
      messages: input.messages.map(toApiMessage),
      stream,
    };

    if (stream) {
      // 让厂商在最后一个分片里带上用量，否则无法统计成本（架构 §38）
      body.stream_options = { include_usage: true };
    }

    if (input.temperature !== undefined) body.temperature = input.temperature;
    if (input.maxOutputTokens !== undefined) body.max_tokens = input.maxOutputTokens;

    if (input.tools?.length) {
      body.tools = input.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    return body;
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined
  ): Promise<Response> {
    // 合并调用方的 signal 与自身的超时 signal。
    // 用户断开 SSE 时必须能中止上游请求，否则会为无人接收的回答付费。
    const timeoutSignal = AbortSignal.timeout(this.cfg.timeoutMs);
    const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: merged,
      });
    } catch (err) {
      const aborted = signal?.aborted === true;
      throw new LLMError(
        aborted ? '请求已被取消' : 'LLM 请求失败（网络或超时）',
        {
          // 用户主动取消不算可重试
          retryable: !aborted,
        }
      );
    }

    if (!res.ok) {
      // 读取响应体里的厂商错误码用于日志，但**不把原文抛给用户**（架构 §39）
      let providerCode: string | undefined;
      try {
        const errJson = (await res.json()) as RawChatResponse;
        providerCode = errJson.error?.code ?? errJson.error?.type;
      } catch {
        // 响应体不是 JSON，忽略
      }

      throw new LLMError(`LLM 服务返回 ${res.status}`, {
        retryable: RETRYABLE_STATUS.has(res.status),
        status: res.status,
        ...(providerCode !== undefined ? { providerCode } : {}),
      });
    }

    return res;
  }
}

// ============================================================
// 辅助函数
// ============================================================

function toApiMessage(m: LLMMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content === '' ? null : m.content,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function mapToolCalls(raw: RawToolCall[] | undefined): LLMToolCall[] {
  if (!raw?.length) return [];
  return raw.map((tc, i) => ({
    id: tc.id ?? `call_${i}`,
    name: tc.function?.name ?? '',
    arguments: tc.function?.arguments ?? '{}',
  }));
}

function mapUsage(u: RawChatResponse['usage']): LLMTokenUsage {
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

/**
 * 守卫：非流式返回「既没有回答也没有工具调用」时必须报错，
 * 而不是把它当成空字符串的成功结果。
 *
 * 为什么需要（2026-09-22 实测踩到）：
 *   推理模型（deepseek-flash / deepseek-v4-pro）会先产出思维链，
 *   而 max_tokens 同时约束思维链与最终回答。预算不足时会出现：
 *     content = ""      finish_reason = "length"
 *     completion_tokens_details.reasoning_tokens == completion_tokens
 *   即 token 全花在思考上、一个字都没答。
 *
 *   若静默返回空串，上层只会看到「模型没说话」，
 *   必须靠猜才能定位；明确报错并给出可操作的建议才有意义。
 */
function assertNotEmptyAnswer(params: {
  content: string;
  toolCalls: LLMToolCall[];
  finishReason: LLMGenerateResult['finishReason'];
  usage: LLMTokenUsage;
}): void {
  const { content, toolCalls, finishReason, usage } = params;

  // 有内容、或有工具调用，都是正常结果
  if (content !== '' || toolCalls.length > 0) return;

  const spentOnReasoning =
    usage.reasoningTokens > 0 && usage.reasoningTokens >= usage.outputTokens;

  if (finishReason === 'length' && spentOnReasoning) {
    throw new LLMError(
      `模型把全部输出预算用于推理，未产生回答` +
        `（推理 token ${usage.reasoningTokens} / 输出上限 ${usage.outputTokens}）。` +
        `请提高 maxOutputTokens 后重试`,
      { retryable: true }
    );
  }

  if (finishReason === 'length') {
    throw new LLMError('模型输出被长度上限截断，且未产生任何内容。请提高 maxOutputTokens', {
      retryable: true,
    });
  }

  if (finishReason === 'content_filter') {
    throw new LLMError('模型因内容策略未产生回答', { retryable: false });
  }

  // 其余情况：模型确实返回了空回答。属于异常，明确报错而不是静默
  throw new LLMError('模型返回了空回答且没有工具调用', { retryable: true });
}

function mapFinishReason(r: string | null | undefined): LLMGenerateResult['finishReason'] {
  switch (r) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

/**
 * 解析 SSE 流，逐个产出 data: 后面的内容。
 *
 * 处理要点：
 *   - 跨 chunk 的行边界（分片不保证按行到达）
 *   - 忽略注释行（以 : 开头的心跳）
 *   - 兼容 \r\n
 */
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);

        if (line === '' || line.startsWith(':')) continue;
        if (line.startsWith('data:')) {
          yield line.slice(5).trim();
        }
      }
    }
    // 流结束时缓冲区可能还有最后一行（无尾随换行）
    const tail = buffer.trim();
    if (tail.startsWith('data:')) yield tail.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}
