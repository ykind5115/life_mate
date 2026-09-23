/**
 * Agent Loop 单元测试
 *
 * 重点验证两件在审计中被点出的缺陷是否真的修好：
 *   F-05  工具结果必须**累积**进消息历史，而不是每轮覆盖
 *   P0-7  各边界条件（迭代上限 / 工具数上限 / 超时 / 结果截断）真的生效
 *
 * 运行：pnpm test
 *
 * 用假 Provider 而非真实 LLM：这些是循环自身的逻辑，不需要模型参与，
 * 而且真调模型会让测试既慢又不稳定。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runAgent, type ToolDefinition } from './loop.js';
import type { GenerateInput, LLMProvider } from '../llm/provider.js';
import { LLMError } from '../llm/provider.js';
import type {
  LLMGenerateResult,
  LLMMessage,
  LLMStreamChunk,
  LLMToolCall,
} from '../llm/types.js';

// ============================================================
// 测试用假 Provider
// ============================================================

/** 按脚本依次返回结果，并记录每次收到的消息，便于断言累积行为 */
class ScriptedProvider implements LLMProvider {
  readonly providerName = 'scripted';
  readonly defaultModel = 'scripted-model';

  /** 每次 generate 收到的 messages 快照 */
  readonly receivedMessages: LLMMessage[][] = [];

  constructor(private readonly script: LLMGenerateResult[]) {}

  async generate(input: GenerateInput): Promise<LLMGenerateResult> {
    this.receivedMessages.push(structuredClone(input.messages));
    const next = this.script.shift();
    if (!next) throw new Error('测试脚本已用尽，但 Loop 仍在调用 generate');
    return next;
  }

  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<never> {
    throw new Error('本测试不使用 stream');
  }
}

function result(partial: Partial<LLMGenerateResult>): LLMGenerateResult {
  return {
    content: '',
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
    model: 'scripted-model',
    finishReason: 'stop',
    ...partial,
  };
}

const echoTool: ToolDefinition = {
  name: 'echo',
  description: '回显参数',
  parameters: { type: 'object', properties: { v: { type: 'string' } } },
  execute: async (args) => ({ echoed: (args as { v?: string }).v ?? null }),
};

// ============================================================
// F-05：工具结果累积
// ============================================================

test('F-05: 第二轮 LLM 调用能看到第一轮的工具结果（累积而非覆盖）', async () => {
  const provider = new ScriptedProvider([
    // 第 1 轮：请求调用 echo
    result({
      toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"v":"第一次"}' }],
      finishReason: 'tool_calls',
    }),
    // 第 2 轮：不再调用工具，直接回答
    result({ content: '完成', finishReason: 'stop' }),
  ]);

  const res = await runAgent({
    provider,
    messages: [{ role: 'user', content: '开始' }],
    tools: [echoTool],
  });

  assert.equal(res.content, '完成');
  assert.equal(provider.receivedMessages.length, 2);

  const second = provider.receivedMessages[1]!;
  const toolMsgs = second.filter((m) => m.role === 'tool');
  const assistantMsgs = second.filter((m) => m.role === 'assistant');

  // 关键断言：第二轮必须同时看到 assistant 的工具调用意图与工具结果
  assert.equal(assistantMsgs.length, 1, '第二轮应看到 assistant 的 tool_calls 意图');
  assert.equal(assistantMsgs[0]!.toolCalls?.[0]?.id, 'call_1');
  assert.equal(toolMsgs.length, 1, '第二轮应看到第一轮的工具结果');
  assert.equal(toolMsgs[0]!.toolCallId, 'call_1');
  assert.match(toolMsgs[0]!.content, /第一次/, '工具结果内容应被保留');
});

test('F-05: 多轮工具结果全部累积，不只是最后一轮', async () => {
  const provider = new ScriptedProvider([
    result({
      toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"v":"A"}' }],
      finishReason: 'tool_calls',
    }),
    result({
      toolCalls: [{ id: 'c2', name: 'echo', arguments: '{"v":"B"}' }],
      finishReason: 'tool_calls',
    }),
    result({ content: '完成', finishReason: 'stop' }),
  ]);

  await runAgent({
    provider,
    messages: [{ role: 'user', content: '开始' }],
    tools: [echoTool],
  });

  const third = provider.receivedMessages[2]!;
  const toolMsgs = third.filter((m) => m.role === 'tool');

  // 这是原伪代码会失败的地方：它只带最后一轮结果，toolMsgs 会是 1 条
  assert.equal(toolMsgs.length, 2, '第三轮应看到两轮的工具结果');
  assert.deepEqual(
    toolMsgs.map((m) => m.toolCallId),
    ['c1', 'c2'],
    '顺序应为 c1 → c2'
  );
});

