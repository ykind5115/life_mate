/**
 * 记忆判定流程测试（§13.7）
 *
 * 覆盖判定树的每一个分支。LLM 三选一用注入的假判定器，
 * 因此这些用例是**确定性**的 —— 不依赖真实模型输出。
 *
 * 这正是 Q2 结构化抽取的价值：判定可回归测试。
 * 若判定完全交给 LLM 自由发挥，这些用例根本无法稳定编写。
 *
 * 运行：pnpm test（需要 postgres 容器）
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { sql } from 'drizzle-orm';

import { closePool } from '../database/client.js';
import { opts, withTestContext } from '../database/repository/_test-helpers.js';
import { conversations } from '../database/schema/conversations.js';
import { messages } from '../database/schema/messages.js';
import {
  findCurrentById,
  findCurrentBySlot,
  listConflicts,
} from '../database/repository/memory-queries.js';
import {
  isEquivalentValue,
  processCandidate,
  slotFingerprint,
  type ExecutorLike,
  type SlotAdjudicator,
} from './candidate-processor.js';
import { normalizeCandidate, parseExtractionResult } from './extraction-schema.js';
import type { CandidateMemory } from './extraction-schema.js';

after(async () => {
  await closePool();
});

/** 构造候选记忆的便捷函数 */
function candidate(partial: Partial<CandidateMemory> & { content: string }): CandidateMemory {
  return { type: 'fact', ...partial };
}

/**
 * 判定流程现在**要求显式提供来源**（source 为必填）。
 *
 * 这些用例不涉及真实消息，因此传空数组 —— 等价于「无消息来源」，
 * 判定流程会写成 sourceType='manual'。
 * 真实抽取编排会传入本次覆盖的 messageId，见 pipeline 实现。
 */
const NO_SOURCE = { messageIds: [] as string[] };

/** 固定判定的假判定器，覆盖三个分支 */
function fixedAdjudicator(
  verdict: 'state_change' | 'conflict' | 'coexist'
): SlotAdjudicator {
  return {
    adjudicate: async () => verdict,
  };
}

// ============================================================
// 分支一：无槽位
// ============================================================

test('无槽位候选 → 直接新增，不参与冲突判定', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const a = await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(candidate({ content: '用户今天心情不错' })),
      executor: exec as unknown as ExecutorLike,
    });
    assert.equal(a.kind, 'created');
    assert.equal(a.reason, 'no_slot');

    // 再来一条内容相同但同样无槽位的 —— 不应去重（数据库表达不了）
    const b = await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(candidate({ content: '用户今天心情不错' })),
      executor: exec as unknown as ExecutorLike,
    });
    assert.equal(b.kind, 'created', '无槽位记忆的重复由抽取器负责，判定流程不合并');
  });
});

test('有 predicateKey 但缺 objectValue → 视为无槽位（成对才有效）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const r = await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(
        candidate({ content: '用户偏好某种沟通方式', predicateKey: 'preference.communication_style' })
      ),
      executor: exec as unknown as ExecutorLike,
    });
    assert.equal(r.kind, 'created');
    assert.equal(
      r.reason,
      'no_slot',
      '槽位与取值必须成对；只有槽位无法判定冲突，应降级为无槽位新增'
    );
  });
});

// ============================================================
// 分支二：无同槽位记忆
// ============================================================

test('同槽位无既有记忆 → 新增', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const r = await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(
        candidate({
          content: '用户正在学习 TypeScript',
          predicateKey: 'skill.learning',
          objectValue: 'TypeScript',
        })
      ),
      executor: exec as unknown as ExecutorLike,
    });

    assert.equal(r.kind, 'created');
    assert.equal(r.reason, 'no_existing');
    assert.equal(r.memory.objectValue, 'TypeScript');
  });
});

// ============================================================
// 分支三：取值等价 → 去重合并
// ============================================================

test('同槽位同取值 → 去重合并，不新建记录', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const first = await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(
        candidate({
          content: '用户正在学习 TypeScript',
          predicateKey: 'skill.learning',
          objectValue: 'TypeScript',
          confidence: 0.8,
        })
      ),
      executor: exec as unknown as ExecutorLike,
    });
    assert.equal(first.kind, 'created');

    // 换个说法再提一次
    const second = await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(
        candidate({
          content: '用户最近在学 TypeScript',
          predicateKey: 'skill.learning',
          objectValue: 'typescript', // 大小写不同，应判为等价
          confidence: 0.95,
        })
      ),
      executor: exec as unknown as ExecutorLike,
    });

    assert.equal(second.kind, 'merged');
    assert.equal(second.memory.id, first.memory.id, '不应产生新记录');
    assert.equal(second.memory.sourceCount, 2);
    assert.equal(
      second.memory.content,
      '用户正在学习 TypeScript',
      '正文保持不变 —— 去重不重写正文'
    );
  });
});

