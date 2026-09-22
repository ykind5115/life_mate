/**
 * Memory 读查询
 *
 * 【本文件的核心纪律】
 *   所有涉及「当前有效记忆」的查询，必须使用 conditions.ts 的谓词，
 *   **不得自行拼写 status / deleted_at / valid_until / superseded_by 条件**。
 *   理由见 docs/03 §13.6：漏掉任一条件就意味着用户已删除的记忆仍可能被召回，
 *   这是隐私问题，不是风格问题（审计 P1-2）。
 *
 * 【返回类型约定】
 *   本文件的「当前有效」查询返回的 Memory 一定满足 §13.6 的谓词。
 *   历史查询（findValidAt / findSupersedeChain）语义不同，注释中单独说明。
 */
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db } from '../client.js';
import { memories, type Memory } from '../schema/memories.js';
import {
  conflictMemoryCondition,
  currentMemoryCondition,
  memoryValidAtCondition,
  notDeletedCondition,
} from './conditions.js';
import type { ListMemoriesFilter, Paginated } from './memory-types.js';

/** 列表查询的默认与上限，避免误传巨大 limit 拖垮查询 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

/**
 * 读查询同样接受可选执行器。
 *
 * 为什么读也需要：调用方常在事务内写完紧接着读（如 supersede 后回读状态），
 * 此时用事务外的连接会因为**读不到未提交数据**而拿到旧结果或空结果。
 * 传入同一执行器即可保证读写一致。
 */
export interface ReadOptions {
  executor?: Executor;
}

type Executor = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'transaction'>;

/**
 * 按 id 取「当前有效」记忆。
 *
 * 不满足 §13.6 谓词的记录（已删除、已替代、已失效、conflict）返回 undefined ——
 * 调用方拿不到就说明它不该被当成当前事实使用。
 * 需要看历史版本请用 findByIdIncludingInactive。
 */
export async function findCurrentById(
  id: string,
  options: ReadOptions = {}
): Promise<Memory | undefined> {
  const exec = options.executor ?? db;

  const rows = await exec
    .select()
    .from(memories)
    .where(and(eq(memories.id, id), currentMemoryCondition()))
    .limit(1);

  return rows[0];
}

/**
 * 按 id 取记忆的**审阅视图**：包含 conflict / archived / superseded，
 * 但**默认排除已删除的**。
 *
 * ⚠️ 命名注意：函数名说的是「包含非 active」，**不是**「包含已删除」。
 *    已删除属于另一个维度 —— 用户删掉的内容不应在审阅时被读出来。
 *    只有「回收站 / 恢复」这类明确场景才传 includeDeletedForRestore: true。
 *
 * 各状态的可读性约定：
 *   active / conflict / archived / superseded  → 默认可见（用户需要审阅历史与待裁决项）
 *   deleted                                    → 默认不可见（尊重删除意图）
 */
export async function findByIdIncludingInactive(
  id: string,
  options: ReadOptions & { includeDeletedForRestore?: boolean } = {}
): Promise<Memory | undefined> {
  const exec = options.executor ?? db;

  const where = options.includeDeletedForRestore
    ? eq(memories.id, id)
    : and(eq(memories.id, id), notDeletedCondition());

  const rows = await exec.select().from(memories).where(where).limit(1);
  return rows[0];
}

/**
 * 取某个槽位上的当前有效记忆。
 *
 * 这是冲突判定流程的第 ① 步（§13.7）：
 * 「取 (user_id, subject_key, predicate_key) 相同 且 当前有效的已有记忆」
 */
export async function findCurrentBySlot(
  params: {
    userId: string;
    subjectKey: string;
    predicateKey: string;
  },
  options: ReadOptions = {}
): Promise<Memory | undefined> {
  const exec = options.executor ?? db;

  const rows = await exec
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.userId, params.userId),
        eq(memories.subjectKey, params.subjectKey),
        eq(memories.predicateKey, params.predicateKey),
        currentMemoryCondition()
      )
    )
    .limit(1);

  return rows[0];
}

/**
 * 取某个槽位上待裁决的冲突记忆（C35）。
 *
 * 这些记忆不参与召回，但需要呈现给用户做裁决。
 */
export async function findConflictsBySlot(
  params: {
    userId: string;
    subjectKey: string;
    predicateKey: string;
  },
  options: ReadOptions = {}
): Promise<Memory[]> {
  const exec = options.executor ?? db;

  return exec
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.userId, params.userId),
        eq(memories.subjectKey, params.subjectKey),
        eq(memories.predicateKey, params.predicateKey),
        conflictMemoryCondition()
      )
    )
    .orderBy(desc(memories.createdAt));
}

/**
 * 列出某用户待裁决的全部冲突记忆（C35）。
 *
 * 用户在「记忆管理」页审阅冲突时使用。
 */
export async function listConflicts(
  userId: string,
  options: ReadOptions = {}
): Promise<Memory[]> {
  const exec = options.executor ?? db;

  return exec
    .select()
    .from(memories)
    .where(and(eq(memories.userId, userId), conflictMemoryCondition()))
    .orderBy(desc(memories.createdAt));
}

/**
 * 分页列出「当前有效」记忆。
 *
 * 前端「我的记忆」页使用。若要包含 archived / conflict，请用
 * listForManagement。
 */
