/**
 * HTTP 层集成测试
 *
 * 用 Fastify 的 inject() 直接打请求，不占端口、不起真实网络。
 *
 * 【为什么必须写这组测试】
 *   实测踩到：不存在的会话返回了 **500 INTERNAL_ERROR** 而不是 404 ——
 *   因为 chat-service 抛的业务错误类型没有在 mapError 里映射。
 *   这类缺陷在手动 curl 时很容易被忽略，只有断言过才会被记住。
 *   因此本文件的核心价值是**锁住错误码映射**，不是走一遍 happy path。
 *
 * 【LLM 用假 Provider】
 *   真调模型会让测试既慢又不稳定（而且花钱）。
 *   假 Provider 返回固定文本，断言的是**我们的协议层**，不是模型质量。
 *
 * 前置：docker compose up -d postgres
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { LightMyRequestResponse } from 'fastify';

import { closePool, db } from '../database/client.js';
import { eq } from 'drizzle-orm';
import { conversations } from '../database/schema/conversations.js';
import { resolveTestUser } from '../database/repository/_test-helpers.js';
import { assertTestDatabase } from '../shared/test-guard.js';
import { emptyDiagnostics } from '../memory/extraction-schema.js';
import { buildServer } from './server.js';
import { IdempotencyStore } from './idempotency.js';
import type { ChatRouteDeps } from './routes/chat.js';
import { ExtractionTrigger } from '../conversation/extraction-trigger.js';
import type { GenerateInput, LLMProvider } from '../llm/provider.js';
import { LLMError } from '../llm/provider.js';
import type { LLMGenerateResult, LLMStreamChunk } from '../llm/types.js';

after(async () => {
  await closePool();
});

// ============================================================
// 测试用假 Provider
// ============================================================

/** 固定回答的假 Provider。记录了它收到的输入，便于断言上下文组装 */
class FakeProvider implements LLMProvider {
  readonly providerName = 'fake';
  readonly defaultModel = 'fake-model';
  readonly received: GenerateInput[] = [];

  constructor(
    private readonly answer = '这是测试回答。',
    private readonly failure?: LLMError
  ) {}

  async generate(input: GenerateInput): Promise<LLMGenerateResult> {
    this.received.push(input);
    if (this.failure) throw this.failure;

    return {
      content: this.answer,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3 },
      model: 'fake-model',
      finishReason: 'stop',
    };
  }

  async *stream(input: GenerateInput): AsyncIterable<LLMStreamChunk> {
    this.received.push(input);
    if (this.failure) {
      yield { type: 'error', error: this.failure.message, retryable: this.failure.options.retryable };
      return;
    }

    // 按字符切分，模拟逐 token 输出
    for (const ch of this.answer) {
      yield { type: 'token', content: ch };
    }
    yield {
      type: 'done',
      result: {
        content: this.answer,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: this.answer.length, reasoningTokens: 3 },
        model: 'fake-model',
        finishReason: 'stop',
      },
    };
  }
}

/** 不触发任何真实抽取的触发器 */
function inertTrigger(): ExtractionTrigger {
  return new ExtractionTrigger({ run: async () => emptySummary() });
}

function emptySummary() {
  return {
    executed: false as const,
    skippedReason: 'no_new_messages' as const,
    candidatesFound: 0,
    // 用共享的空诊断构造函数：ExtractionDiagnostics 加字段时只需改一处
    diagnostics: emptyDiagnostics(),
    outcomes: { created: 0, merged: 0, superseded: 0, conflict: 0 },
    events: { created: 0, skippedDuplicates: 0 },
    adjudicationCalls: 0,
    embeddings: { succeeded: 0, failed: 0 },
    memoriesWithoutEmbedding: [],
  };
}

/**
 * 建一个测试服务器。
 *
 * ⚠️ 每个用例**必须** new 一个 IdempotencyStore：
 *    缺省是模块级单例，用例之间会串（上一个用例的键会命中下一个用例）。
 *
 * ⚠️ retrieveMemories 缺省传 null（显式关闭检索）。
 *    不关掉的话每个用例都会去连 embedding 服务、并读库里**其他用例留下的**
 *    真实记忆，断言就依赖了外部状态与执行顺序。
 *    要测检索接线请显式传一个函数。
 */
