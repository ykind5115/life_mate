/**
 * Memory 路由集成测试
 *
 * 用 Fastify inject() 直接打请求，不占端口。
 *
 * 【本文件的两个重点】
 *   ① 删除 → 恢复的生命周期，尤其是「槽位被占用时恢复会转为 conflict」
 *      —— 这是 uq_memories_current_slot 逼出来的真实分支，不是理论情况
 *   ② PATCH 的受限口径：改 content 必须被拒，且提示正确的替代路径
 *      （docs/04 §23 与 Q1 冲突，本实现按 Q1 保守处理）
 *
 * 【为什么允许连真实 embedding 服务】
 *   /memories/search 走完整的检索链路（这是它存在的意义：
 *   调试用，必须与 Agent 实际用的路径一致）。因此这一条测试
 *   依赖正在运行的 embedding 容器 —— 已在用例内显式标注。
 *
 * 前置：docker compose up -d postgres embedding
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { eq } from 'drizzle-orm';

import { closePool, db } from '../database/client.js';
import { memories } from '../database/schema/memories.js';
import { ensureDefaultUser } from '../database/repository/user-store.js';
import { assertTestDatabase } from '../shared/test-guard.js';
import { emptyDiagnostics } from '../memory/extraction-schema.js';
import { buildServer } from './server.js';
import { IdempotencyStore } from './idempotency.js';
import { ExtractionTrigger } from '../conversation/extraction-trigger.js';
import type { GenerateInput, LLMProvider } from '../llm/provider.js';
import type { LLMGenerateResult, LLMStreamChunk } from '../llm/types.js';

after(async () => {
  await closePool();
});

// ============================================================
// 测试夹具
// ============================================================

/** 最小可用的假 Provider：记忆接口不该调用 LLM，这个只是为了让服务器能装配 */
class StubProvider implements LLMProvider {
  readonly providerName = 'stub';
  readonly defaultModel = 'stub-model';

  generate(_input: GenerateInput): Promise<LLMGenerateResult> {
    return Promise.resolve({
      content: '',
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      model: 'stub-model',
      finishReason: 'stop',
    });
  }

  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<LLMStreamChunk> {
    throw new Error('本测试不使用 stream');
  }
}

interface MemoryFixture {
  app: FastifyInstance;
  userId: string;
  /** 直接往库里塞一条记忆，返回 id。**绕过 HTTP**，用于准备前置数据 */
  seed: (m: {
    content: string;
    type?: string;
    subjectKey?: string | null;
    predicateKey?: string | null;
    objectValue?: string | null;
    status?: 'active' | 'conflict' | 'superseded' | 'archived' | 'deleted';
    importanceScore?: number;
  }) => Promise<string>;
}

/**
 * 准备一个测试服务器 + 默认用户。
 *
 * ⚠️ 怎么隔离数据：用**默认用户**（name='me'）自己，但在用例开始时
 *    删掉它名下的全部记忆，结束时再删一次。
 *
 *    为什么不用一个专属用户 + 让 getOrCreateDefaultUser 指向它：
 *    那需要改动 users 的 created_at 去「抢最早」的位置 ——
 *    实测这样做会污染全局状态，并让另一个测试文件（server.test.ts）
 *    的会话列表断言失败。夹具不该为了自己方便去改写别人的数据。
 *
 *    「按 name 找默认用户」这个确定性（见 user-store.ts）正是为此服务的：
 *    它让「库里有几个用户」不再影响结果。
 */
