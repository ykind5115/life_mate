/**
 * Timeline 路由与周期解析的测试
 *
 * 【本文件的重点】
 *   ① 日期边界：`end=2026-12-31` 必须包含当天。
 *      按 00:00:00 处理会让「查 2026 全年」静默漏掉 12 月 31 日 ——
 *      这类错误很难被发现，所以必须断言。
 *   ② 月份分组：分页只带回一页，但月度计数必须是**该月总数**而不是本页条数。
 *   ③ 周从周一开始（中文语境）。
 *
 * 前置：pnpm test（脚本已指定 .env.test → lifemate_test）
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { eq, inArray } from 'drizzle-orm';

import { closePool, db } from '../database/client.js';
import { events } from '../database/schema/events.js';
import { memories } from '../database/schema/memories.js';
import { goals } from '../database/schema/goals.js';
import { memorySources } from '../database/schema/memory-sources.js';
import { resolveTestUser } from '../database/repository/_test-helpers.js';
import { assertTestDatabase } from '../shared/test-guard.js';
import { buildServer } from './server.js';
import { IdempotencyStore } from './idempotency.js';
import { ExtractionTrigger } from '../conversation/extraction-trigger.js';
import { emptyDiagnostics } from '../memory/extraction-schema.js';
import { resolvePeriod } from '../timeline/timeline-service.js';
import type { GenerateInput, LLMProvider } from '../llm/provider.js';
import type { LLMGenerateResult, LLMStreamChunk } from '../llm/types.js';

after(async () => {
  await closePool();
});

// ============================================================
// 夹具
// ============================================================

class StubProvider implements LLMProvider {
  readonly providerName = 'stub';
  readonly defaultModel = 'stub-model';

  /** 记录收到的请求，便于断言材料组装 */
  readonly received: GenerateInput[] = [];

  constructor(private readonly answer = '{"summary":"这是一段回顾。","highlights":[],"themes":[]}') {}

  generate(input: GenerateInput): Promise<LLMGenerateResult> {
    this.received.push(input);
    return Promise.resolve({
      content: this.answer,
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 10, reasoningTokens: 0 },
      model: 'stub-model',
      finishReason: 'stop',
    });
  }

  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<LLMStreamChunk> {
    throw new Error('本测试不使用 stream');
  }
}

interface TimelineFixture {
  app: FastifyInstance;
  provider: StubProvider;
  userId: string;
  /** 直接插一条事件（绕过 HTTP，用于准备数据） */
  seedEvent: (e: { title: string; eventTime: Date; category?: string | null }) => Promise<string>;
}

async function withTimeline(fn: (f: TimelineFixture) => Promise<void>): Promise<void> {
  assertTestDatabase('timeline-routes.test.ts / withTimeline');

  const provider = new StubProvider();
  const app = await buildServer({
    logLevel: 'silent',
    provider,
    chatIdempotency: new IdempotencyStore(),
    extractionTrigger: new ExtractionTrigger({ run: async () => emptySummary() }),
    retrieveMemories: null,
  });

  const user = await resolveTestUser('timeline-routes.test.ts');
  /**
   * 前置：清空该用户名下的**事件、记忆与目标**。
   *
   * ⚠️ 三者都要清，因为 Life Review 的材料是「事件 + 该区间内有效的记忆 + 活跃目标」。
   *    实测踩到两次：
   *      ① 只清事件时，「无材料」用例因为仍有遗留记忆而真的调了 LLM
   *      ② 只清事件与记忆时，上个用例留下的目标仍然计入材料
   *
   * ⚠️ 清理顺序不可调换：memory_sources.goal_id 引用 goals，
   *    goals 引用 users（RESTRICT）。先删来源行 → 记忆 → 目标。
   */
  await db.delete(events).where(eq(events.userId, user.id));
  await cleanupMemoriesAndGoals(user.id);

  const seedEvent: TimelineFixture['seedEvent'] = async (e) => {
    const rows = await db
      .insert(events)
      .values({
        userId: user.id,
        title: e.title,
        eventTime: e.eventTime,
        category: e.category ?? null,
        sourceType: 'manual',
      })
      .returning({ id: events.id });
    return rows[0]!.id;
  };

  try {
    await fn({ app, provider, userId: user.id, seedEvent });
  } finally {
    await app.close();
    await db.delete(events).where(eq(events.userId, user.id));
    await cleanupMemoriesAndGoals(user.id);
  }
}

