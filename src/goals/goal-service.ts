/**
 * GoalService —— 「目标」的唯一写入入口（docs/03 §13.10）
 *
 * 【本模块的两个核心职责】
 *   ① 维护 goals 表
 *   ② **同步维护它的语义检索投影记忆**（memory(type='goal')）
 *
 *   投影的存在理由：goals 表本身不参与向量检索，
 *   而用户问「我最近在忙什么目标」时需要语义召回。
 *   因此 GoalService 在写 goals 的同时维护一条对应的 memory。
 *
 * 【为什么必须有投影这一层，而不是让用户直接建 type='goal' 的记忆】
 *   §13.10 的 C33 说明：两个写入入口会产生两处真相，
 *   且 Goal 的状态机对记忆不生效 —— 用户把目标标记为「已完成」后，
 *   Agent 仍会召回到那条记忆并当成正在进行的目标回答。
 *
 * 【投影的同步策略】
 *   新建 Goal     → 建一条 active 的投影记忆
 *   改标题/描述   → **重建**投影记忆（不是就地改内容）
 *   状态变化      → 同步投影记忆的 status
 *   软删除 Goal   → 投影记忆置 deleted
 *   物理删除 Goal → 按 C24 的顺序清理（见 goal-store.hardDeleteGoal）
 *
 *   ⚠️ 「改标题时重建而不是就地改」是因为 Q1：
 *      记忆正文永不就地修改。而投影记忆是 goals 的镜像，
 *      目标标题变了它就是一条新事实 —— 走 supersede 语义而不是 UPDATE。
 */
import { eq, sql } from 'drizzle-orm';

import { db } from '../database/client.js';
import { memories } from '../database/schema/memories.js';
import { memoryEmbeddings } from '../database/schema/memory-embeddings.js';
import type { Goal } from '../database/schema/goals.js';
import type { GoalStatus } from '../database/schema/enums.js';
import {
  createGoal,
  findGoalById,
  findProjectionMemoryIds,
  hardDeleteGoal,
  listGoals,
  restoreGoal,
  softDeleteGoal,
  updateGoal,
  type CreateGoalInput,
  type ListGoalsFilter,
} from '../database/repository/goal-store.js';
import { createMemory } from '../database/repository/memory-store.js';
import type { ExecutorOption, Paginated } from '../database/repository/types.js';
import { checkTransition, resolveCompletedAt, type TransitionCheck } from './goal-state-machine.js';

// ============================================================
// 投影记忆
// ============================================================

/**
 * 把 Goal 渲染成投影记忆的正文。
 *
 * ⚠️ 必须**脱离 goals 表也能独立理解** —— 它会进入向量检索，
 *    可能在任何一次对话里被召回，那时没有 goal 上下文。
 *    因此带上状态与时间线索，而不是只写标题。
 */
export function renderProjectionContent(goal: Goal): string {
  const parts = [`用户的目标：${goal.title}`];

  if (goal.description) parts.push(goal.description);

  const statusText = STATUS_TEXT[goal.status] ?? goal.status;
  let line = `（当前状态：${statusText}`;
  if (goal.targetAt) line += `，目标时间 ${formatDate(goal.targetAt)}`;
  if (goal.completedAt) line += `，完成于 ${formatDate(goal.completedAt)}`;
  line += '）';
  parts.push(line);

  return parts.join('。');
}

const STATUS_TEXT: Record<string, string> = {
  active: '进行中',
  paused: '已搁置',
  completed: '已完成',
  cancelled: '已放弃',
  archived: '已归档',
};

/** 格式化为 YYYY-MM-DD。不用 toLocaleDateString：输出依赖运行环境 locale */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * 为新建的 Goal 创建投影记忆。
 *
 * 来源类型是 'goal_projection'，指针是 goal_id（§13.10 的必须④）。
 * 注意 goal_projection **不在** chk_sources_has_origin 的豁免列表里，
 * 因此必须带 goal_id —— 这正是 C24 那个坑的根源。
 */