async function withMemoryFixture(fn: (f: MemoryFixture) => Promise<void>): Promise<void> {
  /**
   * ⚠️ 第一件事就是确认连的是测试库。
   *
   * 这个夹具会**删除数据**，而它曾经跑在开发库上，
   * 把真实抽取的记忆连同向量一起清空了（2026-09-23 实际事故）。
   * 守卫在这里挡住，而不是靠"记得改 DATABASE_URL"。
   */
  assertTestDatabase('memory-routes.test.ts / withMemoryFixture');

  const app = await buildServer({
    logLevel: 'silent',
    provider: new StubProvider(),
    chatIdempotency: new IdempotencyStore(),
    extractionTrigger: new ExtractionTrigger({ run: async () => emptySummary() }),
    retrieveMemories: null,
  });

  const user = await ensureDefaultUser();

  // 前置：清空该用户名下的记忆，让断言不依赖此前遗留的数据
  await db.delete(memories).where(eq(memories.userId, user.id));

  const seed: MemoryFixture['seed'] = async (m) => {
    const status = m.status ?? 'active';

    const inserted = await db
      .insert(memories)
      .values({
        userId: user.id,
        type: m.type ?? 'fact',
        content: m.content,
        subjectKey: m.subjectKey === undefined ? 'user' : m.subjectKey,
        predicateKey: m.predicateKey ?? null,
        objectValue: m.objectValue ?? null,
        status,
        importanceScore: m.importanceScore ?? 0.6,

        /**
         * ⚠️ 状态与必填字段必须自洽，否则库层 CHECK 会拒绝插入：
         *      chk_memories_superseded 要求 superseded_by 非空时才允许 superseded
         *      chk_memories_deleted    要求 deleted_at 非空时才允许 deleted
         *
         *    这里是**库层约束在正确地拦住一个不真实的数据构造**，
         *    不是测试的障碍 —— 说明约束确实生效了。
         *    夹具只能在造数据时把不变量补齐，不能绕过它们。
         */
        ...(status === 'superseded'
          ? {
              // 指向一个不存在的 id：C23 明确 superseded_by 没有外键，
              // 悬空指针是允许的状态（替代者可能已被物理删除）
              supersededBy: '00000000-0000-4000-8000-0000000000ff',
              validUntil: new Date(),
            }
          : {}),
        ...(status === 'deleted' ? { deletedAt: new Date() } : {}),
      })
      .returning({ id: memories.id });

    return inserted[0]!.id;
  };

  try {
    await fn({ app, userId: user.id, seed });
  } finally {
    await app.close();
    // 清理：不留下测试记忆（否则下次跑测试时列表断言会看到它们）
    await db.delete(memories).where(eq(memories.userId, user.id));
  }
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

/** inject 的类型包装：不包一层的话 TS 会把返回值推成联合类型，取 .json() 会报错 */
function req(app: FastifyInstance, opts: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject(opts);
}

// ============================================================
// 列表
// ============================================================

test('GET /memories 只返回当前有效记忆，分页结构符合 docs/04 §8', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    await seed({ content: '用户住在成都', predicateKey: 'residence.city', objectValue: '成都' });
    await seed({ content: '用户以前住在杭州', status: 'superseded' });
    await seed({ content: '已删除的记忆', status: 'deleted' });

    const res = await req(app, { method: 'GET', url: '/api/v1/memories' });
    assert.equal(res.statusCode, 200);

    const { items, pagination } = res.json().data;
    assert.equal(pagination.total, 1, 'superseded 与 deleted 都不属于"当前有效"');
    assert.equal(items[0].content, '用户住在成都');
    assert.equal(items[0].predicate_key, 'residence.city');
    assert.equal(items[0].object_value, '成都');
  });
});

test('GET /memories?view=management 能看到 conflict 与 archived，但仍看不到已删除的', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    await seed({ content: '生效中' });
    await seed({ content: '待裁决', status: 'conflict' });
    await seed({ content: '已归档', status: 'archived' });
    await seed({ content: '已删除', status: 'deleted' });

    const res = await req(app, { method: 'GET', url: '/api/v1/memories?view=management' });
    const contents = (res.json().data.items as { content: string }[]).map((m) => m.content);

    assert.equal(contents.length, 3);
    assert.ok(contents.includes('待裁决'));
    assert.ok(contents.includes('已归档'));
    assert.ok(
      !contents.includes('已删除'),
      '已删除的绝不出现在管理页 —— 用户删了就不该再看到内容'
    );
  });
});

test('GET /memories?type= 按类型过滤', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    await seed({ content: '一条事实', type: 'fact' });
    await seed({ content: '一条偏好', type: 'preference' });

    const res = await req(app, { method: 'GET', url: '/api/v1/memories?type=preference' });
    const items = res.json().data.items as { content: string }[];

    assert.equal(items.length, 1);
    assert.equal(items[0]!.content, '一条偏好');
  });
});

