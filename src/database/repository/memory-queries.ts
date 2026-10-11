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
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';

import { db } from '../client.js';
import { memories, type Memory } from '../schema/memories.js';
import { memorySources, type MemorySource } from '../schema/memory-sources.js';
import { messages } from '../schema/messages.js';
import { conversations } from '../schema/conversations.js';
import {
  conflictMemoryCondition,
  currentMemoryCondition,
  memoryValidAtCondition,
  notDeletedCondition,
} from './conditions.js';
import type { ListMemoriesFilter } from './memory-types.js';
import type { Paginated } from './types.js';

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

/**
 * 取某条记忆的全部来源指针。
 *
 * 用途：Memory Viewer 展示「这条记忆从哪来」（接口 §19 / §26），
 * 以及删除会话时判断记忆是否还有其他来源（§24.3 步骤②）。
 *
 * ⚠️ C22 之后 memory_sources 没有 conversation_id，
 *    「哪些会话贡献了这条记忆」必须 JOIN messages 反查，
 *    不能用本函数的返回值直接当会话 id 用。
 */
export async function findSourcesByMemoryId(
  memoryId: string,
  options: ReadOptions = {}
): Promise<MemorySource[]> {
  const exec = options.executor ?? db;

  return exec
    .select()
    .from(memorySources)
    .where(eq(memorySources.memoryId, memoryId))
    .orderBy(asc(memorySources.createdAt));
}

/**
 * 查询一组来源消息各自属于哪个会话。
 *
 * ⚠️ 为什么需要它：C22 之后 memory_sources 没有 conversation_id，
 *    「这条记忆来自哪些会话」必须 JOIN messages 反查（§15.4）。
 *    返回 Map 而不是数组，是为了让调用方一次查完再逐个取 ——
 *    否则前端要么拿到 200 条来源却不知道会话，要么为每条来源发一个请求。
 *
 * 已被物理删除的消息不会出现在结果里（JOIN 不到）。
 * 调用方据此显示「原始对话已删除」（§24.2 末尾的要求）。
 */
export async function findConversationIdsByMessageIds(
  messageIds: string[],
  options: ReadOptions = {}
): Promise<Map<string, string>> {
  const exec = options.executor ?? db;

  if (messageIds.length === 0) return new Map();

  const rows = await exec
    .select({ messageId: messages.id, conversationId: messages.conversationId })
    .from(messages)
    .where(inArray(messages.id, messageIds));

  return new Map(rows.map((r) => [r.messageId, r.conversationId]));
}

/**
 * 按消息 id 反查「这条消息的原文 + 它属于哪个会话（标题）」。
 *
 * 【为什么单独一个函数，而不是让前端按 conversation_id 再查一次】
 *   记忆来源列表通常有 2~5 条，前端逐条回查会话详情会打出 N 个请求，
 *   而且每个都拉回整个会话（十几条消息）只为拿一个标题。
 *   一次 JOIN 全取回来是最省的。
 *
 * 【为什么正文要截断】
 *   一条消息可能有几千字，而来源列表只是「让你认出这是哪句话」。
 *   截断的代价是引用不完整，因此同时返回 `contentChars` ——
 *   前端据此显示「（已截断，共 N 字）」，而不是假装那是全文。
 */
export interface MessageSnippet {
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  /** 截断后的正文。null 表示消息已被物理删除（会话被删过） */
  content: string | null;
  /** 正文原始长度；没截断时等于 content.length */
  contentChars: number;
  createdAt: Date | null;
}