async function withServer(
  fn: (ctx: { app: FastifyInstance; provider: FakeProvider }) => Promise<void>,
  options: {
    answer?: string;
    failure?: LLMError;
    retrieveMemories?: ChatRouteDeps['retrieveMemories'];
    /**
     * 是否启用标题生成。缺省**关闭**。
     *
     * ⚠️ 与摘要触发器不同，标题没有天然的省钱机制 ——
     *    摘要要满 30 条才动手，标题首轮就会真的去生成。
     *    绝大多数用例不关心标题，开着只会多两条查询、
     *    并在输出里刷出无关的 [title] 日志（实测过一轮，噪声很明显）。
     *    关心标题的用例显式传 true。
     */
    title?: boolean;
  } = {}
): Promise<void> {
  /**
   * ⚠️ 这些用例会**写库**（聊天会落会话与消息）。
   *    必须连测试库 —— 2026-09-23 实测踩到：测试跑在开发库上，
   *    除了污染数据，还积累了 300 多个测试会话。
   */
  assertTestDatabase('server.test.ts / withServer');

  /**
   * 清掉上一个用例留下的会话，做**真正的用例隔离**。
   *
   * ⚠️ 为什么必须清（2026-10-08 加了跨会话衔接之后才暴露）：
   *    本夹具此前从不清理会话，会话于是在测试库里累积。
   *    跨会话衔接会把「2 小时内最后说话的那个会话」注入新会话 ——
   *    于是每个用例的第一轮都接上了上一个用例的会话，
   *    断言「上下文只有 system + user」的用例开始失败，
   *    而且**只在全量跑时失败**（单跑该文件时前面的用例恰好不满足条件）。
   *
   *    这类「顺序依赖」在 AGENTS.md §4.5 已记为踩过的坑，
   *    这里是同一个坑的第三种形态。
   *
   * 只删当前测试用户名下的会话（测试用户是 test-agent，见 §4.4.1）。
   * 消息没有 deleted_at、靠外键级联删除。
   */
  const user = await resolveTestUser('server.test.ts / withServer');
  await db.delete(conversations).where(eq(conversations.userId, user.id));

  const provider = new FakeProvider(options.answer ?? '这是测试回答。', options.failure);
  const app = await buildServer({
    logLevel: 'silent',
    provider,
    chatIdempotency: new IdempotencyStore(),
    extractionTrigger: inertTrigger(),
    retrieveMemories: options.retrieveMemories ?? null,
    titleTrigger: options.title ? undefined : null,
  });

  try {
    await fn({ app, provider });
  } finally {
    // 不 closePool：池是进程级单例，一个用例关掉会让后面的用例全挂
    await app.close();
  }
}

/** 发一个 POST JSON 请求 */
function postJson(
  app: FastifyInstance,
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url,
    payload: body as Record<string, unknown>,
    headers,
  });
}

// ============================================================
// 响应契约（docs/04 §4）
// ============================================================

test('GET /health 返回统一成功结构', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { success: true, data: { status: 'ok' } });
  });
});

test('未知路由返回统一的 404 结构而不是 Fastify 默认格式', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    assert.equal(res.statusCode, 404);

    const body = res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'NOT_FOUND');
    // Fastify 默认返回 { statusCode, error, message }，那不符合 docs/04 §4
    assert.equal(body.statusCode, undefined);
  });
});

test('每个响应都带 X-Request-Id 与 no-store（docs/04 §42、§49）', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.match(res.headers['x-request-id'] as string, /^req_/);
    assert.equal(res.headers['cache-control'], 'no-store');
  });
});

// ============================================================
// Chat 正常路径
// ============================================================

test('POST /chat 返回会话与两条消息，并把模型回答原样落库', async () => {
  await withServer(
    async ({ app }) => {
      const res = await postJson(app, '/api/v1/chat', { message: '你好' });
      assert.equal(res.statusCode, 200);

      const { data } = res.json();
      assert.equal(data.conversation.created, true);
      assert.equal(data.userMessage.content, '你好');
      assert.equal(data.userMessage.sequence, 1);
      assert.equal(data.assistantMessage.content, '这是测试回答。');
      assert.equal(data.assistantMessage.sequence, 2);

      // 列表能查到这次会话
      const list = await app.inject({ method: 'GET', url: '/api/v1/conversations' });
      const items = list.json().data.items as { id: string }[];
      assert.ok(items.some((c) => c.id === data.conversation.id));
    },
    { answer: '这是测试回答。' }
  );
});

