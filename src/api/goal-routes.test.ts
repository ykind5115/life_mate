/**
 * Goals 路由与投影记忆的集成测试
 *
 * 【本文件的重点】
 *   ① **投影记忆**：goals 的写入必须同步维护一条 memory(type='goal')，
 *      否则目标无法被语义召回 —— 用户问「我在忙什么目标」时 Agent 答不出来。
 *   ② **C24 的删除顺序**：物理删 Goal 必须先清理投影记忆与来源行，
 *      否则 chk_sources_has_origin 会让整个删除回滚（审计 F-03 实测过）。
 *   ③ **状态转移是软校验**：非法转移被执行但返回 warning，
 *      不是硬拒绝（理由见 goal-state-machine.ts）。
 *
 * 前置：pnpm test（脚本已指定 .env.test → lifemate_test）
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { eq, inArray } from 'drizzle-orm';

import { closePool, db } from '../database/client.js';
import { goals } from '../database/schema/goals.js';
import { memories } from '../database/schema/memories.js';
import { memorySources } from '../database/schema/memory-sources.js';
import { ensureDefaultUser } from '../database/repository/user-store.js';
import { assertTestDatabase } from '../shared/test-guard.js';
import { buildServer } from './server.js';
import { IdempotencyStore } from './idempotency.js';
import { ExtractionTrigger } from '../conversation/extraction-trigger.js';
import { emptyDiagnostics } from '../memory/extraction-schema.js';
import { checkTransition, resolveCompletedAt } from '../goals/goal-state-machine.js';
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

  generate(_input: GenerateInput): Promise<LLMGenerateResult> {
    return Promise.resolve({
      content: '{}',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      model: 'stub-model',
      finishReason: 'stop',
    });
  }

  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<LLMStreamChunk> {
    throw new Error('本测试不使用 stream');
  }
}

interface GoalFixture {
  app: FastifyInstance;
  userId: string;
  /** 查某个 Goal 的投影记忆 */
  projectionOf: (goalId: string) => Promise<
    { id: string; content: string; status: string; type: string }[]
  >;
}

async function withGoals(fn: (f: GoalFixture) => Promise<void>): Promise<void> {
  assertTestDatabase('goal-routes.test.ts / withGoals');

  const app = await buildServer({
    logLevel: 'silent',
    provider: new StubProvider(),
    chatIdempotency: new IdempotencyStore(),
    extractionTrigger: new ExtractionTrigger({ run: async () => emptySummary() }),
    retrieveMemories: null,
  });

  const user = await ensureDefaultUser();

  /**
   * 前置清理顺序不可调换：
   *   memory_sources.goal_id 引用 goals，goals 引用 users（RESTRICT）。
   *   先删来源行 → 再删记忆（连带来源级联）→ 再删 goals。
   */
  await cleanup(user.id);

  const projectionOf: GoalFixture['projectionOf'] = async (goalId) => {
    const sourceRows = await db
      .select({ memoryId: memorySources.memoryId })
      .from(memorySources)
      .where(eq(memorySources.goalId, goalId));

    const ids = sourceRows.map((s) => s.memoryId);
    if (ids.length === 0) return [];

    return db
      .select({
        id: memories.id,
        content: memories.content,
        status: memories.status,
        type: memories.type,
      })
      .from(memories)
      .where(inArray(memories.id, ids));
  };

  try {
    await fn({ app, userId: user.id, projectionOf });
  } finally {
    await app.close();
    await cleanup(user.id);
  }
}

/**
 * 清理测试数据。
 *
 * ⚠️ 顺序：来源行 → 记忆 → goals。
 *    反了会被 chk_sources_has_origin 或外键 RESTRICT 挡住。
 */