// ============================================================
// P0-7：边界条件
// ============================================================

test('P0-7: 达到迭代上限时停止，并生成收尾回答而非抛错', async () => {
  // 每轮都请求工具，永不主动结束
  const forever = result({
    toolCalls: [{ id: 'cx', name: 'echo', arguments: '{"v":"x"}' }],
    finishReason: 'tool_calls',
  });

  // 脚本条目数必须与「迭代次数 + 1 次收尾调用」严格相等：
  // MAX_ITERATIONS=3 时，循环内 3 次 + 收尾 1 次 = 4 个条目。
  // 给多了会让收尾调用拿到错误的脚本项（这正是本测试第一版失败的原因）。
  const provider = new ScriptedProvider([
    structuredClone(forever),
    structuredClone(forever),
    structuredClone(forever),
    // 第 4 次调用：收尾
    result({ content: '基于已有信息作答', finishReason: 'stop' }),
  ]);

  const res = await runAgent({
    provider,
    messages: [{ role: 'user', content: '开始' }],
    tools: [echoTool],
    limits: { MAX_ITERATIONS: 3, MAX_TOOL_CALLS: 99, LOOP_TIMEOUT_MS: 60_000 },
  });

  assert.equal(res.truncatedBy, 'max_iterations');
  assert.equal(res.iterations, 3);
  assert.equal(res.content, '基于已有信息作答', '应生成收尾回答而不是抛错');
  assert.equal(provider.receivedMessages.length, 4, '3 轮循环 + 1 次收尾 = 4 次调用');
});

test('P0-7: 工具调用总数上限生效，且未执行的调用也有对应结果', async () => {
  const provider = new ScriptedProvider([
    result({
      toolCalls: [
        { id: 't1', name: 'echo', arguments: '{"v":"1"}' },
        { id: 't2', name: 'echo', arguments: '{"v":"2"}' },
        { id: 't3', name: 'echo', arguments: '{"v":"3"}' },
      ],
      finishReason: 'tool_calls',
    }),
    result({ content: '收尾', finishReason: 'stop' }),
  ]);

  const res = await runAgent({
    provider,
    messages: [{ role: 'user', content: '开始' }],
    tools: [echoTool],
    limits: { MAX_TOOL_CALLS: 2, MAX_ITERATIONS: 5, LOOP_TIMEOUT_MS: 60_000 },
  });

  assert.equal(res.toolCallsExecuted, 2, '只应执行 2 次');
  assert.equal(res.truncatedBy, 'max_tool_calls');

  // 每个 tool_call 都必须有对应的 role='tool' 消息，否则历史不完整、
  // 下一轮调用会被厂商拒绝
  const second = provider.receivedMessages[1]!;
  const toolMsgs = second.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 3, '三个调用都要有对应结果（含未执行的）');
  assert.match(toolMsgs[2]!.content, /上限/, '未执行的应有明确说明');
});

test('P0-7: 工具结果超长被截断并显式标注', async () => {
  const bigTool: ToolDefinition = {
    name: 'big',
    description: '返回超长结果',
    parameters: { type: 'object' },
    execute: async () => ({ data: 'x'.repeat(500) }),
  };

  const provider = new ScriptedProvider([
    result({
      toolCalls: [{ id: 'b1', name: 'big', arguments: '{}' }],
      finishReason: 'tool_calls',
    }),
    result({ content: '完成', finishReason: 'stop' }),
  ]);

  await runAgent({
    provider,
    messages: [{ role: 'user', content: '开始' }],
    tools: [bigTool],
    limits: { MAX_TOOL_RESULT_CHARS: 100 },
  });

  const toolMsg = provider.receivedMessages[1]!.find((m) => m.role === 'tool')!;
  assert.match(toolMsg.content, /已截断/, '截断必须有显式标注');
  assert.ok(toolMsg.content.length < 300, '截断后不应保留完整内容');
});

test('工具执行失败不中断循环，错误交给模型', async () => {
  const failing: ToolDefinition = {
    name: 'boom',
    description: '总是失败',
    parameters: { type: 'object' },
    execute: async () => {
      throw new Error('内部错误详情');
    },
  };

  const provider = new ScriptedProvider([
    result({
      toolCalls: [{ id: 'e1', name: 'boom', arguments: '{}' }],
      finishReason: 'tool_calls',
    }),
    result({ content: '工具失败了，我直接回答', finishReason: 'stop' }),
  ]);

  const res = await runAgent({
    provider,
    messages: [{ role: 'user', content: '开始' }],
    tools: [failing],
  });

  assert.equal(res.content, '工具失败了，我直接回答');
  const toolMsg = provider.receivedMessages[1]!.find((m) => m.role === 'tool')!;
  assert.match(toolMsg.content, /error/);
});