async function createProjection(
  goal: Goal,
  options: ExecutorOption
): Promise<string | undefined> {
  /**
   * goal 类型的投影记忆**不带槽位**。
   *
   * 理由：槽位的用途是冲突判定（「同一槽位上的两个取值矛盾」）。
   * 目标之间不存在这种矛盾 —— 用户同时有三个目标是正常的，
   * 给它们同一个 goal.long_term 槽位会撞 uq_memories_current_slot，
   * 第二个目标就建不出来了。
   *
   * 这与「用户对话里提到的目标用 goal.long_term 槽位的 fact 承载」
   * 并不冲突：那是对话抽取出来的信息，这是实体投影，两者用途不同。
   */
  const memory = await createMemory(
    {
      userId: goal.userId,
      type: 'goal',
      content: renderProjectionContent(goal),
      subjectKey: 'user',
      importanceScore: goal.priority,
      confidenceScore: 1.0,
      sources: [{ sourceType: 'goal_projection', goalId: goal.id }],
    },
    options
  );

  return memory.id;
}

/** 把 Goal 的状态同步到投影记忆 */
async function syncProjectionStatus(
  goalId: string,
  status: GoalStatus,
  options: ExecutorOption
): Promise<void> {
  const exec = options.executor ?? db;
  const projectionIds = await findProjectionMemoryIds(goalId, options);
  if (projectionIds.length === 0) return;

  /**
   * 映射：
   *   Goal active / paused        → 记忆 active（仍可召回，「在做但搁置了」也是有效事实）
   *   Goal completed / cancelled  → 记忆 archived（不参与召回）
   *   Goal archived               → 记忆 archived
   *
   * ⚠️ completed 用 archived 而不是 superseded：
   *    superseded 的语义是「被新事实替代」，而「目标完成了」不是被替代，
   *    是这件事结束了。用错状态会让 supersede 链上出现无意义的节点。
   */
  const memoryStatus = status === 'active' || status === 'paused' ? 'active' : 'archived';

  for (const id of projectionIds) {
    await exec
      .update(memories)
      .set({
        status: memoryStatus,
        // completed 的目标有明确结束时间，写进 valid_until 让双时间轴正确
        ...(status === 'completed' || status === 'cancelled'
          ? { validUntil: sqlNow() }
          : { validUntil: null }),
        updatedAt: sqlNow(),
      })
      .where(eq(memories.id, id));

    if (memoryStatus !== 'active') {
      await exec
        .update(memoryEmbeddings)
        .set({ status: 'deleted' })
        .where(eq(memoryEmbeddings.memoryId, id));
    }
  }
}

/** 失效投影记忆（软删除 Goal 时用） */
async function invalidateProjection(goalId: string, options: ExecutorOption): Promise<void> {
  const exec = options.executor ?? db;
  const projectionIds = await findProjectionMemoryIds(goalId, options);
  if (projectionIds.length === 0) return;

  for (const id of projectionIds) {
    await exec
      .update(memories)
      .set({ status: 'deleted', deletedAt: sqlNow(), updatedAt: sqlNow() })
      .where(eq(memories.id, id));
    await exec
      .update(memoryEmbeddings)
      .set({ status: 'deleted' })
      .where(eq(memoryEmbeddings.memoryId, id));
  }
}

/** 恢复投影记忆 */
async function restoreProjection(goalId: string, options: ExecutorOption): Promise<void> {
  const exec = options.executor ?? db;
  const projectionIds = await findProjectionMemoryIds(goalId, options);

  for (const id of projectionIds) {
    await exec
      .update(memories)
      .set({ status: 'active', deletedAt: null, updatedAt: sqlNow() })
      .where(eq(memories.id, id));
    await exec
      .update(memoryEmbeddings)
      .set({ status: 'ready' })
      .where(eq(memoryEmbeddings.memoryId, id));
  }
}

// ============================================================
// 对外操作
// ============================================================

export interface GoalWithProjection {
  goal: Goal;
  /** 本次操作产生的提示（例如非法状态转移的告警） */
  warnings: string[];
}

/** 新建目标，并生成投影记忆 */
export async function createGoalWithProjection(
  input: CreateGoalInput
): Promise<GoalWithProjection> {
  return db.transaction(async (tx) => {
    const ex: ExecutorOption = { executor: tx };

    const goal = await createGoal(input, ex);
    await createProjection(goal, ex);

    return { goal, warnings: [] };
  });
}

export interface UpdateGoalInput {
  title?: string;
  description?: string | null;
  status?: GoalStatus;
  priority?: number;
  startedAt?: Date | null;
  targetAt?: Date | null;
  completedAt?: Date | null;
}

/**
 * 更新目标。
 *
 * ⚠️ 改标题时会重建投影记忆（Q1：正文永不就地修改）。
 *    重建 = 把旧的置 superseded + 建一条新的，而不是 UPDATE content。
 */
