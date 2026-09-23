/**
 * RRF 融合与重排的单元测试
 *
 * 【为什么这组测试价值高】
 *   §18.4 里的几条规则写错了**不会报错**，只会让排序悄悄变差：
 *     · fact 被误衰减 → 两年前的事实排到后面，用户觉得"它忘了"
 *     · state 不衰减   → 半年前的"最近很烦"被当成当前情绪
 *     · 向量分用 min-max 归一化 → 「三条都不相关」与「三条都相关」同分
 *   这些都是"结果看起来正常但其实是错的"，只有断言过才会被记住。
 *
 * 本文件不需要数据库、不需要 embedding 服务，因此可以覆盖全部分支。
 *
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Memory } from '../database/schema/memories.js';
import {
  fuseByRrf,
  normalizeVector,
  rerank,
  decay,
  typeAwareRecency,
} from './retrieval-fusion.js';
import {
  NORM_VECTOR_MAX,
  NORM_VECTOR_MIN,
  RRF_K,
  RERANK_WEIGHTS,
  SOURCE_COUNT_SATURATION,
} from './retrieval-config.js';

// ============================================================
// 测试数据构造
// ============================================================

const NOW = new Date('2026-09-23T12:00:00Z');

/** 造一条记忆。只填断言会用到的字段，其余给缺省值 */
function mem(partial: Partial<Memory> & { id: string }): Memory {
  return {
    userId: 'u1',
    type: 'fact',
    content: `content-${partial.id}`,
    subjectKey: 'user',
    predicateKey: null,
    objectValue: null,
    polarity: null,
    importanceScore: 0.5,
    confidenceScore: 1.0,
    status: 'active',
    validFrom: null,
    validUntil: null,
    supersededBy: null,
    sourceCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...partial,
  };
}

/** 从「天数前」构造 createdAt */
function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 86_400_000);
}

// ============================================================
// RRF 融合
// ============================================================

test('fuseByRrf：单通道时得分 = 1/(k+rank)，rank 从 1 起', () => {
  const fused = fuseByRrf([{ channel: 'vector', ids: ['a', 'b'] }]);

  assert.equal(fused.get('a')!.rrfScore, 1 / (RRF_K + 1));
  assert.equal(fused.get('b')!.rrfScore, 1 / (RRF_K + 2));
  assert.equal(fused.get('a')!.ranks.vector, 1);
  assert.equal(fused.get('b')!.ranks.vector, 2);
});

test('fuseByRrf：两通道都命中的候选得分累加，高于只命中一次的第一名', () => {
  const fused = fuseByRrf([
    { channel: 'vector', ids: ['onlyVector', 'both'] },
    { channel: 'keyword', ids: ['both', 'onlyKeyword'] },
  ]);

  const both = fused.get('both')!;
  const onlyVector = fused.get('onlyVector')!;

  // both: 向量第2 + 关键词第1 = 1/62 + 1/61
  assert.equal(both.rrfScore, 1 / (RRF_K + 2) + 1 / (RRF_K + 1));
  assert.ok(
    both.rrfScore > onlyVector.rrfScore,
    '两个通道都认可的候选应排在只有一个通道的第 1 名之前'
  );
  assert.deepEqual(both.ranks, { vector: 2, keyword: 1 });
});

test('fuseByRrf：三个通道都参与，ranks 记录各通道名次', () => {
  const fused = fuseByRrf([
    { channel: 'vector', ids: ['x'] },
    { channel: 'keyword', ids: ['x'] },
    { channel: 'slot', ids: ['x'] },
  ]);

  assert.deepEqual(fused.get('x')!.ranks, { vector: 1, keyword: 1, slot: 1 });
  assert.equal(fused.get('x')!.rrfScore, 3 / (RRF_K + 1));
});

test('fuseByRrf：空输入返回空 Map，不抛错', () => {
  assert.equal(fuseByRrf([]).size, 0);
  assert.equal(fuseByRrf([{ channel: 'vector', ids: [] }]).size, 0);
});

// ============================================================
// 向量分归一化
// ============================================================

test('normalizeVector：低于下界的相似度归零，不按 [-1,1] 线性映射', () => {
  /**
   * 这是关键的一条。bge-m3 在短文本上的实际相似度集中在 0.3~0.65，
   * 若按 [-1,1] 映射，一个 0.45 的「无关」结果会得到 0.72 的高分 ——
   * 占权重 0.55 的那一项就变成了噪音源。
   */
  assert.equal(normalizeVector(NORM_VECTOR_MIN), 0);
  assert.equal(normalizeVector(NORM_VECTOR_MIN - 0.1), 0);
  assert.equal(normalizeVector(-0.2), 0);

  /**
   * ⚠️ 断言用常量而不是硬编码 0.5：
   *    NORM_VECTOR_MIN 是**实测校准值**（2026-09-23 从 0.5 改为 0.35，
   *    因为它把 87.5% 的相似度都归零了）。硬编码会让每次校准都误报失败。
   */
  assert.ok(NORM_VECTOR_MIN < 0.45, '下界应低于「无关」内容的相似度区间上界');
});