/**
 * 清掉某用户名下的记忆与目标。
 *
 * ⚠️ 顺序不可调换：memory_sources.goal_id 引用 goals，
 *    而 chk_sources_has_origin 要求来源行至少有一个指针。
 *    直接删 goals 会被外键挡住；先删来源行再删记忆、最后删 goals。
 */
async function cleanupMemoriesAndGoals(userId: string): Promise<void> {
  const userGoals = await db.select({ id: goals.id }).from(goals).where(eq(goals.userId, userId));
  const goalIds = userGoals.map((g) => g.id);

  if (goalIds.length > 0) {
    await db.delete(memorySources).where(inArray(memorySources.goalId, goalIds));
  }
  await db.delete(memories).where(eq(memories.userId, userId));
  if (goalIds.length > 0) {
    await db.delete(goals).where(inArray(goals.id, goalIds));
  }
}

function emptySummary() {
  return {
    executed: false as const,
    skippedReason: 'no_new_messages' as const,
    candidatesFound: 0,
    diagnostics: emptyDiagnostics(),
    outcomes: { created: 0, merged: 0, superseded: 0, conflict: 0 },
    events: { created: 0, skippedDuplicates: 0 },
    adjudicationCalls: 0,
    embeddings: { succeeded: 0, failed: 0 },
    memoriesWithoutEmbedding: [],
  };
}

function req(app: FastifyInstance, opts: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject(opts);
}

// ============================================================
// 周期解析（纯函数，不依赖库）
// ============================================================

test('resolvePeriod day：覆盖 UTC 当天 00:00:00.000 ~ 23:59:59.999', () => {
  const p = resolvePeriod({ kind: 'day', at: new Date('2026-09-23T15:30:00Z') });

  assert.equal(p.from.toISOString(), '2026-09-23T00:00:00.000Z');
  assert.equal(p.to.toISOString(), '2026-09-23T23:59:59.999Z');
});

test('resolvePeriod week：从**周一**开始（中文语境）', () => {
  /**
   * 2026-09-23 是周三。本周应为 09-21（周一）~ 09-27（周日）。
   * 若用周日作起点，会把「上周末做的事」切到下一个周期里，
   * 用户会觉得总结漏了东西。
   */
  const p = resolvePeriod({ kind: 'week', at: new Date('2026-09-23T15:30:00Z') });

  assert.equal(p.from.toISOString(), '2026-09-21T00:00:00.000Z');
  assert.equal(p.to.toISOString(), '2026-09-27T23:59:59.999Z');
});

test('resolvePeriod week：周日属于**本周**而不是下周', () => {
  // 2026-09-27 是周日，应仍落在 09-21 那一周
  const p = resolvePeriod({ kind: 'week', at: new Date('2026-09-27T10:00:00Z') });
  assert.equal(p.from.toISOString(), '2026-09-21T00:00:00.000Z');
});

test('resolvePeriod month：覆盖整月最后一天', () => {
  const p = resolvePeriod({ kind: 'month', at: new Date('2026-08-15T00:00:00Z') });

  assert.equal(p.from.toISOString(), '2026-08-01T00:00:00.000Z');
  assert.equal(p.to.toISOString(), '2026-08-31T23:59:59.999Z');
});

test('resolvePeriod month：2 月与闰年', () => {
  const normal = resolvePeriod({ kind: 'month', at: new Date('2026-02-10T00:00:00Z') });
  assert.equal(normal.to.toISOString(), '2026-02-28T23:59:59.999Z');

  // 2028 是闰年
  const leap = resolvePeriod({ kind: 'month', at: new Date('2028-02-10T00:00:00Z') });
  assert.equal(leap.to.toISOString(), '2028-02-29T23:59:59.999Z');
});