test('第二轮请求带上 conversation_id 时会复用同一会话，序号继续递增', async () => {
  await withServer(async ({ app }) => {
    const first = await postJson(app, '/api/v1/chat', { message: '第一句' });
    const conversationId = first.json().data.conversation.id;

    const second = await postJson(app, '/api/v1/chat', {
      conversation_id: conversationId,
      message: '第二句',
    });

    const data = second.json().data;
    assert.equal(data.conversation.id, conversationId);
    assert.equal(data.conversation.created, false, '不应新建会话');
    assert.equal(data.userMessage.sequence, 3);
    assert.equal(data.assistantMessage.sequence, 4);
  });
});

// ============================================================
// 会话标题（docs/12 §方案 2，对应 docs/11 反馈 4）
// ============================================================

test('首轮对话立刻写入占位标题 —— 列表在任何时刻都有东西可显示', async () => {
  await withServer(async ({ app }) => {
    const res = await postJson(app, '/api/v1/chat', { message: '帮我看看这个简历' });

    // 响应里就带着标题（不等到后台生成）
    assert.equal(res.json().data.conversation.title, '帮我看看这个简历');

    const list = await app.inject({ method: 'GET', url: '/api/v1/conversations' });
    const items = list.json().data.items as { id: string; title: string | null }[];
    const created = items.find((c) => c.id === res.json().data.conversation.id);
    assert.equal(created?.title, '帮我看看这个简历');
  });
});

test('占位标题是首条消息的截断，超长也不会把列表撑破', async () => {
  await withServer(async ({ app }) => {
    const res = await postJson(app, '/api/v1/chat', {
      message: '早上好呀，你知道现在是什么时间吗，你知道我是谁吗？',
    });

    const title = res.json().data.conversation.title as string;
    assert.ok(title.endsWith('…'), '超长标题应被截断');
    assert.ok(title.length <= 21);
  });
});

test('后台标题生成把占位标题换成正式标题（含清洗）', async () => {
  await withServer(
    async ({ app }) => {
      const res = await postJson(app, '/api/v1/chat', { message: '聊聊我的运维工作' });
      const conversationId = res.json().data.conversation.id;

      /**
       * 标题生成是 fire-and-forget（在响应之后）。
       * 默认触发器是进程单例，测试无法直接 await 它的 idle()，
       * 因此这里轮询数据库直到标题变化 —— 比 sleep 一个固定值可靠。
       */
      let title: string | null = null;
      for (let i = 0; i < 50; i++) {
        const detail = await app.inject({
          method: 'GET',
          url: `/api/v1/conversations/${conversationId}`,
        });
        title = detail.json().data.title;
        if (title !== '聊聊我的运维工作') break;
        await new Promise((r) => setTimeout(r, 20));
      }

      // 假 Provider 返回的是 answer，清洗后就是它（去掉了句末的句号）
      assert.equal(title, '这是测试回答');
    },
    { answer: '这是测试回答。', title: true }
  );
});

test('已有正式标题时不会重复生成（第二轮不该再调 LLM 起标题）', async () => {
  await withServer(
    async ({ app, provider }) => {
      const first = await postJson(app, '/api/v1/chat', { message: '第一句' });
      const conversationId = first.json().data.conversation.id;

      // 等第一轮的标题生成落库
      for (let i = 0; i < 50; i++) {
        const detail = await app.inject({
          method: 'GET',
          url: `/api/v1/conversations/${conversationId}`,
        });
        if (detail.json().data.title !== '第一句') break;
        await new Promise((r) => setTimeout(r, 20));
      }

      const callsAfterFirst = provider.received.length;

      await postJson(app, '/api/v1/chat', { conversation_id: conversationId, message: '第二句' });
      // 给后台任务一点时间（若它真的调了 LLM，这里就能看出来）
      await new Promise((r) => setTimeout(r, 150));

      assert.equal(
        provider.received.length,
        callsAfterFirst + 1,
        '第二轮只该调一次 LLM（对话本身），不该再调一次起标题'
      );
    },
    { title: true }
  );
});

