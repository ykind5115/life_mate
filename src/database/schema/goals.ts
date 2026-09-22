/**
 * goals（§21）
 *
 * ⚠️ goals 是「目标」的唯一写入入口（§13.10）。
 *    memory(type='goal') 只是它的语义检索投影，由 GoalService 维护。
 *    抽取器不得直接创建 type='goal' 的记忆。
 *    理由：两个入口会产生两处真相，且 Goal 的生命周期状态机对投影不生效。
 */
import { sql } from 'drizzle-orm';
import { check, index, pgTable, real, text, uuid, varchar } from 'drizzle-orm/pg-core';

import { createdAt, nullableTime, primaryId, updatedAt } from './_columns.js';
import { GOAL_STATUSES, inClause } from './enums.js';
import { users } from './users.js';

export const goals = pgTable(
  'goals',
  {
    id: primaryId(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    title: varchar('title', { length: 200 }).notNull(),
    description: text('description'),

    /** active | paused | completed | cancelled | archived */
    status: varchar('status', { length: 20 }).notNull().default('active'),

    priority: real('priority').notNull().default(0.5),

    startedAt: nullableTime('started_at'),
    targetAt: nullableTime('target_at'),
    completedAt: nullableTime('completed_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: nullableTime('deleted_at'),
  },
  (t) => [
    check('chk_goals_status', sql`${t.status}${sql.raw(inClause(GOAL_STATUSES))}`),
    check('chk_goals_priority', sql`${t.priority} BETWEEN 0 AND 1`),

    /**
     * C26（审计 F-10）：时间顺序约束。
     *
     * 原先 memories / conversation_summaries / extraction_runs 都有区间约束，
     * 唯独 goals 漏了，可以写入「目标时间早于开始时间」这类逻辑矛盾数据。
     */
    check(
      'chk_goals_time_order',
      sql`(${t.targetAt} IS NULL OR ${t.startedAt} IS NULL OR ${t.targetAt} >= ${t.startedAt})
          AND (${t.completedAt} IS NULL OR ${t.startedAt} IS NULL OR ${t.completedAt} >= ${t.startedAt})`
    ),

    index('idx_goals_user_status').on(t.userId, t.status),
  ]
);

export type Goal = typeof goals.$inferSelect;
export type NewGoal = typeof goals.$inferInsert;