test('isEquivalentValue 保守判定：只把规范化后相同的视为等价', () => {
  // 应等价
  assert.equal(isEquivalentValue('TypeScript', 'typescript'), true);
  assert.equal(isEquivalentValue(' 广州 ', '广州'), true);
  assert.equal(isEquivalentValue('ＡＢＣ', 'ABC'), true, '全角应归一化');

  // 不应等价 —— 这些必须进 LLM 判定，不能被误合并
  assert.equal(isEquivalentValue('广州', '深圳'), false);
  assert.equal(isEquivalentValue('广州', '广州市'), false, '宁可多问一次，不可错合并');
  assert.equal(isEquivalentValue('广州', null), false);
  assert.equal(isEquivalentValue(null, '广州'), false);
  assert.equal(isEquivalentValue(null, null), true);
});

// ============================================================
// 分支四：取值不同 → LLM 三选一
// ============================================================

test('取值不同 + state_change → supersede，旧记忆保留为历史', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const first = await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(
        candidate({
          content: '用户住在广州',
          predicateKey: 'residence.city',
          objectValue: '广州',
        })
      ),
      executor: exec as unknown as ExecutorLike,
    });
    assert.equal(first.kind, 'created');

    const second = await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(
        candidate({
          content: '用户已搬到深圳',
          predicateKey: 'residence.city',
          objectValue: '深圳',
        })
      ),
      adjudicator: fixedAdjudicator('state_change'),
      executor: exec as unknown as ExecutorLike,
    });

    assert.equal(second.kind, 'superseded');
    assert.equal(second.memory.objectValue, '深圳');
    assert.equal(second.previous.status, 'superseded');
    assert.equal(second.previous.supersededBy, second.memory.id);
    assert.equal(second.previous.content, '用户住在广州', '旧正文保留为历史事实');

    // 当前有效只剩新记忆
    const current = await findCurrentBySlot(
      { userId, subjectKey: 'user', predicateKey: 'residence.city' },
      opts(exec)
    );
    assert.equal(current?.objectValue, '深圳');
  });
});

test('取值不同 + conflict → 以 conflict 状态落库，等用户裁决', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const first = await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(
        candidate({
          content: '用户婚恋状态是单身',
          predicateKey: 'health.status',
          objectValue: '单身',
        })
      ),
      executor: exec as unknown as ExecutorLike,
    });
    assert.equal(first.kind, 'created');

    const second = await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(
        candidate({
          content: '用户婚恋状态是已婚',
          predicateKey: 'health.status',
          objectValue: '已婚',
        })
      ),
      adjudicator: fixedAdjudicator('conflict'),
      executor: exec as unknown as ExecutorLike,
    });

    assert.equal(second.kind, 'conflict');
    assert.equal(second.memory.status, 'conflict');
    assert.equal(
      await findCurrentById(second.memory.id, opts(exec)),
      undefined,
      'conflict 记忆不应被当作当前有效记忆召回'
    );

    // 原记忆仍是当前有效 —— 冲突不擅自覆盖
    const current = await findCurrentBySlot(
      { userId, subjectKey: 'user', predicateKey: 'health.status' },
      opts(exec)
    );
    assert.equal(current?.objectValue, '单身');

    // 冲突可被列出供用户裁决
    const conflicts = await listConflicts(userId, opts(exec));
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.id, second.memory.id);
  });
});

test('取值不同 + coexist 但未指定新槽位 → 退化为冲突（不硬套槽位）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(
        candidate({
          content: '用户正在学习 Python',
          predicateKey: 'skill.learning',
          objectValue: 'Python',
        })
      ),
      executor: exec as unknown as ExecutorLike,
    });

    const r = await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(
        candidate({
          content: '用户也在用 TypeScript',
          predicateKey: 'skill.learning',
          objectValue: 'TypeScript',
        })
      ),
      adjudicator: fixedAdjudicator('coexist'),
      executor: exec as unknown as ExecutorLike,
    });

    // 关键判断：不允许自动改写槽位 ——
    // 硬套错槽位会污染后续判定，比让用户裁决一次更糟
    assert.equal(r.kind, 'conflict');
    assert.equal(r.reason, 'conflict');
  });
});