test('上下文里包含近期历史（短期上下文，docs/02 §23）', async () => {
  await withServer(async ({ app, provider }) => {
    const first = await postJson(app, '/api/v1/chat', { message: '我叫阿康' });
    const conversationId = first.json().data.conversation.id;

    await postJson(app, '/api/v1/chat', {
      conversation_id: conversationId,
      message: '我刚才说了什么',
    });

    /**
     * 第二次调用的 messages：
     *   system(规则 + 当前时间) + 历史(user,assistant) + 当前 user
     *
     * ⚠️ 两条历史消息在同一事务里写入，created_at 完全相同，
     *    因此它们之间不会插时间标记 —— 标记只出现在第一条历史消息之前
     *    （作为锚点）。断言按「非 system 消息的形状」写，
     *    这样即使将来阈值调整也不会因为这个用例假失败。
     */
    const secondCall = provider.received.at(-1)!;
    const nonSystem = secondCall.messages.filter((m) => m.role !== 'system');
    assert.deepEqual(
      nonSystem.map((m) => m.role),
      ['user', 'assistant', 'user']
    );

    const contents = secondCall.messages.map((m) => m.content);
    assert.ok(contents.includes('我叫阿康'), '历史里的用户消息应进入上下文');
    assert.equal(contents.at(-1), '我刚才说了什么');

    /**
     * 关键断言：当前消息**只能出现一次**。
     *
     * 它同时也已经落库，读历史时必然读到它；若组装时再追加一次，
     * 模型会看到同一句话连说两遍（实测踩到过，表现为反复追问同一件事）。
     */
    assert.equal(
      contents.filter((c) => c === '我刚才说了什么').length,
      1,
      '当前消息在上下文里只能出现一次'
    );

    // 系统提示在最前，且带上了「现在」——docs/12 §方案 1（反馈 1.2 / 5）
    assert.equal(secondCall.messages[0]!.role, 'system');
    assert.match(secondCall.messages[0]!.content, /当前时间/, '系统提示必须给出当前时间');
  });
});

// ============================================================
// Chat 错误路径（本文件的核心价值）
// ============================================================

test('消息为空 → 422 VALIDATION_ERROR', async () => {
  await withServer(async ({ app }) => {
    const res = await postJson(app, '/api/v1/chat', { message: '' });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  });
});

test('消息只有空白字符 → 422', async () => {
  await withServer(async ({ app }) => {
    const res = await postJson(app, '/api/v1/chat', { message: '   \n\t ' });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  });
});

