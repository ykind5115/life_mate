/**
 * events（§20）—— 同时承担 Timeline 职责
 *
 * ⚠️ C7：V1.0 初稿有独立的 timeline_events 表，已删除。
 *    Timeline 是 events 的查询视图，不是第二份数据：
 *      SELECT * FROM events
 *       WHERE user_id = $1 AND timeline_visible = true AND deleted_at IS NULL
 *         AND event_time BETWEEN $2 AND $3
 *       ORDER BY event_time DESC;
 *
 *    双表写入没有一致性保障、也没有重建路径（审计 P0-5），
 *    因此不保留。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  real,
  text,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { createdAt, nullableTime, primaryId, requiredTime, updatedAt } from './_columns.js';
import {
  EVENT_CATEGORIES,
  EVENT_PRECISIONS,
  EVENT_SOURCE_TYPES,
  inClause,
} from './enums.js';
import { messages } from './messages.js';
import { users } from './users.js';

export const events = pgTable(
  'events',
  {
    id: primaryId(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),

    /** 事件在现实中发生的时间（业务时间），与 created_at 不同 */
    eventTime: requiredTime('event_time'),

    /**
     * event_time 的精度（2026-09-29 新增）。
     *
     * 【为什么需要单独一列】
     *   只知日期、不知时刻的事件（大多数）此前被落库成 UTC 零点
     *   `T00:00:00Z` —— 在北京显示成 **08:00**。
     *   于是时间线上所有日期级事件都写着 08:00，看起来像
     *   「这些事都发生在早上八点」，一个不存在的规律。
     *
     *   而事件时间**事实上是有精度的**，只是以前无处表达：
     *     · 「上周三搬到杭州」        → 只知道日期，时刻不存在
     *     · 「今天上午面试了两个人」  → 知道大概时段
     *     · 用户明确说「下午三点」    → 知道时刻
     *   把三者都写成同一个 08:00，等于**编造了时刻**。
     *
     * 【取值】
     *   day    —— 只知道日期。event_time 落在**用户当地那一天的零点**
     *             （存成 UTC，如北京 09-29 00:00 = 09-28T16:00Z）。
     *             界面只显示日期，不显示时刻。
     *   minute —— 知道到分钟。event_time 是真实时刻，界面显示到分钟。
     *
     * ⚠️ 为什么「当地零点」而不是「UTC 零点」：
     *    两者都只表示「这一天」，但当地零点在任何按当地时区显示的
     *    界面上都会还原成正确的日期；UTC 零点在北京会变成当天 08:00。
     */
    eventPrecision: varchar('event_precision', { length: 10 })
      .notNull()
      .default('day'),

    /** work | study | project | life | health | other，可空 */
    category: varchar('category', { length: 50 }),

    importanceScore: real('importance_score').notNull().default(0.5),

    /** conversation | manual | system */
    sourceType: varchar('source_type', { length: 20 }).notNull().default('conversation'),

    /** 来源消息，可追溯。消息删除后置空，事件本身保留 */
    sourceMessageId: uuid('source_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),

    /** 是否出现在时间线视图中 */
    timelineVisible: boolean('timeline_visible').notNull().default(true),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: nullableTime('deleted_at'),
  },
  (t) => [
    check('chk_events_source_type', sql`${t.sourceType}${sql.raw(inClause(EVENT_SOURCE_TYPES))}`),
    check('chk_events_importance', sql`${t.importanceScore} BETWEEN 0 AND 1`),
    check(
      'chk_events_precision',
      sql`${t.eventPrecision}${sql.raw(inClause(EVENT_PRECISIONS))}`
    ),

    /**
     * C37：category 的库层 CHECK。
     *
     * 可空 —— 允许事件没有分类，不强制归类。
     * 'other' 为兜底值 —— 抽取器遇到无法归类的真实事件时写 'other'，
     * 而不是编造枚举外的值，也不是弃之不存。
     *
     * 新增分类时：改 enums.ts + 迁移。这是「约束下沉」刻意接受的成本。
     */
    check(
      'chk_events_category',
      sql`${t.category} IS NULL OR ${t.category}${sql.raw(inClause(EVENT_CATEGORIES))}`
    ),

    index('idx_events_user_time').on(t.userId, t.eventTime.desc()),
    index('idx_events_user_category').on(t.userId, t.category),

    /** 时间线视图专用：只覆盖可见且未删除的行 */
    index('idx_events_timeline')
      .on(t.userId, t.eventTime.desc())
      .where(sql`${t.timelineVisible} = true AND ${t.deletedAt} IS NULL`),
  ]
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