test('resolvePeriod custom：缺 from/to 或终点早于起点时抛错', () => {
  assert.throws(() => resolvePeriod({ kind: 'custom' }), /必须同时提供/);
  assert.throws(
    () =>
      resolvePeriod({
        kind: 'custom',
        from: new Date('2026-09-10'),
        to: new Date('2026-09-01'),
      }),
    /不能早于/
  );
});

// ============================================================
// GET /timeline
// ============================================================

test('GET /timeline 按年月分组，且月度 total 是该月总数', async () => {
  await withTimeline(async ({ app, seedEvent }) => {
    await seedEvent({ title: '八月的事一', eventTime: new Date('2026-08-05T00:00:00Z') });
    await seedEvent({ title: '八月的事二', eventTime: new Date('2026-08-20T00:00:00Z') });
    await seedEvent({ title: '九月的事', eventTime: new Date('2026-09-10T00:00:00Z') });

    const res = await req(app, { method: 'GET', url: '/api/v1/timeline?page_size=50' });
    assert.equal(res.statusCode, 200);

    const months = res.json().data.months as { month: string; total: number; items: unknown[] }[];
    assert.deepEqual(
      months.map((m) => m.month),
      ['2026-09', '2026-08'],
      '月份倒序：最近的在前'
    );
    assert.equal(months[1]!.total, 2);
    assert.equal(months[1]!.items.length, 2);
  });
});

test('GET /timeline 分页时月度 total 仍是该月总数（不是本页条数）', async () => {
  await withTimeline(async ({ app, seedEvent }) => {
    // 同一个月 3 条，但 page_size=1
    await seedEvent({ title: 'A', eventTime: new Date('2026-08-01T00:00:00Z') });
    await seedEvent({ title: 'B', eventTime: new Date('2026-08-02T00:00:00Z') });
    await seedEvent({ title: 'C', eventTime: new Date('2026-08-03T00:00:00Z') });

    const res = await req(app, { method: 'GET', url: '/api/v1/timeline?page_size=1' });
    const months = res.json().data.months as { month: string; total: number; items: unknown[] }[];

    assert.equal(months.length, 1, '只返回有内容的月份');
    assert.equal(months[0]!.items.length, 1, '本页只带回一条');
    assert.equal(
      months[0]!.total,
      3,
      'total 必须是该月总数 —— 若按本页算会得到 1，前端会显示成「8月(1)」'
    );
  });
});

test('GET /timeline end=YYYY-MM-DD 包含当天（回归：曾按 00:00:00 处理）', async () => {
  await withTimeline(async ({ app, seedEvent }) => {
    /**
     * 这是本文件最重要的一条断言。
     * 用户查「2026 全年」时，12 月 31 日当天的事件必须出现。
     * 若 end 按 00:00:00 处理，这一天会静默消失。
     */
    await seedEvent({ title: '年末最后一天', eventTime: new Date('2026-12-31T14:00:00Z') });
    await seedEvent({ title: '年内其他日子', eventTime: new Date('2026-06-15T00:00:00Z') });

    const res = await req(app, {
      method: 'GET',
      url: '/api/v1/timeline?start=2026-01-01&end=2026-12-31&page_size=50',
    });

    const titles = (res.json().data.items as { title: string }[]).map((e) => e.title);
    assert.ok(titles.includes('年末最后一天'), '12-31 当天的事件必须被包含');
    assert.ok(titles.includes('年内其他日子'));
  });
});

test('GET /timeline start=YYYY-MM-DD 从当天 00:00 开始', async () => {
  await withTimeline(async ({ app, seedEvent }) => {
    await seedEvent({ title: '边界当天', eventTime: new Date('2026-09-01T00:00:00Z') });
    await seedEvent({ title: '边界前一天', eventTime: new Date('2026-08-31T23:59:59Z') });

    const res = await req(app, {
      method: 'GET',
      url: '/api/v1/timeline?start=2026-09-01&page_size=50',
    });

    const titles = (res.json().data.items as { title: string }[]).map((e) => e.title);
    assert.deepEqual(titles, ['边界当天']);
  });
});