export async function findMessageSnippets(
  params: { messageIds: string[]; maxChars?: number },
  options: ReadOptions = {}
): Promise<Map<string, MessageSnippet>> {
  const exec = options.executor ?? db;
  if (params.messageIds.length === 0) return new Map();

  const maxChars = params.maxChars ?? 300;

  const rows = await exec
    .select({
      messageId: messages.id,
      conversationId: messages.conversationId,
      conversationTitle: conversations.title,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(inArray(messages.id, params.messageIds));

  return new Map(
    rows.map((r) => [
      r.messageId,
      {
        messageId: r.messageId,
        conversationId: r.conversationId,
        conversationTitle: r.conversationTitle,
        content: r.content.length > maxChars ? r.content.slice(0, maxChars) : r.content,
        contentChars: r.content.length,
        createdAt: r.createdAt,
      },
    ])
  );
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

/**
 * 列出记忆里出现过的人名（knowledge graph 用）。
 *
 * 【为什么「库里有哪些人」这件事只有记忆知道】
 *   §22.3 明确设计：记忆用 predicate_key='relationship.person' +
 *   object_value=人名 指向一个人，**不建外键**。
 *   因此 relationships 表是「用户手动补全的关系信息」，
 *   而「实际聊到过谁」要从记忆里读。
 *
 *   实测（2026-10-08）：relationships 0 行，记忆里有 2 个人名 ——
 *   只读关系表的话图谱上一个「人」都没有。
 *
 * 【为什么排除已删除与 rejected】
 *   用户删掉或否定过的记忆不该让人名重新出现 —— 那等于
 *   「我删了它还记得」。conflict 保留：那只是待裁决，内容仍然是真的。
 */
export async function listPersonNames(
  userId: string,
  limit: number,
  options: ReadOptions = {}
): Promise<string[]> {
  const exec = options.executor ?? db;

  const rows = await exec
    .select({ name: memories.objectValue, n: count() })
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        isNull(memories.deletedAt),
        eq(memories.predicateKey, 'relationship.person'),
        isNotNull(memories.objectValue),
        ne(memories.status, 'rejected')
      )
    )
    .groupBy(memories.objectValue)
    // 提得多的排前面：聊得多的人更可能是重要的关系
    .orderBy(desc(count()))
    .limit(limit);

  return rows.map((r) => r.name).filter((n): n is string => n !== null && n.trim().length > 0);
}

// ============================================================
// 概览统计（前端「记忆」页顶部用）
// ============================================================

export interface MemoryOverview {
  /** 当前有效 */
  current: number;
  /** 待裁决的冲突 */
  conflict: number;
  /** 被新事实替代 */
  superseded: number;
  /** 已归档（目标完成等） */
  archived: number;
  /** 被用户否定 */
  rejected: number;
  /** 已软删除 —— 单独计数，前端用来提示「可恢复」 */
  deleted: number;
  /** 总计（不含已删除） */
  total: number;
}

/**
 * 记忆状态分布。
 *
 * 【为什么要一个专门的查询而不是前端数】
 *   前端列表是分页的（一页 50 条），拿它统计只能得到「本页的分布」。
 *   而「有 23 条待裁决」这个数字必须准确 —— 它是用户决定
 *   「现在要不要去处理」的依据。
 *
 * 【为什么用原生 SQL 的 FILTER】
 *   一次扫表得到全部计数，比 6 个 count(*) 查询便宜得多。
 *   这里不需要 §13.6 的 currentMemoryCondition —— 统计**就是要**包含
 *   各种非 active 状态，那正是它的用途。
 */
export async function getMemoryOverview(
  userId: string,
  options: ReadOptions = {}
): Promise<MemoryOverview> {
  const exec = options.executor ?? db;

  const rows = await exec
    .select({
      current: sql<number>`count(*) FILTER (WHERE ${memories.status} = 'active' AND ${memories.deletedAt} IS NULL)`,
      conflict: sql<number>`count(*) FILTER (WHERE ${memories.status} = 'conflict' AND ${memories.deletedAt} IS NULL)`,
      superseded: sql<number>`count(*) FILTER (WHERE ${memories.status} = 'superseded' AND ${memories.deletedAt} IS NULL)`,
      archived: sql<number>`count(*) FILTER (WHERE ${memories.status} = 'archived' AND ${memories.deletedAt} IS NULL)`,
      rejected: sql<number>`count(*) FILTER (WHERE ${memories.status} = 'rejected' AND ${memories.deletedAt} IS NULL)`,
      deleted: sql<number>`count(*) FILTER (WHERE ${memories.deletedAt} IS NOT NULL)`,
      total: sql<number>`count(*) FILTER (WHERE ${memories.deletedAt} IS NULL)`,
    })
    .from(memories)
    .where(eq(memories.userId, userId));

  const r = rows[0];
  const n = (v: unknown): number => Number(v ?? 0);

  return {
    current: n(r?.current),
    conflict: n(r?.conflict),
    superseded: n(r?.superseded),
    archived: n(r?.archived),
    rejected: n(r?.rejected),
    deleted: n(r?.deleted),
    total: n(r?.total),
  };
}

/**
 * 某个会话**派生出了哪些记忆**（经 memory_sources 反查）。
 *
 * 【用途】对话页侧栏「本会话产出了什么」——
 *   把「说过的话」与「它记住的东西」连起来。
 *   这是用户最能直接感知「它在学我」的地方。
 *
 * 【C22 的约束】memory_sources 没有 conversation_id，
 *   必须 JOIN messages 才能按会话过滤（§15.4）。
 */
export async function findMemoriesByConversation(
  params: { conversationId: string },
  options: ReadOptions = {}
): Promise<Memory[]> {
  const exec = options.executor ?? db;

  return exec
    .select({ memory: memories })
    .from(memories)
    .innerJoin(memorySources, eq(memorySources.memoryId, memories.id))
    .innerJoin(messages, eq(messages.id, memorySources.messageId))
    .where(
      and(
        eq(messages.conversationId, params.conversationId),
        // 已删除的记忆不该出现在这里 —— 尊重删除意图（§29.1）
        isNull(memories.deletedAt)
      )
    )
    /**
     * 一个会话可能有多条消息指向同一条记忆（抽取区间重叠时会这样），
     * 因此必须去重。用 GROUP BY 而不是 DISTINCT ON：
     * 后者在事务执行器上没有（drizzle 的类型限制），而 GROUP BY 通用。
     *
     * 按创建时间正序：用户想看到的是「这段对话里它陆续记住了什么」，
     * 那个顺序比按重要度排更符合叙事。
     */
    .groupBy(memories.id)
    .orderBy(asc(memories.createdAt))
    .then((rows) => rows.map((r) => r.memory));
}
