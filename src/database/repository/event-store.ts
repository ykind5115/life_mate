/**
 * Event 读写（docs/03 §20）—— 同时承担 Timeline 职责
 *
 * 【C7：Timeline 不是独立表】
 *   §20.1 明确 Timeline 是 events 的**查询视图**：
 *     SELECT * FROM events
 *      WHERE user_id = $1 AND timeline_visible = true AND deleted_at IS NULL
 *        AND event_time BETWEEN $2 AND $3
 *      ORDER BY event_time DESC
 *   双表写入没有一致性保障、也没有重建路径（审计 P0-5），因此不保留第二份数据。
 *
 * 【C8：source_message_id 是 SET NULL 而不是 RESTRICT】
 *   与 memory_sources 不同：记忆**必须**有来源（它是"从哪来"的凭证），
 *   而事件在消息被删后应保留 —— 事件是用户生活里发生过的事，
 *   不因为聊天记录被清理就不存在了。
 *   因此这里的外键是 ON DELETE SET NULL（schema 已声明），
 *   UI 上显示「来源对话已删除」而不是删掉事件。
 */
import { and, asc, count, desc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';

import { db } from '../client.js';
import { events, type Event } from '../schema/events.js';
import type { EventCategory } from '../schema/enums.js';
import type { ExecutorOption, Paginated } from './types.js';

/** 未删除的事件谓词。所有面向用户的查询都必须带上 */
function aliveEventCondition(): SQL {
  return isNull(events.deletedAt);
}

// ============================================================
// 查询
// ============================================================

export interface ListEventsFilter {
  userId: string;
  /** 时间窗起点（含） */
  from?: Date;
  /** 时间窗终点（含） */
  to?: Date;
  category?: EventCategory;
  /** 是否只要时间线可见的。缺省 true（Timeline 视图的口径） */
  timelineOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * 按时间窗列出事件。
 *
 * ⚠️ 排序是 **event_time 倒序**（§20.1 的参考查询）：
 *    时间线要「最近发生的在最上面」。
 *    注意不是 created_at —— 用户今天补记去年的事时，
 *    它应该出现在去年的位置，而不是今天的位置。
 */
export async function listEvents(
  filter: ListEventsFilter,
  options: ExecutorOption = {}
): Promise<Paginated<Event>> {
  const exec = options.executor ?? db;
  const limit = clampLimit(filter.limit);
  const offset = Math.max(0, filter.offset ?? 0);

  const conds: (SQL | undefined)[] = [eq(events.userId, filter.userId), aliveEventCondition()];

  if (filter.from) conds.push(gte(events.eventTime, filter.from));
  if (filter.to) conds.push(lte(events.eventTime, filter.to));
  if (filter.category) conds.push(eq(events.category, filter.category));
  // 缺省只看时间线可见的；传 false 可拿到全部（管理页用）
  if (filter.timelineOnly !== false) conds.push(eq(events.timelineVisible, true));

  const where = and(...conds);

  const [items, totalRows] = await Promise.all([
    exec
      .select()
      .from(events)
      .where(where)
      .orderBy(desc(events.eventTime), desc(events.createdAt))
      .limit(limit)
      .offset(offset),
    exec.select({ n: count() }).from(events).where(where),
  ]);

  return { items, total: totalRows[0]?.n ?? 0, limit, offset };
}

/** 按 id 取事件（含已软删除的，便于区分 404 与"已删除"） */
export async function findEventById(
  id: string,
  options: ExecutorOption = {}
): Promise<Event | undefined> {
  const exec = options.executor ?? db;
  const rows = await exec.select().from(events).where(eq(events.id, id)).limit(1);
  return rows[0];
}

/**
 * 查找**同一 UTC 日期内标题相同**的事件（去重判据的原子操作）。
 *
 * 只做数据访问，不含「要不要去重」的业务判断 ——
 * 那个判断在 memory/event-writer.ts 里。
 *
 * 【为什么按天而不是按时刻】
 *   模型每次输出的 eventTime 精度不同（有的到日，有的到分），
 *   按时刻比对会漏掉「同一天但时间戳不同」的重复。
 *   一天之内同名的事件本来就是同一件事。
 *
 * 【为什么标题用精确匹配】
 *   相似度判断要调 embedding，而这是抽取写入路径上的热循环。
 *   宁可有少量漏判（时间线上多一个节点，用户能自己删）
 *   也不要为它引入外部调用。局限已记在 event-writer 的文件头。
 */
export async function findSameDayEventByTitle(
  params: { userId: string; title: string; eventTime: Date },
  options: ExecutorOption = {}
): Promise<Event | undefined> {
  const exec = options.executor ?? db;

  const dayStart = new Date(
    Date.UTC(
      params.eventTime.getUTCFullYear(),
      params.eventTime.getUTCMonth(),
      params.eventTime.getUTCDate()
    )
  );
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);

  const rows = await exec
    .select()
    .from(events)
    .where(
      and(
        eq(events.userId, params.userId),
        aliveEventCondition(),
        gte(events.eventTime, dayStart),
        lte(events.eventTime, dayEnd),
        eq(events.title, params.title)
      )
    )
    .limit(1);

  return rows[0];
}

/**
 * 统计某时间窗内的事件，按年月分组。
 *
 * 用途：Timeline 的**分组呈现**（§20.3 的效果图按月分组）。
 * 在前端分组也可行，但分页会把同一个月拆到两页，
 * 那时前端无法知道「这个月还有没有更多」——
 * 因此分组与计数必须在库层算。
 */
export async function countEventsByMonth(
  params: { userId: string; from?: Date; to?: Date },
  options: ExecutorOption = {}
): Promise<{ month: string; n: number }[]> {
  const exec = options.executor ?? db;

  const conds: (SQL | undefined)[] = [
    eq(events.userId, params.userId),
    aliveEventCondition(),
    eq(events.timelineVisible, true),
  ];
  if (params.from) conds.push(gte(events.eventTime, params.from));
  if (params.to) conds.push(lte(events.eventTime, params.to));

  const month = sql<string>`to_char(${events.eventTime} AT TIME ZONE 'UTC', 'YYYY-MM')`;

  const rows = await exec
    .select({ month, n: count() })
    .from(events)
    .where(and(...conds))
    // 倒序：时间线从最近的月份开始
    .groupBy(month)
    .orderBy(desc(month));

  return rows.map((r) => ({ month: r.month, n: Number(r.n) }));
}

/**
 * 列出某时间窗内的事件，供 Life Review 使用（不分页，但有条数上限）。
 *
 * 与 listEvents 的区别：Life Review 需要**按时间正序**读，
 * 因为它要把一段时间内的事讲成一个连贯的故事，
 * 倒序会让模型把因果讲反。
 */
export async function listEventsChronological(
  params: { userId: string; from: Date; to: Date; limit?: number },
  options: ExecutorOption = {}
): Promise<Event[]> {
  const exec = options.executor ?? db;

  return exec
    .select()
    .from(events)
    .where(
      and(
        eq(events.userId, params.userId),
        aliveEventCondition(),
        gte(events.eventTime, params.from),
        lte(events.eventTime, params.to)
      )
    )
    .orderBy(asc(events.eventTime))
    .limit(params.limit ?? 200);
}

// ============================================================
// 写入
// ============================================================

export interface CreateEventInput {
  userId: string;
  title: string;
  description?: string | null;
  eventTime: Date;
  category?: EventCategory | null;
  importanceScore?: number;
  sourceType?: 'conversation' | 'manual' | 'system';
  sourceMessageId?: string | null;
  timelineVisible?: boolean;
}

/** 新建事件 */
export async function createEvent(
  input: CreateEventInput,
  options: ExecutorOption = {}
): Promise<Event> {
  const exec = options.executor ?? db;

  const rows = await exec
    .insert(events)
    .values({
      userId: input.userId,
      title: input.title,
      description: input.description ?? null,
      eventTime: input.eventTime,
      category: input.category ?? null,
      importanceScore: input.importanceScore ?? 0.5,
      sourceType: input.sourceType ?? 'conversation',
      sourceMessageId: input.sourceMessageId ?? null,
      timelineVisible: input.timelineVisible ?? true,
    })
    .returning();

  const event = rows[0];
  if (!event) throw new Error('插入事件后未返回记录');
  return event;
}

/**
 * 更新事件的用户可改字段。
 *
 * ⚠️ 与记忆不同：**事件是可编辑的**。
 *    Q1 的「不可变事实」约束针对的是 memories（因为它要参与冲突判定与历史查询）；
 *    事件是用户人生经历的记录，标题写错了就应该能改。
 *    docs/04 §29 也明确给了 PATCH /timeline/:id。
 *
 *    因此允许改 title / description / eventTime / category / timelineVisible。
 *    不允许改 sourceType / sourceMessageId（那是来源凭证）与 createdAt。
 */
export async function updateEvent(
  id: string,
  patch: {
    title?: string;
    description?: string | null;
    eventTime?: Date;
    category?: EventCategory | null;
    importanceScore?: number;
    timelineVisible?: boolean;
  },
  options: ExecutorOption = {}
): Promise<Event | undefined> {
  const exec = options.executor ?? db;

  const rows = await exec
    .update(events)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.eventTime !== undefined ? { eventTime: patch.eventTime } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.importanceScore !== undefined
        ? { importanceScore: patch.importanceScore }
        : {}),
      ...(patch.timelineVisible !== undefined ? { timelineVisible: patch.timelineVisible } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(events.id, id), aliveEventCondition()))
    .returning();

  return rows[0];
}

/**
 * 软删除事件（docs/04 §30）。
 *
 * 软删除的理由与记忆一致：误删可恢复。
 * 且 timeline_visible=false 与 deleted_at 是两件事：
 *   前者 = 「还在，但我不想在时间线上看到它」
 *   后者 = 「删掉」
 * 前端「从时间线移除」应优先用前者（不丢数据）。
 */
export async function softDeleteEvent(
  id: string,
  options: ExecutorOption = {}
): Promise<Event | undefined> {
  const exec = options.executor ?? db;

  const rows = await exec
    .update(events)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(events.id, id), aliveEventCondition()))
    .returning();

  return rows[0];
}

/** 恢复被软删除的事件 */
export async function restoreEvent(
  id: string,
  options: ExecutorOption = {}
): Promise<Event | undefined> {
  const exec = options.executor ?? db;

  const rows = await exec
    .update(events)
    .set({ deletedAt: null, updatedAt: sql`now()` })
    .where(eq(events.id, id))
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