test('取值不同 + coexist + 显式指定新槽位 → 用新槽位新增', async () => {
  await withTestContext(async ({ exec, userId }) => {
    await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(
        candidate({
          content: '用户正在学习 Python',
          predicateKey: 'skill.learning',
          objectValue: 'Python',
        })
      ),
      executor: exec as unknown as ExecutorLike,
    });

    const r = await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(
        candidate({
          content: '用户把编程当作兴趣',
          predicateKey: 'skill.learning',
          objectValue: '编程',
        })
      ),
      adjudicator: fixedAdjudicator('coexist'),
      overrideSlot: { predicateKey: 'interest.hobby', objectValue: '编程' },
      executor: exec as unknown as ExecutorLike,
    });

    assert.equal(r.kind, 'created');
    assert.equal(r.reason, 'no_existing', '新槽位上没有既有记忆，应直接新增');
    assert.equal(r.memory.predicateKey, 'interest.hobby');
  });
});

test('无判定器时取值不同一律按冲突处理（保守，不擅自覆盖）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(
        candidate({
          content: '用户目标是学 Rust',
          predicateKey: 'goal.long_term',
          objectValue: 'Rust',
        })
      ),
      executor: exec as unknown as ExecutorLike,
    });

    const r = await processCandidate({
      userId,
      source: NO_SOURCE,
      candidate: normalizeCandidate(
        candidate({
          content: '用户目标是学 Go',
          predicateKey: 'goal.long_term',
          objectValue: 'Go',
        })
      ),
      // 不传 adjudicator
      executor: exec as unknown as ExecutorLike,
    });

    assert.equal(r.kind, 'conflict');
  });
});

// ============================================================
// 抽取结果解析（契约层）
// ============================================================

test('parseExtractionResult 处理裸 JSON', () => {
  const r = parseExtractionResult('{"memories":[]}');
  assert.deepEqual(r.memories, []);
});

test('parseExtractionResult 剥离 markdown 代码块', () => {
  const r = parseExtractionResult(
    '```json\n{"memories":[{"type":"fact","content":"用户在学习 TS"}]}\n```'
  );
  assert.equal(r.memories.length, 1);
  assert.equal(r.memories[0]?.content, '用户在学习 TS');
});

test('parseExtractionResult 容忍前后解释文字', () => {
  const r = parseExtractionResult(
    '好的，抽取结果如下：\n{"memories":[{"type":"preference","content":"用户偏好简洁回答"}]}\n以上。'
  );
  assert.equal(r.memories.length, 1);
});

test('parseExtractionResult 容忍顶层直接是数组', () => {
  const r = parseExtractionResult('[{"type":"fact","content":"用户住在上海"}]');
  assert.equal(r.memories.length, 1);
});

test('parseExtractionResult 对非法 JSON 抛错，而不是返回空结果', () => {
  // 这个行为很关键：返回空结果会被上层当成「这段对话没有值得记的内容」，
  // 从而静默丢失记忆 —— 抽取流水线最危险的失败模式
  assert.throws(() => parseExtractionResult('这不是 JSON'), /合法 JSON/);
});

/**
 * ⚠️ 下面两个用例原本断言「非法值 → 抛错」。
 *    分级策略修订后行为变了：**条目级/字段级问题不再抛错**。
 *    原因见 extraction-schema.ts 文件头 —— 整批抛错会把同批里
 *    完全合格的记忆一起丢掉（实测踩到过）。
 *
 *    这两个用例改为断言新的分级行为，避免它们成为"锁住旧设计"的阻力。
 */
test('枚举外的 type → 丢弃该条（条目级），不抛错', () => {
  const r = parseExtractionResult(
    '{"memories":[{"type":"unknown_type","content":"x"},{"type":"fact","content":"合格的一条"}]}'
  );
  assert.equal(r.memories.length, 1, '不合格条目被丢弃，合格条目保留');
  assert.equal(r.memories[0]?.content, '合格的一条');
});

test('受控词表外的 predicateKey → 降级为无槽位（字段级），不丢条目也不抛错', () => {
  const r = parseExtractionResult(
    '{"memories":[{"type":"fact","content":"有价值的内容","predicateKey":"made.up.slot","objectValue":"y"}]}'
  );

  // 关键：内容被保留。词表外槽位按 §13.7 只是「不参与冲突判定」，
  // 不该连带丢掉整条记忆。
  assert.equal(r.memories.length, 1, '内容有价值，不该因槽位非法而丢条');
  assert.equal(r.memories[0]?.content, '有价值的内容');
  assert.ok(
    r.memories[0]?.predicateKey == null,
    '槽位被降级 —— 从而不会污染冲突判定（这正是原先要防的事）'
  );
});

// ============================================================
// 归一化
// ============================================================

test('normalizeCandidate 补齐缺省值', () => {
  const n = normalizeCandidate(candidate({ content: '  用户喜欢喝茶  ' }));

  assert.equal(n.content, '用户喜欢喝茶', '应去掉首尾空白');
  assert.equal(n.subjectKey, 'user', 'V1.0 单用户，主体固定');
  assert.equal(n.predicateKey, null, '未提供槽位应为 null');
  assert.equal(n.objectValue, null);
  assert.equal(n.polarity, 'affirm', '缺省为肯定表述');
  assert.equal(n.importanceScore, 0.5);
  assert.equal(n.confidenceScore, 1.0);
  assert.equal(n.evidence, null);
});