test('conversation_id 不是 UUID → 422', async () => {
  await withServer(async ({ app }) => {
    const res = await postJson(app, '/api/v1/chat', {
      conversation_id: 'not-a-uuid',
      message: 'hi',
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  });
});

test('会话不存在 → 404 NOT_FOUND（曾经的缺陷：返回了 500）', async () => {
  await withServer(async ({ app }) => {
    const res = await postJson(app, '/api/v1/chat', {
      conversation_id: '00000000-0000-4000-8000-000000000000',
      message: 'hi',
    });

    assert.equal(res.statusCode, 404, '业务错误没被映射时会掉进 500 分支');
    assert.equal(res.json().error.code, 'NOT_FOUND');
  });
});

test('向已删除的会话发消息 → 409 CONFLICT', async () => {
  await withServer(async ({ app }) => {
    // 先正常聊一句，把会话真正建出来
    // （新会话是延迟落库的：LLM 失败时不该留下空会话）
    const created = await postJson(app, '/api/v1/chat', { message: '先建一个会话' });
    const conversationId = created.json().data.conversation.id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/conversations/${conversationId}`,
    });
    assert.equal(del.statusCode, 200);

    const res = await postJson(app, '/api/v1/chat', {
      conversation_id: conversationId,
      message: '还能说话吗',
    });

    // 409 而不是 404：会话存在，但状态不允许这个操作
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'CONFLICT');
  });
});

test('向不存在的会话发消息 → 404（与 409 区分开）', async () => {
  await withServer(async ({ app }) => {
    const res = await postJson(app, '/api/v1/chat', {
      conversation_id: '00000000-0000-4000-8000-000000000001',
      message: '这个会话根本没建过',
    });

    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'NOT_FOUND');
  });
});

test('LLM 不可重试错误 → 502 LLM_ERROR，且不透出供应商原文', async () => {
  await withServer(
    async ({ app }) => {
      const res = await postJson(app, '/api/v1/chat', { message: 'hi' });

      assert.equal(res.statusCode, 502);
      const body = res.json();
      assert.equal(body.error.code, 'LLM_ERROR');

      // docs/04 §44：不向用户暴露 Provider 内部错误
      const text = JSON.stringify(body);
      assert.doesNotMatch(text, /sk-/, '不应出现密钥');
      assert.doesNotMatch(text, /api\.deepseek\.com/, '不应出现内部地址');
      assert.doesNotMatch(text, /供应商内部细节/, '不应出现上游错误原文');
    },
    {
      failure: new LLMError('供应商内部细节：请求 https://api.deepseek.com 时 401，key=sk-xxx', {
        retryable: false,
        status: 401,
      }),
    }
  );
});

test('LLM 可重试错误 → 503 SERVICE_UNAVAILABLE', async () => {
  await withServer(
    async ({ app }) => {
      const res = await postJson(app, '/api/v1/chat', { message: 'hi' });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().error.code, 'SERVICE_UNAVAILABLE');
    },
    { failure: new LLMError('上游 503', { retryable: true, status: 503 }) }
  );
});

test('LLM 失败时不留下半条对话（不建空会话、不写孤儿消息）', async () => {
  await withServer(
    async ({ app }) => {
      const before = await app.inject({ method: 'GET', url: '/api/v1/conversations?page_size=100' });
      const beforeIds = new Set(
        (before.json().data.items as { id: string }[]).map((c) => c.id)
      );
      const beforeTotal = before.json().data.pagination.total as number;

      const res = await postJson(app, '/api/v1/chat', { message: '这条会失败' });
      assert.equal(res.statusCode, 502);

      /**
       * 断言「增量」而不是「总数为 0」：库是跨用例共享的，
       * 前面用例建的会话仍在里面。断言绝对值会让这条测试
       * 依赖执行顺序，早晚会以难以理解的方式失败。
       */
      const after = await app.inject({ method: 'GET', url: '/api/v1/conversations?page_size=100' });
      const afterItems = after.json().data.items as { id: string }[];
      const afterTotal = after.json().data.pagination.total as number;

      assert.equal(afterTotal, beforeTotal, '失败的请求不应新增会话');
      assert.deepEqual(
        afterItems.filter((c) => !beforeIds.has(c.id)),
        [],
        '不应出现新会话'
      );
    },
    { failure: new LLMError('boom', { retryable: false }) }
  );
});

// ============================================================
// 幂等（docs/04 §46）
// ============================================================

test('同一 Idempotency-Key 重复提交只落一条消息，第二次标记为重放', async () => {
  await withServer(async ({ app }) => {
    const headers = { 'idempotency-key': 'test-key-1' };
    const body = { message: '只应该被记一次' };

    const first = await postJson(app, '/api/v1/chat', body, headers);
    const second = await postJson(app, '/api/v1/chat', body, headers);

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.headers['idempotency-replayed'], undefined);
    assert.equal(second.headers['idempotency-replayed'], 'true');

    // 关键断言：两次返回的是**同一条**消息，而不是两条内容相同的新消息
    assert.equal(second.json().data.userMessage.id, first.json().data.userMessage.id);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${first.json().data.conversation.id}/messages`,
    });
    assert.equal(detail.json().data.pagination.total, 2, '应只有 user + assistant 两条');
  });
});

test('同一 Idempotency-Key 用于不同内容 → 409，不静默返回旧结果', async () => {
  await withServer(async ({ app }) => {
    const headers = { 'idempotency-key': 'test-key-2' };

    // 第一次必须是**成功**的：失败会清掉幂等记录（允许客户端用同一个键重试），
    // 那就测不到「键被复用于不同内容」这条路径了
    const first = await postJson(app, '/api/v1/chat', { message: '第一条' }, headers);
    assert.equal(first.statusCode, 200);

    const second = await postJson(app, '/api/v1/chat', { message: '完全不同的第二条' }, headers);

    /**
     * 静默返回第一条的内容会让用户以为第二条发出去了 ——
     * 这比报错更糟。因此必须是 409。
     */
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error.code, 'CONFLICT');
  });
});

test('非法 Idempotency-Key 头被忽略而不是报错（视为无键）', async () => {
  await withServer(async ({ app }) => {
    const res = await postJson(
      app,
      '/api/v1/chat',
      { message: '带非法键' },
      { 'idempotency-key': '带中文 和 空格 的键' }
    );

    // 键非法 → 退化为不做幂等，但请求本身应当成功
    assert.equal(res.statusCode, 200);
  });
});

