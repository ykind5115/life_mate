/**
 * conversation_summaries（§12）
 *
 * 物理删除（C29）：随会话一起物理消失，无 deleted_at。
 *
 * 字段名用 sequence_from / sequence_to 而非 start/end_sequence，
 * 以与 extraction_runs 区分（C18）。
 */
import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { createdAt, primaryId } from './_columns.js';
import { SUMMARY_STATUSES, inClause } from './enums.js';
import { conversations } from './conversations.js';

export const conversationSummaries = pgTable(
  'conversation_summaries',
  {
    id: primaryId(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    summary: text('summary').notNull(),

    /** 覆盖的消息序号区间，闭区间 */
    sequenceFrom: bigint('sequence_from', { mode: 'number' }).notNull(),
    sequenceTo: bigint('sequence_to', { mode: 'number' }).notNull(),

    summarizerVersion: varchar('summarizer_version', { length: 50 }).notNull(),

    /** active | stale。被覆盖的消息删除时置 stale，触发重新生成（§12.3） */
    status: varchar('status', { length: 20 }).notNull().default('active'),

    createdAt: createdAt(),
  },
  (t) => [
    check('chk_summaries_range', sql`${t.sequenceTo} >= ${t.sequenceFrom}`),
    check('chk_summaries_status', sql`${t.status}${sql.raw(inClause(SUMMARY_STATUSES))}`),

    uniqueIndex('uq_summaries_range').on(t.conversationId, t.sequenceFrom, t.sequenceTo),
  ]
);

export type ConversationSummary = typeof conversationSummaries.$inferSelect;
export type NewConversationSummary = typeof conversationSummaries.$inferInsert;
