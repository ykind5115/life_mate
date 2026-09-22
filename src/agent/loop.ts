/**
 * Agent Loop（架构 §8）
 *
 * ⚠️ 本实现修正了架构 §8.1 伪代码的一个缺陷（审计 F-05）：
 *    原伪代码为
 *      response = await model.generate({ ...context, toolResults: results })
 *    `...context` 始终是循环外的快照，因此**每轮都丢弃上一轮的工具结果**。
 *    而第 N 轮的工具调用恰恰是基于第 N-1 轮结果做的决策，
 *    模型会「忘记自己刚查过什么」，表现为重复调用同一工具或基于缺失信息作答。
 *
 *    修法：工具结果必须**累积**进消息历史，而不是覆盖。
 *
 * ⚠️ 同时补齐架构 §8.1 完全缺失的边界条件（评审 P0-7）：
 *    MAX_ITERATIONS / MAX_TOOL_CALLS / LOOP_TIMEOUT / 工具结果截断。
 *    没有上限的 while 循环会产生无限 LLM 调用与费用。
 */
import type { GenerateInput, LLMProvider } from '../llm/provider.js';
import { LLMError } from '../llm/provider.js';
import type { LLMMessage, LLMTokenUsage, LLMToolCall } from '../llm/types.js';

/** 循环上限。集中在这里，便于按实测调整（评审 P0-7 要求写进文档并集中配置） */
export const AGENT_LIMITS = {
  /** 工具调用轮次上限 */
  MAX_ITERATIONS: 5,
  /** 单次执行的工具调用总数上限 */
  MAX_TOOL_CALLS: 10,
  /** 整个 Agent 执行超时（ms） */
  LOOP_TIMEOUT_MS: 60_000,
  /** 单个工具超时（ms） */
  TOOL_TIMEOUT_MS: 10_000,
  /** 单个工具结果注入上下文的字符上限，超出则截断并显式标注 */
  MAX_TOOL_RESULT_CHARS: 8_000,
} as const;

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema */
  parameters: Record<string, unknown>;
  execute: (args: unknown, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  signal: AbortSignal;
  /** 幂等键，工具实现可用它避免重复副作用（评审 P0-7） */
  idempotencyKey: string;
  /** 本次 Agent 执行的标识，用于日志关联（架构 §38、接口 §43） */
  agentRunId: string;
}

export interface RunAgentOptions {
  provider: LLMProvider;
  /** 已组装的上下文（system + 历史 + 记忆 + 当前消息） */
  messages: LLMMessage[];
  tools?: ToolDefinition[];
  /** 工具是否只读。V1.0 应为 true（Q3：Agent 不持有写工具） */
  signal?: AbortSignal;
  model?: string;
  maxOutputTokens?: number;
  /**
   * 覆盖默认上限，仅用于测试。
   * ⚠️ 不能用 Partial<typeof AGENT_LIMITS>：AGENT_LIMITS 用了 as const，
   *    属性是字面量类型（如 5），会导致只能传回同样的值、无法覆盖。
   */
  limits?: Partial<Record<keyof typeof AGENT_LIMITS, number>>;
  /** 日志回调。实现方需保证不打印消息正文（docs/03 §29.1） */
  onEvent?: (e: AgentEvent) => void;
}

export type AgentEvent =
  | { type: 'iteration_start'; iteration: number; messageCount: number }
  | { type: 'tool_call'; name: string; id: string }
  | { type: 'tool_result'; name: string; id: string; truncated: boolean; ms: number }
  | { type: 'tool_error'; name: string; id: string; message: string }
  | { type: 'loop_truncated'; reason: 'max_iterations' | 'max_tool_calls' | 'timeout' }
  | { type: 'llm_error'; message: string; retryable: boolean; willRetry: boolean };

export interface RunAgentResult {
  /** 最终回答文本 */
  content: string;
  /** 若因上限中止，为中止原因；正常结束为 undefined */
  truncatedBy?: 'max_iterations' | 'max_tool_calls' | 'timeout';
  /** 累计用量（多轮求和，用于成本核算） */
  usage: LLMTokenUsage;
  iterations: number;
  toolCallsExecuted: number;
  model: string;
  /** 结束原因。'length' 需调用方注意回答被截断 */
  finishReason: string;
}