async function cleanup(userId: string): Promise<void> {
  const userGoals = await db
    .select({ id: goals.id })
    .from(goals)
    .where(eq(goals.userId, userId));
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
// 状态机（纯函数）
// ============================================================

test('状态机：active 可到 paused/completed/cancelled/archived', () => {
  for (const to of ['paused', 'completed', 'cancelled', 'archived'] as const) {
    assert.equal(checkTransition('active', to).allowed, true, `active → ${to} 应允许`);
  }
});

test('状态机：completed 不能直接回到 active，并给出可操作的理由', () => {
  const check = checkTransition('completed', 'active');

  assert.equal(check.allowed, false);
  /**
   * 理由必须**可操作**（告诉用户该怎么做），而不是干巴巴的"不允许"。
   * 这是软校验的意义所在 —— 它要帮用户理解，不是拦住他。
   */
  assert.match(check.reason ?? '', /新建一个目标/);
});

test('状态机：archived 可以重新启用（用户重拾旧目标是常见需求）', () => {
  assert.equal(checkTransition('archived', 'active').allowed, true);
});

test('状态机：同状态转移视为允许（更新其他字段时顺手带 status）', () => {
  assert.equal(checkTransition('active', 'active').allowed, true);
  assert.equal(checkTransition('completed', 'completed').allowed, true);
});

test('resolveCompletedAt：进入 completed 时补时间，离开时清空', () => {
  const now = new Date('2026-09-23T00:00:00Z');

  // 进入 completed 且未提供 → 用当前时间
  const set = resolveCompletedAt('completed', null);
  assert.ok(set instanceof Date);

  // 进入 completed 且提供了 → 用提供的
  assert.equal(resolveCompletedAt('completed', null, now)?.toISOString(), now.toISOString());

  // 离开 completed（且原来有时间）→ 清空
  assert.equal(resolveCompletedAt('active', now), null);

  // 离开 completed（原本就没时间）→ 不动
  assert.equal(resolveCompletedAt('active', null), undefined);
});

// ============================================================
// CRUD 与投影记忆
// ============================================================

test('POST /goals 创建目标，并生成投影记忆', async () => {
  await withGoals(async ({ app, projectionOf }) => {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: { title: '学会弹吉他', description: '想弹唱几首歌', priority: 0.8 },
    });

    assert.equal(res.statusCode, 201);
    const goal = res.json().data;
    assert.equal(goal.title, '学会弹吉他');
    assert.equal(goal.status, 'active');
    assert.equal(goal.is_ongoing, true);

    /**
     * 投影记忆是这块功能的核心 —— 没有它，目标无法被语义召回，
     * 用户问「我在忙什么目标」时 Agent 答不出来。
     */
    const projections = await projectionOf(goal.id);
    assert.equal(projections.length, 1, '应生成一条投影记忆');
    assert.equal(projections[0]!.type, 'goal');
    assert.equal(projections[0]!.status, 'active');
    assert.match(projections[0]!.content, /学会弹吉他/, '投影正文应含目标标题');
    assert.match(projections[0]!.content, /进行中/, '投影正文应含状态，脱离 goals 表也要可理解');
  });
});

test('投影记忆无槽位（否则多个目标会撞唯一索引）', async () => {
  await withGoals(async ({ app, projectionOf }) => {
    const a = await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: { title: '目标一' },
    });
    const b = await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: { title: '目标二' },
    });

    assert.equal(a.statusCode, 201);
    assert.equal(
      b.statusCode,
      201,
      '第二个目标必须能建出来 —— 若投影记忆带 goal.long_term 槽位会被唯一索引拦住'
    );

    const pa = await projectionOf(a.json().data.id);
    const rows = await db
      .select({ predicateKey: memories.predicateKey })
      .from(memories)
      .where(eq(memories.id, pa[0]!.id));

    assert.equal(rows[0]!.predicateKey, null, '投影记忆不应带槽位');
  });
});

test('GET /goals 未完成的目标排在已完成之前', async () => {
  await withGoals(async ({ app }) => {
    const done = await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: { title: '已完成的目标', priority: 0.99 },
    });
    await req(app, {
      method: 'PATCH',
      url: `/api/v1/goals/${done.json().data.id}`,
      payload: { status: 'completed' },
    });
    await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: { title: '进行中的目标', priority: 0.1 },
    });

    const res = await req(app, { method: 'GET', url: '/api/v1/goals' });
    const titles = (res.json().data.items as { title: string }[]).map((g) => g.title);

    /**
     * 优先级高但已完成的目标仍应排在后面 ——
     * 目标列表的用途是「我现在该关注什么」。
     */
    assert.deepEqual(titles, ['进行中的目标', '已完成的目标']);
  });
});

