/**
 * conversations（§9）
 *
 * 注意：会话是**软删除**（status + deleted_at），
 *       而 messages / conversation_summaries 是**物理删除**（C29）。
 *       删除时标题与摘要必须清空为固定占位文案（C38，见 §24.2）。
 */
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';

import { createdAt, nullableTime, primaryId, updatedAt } from './_columns.js';
import { CONVERSATION_STATUSES, inClause } from './enums.js';
import { users } from './users.js';

export const conversations = pgTable(
  'conversations',
  {
    id: primaryId(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /** 由对话内容生成；删除时置为固定占位文案（C38） */
    title: varchar('title', { length: 200 }),

    /** 长摘要缓存；分段摘要见 conversation_summaries */
    summary: text('summary'),

    status: varchar('status', { length: 20 }).notNull().default('active'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: nullableTime('archived_at'),
    deletedAt: nullableTime('deleted_at'),
  },
  (t) => [
    check('chk_conversations_status', sql`${t.status}${sql.raw(inClause(CONVERSATION_STATUSES))}`),
    check('chk_conversations_deleted', sql`${t.status} <> 'deleted' OR ${t.deletedAt} IS NOT NULL`),

    index('idx_conversations_user_updated').on(t.userId, t.updatedAt.desc()),
    index('idx_conversations_user_status').on(t.userId, t.status),
  ]
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