/**
 * 运行 Agent，直到模型不再请求工具或触达上限。
 *
 * 返回值语义：**只要还有已有信息就生成回答**，不因为触达上限而抛错。
 * 触达上限时通过 truncatedBy 告知调用方（评审 P0-7 的截断行为约定）。
 */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const limits = { ...AGENT_LIMITS, ...options.limits };
  const toolMap = new Map((options.tools ?? []).map((t) => [t.name, t]));
  const toolDefs: GenerateInput['tools'] = (options.tools ?? []).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  // 可变的消息历史。工具结果累积到这里，而不是覆盖（F-05 的修法）
  const messages: LLMMessage[] = [...options.messages];

  const deadline = Date.now() + limits.LOOP_TIMEOUT_MS;
  const agentRunId = `run_${Date.now().toString(36)}`;

  const usage: LLMTokenUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let iterations = 0;
  let toolCallsExecuted = 0;
  let lastModel = options.model ?? options.provider.defaultModel;
  let lastFinishReason: string = 'unknown';
  let truncatedBy: RunAgentResult['truncatedBy'];

  const emit = (e: AgentEvent): void => options.onEvent?.(e);

  for (;;) {
    // ---------- 边界检查（P0-7）----------
    if (Date.now() > deadline) {
      truncatedBy = 'timeout';
      emit({ type: 'loop_truncated', reason: 'timeout' });
      break;
    }
    if (iterations >= limits.MAX_ITERATIONS) {
      truncatedBy = 'max_iterations';
      emit({ type: 'loop_truncated', reason: 'max_iterations' });
      break;
    }

    iterations++;
    emit({ type: 'iteration_start', iteration: iterations, messageCount: messages.length });

    // ---------- 调用 LLM（带一次重试）----------
    let response;
    try {
      response = await generateWithRetry(options.provider, {
        messages,
        ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.maxOutputTokens !== undefined
          ? { maxOutputTokens: options.maxOutputTokens }
          : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (err) {
      const retryable = err instanceof LLMError && err.options.retryable;
      const message = err instanceof Error ? err.message : 'LLM 调用失败';
      emit({ type: 'llm_error', message, retryable, willRetry: false });
      throw err;
    }

    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    lastModel = response.model;
    lastFinishReason = response.finishReason;

    // ---------- 无工具调用：结束 ----------
    if (response.toolCalls.length === 0) {
      return {
        content: response.content,
        ...(truncatedBy !== undefined ? { truncatedBy } : {}),
        usage,
        iterations,
        toolCallsExecuted,
        model: lastModel,
        finishReason: lastFinishReason,
      };
    }

    // ---------- 有工具调用：把 assistant 意图追加进历史 ----------
    // 这一步是 F-05 修法的关键：assistant 的 tool_calls 必须先入历史，
    // 否则后续的 role='tool' 消息没有可对应的请求，多数厂商会直接报错。
    messages.push({
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
    });

    // ---------- 执行工具，逐个把结果追加进历史 ----------
    for (const call of response.toolCalls) {
      if (toolCallsExecuted >= limits.MAX_TOOL_CALLS) {
        truncatedBy = 'max_tool_calls';
        emit({ type: 'loop_truncated', reason: 'max_tool_calls' });
        // 仍要为每个未执行的调用补一条结果，否则历史不完整
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify({ error: '工具调用超出本次执行上限，未执行' }),
        });
        continue;
      }

      toolCallsExecuted++;
      const tool = toolMap.get(call.name);

      if (!tool) {
        // 模型请求了不存在的工具：明确回报，而不是静默忽略
        emit({ type: 'tool_error', name: call.name, id: call.id, message: '工具不存在' });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify({ error: `工具 ${call.name} 不存在` }),
        });
        continue;
      }

      const started = Date.now();
      emit({ type: 'tool_call', name: call.name, id: call.id });

      const result = await executeTool(tool, call, {
        signal: options.signal ?? new AbortController().signal,
        idempotencyKey: `${agentRunId}:${call.id}`,
        agentRunId,
        timeoutMs: limits.TOOL_TIMEOUT_MS,
      });

      const ms = Date.now() - started;

      if (!result.ok) {
        emit({ type: 'tool_error', name: call.name, id: call.id, message: result.error });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify({ error: result.error }),
        });
        continue;
      }

      // 截断超长结果并显式标注，避免模型以为看到了全部内容
      const { text, truncated } = stringifyWithLimit(
        result.value,
        limits.MAX_TOOL_RESULT_CHARS
      );
      emit({ type: 'tool_result', name: call.name, id: call.id, truncated, ms });
      messages.push({ role: 'tool', toolCallId: call.id, content: text });
    }

    // 循环继续：下一轮 LLM 调用会看到**累积的**全部工具结果
  }

  // ---------- 触达上限：用已有信息生成收尾回答 ----------
  // 不抛错。架构 §39 要求「不能因为一次失败导致整个系统崩溃」，
  // 这里同理：已经有部分工具结果，足以给用户一个可用回答。
  messages.push({
    role: 'user',
    content:
      '（系统提示：你已达到本次工具调用上限。请基于上面已获得的信息直接回答用户，' +
      '不要再请求调用工具，并说明哪些信息可能不完整。）',
  });

  const final = await options.provider.generate({
    messages,
    ...(options.maxOutputTokens !== undefined
      ? { maxOutputTokens: options.maxOutputTokens }
      : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });

  usage.inputTokens += final.usage.inputTokens;
  usage.outputTokens += final.usage.outputTokens;

  return {
    content: final.content,
    ...(truncatedBy !== undefined ? { truncatedBy } : {}),
    usage,
    iterations,
    toolCallsExecuted,
    model: final.model,
    finishReason: final.finishReason,
  };
}