test('工具参数不是合法 JSON 时明确报错，不静默当作空对象', async () => {
  const provider = new ScriptedProvider([
    result({
      toolCalls: [{ id: 'j1', name: 'echo', arguments: '{坏掉的 json' }],
      finishReason: 'tool_calls',
    }),
    result({ content: '完成', finishReason: 'stop' }),
  ]);

  await runAgent({
    provider,
    messages: [{ role: 'user', content: '开始' }],
    tools: [echoTool],
  });

  const toolMsg = provider.receivedMessages[1]!.find((m) => m.role === 'tool')!;
  assert.match(toolMsg.content, /合法 JSON/, '应明确说明参数解析失败');
});

test('模型请求不存在的工具时明确回报', async () => {
  const provider = new ScriptedProvider([
    result({
      toolCalls: [{ id: 'n1', name: 'nonexistent', arguments: '{}' }],
      finishReason: 'tool_calls',
    }),
    result({ content: '完成', finishReason: 'stop' }),
  ]);

  await runAgent({
    provider,
    messages: [{ role: 'user', content: '开始' }],
    tools: [echoTool],
  });

  const toolMsg = provider.receivedMessages[1]!.find((m) => m.role === 'tool')!;
  assert.match(toolMsg.content, /不存在/);
});

test('不可重试的 LLM 错误直接抛出，不做无谓重试', async () => {
  let calls = 0;
  const provider: LLMProvider = {
    providerName: 'failing',
    defaultModel: 'm',
    async generate() {
      calls++;
      throw new LLMError('鉴权失败', { retryable: false, status: 401 });
    },
    // eslint-disable-next-line require-yield
    async *stream(): AsyncIterable<never> {
      throw new Error('unused');
    },
  };

  await assert.rejects(
    () => runAgent({ provider, messages: [{ role: 'user', content: 'x' }] }),
    /鉴权失败/
  );
  assert.equal(calls, 1, 'retryable=false 时不应重试');
});

test('usage 在多轮之间累加，便于成本核算', async () => {
  const provider = new ScriptedProvider([
    result({
      toolCalls: [{ id: 'u1', name: 'echo', arguments: '{}' }],
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0 },
      finishReason: 'tool_calls',
    }),
    result({
      content: '完成',
      usage: { inputTokens: 20, outputTokens: 8, reasoningTokens: 0 },
      finishReason: 'stop',
    }),
  ]);

  const res = await runAgent({
    provider,
    messages: [{ role: 'user', content: '开始' }],
    tools: [echoTool],
  });

  assert.deepEqual(res.usage, { inputTokens: 30, outputTokens: 13, reasoningTokens: 0 });
});

// ============================================================
// 流式路径（onToken）
// ============================================================

/**
 * 会真正产出 token 的假 Provider。
 *
 * ScriptedProvider 的 stream 直接抛错，覆盖不到 onToken 分支 ——
 * 而这是一个**独立代码路径**（走 provider.stream 而不是 generate），
 * 不测就等于没验证。SSE 端点是它唯一的生产用途。
 */
class StreamingProvider implements LLMProvider {
  readonly providerName = 'streaming';
  readonly defaultModel = 'streaming-model';

  constructor(
    private readonly script: { tokens: string[]; toolCalls?: LLMToolCall[] }[]
  ) {}

  generate(): Promise<LLMGenerateResult> {
    return Promise.reject(new Error('本测试只走 stream 路径'));
  }

  async *stream(): AsyncIterable<LLMStreamChunk> {
    const next = this.script.shift();
    if (!next) throw new Error('测试脚本已用尽，但 Loop 仍在调用 stream');

    for (const t of next.tokens) {
      yield { type: 'token', content: t };
    }

    yield {
      type: 'done',
      result: {
        content: next.tokens.join(''),
        toolCalls: next.toolCalls ?? [],
        usage: { inputTokens: 1, outputTokens: next.tokens.length, reasoningTokens: 0 },
        model: 'streaming-model',
        finishReason: next.toolCalls?.length ? 'tool_calls' : 'stop',
      },
    };
  }
}

test('onToken: 每个 token 按序回调，累积结果与一次性生成一致', async () => {
  const provider = new StreamingProvider([{ tokens: ['你', '好', '，', '世界'] }]);

  const received: string[] = [];
  const res = await runAgent({
    provider,
    messages: [{ role: 'user', content: '打个招呼' }],
    onToken: (t) => received.push(t),
  });

  assert.deepEqual(received, ['你', '好', '，', '世界'], '每个 token 都应按顺序回调');
  assert.equal(res.content, '你好，世界');
});

