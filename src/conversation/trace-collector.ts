/**
 * Agent 执行轨迹的采集器
 *
 * 【它解决的具体问题】（2026-09-29 的排查实录）
 *   用户报告一次幻觉。我要回答「模型当时调了什么工具、拿回多少东西」，
 *   结果 `messages.metadata` 里只有 `{model, iterations}` ——
 *   只知道它调了工具（iterations=2），不知道调的是哪个、传了什么、拿到什么。
 *   **故障就发生在唯一没有记录的那一步上**，这是最糟的情况。
 *
 * 【为什么在工具边界采集，而不是改 Agent Loop】
 *   Loop 已经通过 `onEvent` 发 `tool_call` / `tool_result`，
 *   但那两个事件里**没有参数**（只有 name / id / ms / truncated）。
 *   要拿到参数只有一个位置：包一层 tool.execute。
 *
 *   这样做的额外好处：不动 Loop 的一行代码。Loop 是核心，
 *   它的事件契约还兼作 SSE 的 progress 来源，
 *   为了观测去改它、进而影响流式输出，代价不对等。
 *
 * 【采集什么，不采集什么】
 *   采集：工具名、参数字段的**键名**、结果字符数、是否截断、耗时、错误原因
 *   不采集：参数值、返回值、任何用户正文
 *
 *   理由是 docs/03 §16.2 明确禁止「任何级别的敏感正文副本」进入 JSONB。
 *   而工具参数里最常见的恰恰就是用户原话
 *   （`search_memory({ query: '用户说了什么' })`）。
 *   只看键名已经足够回答「它当时查了什么」。
 */
import type { AgentEvent, ToolDefinition } from '../agent/loop.js';
import { summarizeToolArguments, type ToolCallTrace } from '../database/schema/message-metadata.js';

export interface TraceCollector {
  /** 包装过的工具集，交给 runAgent */
  tools: ToolDefinition[];
  /** 取当前已采集的调用记录（浅拷贝，调用方可安全持有） */
  summary: () => ToolCallTrace[];
}

/**
 * 用采集器包一层工具集。
 *
 * ⚠️ 包装必须**保持工具行为完全不变**：
 *    · 参数与返回值原样透传
 *    · 异常原样抛出（吞掉会让 Agent 拿到假结果）
 *    · 工具超时由 Loop 控制，这里不做二次超时
 *   采集失败（例如结果无法序列化）绝不冒泡 ——
 *   观测代码把业务搞挂是最不能接受的失败模式，
 *   因此所有计量动作都包在 try/catch 里，失败就少记一条。
 */
export function createTraceCollector(tools: ToolDefinition[]): TraceCollector {
  const records: ToolCallTrace[] = [];
  /**
   * 本次 Agent 执行里工具被调用的序号（从 1 开始）。
   * 同一工具可能被调多次（Loop 每轮都可能调），因此按**调用顺序**编号，
   * 而不是按「第几轮迭代」—— 后者在包装层看不到。
   */
  let callIndex = 0;

  const wrapped: ToolDefinition[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (args: unknown, ctx) => {
      callIndex += 1;
      const myTurn = callIndex;
      const started = Date.now();

      let argumentKeys: string[] = [];
      try {
        argumentKeys = summarizeToolArguments(args);
      } catch {
        // 参数不是普通对象（理论上不会）：只记空键名，不影响调用
      }

      try {
        const result = await tool.execute(args, ctx);

        /**
         * 结果大小只算「序列化后的长度」。
         * 序列化失败时记 0 —— 不因为计量失败而丢掉整条记录，
         * 因为「调了这个工具」本身就是最有价值的信息。
         */
        let resultChars = 0;
        try {
          const serialized = JSON.stringify(result);
          resultChars = typeof serialized === 'string' ? serialized.length : 0;
        } catch {
          resultChars = -1; // -1 表示「无法计量」，与「真的是 0」区分开
        }

        records.push({
          name: tool.name,
          turn: myTurn,
          argumentKeys,
          resultChars: Math.max(0, resultChars),
          truncated: false,
          ms: Date.now() - started,
        });

        return result;
      } catch (err) {
        /**
         * 错误信息只取 `name: message`，且截断到 200 字符。
         * 工具的错误消息通常是自己写的（「参数缺失」这类），
         * 但截断是为了兜住「某个工具把用户数据拼进了错误消息」这种情况。
         */
        records.push({
          name: tool.name,
          turn: myTurn,
          argumentKeys,
          resultChars: 0,
          truncated: false,
          ms: Date.now() - started,
          error: describeToolError(err).slice(0, 200),
        });

        // ⚠️ 原样抛出：Agent Loop 依赖这个异常来给模型回报工具失败
        throw err;
      }
    },
  }));

  return {
    tools: wrapped,
    summary: () => records.map((r) => ({ ...r, argumentKeys: [...r.argumentKeys] })),
  };
}

/** 只取错误类型与消息，不带 stack（stack 里可能含调用链上的数据） */
function describeToolError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return '未知错误';
}

/**
 * 把 Loop 的工具事件回填到采集记录上。
 *
 * 【为什么要回填两次信息】
 *   ① `truncated` 只有 Loop 知道 —— 截断是它拿到结果**之后**做的
 *      （超 MAX_TOOL_RESULT_CHARS 才截），工具自身无从得知。
 *   ② `tool_error`（超时、参数不是合法 JSON）发生在**调用之前或之外**：
 *      `executeTool` 在解析参数失败时直接返回 `{ok:false}`，
 *      **根本不会进到 tool.execute**，所以包装器看不到这一种失败。
 *
 * 【怎么对齐】
 *   每个工具调用恰好产生一个事件（tool_result 或 tool_error），
 *   且事件的发出顺序与执行顺序一致。因此按「同名事件的第 n 次出现」
 *   对齐即可，不需要在 Loop 里加字段。
 *
 * ⚠️ 只在事件说 `truncated: true` 时才标截断。
 *    曾经写成「收到 tool_result 就标截断」——那会把所有成功的调用
 *    都记成被截断，事后看数据会得出完全错误的结论。
 */
export function applyToolEvents(
  records: ToolCallTrace[],
  events: readonly AgentEvent[]
): void {
  /** 每个工具名各自维护一个游标：同名多次调用要按顺序一一对应 */
  const cursorByTool = new Map<string, number>();

  for (const event of events) {
    if (event.type !== 'tool_result' && event.type !== 'tool_error') continue;

    const start = cursorByTool.get(event.name) ?? 0;
    // 从 start 往后找第一条同名记录（调用顺序与事件顺序一致）
    let idx = start;
    while (idx < records.length && records[idx]!.name !== event.name) idx += 1;

    const record = records[idx];
    if (!record) continue;
    cursorByTool.set(event.name, idx + 1);

    if (event.type === 'tool_result') {
      // 事件里的耗时是 Loop 侧的实测值，比包装器更准（含参数解析）
      record.ms = event.ms;
      if (event.truncated) record.truncated = true;
    } else {
      record.error = event.message.slice(0, 200);
    }
  }
}