test('GET /timeline 按 category 过滤', async () => {
  await withTimeline(async ({ app, seedEvent }) => {
    await seedEvent({ title: '工作', eventTime: new Date('2026-08-01T00:00:00Z'), category: 'work' });
    await seedEvent({ title: '学习', eventTime: new Date('2026-08-02T00:00:00Z'), category: 'study' });

    const res = await req(app, { method: 'GET', url: '/api/v1/timeline?category=work' });
    const titles = (res.json().data.items as { title: string }[]).map((e) => e.title);

    assert.deepEqual(titles, ['工作']);
  });
});

test('GET /timeline 非法 category → 422', async () => {
  await withTimeline(async ({ app }) => {
    const res = await req(app, { method: 'GET', url: '/api/v1/timeline?category=nonsense' });
    assert.equal(res.statusCode, 422);
  });
});

test('GET /timeline 空结果返回空数组而不是报错', async () => {
  await withTimeline(async ({ app }) => {
    const res = await req(app, {
      method: 'GET',
      url: '/api/v1/timeline?start=2020-01-01&end=2020-12-31',
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data.months, []);
    assert.deepEqual(res.json().data.items, []);
  });
});

test('GET /timeline/categories 返回受控枚举（与库层 CHECK 同源）', async () => {
  await withTimeline(async ({ app }) => {
    const res = await req(app, { method: 'GET', url: '/api/v1/timeline/categories' });
    const values = (res.json().data.items as { value: string }[]).map((c) => c.value);

    assert.ok(values.includes('work'));
    assert.ok(values.includes('other'), 'other 是兜底值，必须在前端可选列表里');
    assert.equal(values.length, 6);
  });
});

// ============================================================
// 写端点
// ============================================================

test('POST /timeline 创建事件返回 201，来源是 manual', async () => {
  await withTimeline(async ({ app }) => {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/timeline',
      payload: {
        title: '搬到杭州',
        description: '从北京搬到杭州',
        event_time: '2026-09-01T00:00:00Z',
        category: 'life',
      },
    });

    assert.equal(res.statusCode, 201);
    const data = res.json().data;
    assert.equal(data.title, '搬到杭州');
    assert.equal(data.source_type, 'manual');
    assert.equal(data.source_message_id, null, '手工创建不应伪造来源消息 id');
    assert.equal(data.timeline_visible, true);
  });
});

test('POST /timeline 时间非法 → 400', async () => {
  await withTimeline(async ({ app }) => {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/timeline',
      payload: { title: '时间不对', event_time: '不是时间' },
    });

    assert.equal(res.statusCode, 400);
  });
});

test('POST /timeline 缺少 event_time → 422（它是 NOT NULL）', async () => {
  await withTimeline(async ({ app }) => {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/timeline',
      payload: { title: '没有时间的事件' },
    });

    assert.equal(res.statusCode, 422);
  });
});