test('slotFingerprint 对同一槽位稳定、对不同槽位不同', () => {
  const a = slotFingerprint({ subjectKey: 'user', predicateKey: 'residence.city' });
  const b = slotFingerprint({ subjectKey: 'user', predicateKey: 'residence.city' });
  const c = slotFingerprint({ subjectKey: 'user', predicateKey: 'residence.country' });

  assert.equal(a, b);
  assert.notEqual(a, c);

  // 大小写与空白差异不应被算成两个槽位，否则按槽位聚合的统计会分裂
  assert.equal(
    slotFingerprint({ subjectKey: 'USER', predicateKey: ' Residence.City ' }),
    a,
    '指纹应归一化大小写与空白'
  );
});

// ============================================================
// 来源追踪（§15）
//
// 这组测试是为补上一个**真实缺口**而加的：
//   原先 processCandidate 写死 sourceType='system' 且所有指针为 null，
//   LLM 摘录的 evidence 被算出来又丢弃，导致抽取产出的记忆
//   **无法回答「这条记忆是从哪句话来的」** —— §15 的核心承诺静默失效。
//   source 现已改为必填参数，类型检查会拦住漏传的调用方；
//   这组测试则锁住「传了是否真的落库」。
// ============================================================

test('来源指针被正确写入 memory_sources（§15 来源追踪）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const convRows = await exec
      .insert(conversations)
      .values({ userId, title: '来源测试' })
      .returning({ id: conversations.id });
    const convId = convRows[0]!.id;

    const msgRows = await exec
      .insert(messages)
      .values({
        conversationId: convId,
        role: 'user',
        content: '我最近想认真学一下 TypeScript',
        sequence: 1,
      })
      .returning({ id: messages.id });
    const msgId = msgRows[0]!.id;

    const r = await processCandidate({
      userId,
      source: { messageIds: [msgId] },
      candidate: normalizeCandidate(
        candidate({
          content: '用户正在学习 TypeScript',
          predicateKey: 'skill.learning',
          objectValue: 'TypeScript',
          evidence: '我最近想认真学一下 TypeScript',
        })
      ),
      executor: exec as unknown as ExecutorLike,
    });

    const rows = await exec.execute<{ source_type: string; message_id: string | null }>(sql`
      SELECT source_type, message_id::text AS message_id
        FROM memory_sources WHERE memory_id = ${r.memory.id}
    `);

    assert.equal(rows.rows.length, 1, '应有一条来源记录');
    assert.equal(rows.rows[0]?.source_type, 'conversation');
    assert.equal(
      rows.rows[0]?.message_id,
      msgId,
      '来源必须指向真实消息 —— 这是「点击记忆跳转到原始对话」的基础'
    );
  });
});

test('多条消息可共同支撑同一条记忆', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const convRows = await exec
      .insert(conversations)
      .values({ userId, title: '多来源测试' })
      .returning({ id: conversations.id });
    const convId = convRows[0]!.id;

    const msgRows = await exec
      .insert(messages)
      .values([
        { conversationId: convId, role: 'user', content: '我在学 TS', sequence: 1 },
        { conversationId: convId, role: 'user', content: 'TS 的类型系统挺有意思', sequence: 2 },
      ])
      .returning({ id: messages.id });

    const r = await processCandidate({
      userId,
      source: { messageIds: msgRows.map((m) => m.id) },
      candidate: normalizeCandidate(
        candidate({
          content: '用户正在学习 TypeScript',
          predicateKey: 'skill.learning',
          objectValue: 'TypeScript',
        })
      ),
      executor: exec as unknown as ExecutorLike,
    });

    const rows = await exec.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM memory_sources WHERE memory_id = ${r.memory.id}
    `);
    assert.equal(rows.rows[0]?.n, 2, '两句话共同支撑时应记下两条来源');
  });
});

test('无消息来源时写为 manual（在 chk_sources_has_origin 豁免内）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const r = await processCandidate({
      userId,
      source: { messageIds: [] },
      candidate: normalizeCandidate(candidate({ content: '用户偏好简洁的回答' })),
      executor: exec as unknown as ExecutorLike,
    });

    const rows = await exec.execute<{ source_type: string; message_id: string | null }>(sql`
      SELECT source_type, message_id::text AS message_id
        FROM memory_sources WHERE memory_id = ${r.memory.id}
    `);
    assert.equal(rows.rows[0]?.source_type, 'manual');
    assert.equal(rows.rows[0]?.message_id, null);
  });
});
