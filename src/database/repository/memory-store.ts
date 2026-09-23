/**
 * Memory 写操作
 *
 * 【本文件最重要的纪律】
 *   **永不 UPDATE memories.content。**
 *   信息变化一律走 supersedeInfo（新建 + 标记旧记录），理由见 docs/03 §13.1：
 *     ① 「用户过去住在广州」本身是需要被记住的历史事实
 *     ② 就地更新会让 valid_from 语义二义（记录时间还是事实时间）
 *     ③ 时间线与历史查询依赖旧记录仍然存在
 *
 *   除 content 外，以下字段也禁止 UPDATE：
 *     type / subject_key / predicate_key / object_value / polarity / valid_from
 *   允许更新的仅限「系统对同一事实的认知」类字段（C25）：
 *     source_count / confidence_score / importance_score / updated_at
 *     status / valid_until / superseded_by / deleted_at
 *
 * 【事务边界】
 *   supersedeInfo / mergeDuplicate / softDelete 等涉及多表写入的操作
 *   内部使用 db.transaction。embedding 的生成是外部调用，
 *   **不能放进事务**（§25.2），由调用方在事务外完成，见文件末尾说明。
 */
import { and, eq, sql } from 'drizzle-orm';

import { db } from '../client.js';
import { memories, type Memory } from '../schema/memories.js';
import { memoryEmbeddings } from '../schema/memory-embeddings.js';
import { memorySources } from '../schema/memory-sources.js';
import { currentMemoryCondition } from './conditions.js';
import type { CreateMemoryInput, MemorySourceInput } from './memory-types.js';

/**
 * 事务内外通用的执行器类型。
 *
 * 为什么带上 transaction：Drizzle 的事务对象自身也有 .transaction()
 * （在已有事务内会生成 SAVEPOINT），因此仓库方法既能在事务外开新事务，
 * 也能被调用方传入一个外层事务，从而组合成更大的原子操作，
 * 或在测试里整体回滚。
 *
 * 显式导出（而非让调用方用条件类型推导）：推导版本既脆弱又难读，
 * 实测会推出 never、把类型检查变成假通过。
 */
export type StoreExecutor = Pick<
  typeof db,
  'select' | 'insert' | 'update' | 'delete' | 'transaction'
>;

/** 所有写操作都接受可选的执行器，默认使用全局 db */
export interface ExecutorOption {
  /** 传入外层事务以组合原子操作；不传则在自身事务内执行 */
  executor?: StoreExecutor;
}

// ============================================================
// 新建
// ============================================================

/**
 * 新建一条记忆。
 *
 * 「当前有效」的部分唯一索引（uq_memories_current_slot）会拦住
 * 同槽位已有 active 记忆的插入 —— 这是刻意的：那条路径应该走
 * mergeDuplicate 或 supersedeInfo，而不是盲目新建。
 *
 * @throws 槽位冲突时抛出数据库唯一约束错误，调用方应捕获后转入
 *         去重/冲突判定流程（§13.7）
 */
export async function createMemory(
  input: CreateMemoryInput,
  options: ExecutorOption = {}
): Promise<Memory> {
  const exec = options.executor ?? db;
  return exec.transaction(async (tx) => {
    const rows = await tx
      .insert(memories)
      .values({
        userId: input.userId,
        type: input.type,
        content: input.content,
        subjectKey: input.subjectKey ?? null,
        predicateKey: input.predicateKey ?? null,
        objectValue: input.objectValue ?? null,
        polarity: input.polarity ?? null,
        importanceScore: input.importanceScore ?? 0.5,
        confidenceScore: input.confidenceScore ?? 1.0,
        status: 'active',
        validFrom: input.validFrom ?? null,
        sourceCount: 1,
      })
      .returning();

    const memory = rows[0];
    if (!memory) throw new Error('插入记忆后未返回记录');

    await insertSources(tx, memory.id, input.sources);

    return memory;
  });
}

// ============================================================
// 去重合并（同一事实被再次提到）
// ============================================================

