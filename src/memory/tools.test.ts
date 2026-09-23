/**
 * Agent 记忆工具的测试
 *
 * 【本文件最重要的断言：Q3 的只读不变量】
 *   Q3 已锁定「Agent 只读记忆，不持有写工具」。
 *   这不是一个「当前没实现」的状态，而是一条**不能退化的约束** ——
 *   一旦有人加了 save_memory，模型就可能把用户随口说的话当成事实存下来，
 *   而用户从未确认过（与 PRD §3.4「用户拥有最终控制权」冲突）。
 *
 *   因此第一组测试专门锁住这一点。
 *
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';

import { closePool, db } from '../database/client.js';
import { memories } from '../database/schema/memories.js';
import { goals } from '../database/schema/goals.js';
import { memorySources } from '../database/schema/memory-sources.js';
import { events } from '../database/schema/events.js';
import { ensureDefaultUser } from '../database/repository/user-store.js';
import { assertTestDatabase } from '../shared/test-guard.js';
import { createMemoryTools } from './tools.js';
import type { ToolContext } from '../agent/loop.js';

after(async () => {
  await closePool();
});

const CTX: ToolContext = {
  signal: new AbortController().signal,
  idempotencyKey: 'test',
  agentRunId: 'test-run',
};

// ============================================================
// Q3：只读不变量（本文件的核心）
// ============================================================

test('Q3：工具集只包含只读工具，**不含任何写工具**', async () => {
  const tools = createMemoryTools({ userId: '00000000-0000-4000-8000-000000000000' });
  const names = tools.map((t) => t.name).sort();

  assert.deepEqual(names, ['get_memory', 'get_timeline', 'search_memory']);

  /**
   * 逐个点名禁用。写成显式列表而不是「不等于那三个」——
   * 后者在新增工具时会静默通过，而这里会失败并要求人确认。
   */
  for (const forbidden of [
    'save_memory',
    'update_memory',
    'delete_memory',
    'create_memory',
    'upsert_memory',
  ]) {
    assert.ok(
      !names.includes(forbidden),
      `工具集里出现了写工具 ${forbidden} —— 违反 Q3「Agent 不持有写工具」`
    );
  }
});

test('Q3：工具的 execute 只做读操作（用「不产生新记忆」间接验证）', async () => {
  assertTestDatabase('tools.test.ts / 只读验证');

  const user = await ensureDefaultUser();
  await cleanup(user.id);

  const tools = createMemoryTools({ userId: user.id });
  const before = await countRows(user.id);

  // 依次调用所有工具
  for (const t of tools) {
    await t.execute({ query: '测试', memory_id: '00000000-0000-4000-8000-000000000000' }, CTX);
  }

  const after = await countRows(user.id);

  /**
   * 数据量不变即证明「没写」。
   * 这是间接验证，但它覆盖的是**实际执行路径**而不是工具名 ——
   * 有人把写操作藏进 search_memory 里也会被这条抓到。
   */
  assert.deepEqual(after, before, '调用工具后数据量不应变化');
});

// ============================================================
// 工具行为
// ============================================================

test('search_memory：参数缺失时返回可读错误，不抛异常', async () => {
  assertTestDatabase('tools.test.ts / search_memory');

  const user = await ensureDefaultUser();
  const tools = createMemoryTools({ userId: user.id });
  const search = tools.find((t) => t.name === 'search_memory')!;

  /**
   * 不抛异常很重要：抛错会中断整个 Agent 循环，
   * 而模型给错参数是常见情况，它应该能自行修正。
   */
  const r1 = (await search.execute({}, CTX)) as { error?: string };
  assert.ok(r1.error, '缺参数应返回 error 字段');

  const r2 = (await search.execute({ query: '   ' }, CTX)) as { error?: string };
  assert.ok(r2.error, '空白查询也应被拒');

  const r3 = (await search.execute({ query: 123 }, CTX)) as { error?: string };
  assert.ok(r3.error, '非字符串参数也应被拒而不是崩');
});