export async function listCurrent(
  filter: ListMemoriesFilter,
  options: ReadOptions = {}
): Promise<Paginated<Memory>> {
  const exec = options.executor ?? db;
  const limit = clampLimit(filter.limit);
  const offset = Math.max(0, filter.offset ?? 0);

  const conds = [eq(memories.userId, filter.userId), currentMemoryCondition()];

  if (filter.type) conds.push(eq(memories.type, filter.type));

  const where = and(...conds);

  const [items, totalRows] = await Promise.all([
    exec
      .select()
      .from(memories)
      .where(where)
      .orderBy(desc(memories.updatedAt))
      .limit(limit)
      .offset(offset),
    exec.select({ n: count() }).from(memories).where(where),
  ]);

  return { items, total: totalRows[0]?.n ?? 0, limit, offset };
}

/**
 * 分页列出用于「记忆管理」的记录：包含 conflict / archived / superseded，
 * 但**排除已删除的**（用户删掉的内容不该出现在管理页）。
 */
export async function listForManagement(
  filter: ListMemoriesFilter,
  options: ReadOptions = {}
): Promise<Paginated<Memory>> {
  const exec = options.executor ?? db;
  const limit = clampLimit(filter.limit);
  const offset = Math.max(0, filter.offset ?? 0);

  const conds = [eq(memories.userId, filter.userId), notDeletedCondition()];

  if (filter.type) conds.push(eq(memories.type, filter.type));
  if (filter.status && filter.status.length > 0) {
    conds.push(inArray(memories.status, filter.status));
  }
  if (filter.includeSlotless === false) {
    conds.push(sql`${memories.predicateKey} IS NOT NULL`);
  }

  const where = and(...conds);

  const [items, totalRows] = await Promise.all([
    exec
      .select()
      .from(memories)
      .where(where)
      .orderBy(desc(memories.updatedAt))
      .limit(limit)
      .offset(offset),
    exec.select({ n: count() }).from(memories).where(where),
  ]);

  return { items, total: totalRows[0]?.n ?? 0, limit, offset };
}

/**
 * 查询「在某个时间点上成立的事实」（§13.6 的历史查询谓词）。
 *
 * ⚠️ 语义与 listCurrent 不同，不要混用：
 *   这里回答的是「2026-06-01 那天，系统认为用户住在哪里」，
 *   因此会包含现在已被 superseded 但当时有效的记录。
 *
 * 用途：时间线回溯、Life Review、「我什么时候开始想做这个项目」。
 */
export async function findValidAt(
  params: {
    userId: string;
    at: Date;
    type?: Memory['type'];
  },
  options: ReadOptions = {}
): Promise<Memory[]> {
  const exec = options.executor ?? db;

  const conds = [eq(memories.userId, params.userId), memoryValidAtCondition(params.at)];
  if (params.type) conds.push(eq(memories.type, params.type));

  return exec
    .select()
    .from(memories)
    .where(and(...conds))
    .orderBy(desc(memories.validFrom));
}

/**
 * 沿 superseded_by 链回溯一条记忆的替代历史。
 *
 * ⚠️ C23：superseded_by 没有外键约束，替代者可能已被物理删除。
 *    因此本函数**必须容忍断层**：遇到解析不到的 id 就终止并返回已收集的部分，
 *    不能假设链条完整。返回值中 mayBeIncomplete 标识是否发生了断层。
 */
export async function findSupersedeChain(
  startId: string,
  options: ReadOptions = {}
): Promise<{
  chain: Memory[];
  mayBeIncomplete: boolean;
}> {
  const chain: Memory[] = [];
  const visited = new Set<string>();

  let currentId: string | undefined = startId;
  let mayBeIncomplete = false;

  // 上限防御：万一数据出现环（不应发生，但不能靠假设），避免死循环
  const MAX_DEPTH = 100;

  while (currentId && chain.length < MAX_DEPTH) {
    if (visited.has(currentId)) {
      // 出现环：数据异常，明确标记而不是静默
      mayBeIncomplete = true;
      break;
    }
    visited.add(currentId);

    const node: Memory | undefined = await findByIdIncludingInactive(currentId, {
      ...options,
      includeDeletedForRestore: true,
    });

    if (!node) {
      // 指针悬空（替代者已被物理删除）。这正是 C23 允许的状态
      mayBeIncomplete = true;
      break;
    }

    chain.push(node);

    const next: string | null = node.supersededBy;
    currentId = next ?? undefined;
  }

  if (chain.length >= MAX_DEPTH) mayBeIncomplete = true;

  return { chain, mayBeIncomplete };
}

/** 统计当前有效记忆数量，用于容量监控与评测 */
export async function countCurrent(
  userId: string,
  options: ReadOptions = {}
): Promise<number> {
  const exec = options.executor ?? db;

  const rows = await exec
    .select({ n: count() })
    .from(memories)
    .where(and(eq(memories.userId, userId), currentMemoryCondition()));

  return rows[0]?.n ?? 0;
}

/**
 * 统计「无槽位」的当前有效记忆数量。
 *
 * 用途（§17.4 的 C28）：无槽位记忆不受 uq_memories_current_slot 约束，
 * 其重复由抽取器负责。因此 Memory Noise 指标需要把有槽位/无槽位分开统计：
 *   有槽位的重复 = 数据库级缺陷（可直接告警）
 *   无槽位的重复 = 抽取质量问题（靠评测集发现）
 */
export async function countSlotlessCurrent(
  userId: string,
  options: ReadOptions = {}
): Promise<number> {
  const exec = options.executor ?? db;

  const rows = await exec
    .select({ n: count() })
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        currentMemoryCondition(),
        isNull(memories.predicateKey)
      )
    );

  return rows[0]?.n ?? 0;
}
