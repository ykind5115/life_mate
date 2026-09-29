/**
 * 执行轨迹的落库验证（docs/13 §6.1 的 P0）
 *
 * 【它回答的问题】
 *   2026-09-29 那次幻觉排查的结论是：**故障恰好发生在唯一没有记录的那一步**。
 *   于是补了执行轨迹（工具调用、注入的记忆、检索诊断…）。
 *   但「代码写了」不等于「真的落库了」——
 *   这个文件走**真实的 HTTP → ChatService → 数据库**链路，
 *   回头从库里把 metadata 读出来核对。
 *
 * 【为什么必须从库里读回来，而不是相信内存里的对象】
 *   轨迹要经过：组装 → Zod 校验 → appendMessage → JSONB 序列化。
 *   任何一步出问题（比如校验把整个 trace 丢掉、或 jsonb 丢了嵌套键），
 *   内存里的对象都看不出异常 —— 只有读回来才知道。
 *   而「校验失败时放弃轨迹」这个降级路径**本身就该被测**。
 *
 * 【为什么不真调 LLM】
 *   用假 Provider：轨迹的内容与模型无关（模型名、token、工具调用
 *   都由我们喂的数据决定），而真调一次要花钱、还不确定。
 *   真实链路（HTTP + 服务 + 数据库）已经全部覆盖到了。
 *
 * 前置：pnpm test（脚本已指定 .env.test → lifemate_test）
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

import { closePool, db } from '../database/client.js';
import { messages } from '../database/schema/messages.js';
import { safeParseMessageMetadata } from '../database/schema/message-metadata.js';
import { conversations } from '../database/schema/conversations.js';
import { assertTestDatabase } from '../shared/test-guard.js';
import { emptyDiagnostics } from '../memory/extraction-schema.js';
import { buildServer } from './server.js';
import { IdempotencyStore } from './idempotency.js';
import { ExtractionTrigger } from '../conversation/extraction-trigger.js';
import type { GenerateInput, LLMProvider } from '../llm/provider.js';
import type { LLMGenerateResult, LLMStreamChunk } from '../llm/types.js';
import { eq } from 'drizzle-orm';

after(async () => {
  await closePool();
});

// ============================================================
// 夹具
// ============================================================

/**
 * 假 Provider：第一次回答**请求一个工具**，第二次给出最终回答。
 *
 * 为什么要两轮：轨迹里最有价值的部分就是工具调用，
 * 而单轮回答产生不了 —— 那正是本次要验证的东西。
 */
class ToolThenAnswerProvider implements LLMProvider {
  readonly providerName = 'trace-test-provider';
  readonly defaultModel = 'trace-test-model';
  readonly received: GenerateInput[] = [];

  generate(input: GenerateInput): Promise<LLMGenerateResult> {
    this.received.push(input);

    const alreadyCalledTool = input.messages.some((m) => m.role === 'tool');

    if (!alreadyCalledTool) {
      return Promise.resolve({
        content: '',
        toolCalls: [
          {
            id: 'call_1',
            name: 'search_memory',
            arguments: JSON.stringify({ query: '这是一段不该进 metadata 的查询词' }),
          },
        ],
        usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 5 },
        model: 'trace-test-model',
        finishReason: 'tool_calls',
      });
    }

    return Promise.resolve({
      content: '这是最终回答。',
      toolCalls: [],
      usage: { inputTokens: 150, outputTokens: 30, reasoningTokens: 7 },
      model: 'trace-test-model',
      finishReason: 'stop',
    });
  }

  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<LLMStreamChunk> {
    throw new Error('本测试不使用流式');
  }
}

function inertTrigger(): ExtractionTrigger {
  return new ExtractionTrigger({
    run: async () => ({
      executed: false as const,
      skippedReason: 'no_new_messages' as const,
      candidatesFound: 0,
      diagnostics: emptyDiagnostics(),
      outcomes: { created: 0, merged: 0, superseded: 0, conflict: 0 },
      events: { created: 0, skippedDuplicates: 0 },
      adjudicationCalls: 0,
      embeddings: { succeeded: 0, failed: 0 },
      memoriesWithoutEmbedding: [],
    }),
  });
}

/** 基准行数：断言用增量，不用绝对值（AGENTS.md §4.4 的教训） */
async function messageCount(): Promise<number> {
  const rows = await db.select({ id: messages.id }).from(messages);
  return rows.length;
}

function req(app: FastifyInstance, opts: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject(opts);
}

// ============================================================
// 用例
// ============================================================