/**
 * 去重合并：同一槽位、同一取值被再次提到（§13.7）。
 *
 * 只递增 source_count 并按需提升 confidence，**不新建记录、不重算 embedding**。
 * 这是 §26 里 Update 与 Supersede 的区别：
 *   Update    = 同一事实的强化 → 不产生新记录
 *   Supersede = 事实发生变化   → 产生新记录，旧记录保留为历史
 *
 * @param memoryId 被合并到的那条记忆
 * @param sources  本次新增的来源（会追加到 memory_sources）
 */
export async function mergeDuplicate(
  params: {
    memoryId: string;
    sources: MemorySourceInput[];
    /** 新的置信度。取与现有值的较大者，避免反复提及反而降低置信度 */
    confidenceScore?: number;
  },
  options: ExecutorOption = {}
): Promise<Memory> {
  const exec = options.executor ?? db;
  return exec.transaction(async (tx) => {
    const rows = await tx
      .update(memories)
      .set({
        sourceCount: sql`${memories.sourceCount} + 1`,
        // 只提升不降低：再次被提到是增强证据，不应削弱
        ...(params.confidenceScore !== undefined
          ? {
              confidenceScore: sql`GREATEST(${memories.confidenceScore}, ${params.confidenceScore})`,
            }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(memories.id, params.memoryId))
      .returning();

    const memory = rows[0];
    if (!memory) throw new Error(`记忆不存在：${params.memoryId}`);

    await insertSources(tx, memory.id, params.sources, { ignoreConflict: true });

    return memory;
  });
}

// ============================================================
// 替代（信息发生变化）
// ============================================================

/**
 * 信息发生变化：新建记忆 + 把旧记忆标记为 superseded。
 *
 * 这是 Q1「不可变事实」的核心操作，也是唯一正确的「修改记忆」方式。
 *
 * 同一事务内完成三件事：
 *   ① 插入新记忆
 *   ② 旧记忆写 valid_until + superseded_by + status='superseded'
 *      —— 注意旧记忆的 content/valid_from 一个字都不改
 *   ③ 记录新记忆的来源
 *
 * 旧的 embedding 不需要处理：它已因 status 不再是 active 而不可召回，
 * 且若把 status 置为 'deleted' 反而会误导（它并没有被删除）。
 *
 * @param oldMemoryId  被替代的记忆
 * @param newMemory    新事实的内容（通常是同槽位、不同取值）
 * @param validUntil   旧事实的失效时间。不传则取新事实的 validFrom 或当前时间
 */
export async function supersedeMemory(
  params: {
    oldMemoryId: string;
    newMemory: Omit<CreateMemoryInput, 'userId'> & { userId: string };
    validUntil?: Date;
  },
  options: ExecutorOption = {}
): Promise<{ old: Memory; created: Memory }> {
  const exec = options.executor ?? db;
  return exec.transaction(async (tx) => {
    // 确认旧记忆存在且确实处于可被替代的状态
    const oldRows = await tx
      .select()
      .from(memories)
      .where(and(eq(memories.id, params.oldMemoryId), currentMemoryCondition()))
      .limit(1);

    const old = oldRows[0];
    if (!old) {
      throw new Error(
        `待替代的记忆不存在或不是当前有效状态：${params.oldMemoryId}\n` +
          `（只有满足「当前有效」谓词的记忆才能被替代，见 docs/03 §13.6）`
      );
    }

    // 生成新记忆的 id，以便第一步就能把它写进旧记忆的 superseded_by
    const newId = crypto.randomUUID();
    const validUntil =
      params.validUntil ?? params.newMemory.validFrom ?? new Date();

    // ① 先把旧记忆置为 superseded —— **必须先做这一步**。
    //
    // 顺序很重要：uq_memories_current_slot 是部分唯一索引，
    // 只覆盖 status='active' 的行。若先插入新记忆，此刻旧记忆仍是 active，
    // 同槽位两条 active 会撞唯一约束，整个操作失败。
    // 先在事务内把旧记忆移出 active 集合，槽位就腾出来了。
    //
    // 事务保证这个中间状态对外不可见：要么两步都成功，要么都回滚。
    //
    // 注意这里只改状态类字段；content 与其他不可变字段一个字都不动（C25）。
    await tx
      .update(memories)
      .set({
        status: 'superseded',
        validUntil,
        supersededBy: newId,
        updatedAt: sql`now()`,
      })
      .where(eq(memories.id, old.id));

    // ② 再插入新记忆
    const createdRows = await tx
      .insert(memories)
      .values({
        id: newId,
        userId: params.newMemory.userId,
        type: params.newMemory.type,
        content: params.newMemory.content,
        subjectKey: params.newMemory.subjectKey ?? null,
        predicateKey: params.newMemory.predicateKey ?? null,
        objectValue: params.newMemory.objectValue ?? null,
        polarity: params.newMemory.polarity ?? null,
        importanceScore: params.newMemory.importanceScore ?? old.importanceScore,
        confidenceScore: params.newMemory.confidenceScore ?? old.confidenceScore,
        status: 'active',
        validFrom: params.newMemory.validFrom ?? validUntil,
        sourceCount: 1,
      })
      .returning();

    const created = createdRows[0];
    if (!created) throw new Error('插入新记忆后未返回记录');

    // ③ 新记忆的来源
    await insertSources(tx, created.id, params.newMemory.sources);

    // 回读旧记忆，返回更新后的状态
    const oldAfter = await tx
      .select()
      .from(memories)
      .where(eq(memories.id, old.id))
      .limit(1);

    return { old: oldAfter[0]!, created };
  });
}

// ============================================================
// 冲突（C35）
// ============================================================

/**
 * 把一条新候选标记为「待用户裁决的冲突」（C35）。
 *
 * 它照常写入 memories（保留全部上下文便于审阅），但：
 *   - status='conflict' → 不被召回（§13.6 要求 active）
 *   - 不参与 uq_memories_current_slot（该索引只覆盖 active）
 *   - 不阻塞同槽位的新写入
 */
export async function createConflictMemory(
  input: CreateMemoryInput,
  options: ExecutorOption = {}
): Promise<Memory> {
  const exec = options.executor ?? db;
  return exec.transaction(async (tx) => {
    const rows = await tx
      .insert(memories)
      .values({
        userId: input.userId,
        type: input.type,
        content: input.content,
        subjectKey: input.subjectKey ?? null,
        predicateKey: input.predicateKey ?? null,
        objectValue: input.objectValue ?? null,
        polarity: input.polarity ?? null,
        importanceScore: input.importanceScore ?? 0.5,
        // 冲突意味着系统不确定，置信度应当低于正常的 1.0
        confidenceScore: input.confidenceScore ?? 0.5,
        status: 'conflict',
        validFrom: input.validFrom ?? null,
        sourceCount: 1,
      })
      .returning();

    const memory = rows[0];
    if (!memory) throw new Error('插入冲突记忆后未返回记录');

    await insertSources(tx, memory.id, input.sources);

    return memory;
  });
}

/**
 * 裁决「采纳新记忆」（C35 的 accept_new）。
 *
 * 冲突记忆转 active，被替代的旧记忆置 superseded。
 * 注意顺序：先把旧记忆置 superseded，再把冲突记忆转 active，
 * 否则两者会同时是 active 而撞上 uq_memories_current_slot。
 */
export async function resolveConflictAcceptNew(
  params: {
    conflictMemoryId: string;
    supersededMemoryId: string;
    validUntil?: Date;
  },
  options: ExecutorOption = {}
): Promise<{ activated: Memory; superseded: Memory }> {
  const exec = options.executor ?? db;
  return exec.transaction(async (tx) => {
    const conflict = await loadMemory(tx, params.conflictMemoryId);
    if (conflict.status !== 'conflict') {
      throw new Error(
        `记忆 ${params.conflictMemoryId} 的状态是 ${conflict.status}，不是 conflict，无法按冲突裁决`
      );
    }

    const old = await loadMemory(tx, params.supersededMemoryId);
    if (old.status !== 'active') {
      throw new Error(
        `记忆 ${params.supersededMemoryId} 的状态是 ${old.status}，不是 active，无法被替代`
      );
    }

    const validUntil = params.validUntil ?? conflict.validFrom ?? new Date();

    // 先腾出槽位
    await tx
      .update(memories)
      .set({
        status: 'superseded',
        validUntil,
        supersededBy: conflict.id,
        updatedAt: sql`now()`,
      })
      .where(eq(memories.id, old.id));

    // 再把冲突记忆转正
    const activatedRows = await tx
      .update(memories)
      .set({ status: 'active', validFrom: sql`COALESCE(${memories.validFrom}, now())`, updatedAt: sql`now()` })
      .where(eq(memories.id, conflict.id))
      .returning();

    const supersededRows = await tx
      .select()
      .from(memories)
      .where(eq(memories.id, old.id))
      .limit(1);

    return { activated: activatedRows[0]!, superseded: supersededRows[0]! };
  });
}

/**
 * 裁决「保留旧记忆」（C35 的 keep_old）。
 *
 * 冲突记忆转 archived：保留为历史但永不召回，也不占用槽位。
 */
export async function resolveConflictKeepOld(
  params: { conflictMemoryId: string },
  options: ExecutorOption = {}
): Promise<Memory> {
  const exec = options.executor ?? db;

  const rows = await exec
    .update(memories)
    .set({ status: 'archived', validUntil: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(memories.id, params.conflictMemoryId), eq(memories.status, 'conflict')))
    .returning();

  const memory = rows[0];
  if (!memory) {
    throw new Error(
      `记忆 ${params.conflictMemoryId} 不存在或不是 conflict 状态，无法按「保留旧记忆」裁决`
    );
  }
  return memory;
}

/**
 * 把长期未裁决的冲突记忆自动归档（C35：默认 30 天）。
 *
 * 避免 conflict 记录无限累积。返回被归档的条数。
 *
 * @param olderThanDays 超过该天数仍未裁决则归档。
 *                      用 `<=` 比较，因此传 0 表示「全部立即归档」——
 *                      若用 `<`，刚创建的记录会因 created_at 恰等于 now()
 *                      而漏掉（时间戳精度导致）。
 */
export async function archiveStaleConflicts(
  userId: string,
  olderThanDays = 30,
  options: ExecutorOption = {}
): Promise<number> {
  const exec = options.executor ?? db;

  const rows = await exec
    .update(memories)
    .set({ status: 'archived', updatedAt: sql`now()` })
    .where(
      and(
        eq(memories.userId, userId),
        eq(memories.status, 'conflict'),
        sql`${memories.createdAt} <= now() - ${`${olderThanDays} days`}::interval`
      )
    )
    .returning({ id: memories.id });

  return rows.length;
}

// ============================================================
// 软删除与恢复
// ============================================================

/**
 * 软删除记忆（§24.4）。
 *
 * 同一事务内：
 *   ① memory 置 status='deleted' + deleted_at
 *   ② 其 embedding 置 status='deleted'
 *
 * ② 不是严格必需（检索谓词已因 status 变化而排除它），
 * 但保持数据一致、避免"看起来还能用"的向量残留。
 */
export async function softDeleteMemory(
  memoryId: string,
  options: ExecutorOption = {}
): Promise<Memory> {
  const exec = options.executor ?? db;
  return exec.transaction(async (tx) => {
    const rows = await tx
      .update(memories)
      .set({ status: 'deleted', deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(memories.id, memoryId))
      .returning();

    const memory = rows[0];
    if (!memory) throw new Error(`记忆不存在：${memoryId}`);

    await tx
      .update(memoryEmbeddings)
      .set({ status: 'deleted' })
      .where(eq(memoryEmbeddings.memoryId, memoryId));

    return memory;
  });
}

/**
 * 恢复被软删除的记忆（接口 §25 的 restore）。
 *
 * 恢复到 active。若该槽位已被别的记忆占用，则转为 conflict 等待裁决 ——
 * 直接置 active 会撞上 uq_memories_current_slot。
 *
 * embedding 同步恢复为 ready（与 softDeleteMemory 对称）。
 */
export async function restoreMemory(
  memoryId: string,
  options: ExecutorOption = {}
): Promise<{ memory: Memory; becameConflict: boolean }> {
  const exec = options.executor ?? db;
  return exec.transaction(async (tx) => {
    const target = await loadMemory(tx, memoryId);

    if (target.status !== 'deleted') {
      throw new Error(`记忆 ${memoryId} 的状态是 ${target.status}，只有已删除的可以恢复`);
    }

    // 检查槽位是否已被占用（只有带槽位的记忆才需要检查）
    let becameConflict = false;
    if (target.predicateKey !== null && target.subjectKey !== null) {
      const occupied = await tx
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.userId, target.userId),
            eq(memories.subjectKey, target.subjectKey),
            eq(memories.predicateKey, target.predicateKey),
            currentMemoryCondition()
          )
        )
        .limit(1);

      becameConflict = occupied.length > 0;
    }

    const rows = await tx
      .update(memories)
      .set({
        status: becameConflict ? 'conflict' : 'active',
        deletedAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(memories.id, memoryId))
      .returning();

    await tx
      .update(memoryEmbeddings)
      .set({ status: 'ready' })
      .where(eq(memoryEmbeddings.memoryId, memoryId));

    return { memory: rows[0]!, becameConflict };
  });
}

/**
 * 物理删除记忆（§24.4 承诺的「真正的物理删除」）。
 *
 * ⚠️ 这是不可逆操作，仅供用户在明确要求永久删除时使用。
 *
 * 为什么现在能删了：C23 已把 superseded_by 改为无外键，
 * 因此即使别的记忆把它作为 superseded_by 指向目标，也不会阻塞删除
 * —— 那会留下悬空历史指针，这是刻意接受的代价（审计 F-04）。
 *
 * memory_embeddings 与 memory_sources 由外键 ON DELETE CASCADE 自动清理。
 */
export async function hardDeleteMemory(
  memoryId: string,
  options: ExecutorOption = {}
): Promise<boolean> {
  const exec = options.executor ?? db;

  const rows = await exec
    .delete(memories)
    .where(eq(memories.id, memoryId))
    .returning({ id: memories.id });

  return rows.length > 0;
}

// ============================================================
// 来源管理
// ============================================================

/**
 * 移除指向某条消息的来源指针（§24.3 第 ③ 步 b 支）。
 *
 * 用途：删除会话时，对于「仍有其他来源」的记忆，只移除指向被删消息的来源，
 * 记忆本身保留。
 */
export async function removeSourcesByMessageIds(messageIds: string[]): Promise<number> {
  if (messageIds.length === 0) return 0;

  const rows = await db
    .delete(memorySources)
    .where(sql`${memorySources.messageId} = ANY(${messageIds})`)
    .returning({ id: memorySources.id });

  return rows.length;
}

// ============================================================
// 内部辅助
// ============================================================

async function loadMemory(tx: StoreExecutor, id: string): Promise<Memory> {
  const rows = await tx.select().from(memories).where(eq(memories.id, id)).limit(1);
  const memory = rows[0];
  if (!memory) throw new Error(`记忆不存在：${id}`);
  return memory;
}

/**
 * 写入来源记录。
 *
 * @param ignoreConflict 去重合并场景下，同一 (memory, message) 可能已存在，
 *                       此时忽略冲突而非报错（uq_memory_sources_memory_message）
 */
async function insertSources(
  tx: StoreExecutor,
  memoryId: string,
  sources: MemorySourceInput[],
  options: { ignoreConflict?: boolean } = {}
): Promise<void> {
  if (sources.length === 0) return;

  const values = sources.map((s) => ({
    memoryId,
    sourceType: s.sourceType,
    messageId: s.messageId ?? null,
    eventId: s.eventId ?? null,
    goalId: s.goalId ?? null,
  }));

  const stmt = tx.insert(memorySources).values(values);
  await (options.ignoreConflict ? stmt.onConflictDoNothing() : stmt);
}

/**
 * 【调用方须知】embedding 的生成不能放进本文件的事务。
 *
 * 理由（§25.2）：embedding 是外部调用（GPU 推理），
 * 在事务内做会把数据库连接持有到推理结束，且失败时连记忆本体一起回滚
 * —— 而记忆本体是应该保留的。
 *
 * 正确顺序：
 *   ① 事务 A：写入记忆（本文件的方法）
 *   ② 事务外：调用 bge-m3 生成向量
 *   ③ 事务 B：写入 memory_embeddings
 *
 * ②失败时的降级：记忆保留，embedding 缺失或标记 failed，
 * 该记忆仍可被关键词通道（pg_trgm）召回 —— 功能降级但不丢失。
 */
export const EMBEDDING_FLOW_NOTE = 'see docs/03 §25.2';