test('PATCH /timeline/:id 允许改内容（与记忆不同）', async () => {
  await withTimeline(async ({ app, seedEvent }) => {
    const id = await seedEvent({ title: '原标题', eventTime: new Date('2026-08-01T00:00:00Z') });

    const res = await req(app, {
      method: 'PATCH',
      url: `/api/v1/timeline/${id}`,
      payload: { title: '改后的标题', event_time: '2026-08-15T00:00:00Z' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.title, '改后的标题');
    assert.equal(
      new Date(res.json().data.event_time).toISOString(),
      '2026-08-15T00:00:00.000Z'
    );
  });
});

test('PATCH /timeline/:id 空 body → 400', async () => {
  await withTimeline(async ({ app, seedEvent }) => {
    const id = await seedEvent({ title: '事件', eventTime: new Date('2026-08-01T00:00:00Z') });
    const res = await req(app, { method: 'PATCH', url: `/api/v1/timeline/${id}`, payload: {} });
    assert.equal(res.statusCode, 400);
  });
});

test('PATCH /timeline/:id 不允许改来源字段（strict 校验）', async () => {
  await withTimeline(async ({ app, seedEvent }) => {
    const id = await seedEvent({ title: '事件', eventTime: new Date('2026-08-01T00:00:00Z') });

    const res = await req(app, {
      method: 'PATCH',
      url: `/api/v1/timeline/${id}`,
      payload: { source_type: 'system' },
    });

    assert.equal(res.statusCode, 422, '来源凭证不该能被客户端改写');
  });
});

test('PATCH timeline_visible=false 可以隐藏而不删除', async () => {
  await withTimeline(async ({ app, seedEvent }) => {
    const id = await seedEvent({ title: '想隐藏的事件', eventTime: new Date('2026-08-01T00:00:00Z') });

    const patch = await req(app, {
      method: 'PATCH',
      url: `/api/v1/timeline/${id}`,
      payload: { timeline_visible: false },
    });
    assert.equal(patch.statusCode, 200);

    // 时间线里看不到
    const list = await req(app, { method: 'GET', url: '/api/v1/timeline?page_size=50' });
    assert.deepEqual(list.json().data.items, [], '隐藏后不出现在时间线');

    // 但事件本身还在（不是删除）
    const detail = await req(app, {
      method: 'GET',
      url: `/api/v1/timeline?page_size=50`,
    });
    assert.equal(detail.statusCode, 200);
  });
});

test('DELETE /timeline/:id 软删除后从时间线消失，可恢复', async () => {
  await withTimeline(async ({ app, seedEvent }) => {
    const id = await seedEvent({ title: '要删的事件', eventTime: new Date('2026-08-01T00:00:00Z') });

    const del = await req(app, { method: 'DELETE', url: `/api/v1/timeline/${id}` });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().data.deleted, true);

    const list = await req(app, { method: 'GET', url: '/api/v1/timeline?page_size=50' });
    assert.deepEqual(list.json().data.items, []);

    const restore = await req(app, { method: 'POST', url: `/api/v1/timeline/${id}/restore` });
    assert.equal(restore.statusCode, 200);

    const after = await req(app, { method: 'GET', url: '/api/v1/timeline?page_size=50' });
    assert.equal((after.json().data.items as unknown[]).length, 1);
  });
});

test('DELETE 已删除的事件 → 404（不静默成功）', async () => {
  await withTimeline(async ({ app, seedEvent }) => {
    const id = await seedEvent({ title: '事件', eventTime: new Date('2026-08-01T00:00:00Z') });

    await req(app, { method: 'DELETE', url: `/api/v1/timeline/${id}` });
    const again = await req(app, { method: 'DELETE', url: `/api/v1/timeline/${id}` });

    assert.equal(again.statusCode, 404);
  });
});

test('PATCH 已删除的事件 → 409（提示先恢复）', async () => {
  await withTimeline(async ({ app, seedEvent }) => {
    const id = await seedEvent({ title: '事件', eventTime: new Date('2026-08-01T00:00:00Z') });
    await req(app, { method: 'DELETE', url: `/api/v1/timeline/${id}` });

    const res = await req(app, {
      method: 'PATCH',
      url: `/api/v1/timeline/${id}`,
      payload: { title: '改一下' },
    });

    assert.equal(res.statusCode, 409);
  });
});

// ============================================================
// Life Review
// ============================================================

test('POST /life-review 返回 period / review / materials', async () => {
  await withTimeline(async ({ app, seedEvent }) => {
    await seedEvent({ title: '开始新的项目', eventTime: new Date('2026-08-10T00:00:00Z') });

    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/life-review',
      payload: { start: '2026-08-01', end: '2026-08-31' },
    });

    assert.equal(res.statusCode, 200);
    const data = res.json().data;

    assert.equal(data.period.kind, 'custom');
    assert.equal(data.review.summary, '这是一段回顾。');
    assert.ok(Array.isArray(data.materials.events));
    assert.equal(data.materials.events.length, 1);
  });
});