test('检索到的记忆被注入到上下文（system 段落），且当前消息仍在最后', async () => {
  await withServer(
    async ({ app, provider }) => {
      await postJson(app, '/api/v1/chat', { message: '我最近怎么样' });

      const call = provider.received.at(-1)!;

      // 结构：system(规则) + system(你记得的事) + user(当前消息)
      assert.equal(call.messages[0]!.role, 'system');
      assert.equal(call.messages[1]!.role, 'system');
      assert.match(call.messages[1]!.content, /你记得的关于对方的事/, '第二条 system 应是记忆段落');
      assert.match(call.messages[1]!.content, /用户正在学习 Rust/, '记忆正文应出现在上下文里');
      assert.match(call.messages[1]!.content, /2026-01-15/, '应带事实生效日期，供模型正确表述');
      assert.equal(call.messages.at(-1)!.content, '我最近怎么样');

      /**
       * docs/11 反馈 1：不能把机制端到对方面前。
       * 上下文里出现的机制词汇会被模型照着复述，因此这里断言它们不出现。
       * 注意只查**记忆段落**：系统提示词正文里「记忆」是规则用语，
       * 那是给模型看的，不会被复述成「我翻了长期记忆」。
       */
      assert.doesNotMatch(
        call.messages[1]!.content,
        /系统|检索|上下文|数据库/,
        '记忆段落不得出现机制词汇 —— 模型会照着复述'
      );
    },
    {
      retrieveMemories: async () => [
        {
          id: 'm1',
          content: '用户正在学习 Rust',
          type: 'fact',
          validFrom: new Date('2026-01-15T00:00:00Z'),
        },
      ],
    }
  );
});

test('检索返回空 → 不插入空的「已知信息」段落', async () => {
  await withServer(
    async ({ app, provider }) => {
      await postJson(app, '/api/v1/chat', { message: '你好' });

      const call = provider.received.at(-1)!;
      /**
       * 空段落会被模型当成「确实没有」，
       * 而实际上可能只是本次没命中。整段不出现才不传递错误信号。
       *
       * ⚠️ 断言的是**段落标题**而不是「记忆」两个字：
       *    系统提示词正文里本来就有关于记忆的规则文本，
       *    用宽泛的模式会把规则文本也匹配上（本测试第一版就是这么假失败的）。
       *
       * ⚠️ 原先还断言 `messages.length === 2`（只有 system + user）。
       *    2026-10-08 加了跨会话衔接之后这条断言不再成立 ——
       *    它**不该**成立：那个数字会因为「上一个会话是否在 2 小时内」
       *    而变化，而本测试关心的是「记忆段落有没有出现」。
       *    把它换成更精确的形状判断：除 system/当前 user 外不得有别的消息，
       *    且不得出现记忆段落。
       */
      assert.equal(
        call.messages.filter((m) => m.role === 'user').length,
        1,
        '除当前这句外不应有其他 user 消息'
      );
      assert.doesNotMatch(
        JSON.stringify(call.messages),
        /你记得的关于对方的事/,
        '没有记忆时不应出现记忆段落'
      );
    },
    { retrieveMemories: async () => [] }
  );
});

test('检索抛错 → 聊天照常成功（§45 的同类降级原则）', async () => {
  await withServer(
    async ({ app }) => {
      const res = await postJson(app, '/api/v1/chat', { message: '检索挂了也要能聊' });

      assert.equal(res.statusCode, 200, '检索失败不应让聊天失败');
      assert.equal(res.json().data.meta.context.injectedMemoryCount, 0);
    },
    {
      retrieveMemories: async () => {
        throw new Error('embedding 服务连接被拒绝');
      },
    }
  );
});