test('GET /memories?status= 支持逗号分隔的多状态', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    await seed({ content: '待裁决', status: 'conflict' });
    await seed({ content: '已归档', status: 'archived' });
    await seed({ content: '生效中', status: 'active' });

    const res = await req(app, {
      method: 'GET',
      url: '/api/v1/memories?view=management&status=conflict,archived',
    });
    const contents = (res.json().data.items as { content: string }[]).map((m) => m.content);

    assert.equal(contents.length, 2);
    assert.ok(!contents.includes('生效中'));
  });
});

test('GET /memories?type=非法值 → 422', async () => {
  await withMemoryFixture(async ({ app }) => {
    const res = await req(app, { method: 'GET', url: '/api/v1/memories?type=nonsense' });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  });
});

// ============================================================
// 详情
// ============================================================

test('GET /memories/:id 返回详情，并标明是否参与冲突判定', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    const id = await seed({
      content: '有槽位的记忆',
      predicateKey: 'residence.city',
      objectValue: '成都',
    });

    const res = await req(app, { method: 'GET', url: `/api/v1/memories/${id}` });
    assert.equal(res.statusCode, 200);

    const data = res.json().data;
    assert.equal(data.id, id);
    assert.equal(data.participates_in_conflict, true);
    assert.equal(typeof data.importance_score, 'number');
  });
});

test('GET /memories/:id 无槽位记忆标明不参与冲突判定（C28）', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    const id = await seed({ content: '没有槽位的记忆', predicateKey: null });

    const res = await req(app, { method: 'GET', url: `/api/v1/memories/${id}` });
    assert.equal(res.json().data.participates_in_conflict, false);
  });
});

test('GET /memories/:id 待裁决的冲突记忆能打开（不是 404）', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    const id = await seed({ content: '待裁决', status: 'conflict' });

    const res = await req(app, { method: 'GET', url: `/api/v1/memories/${id}` });
    assert.equal(res.statusCode, 200, '管理页点到冲突记忆不该 404');
    assert.equal(res.json().data.status, 'conflict');
  });
});

test('GET /memories/:id 已删除的记忆 → 404 且提示已删除', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    const id = await seed({ content: '已删除', status: 'deleted' });

    const res = await req(app, { method: 'GET', url: `/api/v1/memories/${id}` });
    assert.equal(res.statusCode, 404);
    assert.match(res.json().error.message, /已删除/);
  });
});

test('GET /memories/:id 非法 UUID → 422，不查库', async () => {
  await withMemoryFixture(async ({ app }) => {
    const res = await req(app, { method: 'GET', url: '/api/v1/memories/not-a-uuid' });
    assert.equal(res.statusCode, 422);
  });
});

// ============================================================
// 手工创建
// ============================================================

test('POST /memories 创建成功返回 201，来源类型是 manual', async () => {
  await withMemoryFixture(async ({ app }) => {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/memories',
      payload: { type: 'preference', content: '用户喜欢直接、具体的技术解释' },
    });

    assert.equal(res.statusCode, 201);
    const data = res.json().data;
    assert.equal(data.type, 'preference');
    assert.equal(data.status, 'active');
    assert.equal(data.confidence_score, 1.0, '用户自己说的，置信度给满');
  });
});

test('POST /memories 拒绝 type=goal（审计 F-06：必须走 Goal 实体）', async () => {
  await withMemoryFixture(async ({ app }) => {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/memories',
      payload: { type: 'goal', content: '用户想学会 Rust' },
    });

    /**
     * 允许它会造成同一个目标有两处真相：
     * goals 表里没有这条目标，且 Goal 的状态机对它不生效。
     */
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
  });
});

test('POST /memories 拒绝 type=event（同上，必须走 events）', async () => {
  await withMemoryFixture(async ({ app }) => {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/memories',
      payload: { type: 'event', content: '用户今天换了工作' },
    });

    assert.equal(res.statusCode, 422);
  });
});

test('POST /memories 同槽位重复 → 409（部分唯一索引生效）', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    await seed({ content: '用户住在成都', predicateKey: 'residence.city', objectValue: '成都' });

    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/memories',
      payload: {
        type: 'fact',
        content: '用户住在重庆',
        subject_key: 'user',
        predicate_key: 'residence.city',
        object_value: '重庆',
      },
    });

    /**
     * 这是 uq_memories_current_slot 在拦人。正确路径是走「替代」语义
     * （新建 + 失效旧的），而不是盲目新建 —— 但那个端点尚未实现，
     * 因此当前只能报 409。已记入交付说明。
     */
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'CONFLICT');
  });
});