test('助手消息的 metadata 里真的落下了执行轨迹', async () => {
  assertTestDatabase('trace-routes.test.ts');

  const app = await buildServer({
    logLevel: 'silent',
    provider: new ToolThenAnswerProvider(),
    chatIdempotency: new IdempotencyStore(),
    extractionTrigger: inertTrigger(),
    retrieveMemories: null,
    titleTrigger: null,
  });

  const before = await messageCount();

  try {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/chat',
      payload: { message: '轨迹验证用的提问' },
    });
    assert.equal(res.statusCode, 200);

    const conversationId = res.json().data.conversation.id as string;

    // ---------- 从库里读回来（不是相信内存对象）----------
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));

    const assistant = rows.find((m) => m.role === 'assistant');
    assert.ok(assistant, '应当写下一条助手消息');

    /**
     * 用宽松解析：schema 会演进，测试不该因为「多了个可选字段」而挂。
     * 但 problem 必须为空 —— 它非空说明**结构不合白名单**，
     * 而那正是我们要防的（会走「放弃轨迹」的降级路径）。
     */
    const { data, problem } = safeParseMessageMetadata(assistant.metadata);
    assert.equal(problem, undefined, `metadata 不合白名单：${problem}`);

    const trace = data.agent;
    assert.ok(trace, 'metadata.agent 必须存在 —— 否则整条轨迹没落库');

    // ① 提示词版本：排查「它怎么突然变这样」时第一个要看的
    assert.equal(typeof trace.promptVersion, 'string');

    // ② 模型与结束原因
    assert.equal(trace.model, 'trace-test-model');
    assert.equal(trace.finishReason, 'stop');

    // ③ 迭代与用量
    assert.equal(trace.iterations, 2, '第一轮请求工具，第二轮收尾');
    assert.equal(trace.toolCallsExecuted, 1);
    assert.deepEqual(trace.usage, {
      inputTokens: 250,
      outputTokens: 50,
      reasoningTokens: 12,
    });

    // ④ 耗时存在且是数字
    assert.equal(typeof trace.timingsMs?.['agentTotal'], 'number');

    // ⑤ 上下文规模
    assert.equal(typeof trace.context?.approxTokens, 'number');
    assert.equal(trace.context?.timezone, 'Asia/Shanghai');

    // ⑥ 检索：本用例显式关掉了检索，必须如实记录「没检索」而不是留空
    assert.equal(trace.retrieval?.performed, false);
    assert.equal(trace.retrieval?.skippedReason, 'not_implemented');

    // ⑦ 工具调用 —— 本次改动的核心
    assert.equal(trace.toolCalls?.length, 1, '必须记下那次工具调用');
    const tool = trace.toolCalls![0]!;
    assert.equal(tool.name, 'search_memory');
    assert.deepEqual(tool.argumentKeys, ['query'], '只记参数键名');
    assert.equal(typeof tool.resultChars, 'number');
    assert.equal(typeof tool.ms, 'number');

    // ⑧ 与请求关联
    assert.equal(typeof trace.requestId, 'string');

    // ⑨ 回答字符数（不存正文，但要有长度）
    assert.equal(trace.answerChars, '这是最终回答。'.length);
  } finally {
    await app.close();
  }

  const afterCount = await messageCount();
  assert.equal(afterCount - before, 2, '一次对话应恰好新增 user + assistant 两条');
});

test('🔴 轨迹里不含任何正文 —— 工具参数值、消息内容都不许出现', async () => {
  /**
   * 这个用例守的是 docs/03 §16.2「不得存任何级别的敏感正文副本」。
   *
   * 为什么是硬要求而不是「最好别」：
   *   metadata 是 JSONB，会被导出、会被我写诊断脚本打印。
   *   一旦正文进去，就多了一个不受消息表删除策略约束的副本
   *   （删消息是物理删除，但 metadata 里的副本不跟着走）。
   */
  assertTestDatabase('trace-routes.test.ts');

  const app = await buildServer({
    logLevel: 'silent',
    provider: new ToolThenAnswerProvider(),
    chatIdempotency: new IdempotencyStore(),
    extractionTrigger: inertTrigger(),
    retrieveMemories: null,
    titleTrigger: null,
  });

  /** 特意用独一无二的字符串，避免误判 */
  const secretQuery = '这是一段不该进 metadata 的查询词';
  const userText = '轨迹验证用的提问';

  try {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/chat',
      payload: { message: userText },
    });
    const conversationId = res.json().data.conversation.id as string;

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId));

    const assistant = rows.find((m) => m.role === 'assistant')!;
    const serialized = JSON.stringify(assistant.metadata);

    assert.ok(
      !serialized.includes(secretQuery),
      '工具参数的【值】不得进入 metadata —— 那往往就是用户原话'
    );
    assert.ok(!serialized.includes(userText), '用户消息正文不得进入 metadata');
    assert.ok(!serialized.includes('这是最终回答'), '助手回答正文不得进入 metadata');
  } finally {
    await app.close();
  }
});

test('metadata 白名单之外的键会被拒绝（§16.3 的白名单模式）', async () => {
  /**
   * §16.3 要求「白名单模式（只允许已知键），不是黑名单过滤」。
   *
   * ⚠️ 刻意**抛错而不是静默丢弃**：静默丢弃会让「我明明写了怎么查不到」
   *    变成一个新的谜题。抛错则在写入的那一行就炸，定位成本最低。
   *
   * ⚠️ 关于数据隔离：这个用例直连库（不像上面两个走 HTTP），
   *    因此按 AGENTS.md §4.4.1 用 resolveTestUser 取**测试用户**
   *    （它会断言名字不是 'me'），并在 finally 里清掉自己造的两行。
   */
  assertTestDatabase('trace-routes.test.ts');

  const { appendMessage, createConversation } = await import(
    '../database/repository/conversation-store.js'
  );
  const { resolveTestUser } = await import('../database/repository/_test-helpers.js');

  const user = await resolveTestUser('trace-routes.test.ts');
  const conv = await createConversation({ userId: user.id, title: '【测试】白名单' });

  try {
    await assert.rejects(
      () =>
        appendMessage({
          conversationId: conv.id,
          role: 'assistant',
          content: 'x',
          metadata: {
            agent: { model: 'm' },
            // @ts-expect-error 故意传白名单之外的键，验证运行时也会被拒
            正文: '不该被接受',
          },
        }),
      /Unrecognized key|正文/,
      '白名单之外的键必须报错'
    );

    /**
     * 校验发生**在插入之前**，因此不该留下任何行。
     * 断言它，是为了防止将来有人把校验挪到「插入之后再去掉」的写法 ——
     * 那会让一次被拒绝的写入也产生副作用。
     */
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    assert.equal(rows.length, 0, '被拒绝的写入不该留下任何消息行');
  } finally {
    await db.delete(messages).where(eq(messages.conversationId, conv.id));
    await db.delete(conversations).where(eq(conversations.id, conv.id));
  }
});