test('search_memory：工具结果不含 id 与分数', async () => {
  assertTestDatabase('tools.test.ts / search_memory 输出');

  const user = await ensureDefaultUser();
  await cleanup(user.id);

  await db.insert(memories).values({
    userId: user.id,
    type: 'fact',
    content: '用户正在学习钢琴',
    subjectKey: 'user',
    predicateKey: 'skill.learning',
    objectValue: '钢琴',
  });

  const search = createMemoryTools({ userId: user.id }).find((t) => t.name === 'search_memory')!;
  const r = (await search.execute({ query: '钢琴' }, CTX)) as {
    memories: Record<string, unknown>[];
  };

  assert.ok(r.memories.length > 0, '应召回到刚插入的记忆');

  for (const m of r.memories) {
    /**
     * 不给 id：模型会倾向于在回答里引用它（「根据记忆 m_abc123」），
     * 那对用户毫无意义。分数同理 —— 它是内部排序信号。
     */
    assert.equal(m['id'], undefined, '工具结果不应含 id');
    assert.equal(m['score'], undefined, '工具结果不应含分数');
    assert.ok(typeof m['content'] === 'string');
  }

  await cleanup(user.id);
});

test('get_memory：找不到时返回可读结果，并提示不要断言「不存在」', async () => {
  assertTestDatabase('tools.test.ts / get_memory');

  const user = await ensureDefaultUser();
  const get = createMemoryTools({ userId: user.id }).find((t) => t.name === 'get_memory')!;

  const r = (await get.execute(
    { memory_id: '00000000-0000-4000-8000-000000000000' },
    CTX
  )) as { error?: string; hint?: string };

  assert.ok(r.error);
  /**
   * hint 是针对**模型行为**的约束：检索不到不等于用户没提过
   * （可能只是本次没召回）。不提示的话模型会说「你从没说过」，
   * 那是不准确的断言。
   */
  assert.match(r.hint ?? '', /不要向用户断言/);
});

test('get_memory：已删除的记忆查不到（尊重删除意图）', async () => {
  assertTestDatabase('tools.test.ts / get_memory 删除');

  const user = await ensureDefaultUser();
  await cleanup(user.id);

  const inserted = await db
    .insert(memories)
    .values({
      userId: user.id,
      type: 'fact',
      content: '已删除的记忆',
      status: 'deleted',
      deletedAt: new Date(),
    })
    .returning({ id: memories.id });

  const get = createMemoryTools({ userId: user.id }).find((t) => t.name === 'get_memory')!;
  const r = (await get.execute({ memory_id: inserted[0]!.id }, CTX)) as { error?: string };

  assert.ok(r.error, '已删除的记忆不该被读出来');
  await cleanup(user.id);
});

test('get_timeline：返回事件并标注分类与日期', async () => {
  assertTestDatabase('tools.test.ts / get_timeline');

  const user = await ensureDefaultUser();
  await cleanup(user.id);

  await db.insert(events).values({
    userId: user.id,
    title: '换工作',
    eventTime: new Date('2026-09-16T00:00:00Z'),
    category: 'work',
    sourceType: 'manual',
  });

  const tool = createMemoryTools({ userId: user.id }).find((t) => t.name === 'get_timeline')!;
  const r = (await tool.execute({}, CTX)) as {
    events: { title: string; event_time: string; category: string }[];
    totalInRange: number;
  };

  assert.equal(r.totalInRange, 1);
  assert.equal(r.events[0]!.title, '换工作');
  assert.equal(r.events[0]!.event_time, '2026-09-16');
  assert.equal(r.events[0]!.category, 'work');

  await cleanup(user.id);
});

test('get_timeline：参数非法时不崩（返回空结果）', async () => {
  assertTestDatabase('tools.test.ts / get_timeline 参数');

  const user = await ensureDefaultUser();
  const tool = createMemoryTools({ userId: user.id }).find((t) => t.name === 'get_timeline')!;

  const r = (await tool.execute({ start: '不是日期' }, CTX)) as { events: unknown[] };
  assert.ok(Array.isArray(r.events), '非法日期应被忽略而不是抛错');
});

// ============================================================
// 辅助
// ============================================================

async function countRows(userId: string): Promise<Record<string, number>> {
  const m = await db.select({ id: memories.id }).from(memories).where(eq(memories.userId, userId));
  const g = await db.select({ id: goals.id }).from(goals).where(eq(goals.userId, userId));
  const e = await db.select({ id: events.id }).from(events).where(eq(events.userId, userId));
  return { memories: m.length, goals: g.length, events: e.length };
}

async function cleanup(userId: string): Promise<void> {
  const userGoals = await db.select({ id: goals.id }).from(goals).where(eq(goals.userId, userId));
  const goalIds = userGoals.map((x) => x.id);

  if (goalIds.length > 0) {
    for (const id of goalIds) {
      await db.delete(memorySources).where(eq(memorySources.goalId, id));
    }
  }
  await db.delete(events).where(eq(events.userId, userId));
  await db.delete(memories).where(eq(memories.userId, userId));
  for (const id of goalIds) {
    await db.delete(goals).where(eq(goals.id, id));
  }
}