test('未注入检索实现时 injectedMemoryCount 为 0（功能未开，不是失败）', async () => {
  await withServer(async ({ app }) => {
    const res = await postJson(app, '/api/v1/chat', { message: '你好' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.meta.context.injectedMemoryCount, 0);
  });
});

// ============================================================
// Conversations 路由
// ============================================================

test('GET /conversations 分页结构符合 docs/04 §8', async () => {
  await withServer(async ({ app }) => {
    const before = await app.inject({ method: 'GET', url: '/api/v1/conversations?page_size=100' });
    const beforeTotal = before.json().data.pagination.total as number;

    await postJson(app, '/api/v1/chat', { message: '第一条会话' });
    await postJson(app, '/api/v1/chat', { message: '第二条会话' });

    /**
     * 断言增量而不是绝对值：库是跨用例共享的。
     * 绝对值断言会让这条测试依赖执行顺序。
     */
    const res = await app.inject({ method: 'GET', url: '/api/v1/conversations?page=1&page_size=1' });
    assert.equal(res.statusCode, 200);

    const { items, pagination } = res.json().data;
    assert.equal(items.length, 1, 'page_size=1 只返回一条');
    assert.equal(pagination.page, 1);
    assert.equal(pagination.page_size, 1);
    assert.equal(pagination.total, beforeTotal + 2);
    assert.equal(pagination.total_pages, beforeTotal + 2);

    // 第二页应与第一页不同（分页真的偏移了）
    const page2 = await app.inject({ method: 'GET', url: '/api/v1/conversations?page=2&page_size=1' });
    assert.notEqual(page2.json().data.items[0].id, items[0].id);
  });
});

test('GET /conversations/:id 返回消息，且 DTO 形状符合 docs/04 §13', async () => {
  await withServer(async ({ app }) => {
    const created = await postJson(app, '/api/v1/chat', { message: '你好' });
    const id = created.json().data.conversation.id;

    const res = await app.inject({ method: 'GET', url: `/api/v1/conversations/${id}` });
    assert.equal(res.statusCode, 200);

    const data = res.json().data;
    assert.equal(data.id, id);
    assert.equal(data.messages.length, 2);

    const msg = data.messages[0];
    assert.deepEqual(Object.keys(msg).sort(), ['content', 'created_at', 'id', 'role', 'sequence']);
    assert.equal(msg.role, 'user');
    // sequence 必须是数字而不是字符串（pg 的 bigint 有时会返回字符串）
    assert.equal(typeof msg.sequence, 'number');
  });
});

test('PATCH /conversations/:id 改标题', async () => {
  await withServer(async ({ app }) => {
    const created = await postJson(app, '/api/v1/chat', { message: '你好' });
    const id = created.json().data.conversation.id;

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/conversations/${id}`,
      payload: { title: '新标题' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.title, '新标题');
  });
});

test('DELETE /conversations/:id 默认保留派生记忆（memory_policy=keep）', async () => {
  await withServer(async ({ app }) => {
    const created = await postJson(app, '/api/v1/chat', { message: '你好' });
    const id = created.json().data.conversation.id;

    const res = await app.inject({ method: 'DELETE', url: `/api/v1/conversations/${id}` });
    assert.equal(res.statusCode, 200);

    const data = res.json().data;
    assert.equal(data.memory_policy, 'keep', '缺省必须是保守口径，不能替用户删数据');
    assert.equal(data.deleted_messages, 2);
  });
});

test('DELETE 后再 DELETE → 404（不静默成功）', async () => {
  await withServer(async ({ app }) => {
    const created = await postJson(app, '/api/v1/chat', { message: '你好' });
    const id = created.json().data.conversation.id;

    await app.inject({ method: 'DELETE', url: `/api/v1/conversations/${id}` });
    const again = await app.inject({ method: 'DELETE', url: `/api/v1/conversations/${id}` });

    assert.equal(again.statusCode, 404);
  });
});

test('删除会话后详情仍可打开，但标题是占位文案且消息已消失', async () => {
  await withServer(async ({ app }) => {
    const created = await postJson(app, '/api/v1/chat', { message: '私密内容' });
    const id = created.json().data.conversation.id;

    await app.inject({ method: 'PATCH', url: `/api/v1/conversations/${id}`, payload: { title: '私密标题' } });
    await app.inject({ method: 'DELETE', url: `/api/v1/conversations/${id}` });

    const res = await app.inject({ method: 'GET', url: `/api/v1/conversations/${id}` });
    assert.equal(res.statusCode, 200);

    const data = res.json().data;
    assert.equal(data.title, '[已删除的对话]', 'C38：标题必须被占位文案替换');
    assert.equal(data.summary, null);
    assert.equal(data.status, 'deleted');
    assert.deepEqual(data.messages, [], 'C29：消息是物理删除');
  });
});

test('PATCH 已删除的会话 → 404（不允许改已删内容）', async () => {
  await withServer(async ({ app }) => {
    const created = await postJson(app, '/api/v1/chat', { message: '你好' });
    const id = created.json().data.conversation.id;

    await app.inject({ method: 'DELETE', url: `/api/v1/conversations/${id}` });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/conversations/${id}`,
      payload: { title: '改一下' },
    });

    assert.equal(res.statusCode, 404);
  });
});