test('POST /memories 词表外的 predicate_key → 422', async () => {
  await withMemoryFixture(async ({ app }) => {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/memories',
      payload: {
        type: 'fact',
        content: '随便编一个槽位',
        predicate_key: 'made.up.slot',
      },
    });

    assert.equal(res.statusCode, 422, '槽位必须来自受控词表');
  });
});

test('POST /memories 未知字段 → 422（strict 模式，不静默忽略）', async () => {
  await withMemoryFixture(async ({ app }) => {
    const res = await req(app, {
      method: 'POST',
      url: '/api/v1/memories',
      payload: { type: 'fact', content: '有未知字段', is_admin: true },
    });

    assert.equal(res.statusCode, 422, '多传字段通常是客户端 bug，应暴露而不是忽略');
  });
});

// ============================================================
// 更新（受限口径）
// ============================================================

test('PATCH /memories/:id 允许改 importance_score', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    const id = await seed({ content: '一条记忆', importanceScore: 0.3 });

    const res = await req(app, {
      method: 'PATCH',
      url: `/api/v1/memories/${id}`,
      payload: { importance_score: 0.9 },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.importance_score, 0.9);
  });
});

test('PATCH /memories/:id 拒绝改 content（Q1：正文永不就地修改）', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    const id = await seed({ content: '用户住在杭州' });

    const res = await req(app, {
      method: 'PATCH',
      url: `/api/v1/memories/${id}`,
      payload: { content: '用户住在成都' },
    });

    /**
     * docs/04 §23 允许改 content，但 Q1 与 docs/03 §13.1 明确禁止 ——
     * 就地改会让「用户过去住在杭州」这段历史事实消失。
     * 本实现按 Q1 处理：拒绝，并让客户端知道正确路径。
     */
    assert.equal(res.statusCode, 422);
  });
});

test('PATCH /memories/:id 空 body → 400', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    const id = await seed({ content: '一条记忆' });

    const res = await req(app, { method: 'PATCH', url: `/api/v1/memories/${id}`, payload: {} });
    assert.equal(res.statusCode, 400);
  });
});

test('PATCH /memories/:id 已删除的记忆 → 409', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    const id = await seed({ content: '已删除', status: 'deleted' });

    const res = await req(app, {
      method: 'PATCH',
      url: `/api/v1/memories/${id}`,
      payload: { importance_score: 0.9 },
    });

    assert.equal(res.statusCode, 409);
  });
});

// ============================================================
// 删除与恢复（本文件的重点）
// ============================================================

test('DELETE /memories/:id 软删除后从列表消失，且详情 404', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    const id = await seed({ content: '要删掉的记忆' });

    const del = await req(app, { method: 'DELETE', url: `/api/v1/memories/${id}` });
    assert.equal(del.statusCode, 200);
    assert.equal(del.json().data.status, 'deleted');

    const list = await req(app, { method: 'GET', url: '/api/v1/memories' });
    assert.equal(list.json().data.pagination.total, 0, '删除后应从列表消失');

    const detail = await req(app, { method: 'GET', url: `/api/v1/memories/${id}` });
    assert.equal(detail.statusCode, 404);
  });
});

test('DELETE 已删除的记忆 → 404（不静默成功）', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    const id = await seed({ content: '已删除', status: 'deleted' });

    const res = await req(app, { method: 'DELETE', url: `/api/v1/memories/${id}` });
    assert.equal(res.statusCode, 404);
  });
});

test('POST /:id/restore 恢复后回到列表，became_conflict=false', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    const id = await seed({ content: '先删后恢复' });

    await req(app, { method: 'DELETE', url: `/api/v1/memories/${id}` });
    const res = await req(app, { method: 'POST', url: `/api/v1/memories/${id}/restore` });

    assert.equal(res.statusCode, 200);
    const data = res.json().data;
    assert.equal(data.status, 'active');
    assert.equal(data.became_conflict, false);

    const list = await req(app, { method: 'GET', url: '/api/v1/memories' });
    assert.equal(list.json().data.pagination.total, 1);
  });
});