// ============================================================
// 辅助
// ============================================================

/** 一次重试。仅对可重试错误重试，指数退避（架构 §39） */
async function generateWithRetry(
  provider: LLMProvider,
  input: GenerateInput,
  maxAttempts = 2
): Promise<Awaited<ReturnType<LLMProvider['generate']>>> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await provider.generate(input);
    } catch (err) {
      lastErr = err;

      const retryable = err instanceof LLMError && err.options.retryable;
      const aborted = input.signal?.aborted === true;
      if (!retryable || aborted || attempt === maxAttempts) throw err;

      // 指数退避：500ms, 1000ms...
      await sleep(500 * 2 ** (attempt - 1));
    }
  }

  throw lastErr;
}

async function executeTool(
  tool: ToolDefinition,
  call: LLMToolCall,
  ctx: ToolContext & { timeoutMs: number }
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  // 参数解析失败必须显式报错：静默当作 {} 会让工具以错误参数执行
  let args: unknown;
  try {
    args = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments);
  } catch {
    return { ok: false, error: `工具参数不是合法 JSON` };
  }

  const timeoutSignal = AbortSignal.timeout(ctx.timeoutMs);
  const merged = AbortSignal.any([ctx.signal, timeoutSignal]);

  try {
    const value = await tool.execute(args, {
      signal: merged,
      idempotencyKey: ctx.idempotencyKey,
      agentRunId: ctx.agentRunId,
    });
    return { ok: true, value };
  } catch (err) {
    // 工具失败不中断整个 Loop：把错误交给模型，让它决定如何继续
    const msg =
      timeoutSignal.aborted
        ? `工具执行超时（>${ctx.timeoutMs}ms）`
        : err instanceof Error
          ? err.message
          : '工具执行失败';
    return { ok: false, error: msg };
  }
}

function stringifyWithLimit(value: unknown, limit: number): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }

  if (text.length <= limit) return { text, truncated: false };

  // 显式标注截断，避免模型以为看到了全部内容而给出过于确定的回答
  return {
    text:
      text.slice(0, limit) +
      `\n\n[系统提示：结果过长已截断，仅显示前 ${limit} 字符，共 ${text.length} 字符]`,
    truncated: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