// ============================================================
// SSE（docs/04 §11）
// ============================================================

test('POST /chat/stream 输出 SSE 事件序列，token 拼起来等于完整回答', async () => {
  await withServer(
    async ({ app }) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/stream',
        payload: { message: '你好' },
      });

      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'] as string, /text\/event-stream/);

      const events = parseSse(res.body);

      // token 事件的内容拼起来必须等于完整回答
      const tokens = events.filter((e) => e.type === 'token').map((e) => e.content);
      assert.equal(tokens.join(''), '流式回答。');

      // 顺序：token* → message(user) → message(assistant) → meta → done
      assert.equal(events.at(-1)!.type, 'done');

      const messages = events.filter((e) => e.type === 'message');
      assert.equal(messages.length, 2);
      assert.equal(messages[0]!.role, 'user');
      assert.equal(messages[1]!.role, 'assistant');
      assert.ok(messages[0]!.message_id, '前端需要 message_id 做后续引用');
      assert.ok(messages[0]!.conversation_id, '前端需要 conversation_id 复用会话');

      const meta = events.find((e) => e.type === 'meta')!;
      assert.equal(meta.data?.model, 'fake-model');
    },
    { answer: '流式回答。' }
  );
});

test('SSE 参数非法 → 以普通 422 JSON 返回，不建立事件流', async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/stream',
      payload: { message: '' },
    });

    /**
     * 这是「校验必须在写响应头之前」的验证：
     * 一旦发出 200 + text/event-stream，就再也改不了状态码，
     * 前端得从流里解析错误，体验与实现都更差。
     */
    assert.equal(res.statusCode, 422);
    assert.match(res.headers['content-type'] as string, /application\/json/);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  });
});

test('SSE 中 LLM 失败 → 流内 error 事件，不抛未捕获异常', async () => {
  await withServer(
    async ({ app }) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/stream',
        payload: { message: 'hi' },
      });

      // 流已经建立，状态码仍是 200
      assert.equal(res.statusCode, 200);

      const events = parseSse(res.body);
      const err = events.find((e) => e.type === 'error');
      assert.ok(err, '应有 error 事件');
      assert.equal(err.code, 'LLM_ERROR');
      assert.doesNotMatch(JSON.stringify(err), /sk-/, '不应泄露密钥');
    },
    { failure: new LLMError('上游 401，key=sk-secret', { retryable: false, status: 401 }) }
  );
});

test('SSE 流式回答会落库（与一次性接口一致）', async () => {
  await withServer(
    async ({ app }) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/stream',
        payload: { message: '流式也要存' },
      });

      const events = parseSse(res.body);
      const assistantMsg = events.find((e) => e.type === 'message' && e.role === 'assistant')!;
      const conversationId = assistantMsg.conversation_id;

      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/conversations/${conversationId}`,
      });

      const messages = detail.json().data.messages as { role: string; content: string }[];
      assert.equal(messages.length, 2);
      assert.equal(messages[1]!.role, 'assistant');
      assert.equal(messages[1]!.content, '流式回答。');
    },
    // 必须与上面那条断言用同一个回答：假 Provider 的默认回答是「这是测试回答。」
    { answer: '流式回答。' }
  );
});

// ============================================================
// 辅助
// ============================================================

interface ParsedSseEvent {
  type: string;
  content?: string;
  role?: string;
  message_id?: string;
  conversation_id?: string;
  code?: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * 解析 SSE 响应体。
 *
 * 只处理本实现用到的子集：以 `data: ` 开头的数据行、空行分隔事件、
 * `: ` 开头的心跳注释。不引入 SSE 解析库 ——
 * 那会让「我们的输出格式对不对」变成「库能不能容忍」。
 */
function parseSse(body: string): ParsedSseEvent[] {
  const events: ParsedSseEvent[] = [];

  for (const block of body.split('\n\n')) {
    const line = block
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));

    if (!line) continue;

    const payload = line.slice('data:'.length).trim();
    if (payload.length === 0) continue;

    events.push(JSON.parse(payload) as ParsedSseEvent);
  }

  return events;
}