test('onToken: 多轮工具调用时，每一轮的 token 都被回调，且带轮次编号', async () => {
  const provider = new StreamingProvider([
    {
      tokens: ['让我查一下'],
      toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"v":"x"}' }],
    },
    { tokens: ['查到了'] },
  ]);

  const received: { token: string; turn: number }[] = [];
  const res = await runAgent({
    provider,
    messages: [{ role: 'user', content: '开始' }],
    tools: [echoTool],
    onToken: (token, turn) => received.push({ token, turn }),
  });

  /**
   * 轮次编号是给 SSE 层用的：第 1 轮的文字是「中间说明」
   * （模型当时打算调工具），不是给用户的答案。
   * 调用方靠 turn 判断哪些 token 属于最终回答。
   */
  assert.deepEqual(received, [
    { token: '让我查一下', turn: 1 },
    { token: '查到了', turn: 2 },
  ]);
  assert.equal(res.content, '查到了');
  assert.equal(res.toolCallsExecuted, 1);
});

test('onToken: 触达上限的收尾回答带 iterations+1 的轮次，可被识别', async () => {
  const forever: LLMToolCall[] = [{ id: 'cx', name: 'echo', arguments: '{"v":"x"}' }];
  const provider = new StreamingProvider([
    { tokens: ['第1轮'], toolCalls: structuredClone(forever) },
    { tokens: ['第2轮'], toolCalls: structuredClone(forever) },
    { tokens: ['收尾回答'] },
  ]);

  const turns = new Map<string, number>();
  const res = await runAgent({
    provider,
    messages: [{ role: 'user', content: '开始' }],
    tools: [echoTool],
    limits: { MAX_ITERATIONS: 2, MAX_TOOL_CALLS: 99, LOOP_TIMEOUT_MS: 60_000 },
    onToken: (token, turn) => turns.set(token, turn),
  });

  assert.equal(res.truncatedBy, 'max_iterations');
  assert.equal(turns.get('第1轮'), 1);
  assert.equal(turns.get('第2轮'), 2);
  assert.equal(turns.get('收尾回答'), 3, '收尾轮应为 iterations+1，从而与循环内的轮次区分开');
});

test('usage.reasoningTokens 在多轮之间也被累加', async () => {
  const provider = new ScriptedProvider([
    result({
      toolCalls: [{ id: 'r1', name: 'echo', arguments: '{}' }],
      usage: { inputTokens: 10, outputTokens: 100, reasoningTokens: 90 },
      finishReason: 'tool_calls',
    }),
    result({
      content: '完成',
      usage: { inputTokens: 20, outputTokens: 30, reasoningTokens: 25 },
      finishReason: 'stop',
    }),
  ]);

  const res = await runAgent({
    provider,
    messages: [{ role: 'user', content: '开始' }],
    tools: [echoTool],
  });

  // 推理开销在多轮里同样发生，漏加会让「回答很短却花了大量 token」无法解释
  assert.equal(res.usage.reasoningTokens, 115);
  assert.equal(res.usage.outputTokens, 130);
});

test('onToken: 不传 onToken 时仍走 generate，不误用 stream', async () => {
  // ScriptedProvider 的 stream 会抛错，因此这里能跑通即证明走的是 generate
  const provider = new ScriptedProvider([result({ content: '一次性', finishReason: 'stop' })]);

  const res = await runAgent({
    provider,
    messages: [{ role: 'user', content: 'x' }],
  });

  assert.equal(res.content, '一次性');
});

test('onToken: 流里的 error 块转成 LLMError，并保留 retryable 标记', async () => {
  const provider: LLMProvider = {
    providerName: 'failing-stream',
    defaultModel: 'm',
    generate: () => Promise.reject(new Error('unused')),
    async *stream(): AsyncIterable<LLMStreamChunk> {
      yield { type: 'token', content: '部分' };
      yield { type: 'error', error: '流中断了', retryable: false };
    },
  };

  await assert.rejects(
    () =>
      runAgent({
        provider,
        messages: [{ role: 'user', content: 'x' }],
        onToken: () => undefined,
      }),
    (err: unknown) => err instanceof LLMError && err.options.retryable === false
  );
});

test('onToken: 流没有 done 块就结束 → 视为可重试错误，而不是当成空回答', async () => {
  const provider: LLMProvider = {
    providerName: 'no-done',
    defaultModel: 'm',
    generate: () => Promise.reject(new Error('unused')),
    async *stream(): AsyncIterable<LLMStreamChunk> {
      yield { type: 'token', content: '只有内容没有收尾' };
    },
  };

  await assert.rejects(
    () =>
      runAgent({
        provider,
        messages: [{ role: 'user', content: 'x' }],
        onToken: () => undefined,
      }),
    /没有 done 块/
  );
});
