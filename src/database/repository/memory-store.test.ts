/**
 * Memory Repository 集成测试
 *
 * 为什么是集成测试而不是单元测试：
 *   本层的不变量有一半由**数据库约束**保证（部分唯一索引、CHECK、外键），
 *   用 mock 测等于什么都没测。因此直连真实 PostgreSQL。
 *
 * 数据洁癖：每个用例跑在自己的顶层事务里，结束即回滚（见 _test-helpers.ts）。
 *   已单独验证：库中不应残留测试用户。
 *
 * 前置：docker compose up -d postgres
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { closePool, db } from '../client.js';
import { assertRejectsWithConstraint, countUsersByName, opts, withTestContext } from './_test-helpers.js';
import {
  archiveStaleConflicts,
  createConflictMemory,
  createMemory,
  hardDeleteMemory,
  mergeDuplicate,
  restoreMemory,
  resolveConflictAcceptNew,
  resolveConflictKeepOld,
  softDeleteMemory,
  supersedeMemory,
} from './memory-store.js';
import {
  findByIdIncludingInactive,
  findConflictsBySlot,
  findCurrentById,
  findCurrentBySlot,
  findSupersedeChain,
  findValidAt,
  listConflicts,
  listForManagement,
} from './memory-queries.js';
import * as q from './memory-queries.js';

after(async () => {
  await closePool();
});

// ============================================================
// 新建与读取
// ============================================================

test('createMemory 写入记忆与来源指针', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const m = await createMemory(
      {
        userId,
        type: 'fact',
        content: '用户住在广州',
        subjectKey: 'user',
        predicateKey: 'residence.city',
        objectValue: '广州',
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    assert.equal(m.status, 'active');
    assert.equal(m.sourceCount, 1);
    assert.equal(m.predicateKey, 'residence.city');
    assert.equal(m.validUntil, null);
    assert.equal(m.supersededBy, null);

    const found = await findCurrentById(m.id, opts(exec));
    assert.ok(found, '应能按 id 读到当前有效记忆');
    assert.equal(found.content, '用户住在广州');
  });
});

test('createMemory 拒绝同槽位的第二条 active（部分唯一索引生效）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    await createMemory(
      {
        userId,
        type: 'fact',
        content: '用户喜欢喝茶',
        subjectKey: 'user',
        predicateKey: 'preference.food',
        objectValue: '茶',
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    await assertRejectsWithConstraint(
      () =>
        createMemory(
          {
            userId,
            type: 'fact',
            content: '用户喜欢咖啡',
            subjectKey: 'user',
            predicateKey: 'preference.food',
            objectValue: '咖啡',
            sources: [{ sourceType: 'manual' }],
          },
          opts(exec)
        ),
      'uq_memories_current_slot',
      '同槽位第二条 active 应被数据库拒绝 —— 该走 mergeDuplicate 或 supersede'
    );
  });
});

test('无槽位记忆不受唯一约束（C28 的设计意图）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const a = await createMemory(
      { userId, type: 'fact', content: '无槽位重复内容', sources: [{ sourceType: 'manual' }] },
      opts(exec)
    );
    const b = await createMemory(
      { userId, type: 'fact', content: '无槽位重复内容', sources: [{ sourceType: 'manual' }] },
      opts(exec)
    );

    assert.notEqual(a.id, b.id, '无槽位记忆允许重复 —— 去重由抽取器负责，数据库不兜底');
  });
});

test('createMemory 拒绝非法枚举值（CHECK 下沉生效）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    await assertRejectsWithConstraint(
      () =>
        createMemory(
          {
            userId,
            type: 'not_a_type' as never,
            content: 'x',
            sources: [{ sourceType: 'manual' }],
          },
          opts(exec)
        ),
      'chk_memories_type',
      'type 非法应被库层 CHECK 拦住'
    );
  });
});

// ============================================================
// 去重合并：不新建、不改正文
// ============================================================

test('mergeDuplicate 只递增 sourceCount，不新建记录、不改正文', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const before = await createMemory(
      {
        userId,
        type: 'preference',
        content: '用户喜欢直接的技术解释',
        subjectKey: 'user',
        predicateKey: 'preference.communication_style',
        objectValue: '直接',
        confidenceScore: 0.7,
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    const merged = await mergeDuplicate(
      { memoryId: before.id, sources: [{ sourceType: 'manual' }], confidenceScore: 0.9 },
      opts(exec)
    );

    assert.equal(merged.id, before.id, '不应产生新记录');
    assert.equal(merged.sourceCount, 2, 'sourceCount 应递增到 2');
    assert.equal(merged.content, before.content, '正文必须一字不改');
    assert.ok(merged.confidenceScore >= 0.9, 'confidence 应被提升');

    // 再次合并时给一个更低的置信度：不应把已提升的值拉低
    const merged2 = await mergeDuplicate(
      { memoryId: before.id, sources: [{ sourceType: 'manual' }], confidenceScore: 0.3 },
      opts(exec)
    );
    assert.equal(merged2.sourceCount, 3);
    assert.ok(merged2.confidenceScore >= 0.9, 'confidence 只升不降');
  });
});

// ============================================================
// supersede：Q1 不可变事实的核心
// ============================================================

test('supersedeMemory 保留旧正文、写 valid_until 与替代指针', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const old = await createMemory(
      {
        userId,
        type: 'fact',
        content: '用户住在北京',
        subjectKey: 'user',
        predicateKey: 'residence.city',
        objectValue: '北京',
        validFrom: new Date('2026-01-01T00:00:00Z'),
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    const { old: oldAfter, created } = await supersedeMemory(
      {
        oldMemoryId: old.id,
        newMemory: {
          userId,
          type: 'fact',
          content: '用户已搬到上海',
          subjectKey: 'user',
          predicateKey: 'residence.city',
          objectValue: '上海',
          validFrom: new Date('2026-09-01T00:00:00Z'),
          sources: [{ sourceType: 'manual' }],
        },
      },
      opts(exec)
    );

    // 旧记忆：状态变了，但正文与 valid_from 一字未动
    assert.equal(oldAfter.status, 'superseded');
    assert.equal(oldAfter.content, '用户住在北京', '旧正文必须保留 —— 这是历史事实');
    assert.equal(
      oldAfter.validFrom?.toISOString(),
      old.validFrom?.toISOString(),
      'valid_from 不可变'
    );
    assert.ok(oldAfter.validUntil, '应写入 valid_until');
    assert.equal(oldAfter.supersededBy, created.id, '应指向新记忆');

    // 新记忆 active
    assert.equal(created.status, 'active');
    assert.equal(created.objectValue, '上海');

    // 当前有效查询只返回新记忆
    const current = await findCurrentBySlot(
      { userId, subjectKey: 'user', predicateKey: 'residence.city' },
      opts(exec)
    );
    assert.equal(current?.content, '用户已搬到上海');

    // 旧的读不到（不是当前有效）
    assert.equal(await findCurrentById(old.id, opts(exec)), undefined);
    // 但它还在库里
    assert.ok(await findByIdIncludingInactive(old.id, opts(exec)));
  });
});

test('supersedeMemory 拒绝替代非 active 的记忆', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const m = await createMemory(
      { userId, type: 'fact', content: '待删除的记忆', sources: [{ sourceType: 'manual' }] },
      opts(exec)
    );
    await softDeleteMemory(m.id, opts(exec));

    await assert.rejects(
      () =>
        supersedeMemory(
          {
            oldMemoryId: m.id,
            newMemory: {
              userId,
              type: 'fact',
              content: '新内容',
              sources: [{ sourceType: 'manual' }],
            },
          },
          opts(exec)
        ),
      /不存在或不是当前有效状态/,
      '已删除的记忆不应能被替代'
    );
  });
});

// ============================================================
// 历史查询：与当前查询语义不同
// ============================================================

test('findValidAt 能查到「当时成立、现已失效」的事实', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const old = await createMemory(
      {
        userId,
        type: 'fact',
        content: '用户当时住在杭州',
        subjectKey: 'user',
        predicateKey: 'residence.country',
        objectValue: '中国',
        validFrom: new Date('2025-01-01T00:00:00Z'),
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    await supersedeMemory(
      {
        oldMemoryId: old.id,
        newMemory: {
          userId,
          type: 'fact',
          content: '用户现居日本',
          subjectKey: 'user',
          predicateKey: 'residence.country',
          objectValue: '日本',
          validFrom: new Date('2026-06-01T00:00:00Z'),
          sources: [{ sourceType: 'manual' }],
        },
      },
      opts(exec)
    );

    // 站在 2025-06-01：应看到旧事实，看不到当时尚未成立的新事实
    const atPast = await findValidAt(
      { userId, at: new Date('2025-06-01T00:00:00Z') },
      opts(exec)
    );
    const pastContents = atPast.map((m) => m.content);

    assert.ok(
      pastContents.includes('用户当时住在杭州'),
      '历史查询应能看到当时有效、现已 superseded 的事实'
    );
    assert.ok(
      !pastContents.includes('用户现居日本'),
      '历史查询不应看到当时尚未成立的事实'
    );
  });
});

// ============================================================
// 冲突（C35）
// ============================================================

test('C35: 冲突记忆可落库、可列出、不阻塞同槽位', async () => {
  await withTestContext(async ({ exec, userId }) => {
    await createMemory(
      {
        userId,
        type: 'fact',
        content: '用户职业状态：在职',
        subjectKey: 'user',
        predicateKey: 'employment.role',
        objectValue: '在职',
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    // 同槽位插入冲突记忆 —— 若 conflict 未从唯一索引中排除，这里会失败
    const conflict = await createConflictMemory(
      {
        userId,
        type: 'fact',
        content: '用户职业状态：离职',
        subjectKey: 'user',
        predicateKey: 'employment.role',
        objectValue: '离职',
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    assert.equal(conflict.status, 'conflict');
    assert.ok(conflict.confidenceScore < 1, '冲突记忆的置信度应低于正常值');

    // 冲突记忆不参与「当前有效」查询
    assert.equal(
      await findCurrentById(conflict.id, opts(exec)),
      undefined,
      'conflict 记忆不应被当作当前有效记忆返回'
    );

    const conflicts = await findConflictsBySlot(
      {
        userId,
        subjectKey: 'user',
        predicateKey: 'employment.role',
      },
      opts(exec)
    );
    assert.equal(conflicts.length, 1);

    const all = await listConflicts(userId, opts(exec));
    assert.ok(all.some((c) => c.id === conflict.id));
  });
});

test('C35: accept_new 裁决 —— 旧记忆 superseded，冲突记忆转 active', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const old = await createMemory(
      {
        userId,
        type: 'fact',
        content: '用户目标是学 Rust',
        subjectKey: 'user',
        predicateKey: 'skill.learning',
        objectValue: 'Rust',
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    const conflict = await createConflictMemory(
      {
        userId,
        type: 'fact',
        content: '用户目标是学 Go',
        subjectKey: 'user',
        predicateKey: 'skill.learning',
        objectValue: 'Go',
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    const { activated, superseded } = await resolveConflictAcceptNew(
      { conflictMemoryId: conflict.id, supersededMemoryId: old.id },
      opts(exec)
    );

    assert.equal(activated.status, 'active');
    assert.equal(superseded.status, 'superseded');
    assert.equal(superseded.supersededBy, conflict.id);
    assert.equal(superseded.content, '用户目标是学 Rust', '旧正文保留');

    const current = await findCurrentBySlot(
      { userId, subjectKey: 'user', predicateKey: 'skill.learning' },
      opts(exec)
    );
    assert.equal(current?.objectValue, 'Go');
  });
});

test('C35: keep_old 裁决 —— 冲突记忆转 archived 且保留正文', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const conflict = await createConflictMemory(
      {
        userId,
        type: 'fact',
        content: '用户口味：偏咸',
        subjectKey: 'user',
        predicateKey: 'preference.food',
        objectValue: '偏咸',
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    const archived = await resolveConflictKeepOld({ conflictMemoryId: conflict.id }, opts(exec));
    assert.equal(archived.status, 'archived');
    assert.equal(archived.content, '用户口味：偏咸', '归档保留正文，不删除');
  });
});

test('C35: 裁决时状态不匹配应明确报错，而不是静默改状态', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const active = await createMemory(
      { userId, type: 'fact', content: '普通 active 记忆', sources: [{ sourceType: 'manual' }] },
      opts(exec)
    );

    await assert.rejects(
      () => resolveConflictKeepOld({ conflictMemoryId: active.id }, opts(exec)),
      /不是 conflict 状态/,
      '对非 conflict 记忆执行裁决应报错'
    );
  });
});

test('C35: archiveStaleConflicts 归档超期未裁决的冲突', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const conflict = await createConflictMemory(
      {
        userId,
        type: 'fact',
        content: '用户习惯：晚睡',
        subjectKey: 'user',
        predicateKey: 'habit.sleep',
        objectValue: '晚睡',
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    // 0 天阈值：刚创建的也算超期
    const n = await archiveStaleConflicts(userId, 0, opts(exec));
    assert.equal(n, 1, '应归档 1 条冲突记忆');

    const after = await findByIdIncludingInactive(conflict.id, opts(exec));
    assert.equal(after?.status, 'archived');

    // 阈值很大时不应误伤
    const c2 = await createConflictMemory(
      {
        userId,
        type: 'fact',
        content: '另一个冲突',
        subjectKey: 'user',
        predicateKey: 'habit.exercise',
        objectValue: '游泳',
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );
    const n2 = await archiveStaleConflicts(userId, 30, opts(exec));
    assert.equal(n2, 0, '30 天阈值下刚创建的不应被归档');
    assert.equal((await findByIdIncludingInactive(c2.id, opts(exec)))?.status, 'conflict');
  });
});

// ============================================================
// 软删除 / 恢复 / 物理删除
// ============================================================

test('softDeleteMemory 后从所有当前查询中消失，但记录仍在', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const m = await createMemory(
      {
        userId,
        type: 'fact',
        content: '待软删除的记忆',
        subjectKey: 'user',
        predicateKey: 'interest.hobby',
        objectValue: '跑步',
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    await softDeleteMemory(m.id, opts(exec));

    assert.equal(await findCurrentById(m.id, opts(exec)), undefined, '当前有效查询应读不到');
    assert.equal(
      await findCurrentBySlot({ userId, subjectKey: 'user', predicateKey: 'interest.hobby' }, opts(exec)),
      undefined,
      '槽位查询应读不到'
    );

    // 默认审阅视图仍应排除已删除的（函数名说的是「含非 active」，不含已删除）
    assert.equal(
      await findByIdIncludingInactive(m.id, opts(exec)),
      undefined,
      '审阅视图默认也应排除已删除的记忆'
    );

    // 只有明确要求「为了恢复」时才读得到
    const forRestore = await findByIdIncludingInactive(m.id, {
      ...opts(exec),
      includeDeletedForRestore: true,
    });
    assert.ok(forRestore, '显式指定后才应读到已删除记录（供恢复用）');
    assert.equal(forRestore.status, 'deleted');
    assert.ok(forRestore.deletedAt);

    // 管理页也应排除已删除的
    const mgmt = await listForManagement({ userId, limit: 200 }, opts(exec));
    assert.ok(
      !mgmt.items.some((x) => x.id === m.id),
      '管理页应排除已删除的记忆'
    );

    // 统计也不应算入
    assert.equal(await q.countCurrent(userId, opts(exec)), 0, '软删除后当前有效计数应为 0');
  });
});

test('restoreMemory 在槽位空出时恢复为 active', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const m = await createMemory(
      {
        userId,
        type: 'fact',
        content: '可恢复的记忆',
        subjectKey: 'user',
        predicateKey: 'plan.near_term',
        objectValue: '计划 A',
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    await softDeleteMemory(m.id, opts(exec));
    const { memory, becameConflict } = await restoreMemory(m.id, opts(exec));

    assert.equal(becameConflict, false, '槽位已空出，应直接恢复为 active');
    assert.equal(memory.status, 'active');
    assert.equal(memory.deletedAt, null);
    assert.ok(await findCurrentById(m.id, opts(exec)));
  });
});

test('restoreMemory 在槽位被占用时转为 conflict 而非报错', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const first = await createMemory(
      {
        userId,
        type: 'fact',
        content: '将被占用槽位的记忆',
        subjectKey: 'user',
        predicateKey: 'education.major',
        objectValue: '计算机',
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );
    await softDeleteMemory(first.id, opts(exec));

    // 槽位被别人占用
    await createMemory(
      {
        userId,
        type: 'fact',
        content: '占用槽位的新记忆',
        subjectKey: 'user',
        predicateKey: 'education.major',
        objectValue: '数学',
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    const { memory, becameConflict } = await restoreMemory(first.id, opts(exec));
    assert.equal(becameConflict, true, '槽位被占用时应转为 conflict 而不是撞唯一约束');
    assert.equal(memory.status, 'conflict');
  });
});

test('restoreMemory 拒绝恢复未删除的记忆', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const m = await createMemory(
      { userId, type: 'fact', content: '未删除', sources: [{ sourceType: 'manual' }] },
      opts(exec)
    );

    await assert.rejects(
      () => restoreMemory(m.id, opts(exec)),
      /只有已删除的可以恢复/
    );
  });
});

test('hardDeleteMemory 物理删除成功（C23：superseded_by 无外键不阻塞）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const old = await createMemory(
      {
        userId,
        type: 'fact',
        content: '旧的居住地',
        subjectKey: 'user',
        predicateKey: 'residence.country',
        objectValue: '中国',
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    const { created } = await supersedeMemory(
      {
        oldMemoryId: old.id,
        newMemory: {
          userId,
          type: 'fact',
          content: '新的居住地',
          subjectKey: 'user',
          predicateKey: 'residence.country',
          objectValue: '日本',
          sources: [{ sourceType: 'manual' }],
        },
      },
      opts(exec)
    );

    // created 被 old.superseded_by 指向。物理删除它不应失败 ——
    // 这正是审计 F-04 修复后应具备的能力
    const deleted = await hardDeleteMemory(created.id, opts(exec));
    assert.equal(deleted, true, '物理删除应成功');

    // 旧记忆仍在，其 superseded_by 成为悬空指针（刻意接受的代价）
    const oldAfter = await findByIdIncludingInactive(old.id, opts(exec));
    assert.ok(oldAfter, '旧记忆不应被级联删除');
    assert.equal(oldAfter.status, 'superseded');
    assert.equal(oldAfter.supersededBy, created.id, '指针保留为历史记录');
  });
});

// ============================================================
// supersede 链（容忍断层）
// ============================================================

test('findSupersedeChain 沿链回溯，并在指针悬空时标记不完整', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const m1 = await createMemory(
      {
        userId,
        type: 'fact',
        content: '链：第一版',
        subjectKey: 'user',
        predicateKey: 'goal.long_term',
        objectValue: '初级',
        sources: [{ sourceType: 'manual' }],
      },
      opts(exec)
    );

    const { created: m2 } = await supersedeMemory(
      {
        oldMemoryId: m1.id,
        newMemory: {
          userId,
          type: 'fact',
          content: '链：第二版',
          subjectKey: 'user',
          predicateKey: 'goal.long_term',
          objectValue: '中级',
          sources: [{ sourceType: 'manual' }],
        },
      },
      opts(exec)
    );

    const okChain = await findSupersedeChain(m1.id, opts(exec));
    assert.equal(okChain.chain.length, 2);
    assert.equal(okChain.chain[0]?.content, '链：第一版');
    assert.equal(okChain.chain[1]?.content, '链：第二版');
    assert.equal(okChain.mayBeIncomplete, false);

    // 删掉链尾，制造悬空指针
    await hardDeleteMemory(m2.id, opts(exec));
    const broken = await findSupersedeChain(m1.id, opts(exec));
    assert.equal(broken.chain.length, 1, '应只返回能解析到的部分');
    assert.equal(broken.mayBeIncomplete, true, '必须明确标记链条不完整');
  });
});

// ============================================================
// 统计与列表
// ============================================================

test('countCurrent / countSlotlessCurrent 口径分离（C28 指标要求）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    await createMemory(
      { userId, type: 'fact', content: '有槽位的记忆甲', subjectKey: 'user', predicateKey: 'health.status', objectValue: '良好', sources: [{ sourceType: 'manual' }] },
      opts(exec)
    );
    await createMemory(
      { userId, type: 'fact', content: '无槽位记忆乙', sources: [{ sourceType: 'manual' }] },
      opts(exec)
    );
    await createMemory(
      { userId, type: 'fact', content: '无槽位记忆丙', sources: [{ sourceType: 'manual' }] },
      opts(exec)
    );

    assert.equal(await q.countCurrent(userId, opts(exec)), 3);
    assert.equal(
      await q.countSlotlessCurrent(userId, opts(exec)),
      2,
      '无槽位记忆应被单独统计 —— 它们的重复不是数据库能拦的'
    );
  });
});

test('listCurrent 只返回满足「当前有效」谓词的记忆', async () => {
  await withTestContext(async ({ exec, userId }) => {
    // 造出各种非当前有效的状态
    const active = await createMemory(
      { userId, type: 'fact', content: '正常记忆', subjectKey: 'user', predicateKey: 'residence.city', objectValue: '上海', sources: [{ sourceType: 'manual' }] },
      opts(exec)
    );
    const toDelete = await createMemory(
      { userId, type: 'fact', content: '将被删除', sources: [{ sourceType: 'manual' }] },
      opts(exec)
    );
    await softDeleteMemory(toDelete.id, opts(exec));
    await createConflictMemory(
      { userId, type: 'fact', content: '冲突记忆', sources: [{ sourceType: 'manual' }] },
      opts(exec)
    );

    const page = await q.listCurrent({ userId, limit: 200 }, opts(exec));
    assert.equal(page.total, 1, '只有 1 条当前有效');
    assert.equal(page.items[0]?.id, active.id);

    for (const m of page.items) {
      assert.equal(m.status, 'active');
      assert.equal(m.deletedAt, null);
      assert.equal(m.validUntil, null);
      assert.equal(m.supersededBy, null);
    }
  });
});

test('listForManagement 可见 conflict/archived，但不可见 deleted', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const conflict = await createConflictMemory(
      { userId, type: 'fact', content: '待裁决', sources: [{ sourceType: 'manual' }] },
      opts(exec)
    );
    const deleted = await createMemory(
      { userId, type: 'fact', content: '已删除', sources: [{ sourceType: 'manual' }] },
      opts(exec)
    );
    await softDeleteMemory(deleted.id, opts(exec));

    const page = await listForManagement({ userId, limit: 200 }, opts(exec));
    const ids = page.items.map((m) => m.id);
    const statuses = page.items.map((m) => m.status);

    assert.ok(ids.includes(conflict.id), '管理页应看到待裁决的冲突记忆');
    assert.ok(!ids.includes(deleted.id), '管理页不应看到已删除的记忆');
    assert.ok(!statuses.includes('deleted'));
  });
});

test('listForManagement 支持按状态过滤', async () => {
  await withTestContext(async ({ exec, userId }) => {
    await createConflictMemory(
      { userId, type: 'fact', content: '冲突一', sources: [{ sourceType: 'manual' }] },
      opts(exec)
    );
    await createMemory(
      { userId, type: 'fact', content: '正常一', sources: [{ sourceType: 'manual' }] },
      opts(exec)
    );

    const page = await listForManagement({ userId, status: ['conflict'], limit: 200 }, opts(exec));
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.status, 'conflict');
  });
});

// ============================================================
// 回滚有效性
// ============================================================

test('测试用例的数据确实被回滚（库中无残留）', async () => {
  const n = await countUsersByName('repo-test');
  assert.equal(n, 0, '测试用户不应残留 —— 否则说明事务回滚没生效');
});

// 直接引用 db 以避免「已导入未使用」的同时确保连接可用
void db;