test('POST /:id/restore 槽位已被占用时转为 conflict，而不是撞唯一索引', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    const slot = { predicateKey: 'residence.city', objectValue: '杭州' };

    const first = await seed({ content: '用户住在杭州', ...slot });
    await req(app, { method: 'DELETE', url: `/api/v1/memories/${first}` });

    /**
     * 删掉之后同槽位插入新的 —— 模拟「用户改了口径」。
     * 此处直接用 status='deleted' 的旧行腾出槽位，新行才能进。
     */
    await seed({ content: '用户住在成都', ...slot });

    const res = await req(app, { method: 'POST', url: `/api/v1/memories/${first}/restore` });
    assert.equal(res.statusCode, 200);

    const data = res.json().data;
    /**
     * 直接置 active 会撞 uq_memories_current_slot（同槽位只能有一条 active），
     * 因此必须转 conflict 等用户裁决。
     * 前端必须据此提示 —— 否则用户会以为"恢复了但搜不到"是 bug。
     */
    assert.equal(data.became_conflict, true);
    assert.equal(data.status, 'conflict');
  });
});

test('POST /:id/restore 未删除的记忆 → 409', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    const id = await seed({ content: '还活着' });

    const res = await req(app, { method: 'POST', url: `/api/v1/memories/${id}/restore` });
    assert.equal(res.statusCode, 409);
  });
});

// ============================================================
// 搜索（docs/04 §20）
// ============================================================

test('GET /memories/search 返回带分数与通道名次的结果 + 诊断', async () => {
  /**
   * ⚠️ 本用例**依赖正在运行的 embedding 容器**：
   *    /memories/search 刻意走完整检索链路（它存在的意义就是调试检索），
   *    因此不 mock embedding。容器未启动时本用例会失败 —— 这是刻意的，
   *    静默跳过会让「检索其实已经坏了」不被发现。
   */
  await withMemoryFixture(async ({ app, seed }) => {
    await seed({
      content: '用户正在学习 Rust',
      type: 'fact',
      predicateKey: 'skill.learning',
      objectValue: 'Rust',
    });

    const res = await req(app, { method: 'GET', url: '/api/v1/memories/search?q=Rust' });
    assert.equal(res.statusCode, 200);

    const data = res.json().data;
    assert.ok(Array.isArray(data.items));
    assert.ok(data.diagnostics, '诊断信息应存在');
    assert.equal(typeof data.diagnostics.timings.total, 'number');

    if (data.items.length > 0) {
      const hit = data.items[0];
      assert.ok(hit.id);
      assert.equal(typeof hit.score, 'number');
      assert.ok(hit.ranks, '应带各通道名次，便于排查"为什么这条被召回"');
    }
  });
});

test('GET /memories/search 空查询 → 422', async () => {
  await withMemoryFixture(async ({ app }) => {
    const res = await req(app, { method: 'GET', url: '/api/v1/memories/search?q=' });
    assert.equal(res.statusCode, 422);
  });
});

test('GET /memories/search 不返回已删除的记忆', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    await seed({ content: '用户正在学习 Rust', predicateKey: 'skill.learning' });
    await seed({ content: '用户正在学习 Rust 的旧记录', status: 'deleted' });

    const res = await req(app, { method: 'GET', url: '/api/v1/memories/search?q=Rust' });
    const contents = (res.json().data.items as { content: string }[]).map((m) => m.content);

    assert.ok(
      !contents.some((c) => c.includes('旧记录')),
      '已删除的记忆绝不能被召回（§18.3 的隐私要求）'
    );
  });
});

// ============================================================
// 来源
// ============================================================

test('GET /memories/:id/sources 无来源时返回空数组', async () => {
  await withMemoryFixture(async ({ app, seed }) => {
    const id = await seed({ content: '通过 seed 直接插入，没有来源行' });

    const res = await req(app, { method: 'GET', url: `/api/v1/memories/${id}/sources` });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().data.items, []);
  });
});

test('GET /memories/:id/sources 不存在的记忆 → 404', async () => {
  await withMemoryFixture(async ({ app }) => {
    const res = await req(app, {
      method: 'GET',
      url: '/api/v1/memories/00000000-0000-4000-8000-000000000000/sources',
    });
    assert.equal(res.statusCode, 404);
  });
});