test('POST /life-review kind=week 会自动算区间', async () => {
  await withTimeline(async ({ app }) => {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/life-review',
      payload: { kind: 'week', at: '2026-09-23' },
    });

    assert.equal(res.statusCode, 200);
    const period = res.json().data.period;
    assert.equal(period.kind, 'week');
    assert.equal(new Date(period.start).toISOString(), '2026-09-21T00:00:00.000Z');
    assert.equal(new Date(period.end).toISOString(), '2026-09-27T23:59:59.999Z');
  });
});

test('POST /life-review 无材料时**不调用 LLM**，直接返回说明', async () => {
  await withTimeline(async ({ app, provider }) => {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/life-review',
      payload: { start: '2020-01-01', end: '2020-01-31' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(
      provider.received.length,
      0,
      '没有材料时调用模型只会得到编造的内容 —— 应该直接跳过'
    );
    assert.match(res.json().data.review.summary, /没有任何记录/);
  });
});

test('POST /life-review 四条来源都已接入（docs/04 §32）', async () => {
  await withTimeline(async ({ app, userId, seedEvent }) => {
    // 造材料：一个进行中的目标 + 一条事件
    await db.insert(goals).values({
      userId,
      title: '学会弹吉他',
      status: 'active',
      priority: 0.8,
    });
    await seedEvent({ title: '开始学吉他', eventTime: new Date('2026-09-10T00:00:00Z') });

    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/life-review',
      /**
       * ⚠️ 区间终点必须在目标创建时间**之后**。
       *    loadGoalsForPeriod 会按「创建时间 ≤ 区间终点」筛 ——
       *    回顾 8 月时，9 月才立的目标不该出现（那时它还不存在）。
       */
      payload: { start: '2026-08-01', end: '2027-12-31' },
    });

    const sources = res.json().data.sources_available;

    /**
     * docs/04 §32 的四条来源：Timeline / Memories / Goals / Summaries。
     * 现在全部接入，因此 unavailable 应为空数组。
     * 保留这个字段是为了让「这次回顾用了什么材料」始终可核对。
     */
    assert.equal(sources.events, 1);
    assert.equal(sources.goals, 1);
    assert.equal(
      sources.unavailable.length,
      0,
      `四条来源都应接入，实际未接入：${JSON.stringify(sources.unavailable)}`
    );

    // 材料应可核对
    assert.equal(res.json().data.materials.goals[0].title, '学会弹吉他');
    assert.ok(Array.isArray(res.json().data.materials.summaries));
  });
});

test('Life Review 不纳入区间终点之后才创建的目标', async () => {
  await withTimeline(async ({ app, userId }) => {
    await db.insert(goals).values({ userId, title: '未来才立的目标', status: 'active' });

    // 回顾一段很久以前的时间：那时这个目标还不存在
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/life-review',
      payload: { start: '2020-01-01', end: '2020-12-31' },
    });

    assert.equal(
      res.json().data.sources_available.goals,
      0,
      '回顾过去时不该出现当时还不存在的目标'
    );
  });
});

test('POST /life-review kind=custom 缺 end → 422（入口拦下，不是 500）', async () => {
  await withTimeline(async ({ app }) => {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/life-review',
      payload: { kind: 'custom', start: '2026-08-01' },
    });

    assert.equal(res.statusCode, 422);
  });
});

test('POST /life-review 区间终点早于起点 → 400', async () => {
  await withTimeline(async ({ app }) => {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/life-review',
      payload: { start: '2026-09-10', end: '2026-09-01' },
    });

    assert.equal(res.statusCode, 400);
  });
});

test('POST /life-review 给模型的材料里带事件 id（highlights 要能引用）', async () => {
  await withTimeline(async ({ app, provider, seedEvent }) => {
    const id = await seedEvent({ title: '带 id 的事件', eventTime: new Date('2026-08-10T00:00:00Z') });

    await req(app, {
      method: 'POST',
      url: '/api/v1/life-review',
      payload: { start: '2026-08-01', end: '2026-08-31' },
    });

    const sent = JSON.stringify(provider.received.at(-1)!.messages);
    assert.ok(sent.includes(id), '材料里应带事件 id，否则 highlights 无法引用');
    assert.ok(sent.includes('带 id 的事件'));
  });
});
