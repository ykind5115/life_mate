/**
 * Goal 读写（docs/03 §21、§13.10）
 *
 * 【为什么 goals 是「目标」的唯一写入入口】
 *   §13.10 明确：
 *     goals 表              = 一等实体，有完整生命周期状态机
 *     memory(type='goal')   = goals 的**语义检索投影**，由 GoalService 维护
 *   两个入口会产生两处真相，且 Goal 的状态机对投影不生效。
 *   因此抽取器不得创建 type='goal' 的记忆（提示词里已明确禁止），
 *   用户也不能通过 POST /memories 建（schemas.ts 的 CREATABLE_MEMORY_TYPES 已排除）。
 *
 * 【本文件只做数据访问】
 *   状态机校验、投影记忆的同步维护都属于业务规则，
 *   放在 goal-service.ts。
 */
import { and, asc, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import { db } from '../client.js';
import { goals, type Goal } from '../schema/goals.js';
import { memories } from '../schema/memories.js';
import { memoryEmbeddings } from '../schema/memory-embeddings.js';
import { memorySources } from '../schema/memory-sources.js';
import type { GoalStatus } from '../schema/enums.js';
import type { ExecutorOption, Paginated } from './types.js';

/** 未删除的 Goal 谓词 */
function aliveGoalCondition(): SQL {
  return isNull(goals.deletedAt);
}

// ============================================================
// 查询
// ============================================================

export interface ListGoalsFilter {
  userId: string;
  status?: GoalStatus[];
  limit?: number;
  offset?: number;
}

/**
 * 分页列出 Goal。
 *
 * 排序：未完成优先 + 优先级降序 + 创建时间降序。
 *
 * 为什么未完成的排前面：目标列表的主要用途是「我现在该关注什么」。
 * 已完成的沉到底部符合直觉；若一律按创建时间排，
 * 一个三年前完成的目标会永远压在新目标上面。
 */
export async function listGoals(
  filter: ListGoalsFilter,
  options: ExecutorOption = {}
): Promise<Paginated<Goal>> {
  const exec = options.executor ?? db;
  const limit = clampLimit(filter.limit);
  const offset = Math.max(0, filter.offset ?? 0);

  const conds: (SQL | undefined)[] = [eq(goals.userId, filter.userId), aliveGoalCondition()];
  if (filter.status && filter.status.length > 0) {
    conds.push(inArray(goals.status, filter.status));
  }

  const where = and(...conds);

  const [items, totalRows] = await Promise.all([
    exec
      .select()
      .from(goals)
      .where(where)
      .orderBy(
        // 0 = 未完成，1 = 已完成/取消 → 未完成的排前面
        sql`CASE WHEN ${goals.status} IN ('completed','cancelled','archived') THEN 1 ELSE 0 END`,
        desc(goals.priority),
        desc(goals.createdAt)
      )
      .limit(limit)
      .offset(offset),
    exec.select({ n: count() }).from(goals).where(where),
  ]);

  return { items, total: totalRows[0]?.n ?? 0, limit, offset };
}

export async function findGoalById(
  id: string,
  options: ExecutorOption = {}
): Promise<Goal | undefined> {
  const exec = options.executor ?? db;
  const rows = await exec.select().from(goals).where(eq(goals.id, id)).limit(1);
  return rows[0];
}

/** 列出当前活跃的目标（供 Life Review 与「我的记忆」的「目标」分组使用） */
export async function listActiveGoals(
  userId: string,
  options: ExecutorOption = {}
): Promise<Goal[]> {
  const exec = options.executor ?? db;

  return exec
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), aliveGoalCondition(), eq(goals.status, 'active')))
    .orderBy(desc(goals.priority), asc(goals.createdAt));
}

/** 统计各状态的 Goal 数量，用于概览与监控 */
export async function countGoalsByStatus(
  userId: string,
  options: ExecutorOption = {}
): Promise<{ status: string; n: number }[]> {
  const exec = options.executor ?? db;

  const rows = await exec
    .select({ status: goals.status, n: count() })
    .from(goals)
    .where(and(eq(goals.userId, userId), aliveGoalCondition()))
    .groupBy(goals.status);

  return rows.map((r) => ({ status: r.status, n: Number(r.n) }));
}

/**
 * 找出某条投影记忆对应的 Goal。
 *
 * 用途：Goal 更新时要知道该同步哪条投影记忆。
 * 走 memory_sources.goal_id → 这是「这条记忆由哪个目标投影而来」的唯一凭证。
 */