test('normalizeVector：下界之上线性映射到 [0,1]，上界封顶', () => {
  assert.equal(normalizeVector(NORM_VECTOR_MAX), 1);
  assert.equal(normalizeVector(1.5), 1, '超过理论上界也封顶');
  assert.equal(normalizeVector(NORM_VECTOR_MIN), 0);

  // 下界与上界的中点应映射到 0.5
  const mid = (NORM_VECTOR_MIN + NORM_VECTOR_MAX) / 2;
  assert.ok(Math.abs(normalizeVector(mid) - 0.5) < 1e-9);
});

test('normalizeVector：没有向量分（undefined）得 0，不抛错', () => {
  assert.equal(normalizeVector(undefined), 0);
});

// ============================================================
// 时效项（§18.4 的 type_aware_recency）
// ============================================================

test('typeAwareRecency：fact 永不衰减 —— 两年前的事实仍得满分', () => {
  /**
   * §18.4 特意用「重要」标出这一条：
   *   两年前的「用户是软件工程师」依然有效，
   *   不该因为「旧」被系统性降权。
   * 写错这一条的直接表现就是「用久了它反而忘了我是谁」。
   */
  const old = mem({ id: 'f', type: 'fact', createdAt: daysAgo(730) });
  assert.equal(typeAwareRecency(old, NOW), 1.0);
});

test('typeAwareRecency：event 与 relationship 也不衰减', () => {
  assert.equal(typeAwareRecency(mem({ id: 'e', type: 'event', createdAt: daysAgo(1000) }), NOW), 1.0);
  assert.equal(
    typeAwareRecency(mem({ id: 'r', type: 'relationship', createdAt: daysAgo(1000) }), NOW),
    1.0
  );
});

test('typeAwareRecency：state 按 14 天半衰期快速衰减', () => {
  const fresh = mem({ id: 's1', type: 'state', createdAt: NOW });
  const halfLife = mem({ id: 's2', type: 'state', createdAt: daysAgo(14) });
  const stale = mem({ id: 's3', type: 'state', createdAt: daysAgo(56) });

  assert.equal(typeAwareRecency(fresh, NOW), 1.0);
  assert.ok(Math.abs(typeAwareRecency(halfLife, NOW) - 0.5) < 1e-9, '14 天后应恰好衰减一半');
  assert.ok(Math.abs(typeAwareRecency(stale, NOW) - 0.0625) < 1e-9, '56 天 = 4 个半衰期');
});

test('typeAwareRecency：preference 缓慢衰减且有 0.5 下限', () => {
  const fresh = mem({ id: 'p1', type: 'preference', createdAt: NOW });
  const veryOld = mem({ id: 'p2', type: 'preference', createdAt: daysAgo(3650) });

  assert.equal(typeAwareRecency(fresh, NOW), 1.0);
  assert.ok(typeAwareRecency(veryOld, NOW) >= 0.5, '偏好再久也不该掉到 0.5 以下');
  assert.ok(typeAwareRecency(veryOld, NOW) <= 0.51, '十年后应接近下限');
});

test('typeAwareRecency：event / state 用 valid_from 而不是 created_at', () => {
  /**
   * 用户今天补记「去年三月换了工作」时，这件事的时效性应由
   * **事件发生时间**决定。用 created_at 会让一年前的事看起来像新事。
   */
  const backfilled = mem({
    id: 's',
    type: 'state',
    createdAt: NOW, // 今天才记录
    validFrom: daysAgo(28), // 但事情发生在 28 天前（= 2 个半衰期）
  });

  assert.ok(
    Math.abs(typeAwareRecency(backfilled, NOW) - 0.25) < 1e-9,
    '应按 valid_from 算，28 天 = 2 个半衰期 → 0.25'
  );
});

test('typeAwareRecency：goal 只有 active 得满分', () => {
  assert.equal(typeAwareRecency(mem({ id: 'g1', type: 'goal', status: 'active' }), NOW), 1.0);
  assert.equal(typeAwareRecency(mem({ id: 'g2', type: 'goal', status: 'conflict' }), NOW), 0);
});

test('typeAwareRecency：valid_from 在未来时不产生负天数（时钟偏差防护）', () => {
  const future = mem({ id: 'x', type: 'state', validFrom: new Date(NOW.getTime() + 86_400_000) });
  const score = typeAwareRecency(future, NOW);
  assert.ok(score <= 1.0, `不应超过 1.0，实际 ${score}`);
  assert.equal(score, 1.0);
});

test('decay：半衰期处恰好减半，零或负半衰期返回 0 而不是 NaN', () => {
  assert.ok(Math.abs(decay(10, 10) - 0.5) < 1e-12);
  assert.ok(Math.abs(decay(20, 10) - 0.25) < 1e-12);
  assert.equal(decay(5, 0), 0);
  assert.equal(decay(5, -1), 0);
});