test('PATCH /goals/:id 标记完成会写入 completed_at 并归档投影', async () => {
  await withGoals(async ({ app, projectionOf }) => {
    const created = await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: { title: '要完成的目标' },
    });
    const id = created.json().data.id;

    const res = await req(app, {
      method: 'PATCH',
      url: `/api/v1/goals/${id}`,
      payload: { status: 'completed' },
    });

    assert.equal(res.statusCode, 200);
    assert.ok(res.json().data.completed_at, 'completed_at 应被自动补上');
    assert.equal(res.json().data.is_ongoing, false);

    const projections = await projectionOf(id);
    assert.equal(
      projections[0]!.status,
      'archived',
      '完成的目标其投影记忆应归档，否则 Agent 会把已完成的目标当成在进行的'
    );
  });
});

test('PATCH 非法转移被执行但返回 warning（软校验）', async () => {
  await withGoals(async ({ app }) => {
    const created = await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: { title: '目标' },
    });
    const id = created.json().data.id;

    await req(app, { method: 'PATCH', url: `/api/v1/goals/${id}`, payload: { status: 'completed' } });
    const back = await req(app, {
      method: 'PATCH',
      url: `/api/v1/goals/${id}`,
      payload: { status: 'active' },
    });

    assert.equal(back.statusCode, 200, '软校验不拒绝执行');
    assert.equal(back.json().data.status, 'active');
    assert.ok(Array.isArray(back.json().data.warnings), '应带 warnings');
    assert.match(back.json().data.warnings[0], /新建一个目标/);
  });
});

test('PATCH 改标题会重建投影记忆（不是就地改，Q1）', async () => {
  await withGoals(async ({ app, projectionOf }) => {
    const created = await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: { title: '原标题' },
    });
    const id = created.json().data.id;

    await req(app, {
      method: 'PATCH',
      url: `/api/v1/goals/${id}`,
      payload: { title: '新标题' },
    });

    const projections = await projectionOf(id);
    assert.equal(projections.length, 2, '旧投影保留为历史，新投影另建一条');

    const active = projections.find((p) => p.status === 'active')!;
    const archived = projections.find((p) => p.status === 'archived')!;

    assert.match(active.content, /新标题/);
    assert.match(
      archived.content,
      /原标题/,
      '旧投影必须保留原文 —— Q1：记忆正文永不就地修改，「它原本叫什么」是历史'
    );
  });
});

test('PATCH 传相同标题不触发重建（避免白产生历史记录）', async () => {
  await withGoals(async ({ app, projectionOf }) => {
    const created = await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: { title: '不变的标题' },
    });
    const id = created.json().data.id;

    await req(app, {
      method: 'PATCH',
      url: `/api/v1/goals/${id}`,
      payload: { title: '不变的标题', priority: 0.9 },
    });

    const projections = await projectionOf(id);
    assert.equal(projections.length, 1, '正文没变就不该重建');
  });
});

test('POST /goals 目标时间早于开始时间 → 400（不是笼统的 409）', async () => {
  await withGoals(async ({ app }) => {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: {
        title: '时间矛盾的目标',
        started_at: '2026-09-01',
        target_at: '2026-08-01',
      },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error.message, /不能早于/);
  });
});

test('PATCH 只传 target_at 时也会跟库里的 started_at 比对', async () => {
  await withGoals(async ({ app }) => {
    const created = await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: { title: '目标', started_at: '2026-09-01' },
    });
    const id = created.json().data.id;

    /**
     * 这是容易漏的一条：单看入参（只有 target_at）无法判断矛盾，
     * 必须与库里已有的 started_at 合并后再比。
     */
    const res = await req(app, {
      method: 'PATCH',
      url: `/api/v1/goals/${id}`,
      payload: { target_at: '2026-08-01' },
    });

    assert.equal(res.statusCode, 400);
  });
});