export async function updateGoalWithProjection(
  goalId: string,
  patch: UpdateGoalInput
): Promise<GoalWithProjection | undefined> {
  return db.transaction(async (tx) => {
    const ex: ExecutorOption = { executor: tx };

    const existing = await findGoalById(goalId, ex);
    if (!existing || existing.deletedAt !== null) return undefined;

    const warnings: string[] = [];

    // ---------- 状态转移检查（软校验，见 goal-state-machine 的说明）----------
    let completedAtPatch: Date | null | undefined;
    if (patch.status !== undefined) {
      const check: TransitionCheck = checkTransition(
        existing.status as GoalStatus,
        patch.status
      );
      if (!check.allowed && check.reason) {
        warnings.push(check.reason);
      }
      completedAtPatch = resolveCompletedAt(
        patch.status,
        existing.completedAt,
        patch.completedAt
      );
    }

    const updated = await updateGoal(
      goalId,
      {
        ...patch,
        ...(completedAtPatch !== undefined ? { completedAt: completedAtPatch } : {}),
      },
      ex
    );
    if (!updated) return undefined;

    /**
     * 标题或描述变了 → 投影记忆需要重建。
     *
     * 判据是「渲染出来的正文是否变化」，而不是「入参里有没有 title」：
     * 传了一个相同的标题不该触发重建（那会白产生一条 superseded 记录）。
     */
    const contentChanged =
      renderProjectionContent(updated) !== renderProjectionContent(existing);

    if (contentChanged) {
      await markProjectionSuperseded(goalId, ex);
      await createProjection(updated, ex);
    } else if (patch.status !== undefined) {
      await syncProjectionStatus(goalId, updated.status as GoalStatus, ex);
    }

    return { goal: updated, warnings };
  });
}

/**
 * 把旧投影记忆置为 superseded。
 *
 * 为什么不删除：Q1 的不可变事实原则 ——
 * 「目标原本叫 A」是一段真实发生过的事，删掉就没了历史。
 * superseded 让它在时间线上仍可追溯，但不参与召回。
 */
async function markProjectionSuperseded(
  goalId: string,
  options: ExecutorOption
): Promise<void> {
  const exec = options.executor ?? db;
  const projectionIds = await findProjectionMemoryIds(goalId, options);
  if (projectionIds.length === 0) return;

  for (const id of projectionIds) {
    /**
     * ⚠️ chk_memories_superseded 要求 status='superseded' 时 superseded_by 非空。
     *    但投影记忆没有「替代者」（新投影是新的一条，不是替代关系）。
     *    因此这里用 archived 而不是 superseded ——
     *    archived 同样不参与召回，且没有「必须有替代者」的约束。
     *
     *    这个选择是库层约束逼出来的，不是随意挑的。
     */
    await exec
      .update(memories)
      .set({ status: 'archived', validUntil: sqlNow(), updatedAt: sqlNow() })
      .where(eq(memories.id, id));
    await exec
      .update(memoryEmbeddings)
      .set({ status: 'deleted' })
      .where(eq(memoryEmbeddings.memoryId, id));
  }
}

/** 软删除目标（可恢复） */
export async function softDeleteGoalWithProjection(
  goalId: string
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const ex: ExecutorOption = { executor: tx };

    const deleted = await softDeleteGoal(goalId, ex);
    if (!deleted) return false;

    await invalidateProjection(goalId, ex);
    return true;
  });
}

/** 恢复目标 */
export async function restoreGoalWithProjection(goalId: string): Promise<Goal | undefined> {
  return db.transaction(async (tx) => {
    const ex: ExecutorOption = { executor: tx };

    const restored = await restoreGoal(goalId, ex);
    if (!restored) return undefined;

    await restoreProjection(goalId, ex);
    return restored;
  });
}

/** 物理删除目标（C24 的顺序在 goal-store.hardDeleteGoal 里） */
export async function hardDeleteGoalWithProjection(
  goalId: string
): Promise<{ deletedProjections: number }> {
  return hardDeleteGoal(goalId);
}

// 透传查询，避免调用方为了读而绕过本 service
export { listGoals, findGoalById };
export type { ListGoalsFilter, Paginated };

/**
 * 事务内的时间函数。
 *
 * 用 SQL 的 now() 而不是 JS 的 new Date()：与库内其他写入的时间口径一致。
 * 同事务内 now() 是常量 —— 这正是我们想要的：一次更新只产生一个时间戳，
 * 而不是每行一个略有差异的时间（那会让「同一批更新」看起来像多次操作）。
 */
function sqlNow() {
  return sql`now()`;
}