export async function findProjectionMemoryIds(
  goalId: string,
  options: ExecutorOption = {}
): Promise<string[]> {
  const exec = options.executor ?? db;

  const rows = await exec
    .select({ memoryId: memorySources.memoryId })
    .from(memorySources)
    .where(
      and(eq(memorySources.goalId, goalId), eq(memorySources.sourceType, 'goal_projection'))
    );

  return rows.map((r) => r.memoryId);
}

// ============================================================
// 写入
// ============================================================

export interface CreateGoalInput {
  userId: string;
  title: string;
  description?: string | null;
  priority?: number;
  startedAt?: Date | null;
  targetAt?: Date | null;
}

export async function createGoal(
  input: CreateGoalInput,
  options: ExecutorOption = {}
): Promise<Goal> {
  const exec = options.executor ?? db;

  const rows = await exec
    .insert(goals)
    .values({
      userId: input.userId,
      title: input.title,
      description: input.description ?? null,
      status: 'active',
      priority: input.priority ?? 0.5,
      startedAt: input.startedAt ?? null,
      targetAt: input.targetAt ?? null,
    })
    .returning();

  const goal = rows[0];
  if (!goal) throw new Error('插入 Goal 后未返回记录');
  return goal;
}

export async function updateGoal(
  id: string,
  patch: {
    title?: string;
    description?: string | null;
    status?: GoalStatus;
    priority?: number;
    startedAt?: Date | null;
    targetAt?: Date | null;
    completedAt?: Date | null;
  },
  options: ExecutorOption = {}
): Promise<Goal | undefined> {
  const exec = options.executor ?? db;

  const rows = await exec
    .update(goals)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
      ...(patch.targetAt !== undefined ? { targetAt: patch.targetAt } : {}),
      ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(goals.id, id), aliveGoalCondition()))
    .returning();

  return rows[0];
}

/**
 * 物理删除 Goal，并按其投影记忆（C24 的顺序，不可调换）。
 *
 * 【为什么必须按这个顺序】（§13.10 的 C24，审计 F-03 实测过）
 *   投影记忆的来源指针是 goal_id。
 *   若直接删 Goal，外键的 ON DELETE SET NULL 会把 goal_id 置空，
 *   而 chk_sources_has_origin 要求「至少一个来源指针非空」
 *   （goal_projection 不在豁免列表里），于是**整个删除被回滚**。
 *
 *   实测确认过：CHECK constraint failed。
 *
 *   正确顺序：
 *     ① 投影记忆置 deleted
 *     ② 其 embedding 置 deleted
 *     ③ 删来源行
 *     ④ 删 Goal
 *
 * 【为什么是物理删除而不是软删除】
 *   用户明确要求「永久删除这个目标」时才走这里。
 *   普通的「不想看了」用软删除（deleted_at）。
 */
export async function hardDeleteGoal(
  goalId: string,
  options: ExecutorOption = {}
): Promise<{ deletedProjections: number }> {
  const exec = options.executor ?? db;

  return exec.transaction(async (tx) => {
    const projectionIds = await findProjectionMemoryIds(goalId, { executor: tx });

    if (projectionIds.length > 0) {
      // ① 投影记忆失效
      await tx
        .update(memories)
        .set({ status: 'deleted', deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(inArray(memories.id, projectionIds));

      // ② 向量同步失效（与 softDeleteMemory 对称）
      await tx
        .update(memoryEmbeddings)
        .set({ status: 'deleted' })
        .where(inArray(memoryEmbeddings.memoryId, projectionIds));
    }

    // ③ 删来源行 —— 不做这一步，第 ④ 步会撞 chk_sources_has_origin
    await tx.delete(memorySources).where(eq(memorySources.goalId, goalId));

    // ④ 删 Goal
    await tx.delete(goals).where(eq(goals.id, goalId));

    return { deletedProjections: projectionIds.length };
  });
}

/** 软删除 Goal（保留行，可恢复） */
export async function softDeleteGoal(
  id: string,
  options: ExecutorOption = {}
): Promise<Goal | undefined> {
  const exec = options.executor ?? db;

  const rows = await exec
    .update(goals)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(goals.id, id), aliveGoalCondition()))
    .returning();

  return rows[0];
}

export async function restoreGoal(
  id: string,
  options: ExecutorOption = {}
): Promise<Goal | undefined> {
  const exec = options.executor ?? db;

  const rows = await exec
    .update(goals)
    .set({ deletedAt: null, updatedAt: sql`now()` })
    .where(eq(goals.id, id))
    .returning();

  return rows[0];
}

// ============================================================
// 内部
// ============================================================

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}