// ============================================================
// 删除（C24 是本文件最重要的部分）
// ============================================================

test('DELETE /goals/:id 软删除会失效投影记忆', async () => {
  await withGoals(async ({ app, projectionOf }) => {
    const created = await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: { title: '要删的目标' },
    });
    const id = created.json().data.id;

    const del = await req(app, { method: 'DELETE', url: `/api/v1/goals/${id}` });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().data.hard_deleted, false);

    const projections = await projectionOf(id);
    assert.equal(projections[0]!.status, 'deleted', '投影记忆应一并失效，否则仍会被召回');
  });
});

test('C24：物理删除 Goal 成功（回归：漏删来源行会被 CHECK 约束回滚）', async () => {
  await withGoals(async ({ app, projectionOf }) => {
    const created = await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: { title: '要物理删除的目标' },
    });
    const id = created.json().data.id;
    const projections = await projectionOf(id);
    assert.equal(projections.length, 1);

    /**
     * ⚠️ 这是本文件的核心断言。
     *    投影记忆的来源指针是 goal_id，而 goal_projection **不在**
     *    chk_sources_has_origin 的豁免列表里。
     *    若不先删来源行就删 Goal，外键的 SET NULL 会让来源行失去所有指针
     *    → CHECK 违约 → **整个删除被回滚**（审计 F-03 实测过）。
     */
    const del = await req(app, { method: 'DELETE', url: `/api/v1/goals/${id}?hard=true` });
    assert.equal(del.statusCode, 200, '物理删除应当成功，而不是被约束回滚');
    assert.equal(del.json().data.hard_deleted, true);
    assert.equal(del.json().data.deleted_projection_memories, 1);

    // Goal 真的没了
    const detail = await req(app, { method: 'GET', url: `/api/v1/goals/${id}` });
    assert.equal(detail.statusCode, 404);

    // 来源行也清干净了
    const sources = await db
      .select({ id: memorySources.id })
      .from(memorySources)
      .where(eq(memorySources.goalId, id));
    assert.equal(sources.length, 0);
  });
});

test('DELETE 后再 DELETE → 404（不静默成功）', async () => {
  await withGoals(async ({ app }) => {
    const created = await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: { title: '目标' },
    });
    const id = created.json().data.id;

    await req(app, { method: 'DELETE', url: `/api/v1/goals/${id}` });
    const again = await req(app, { method: 'DELETE', url: `/api/v1/goals/${id}` });

    assert.equal(again.statusCode, 404);
  });
});

test('软删除后可恢复，投影记忆一并恢复', async () => {
  await withGoals(async ({ app, projectionOf }) => {
    const created = await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: { title: '删了又恢复' },
    });
    const id = created.json().data.id;

    await req(app, { method: 'DELETE', url: `/api/v1/goals/${id}` });
    const restore = await req(app, { method: 'POST', url: `/api/v1/goals/${id}/restore` });

    assert.equal(restore.statusCode, 200);
    assert.equal(restore.json().data.title, '删了又恢复');

    const projections = await projectionOf(id);
    assert.equal(projections[0]!.status, 'active', '投影记忆应恢复为 active');
  });
});

test('恢复未被删除的目标 → 409', async () => {
  await withGoals(async ({ app }) => {
    const created = await req(app, {
      method: 'POST',
      url: '/api/v1/goals',
      payload: { title: '好好活着' },
    });

    const res = await req(app, {
      method: 'POST',
      url: `/api/v1/goals/${created.json().data.id}/restore`,
    });

    assert.equal(res.statusCode, 409);
  });
});

test('POST /memories 仍然拒绝 type=goal（Q3/§13.10：唯一入口是 GoalService）', async () => {
  await withGoals(async ({ app }) => {
    /**
     * 这是与 goals 端点配套的约束：既然有了 POST /goals，
     * 就不该再允许通过 POST /memories 绕过它建目标记忆。
     * 两条路都能建 = 两处真相，且 Goal 的状态机对记忆不生效。
     */
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/memories',
      payload: { type: 'goal', content: '用户想学会弹吉他' },
    });

    assert.equal(res.statusCode, 422);
  });
});