// ============================================================
// 重排
// ============================================================

test('rerank：按加权和排序，各分项写入 normalized 便于评测分析', () => {
  const high = mem({ id: 'high', importanceScore: 0.9 });
  const low = mem({ id: 'low', importanceScore: 0.1 });

  const fused = fuseByRrf([{ channel: 'vector', ids: ['high', 'low'] }]);
  const scored = rerank(
    [
      { memory: high, vectorScore: 0.9 },
      { memory: low, vectorScore: 0.6 },
    ],
    fused,
    NOW
  );

  assert.equal(scored[0]!.memory.id, 'high');
  assert.equal(scored[1]!.memory.id, 'low');

  // 逐项核对权重应用是否正确
  const item = scored[0]!;
  const expected =
    RERANK_WEIGHTS.vector * item.normalized.vector +
    RERANK_WEIGHTS.importance * item.normalized.importance +
    RERANK_WEIGHTS.recency * item.normalized.recency +
    RERANK_WEIGHTS.sourceCount * item.normalized.sourceCount;
  assert.ok(Math.abs(item.finalScore - expected) < 1e-12);
});

test('rerank：向量分优势可以盖过 RRF 排名劣势（两阶段各司其职）', () => {
  /**
   * RRF 只看名次，重排看实际分数。
   * 因此「向量第 2 名但相似度极高」应当能超过「向量第 1 名但相似度一般」。
   * 若这条失败，说明某一阶段被另一阶段覆盖掉了。
   */
  const a = mem({ id: 'a', importanceScore: 0.5 });
  const b = mem({ id: 'b', importanceScore: 0.5 });

  const fused = fuseByRrf([{ channel: 'vector', ids: ['a', 'b'] }]);

  const scored = rerank(
    [
      { memory: a, vectorScore: 0.62 }, // RRF 第 1，但相似度一般
      { memory: b, vectorScore: 0.98 }, // RRF 第 2，但相似度极高
    ],
    fused,
    NOW
  );

  assert.equal(scored[0]!.memory.id, 'b', '重排应让高相似度的 b 胜出');
});

test('rerank：缺少向量分的候选靠重要性/时效仍能排上来，不被一票否决', () => {
  const noVector = mem({ id: 'nv', importanceScore: 1.0, createdAt: NOW });
  const weakVector = mem({ id: 'wv', importanceScore: 0.0, createdAt: NOW });

  const fused = fuseByRrf([{ channel: 'keyword', ids: ['nv'] }]);

  const scored = rerank(
    [
      { memory: noVector, vectorScore: undefined },
      { memory: weakVector, vectorScore: 0.55 }, // 刚过下界，归一化后接近 0
    ],
    fused,
    NOW
  );

  assert.equal(scored[0]!.memory.id, 'nv');
  assert.equal(scored[0]!.normalized.vector, 0, '没有向量分时向量项为 0');
});

test('rerank：source_count 饱和，提到 30 次不比 5 次高', () => {
  const many = mem({ id: 'many', sourceCount: 30 });
  const sat = mem({ id: 'sat', sourceCount: SOURCE_COUNT_SATURATION });

  const fused = fuseByRrf([{ channel: 'vector', ids: ['many', 'sat'] }]);
  const scored = rerank(
    [
      { memory: many, vectorScore: 0.9 },
      { memory: sat, vectorScore: 0.9 },
    ],
    fused,
    NOW
  );

  assert.equal(scored[0]!.normalized.sourceCount, 1);
  assert.equal(scored[1]!.normalized.sourceCount, 1);
});

test('rerank：同分时排序确定，不依赖输入顺序', () => {
  /**
   * 没有次级排序键时，同分候选的顺序取决于输入顺序，
   * 表现为「同一份数据两次检索给出不同结果」——
   * 在离线评测里这会变成无法解释的指标抖动。
   */
  const x = mem({ id: 'x', importanceScore: 0.5, createdAt: NOW });
  const y = mem({ id: 'y', importanceScore: 0.5, createdAt: NOW });

  const fused = fuseByRrf([{ channel: 'vector', ids: ['x', 'y'] }]);

  const forward = rerank([{ memory: x }, { memory: y }], fused, NOW).map((s) => s.memory.id);
  const backward = rerank([{ memory: y }, { memory: x }], fused, NOW).map((s) => s.memory.id);

  assert.deepEqual(forward, backward, '两种输入顺序应得到同一结果');
});

test('rerank：空输入返回空数组', () => {
  assert.deepEqual(rerank([], new Map(), NOW), []);
});

test('rerank：importance 越界值被夹到 [0,1]，防止脏数据放大权重', () => {
  const bad = mem({ id: 'bad', importanceScore: 5 });
  const fused = fuseByRrf([{ channel: 'vector', ids: ['bad'] }]);
  const scored = rerank([{ memory: bad, vectorScore: 0.9 }], fused, NOW);

  assert.equal(scored[0]!.normalized.importance, 1, '越界值应被夹到 1 而不是放大到 5');
});
