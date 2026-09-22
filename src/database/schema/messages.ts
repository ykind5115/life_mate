/**
 * messages（§10）
 *
 * 注意：messages 是**物理删除**（C29）—— 没有 deleted_at 字段。
 *       由 conversation_summaries 与 memory_sources 引用。
 *
 * sequence：会话内单调序号，由服务层在事务内分配（§10.4），
 *           唯一约束是最终防线。
 */
import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgTable, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { createdAt, primaryId } from './_columns.js';
import { MESSAGE_ROLES, inClause } from './enums.js';
import { conversations } from './conversations.js';

export const messages = pgTable(
  'messages',
  {
    id: primaryId(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    role: varchar('role', { length: 20 }).notNull(),

    content: text('content').notNull(),

    /** 会话内从 1 开始单调递增；分配方式见 §10.4 */
    sequence: bigint('sequence', { mode: 'number' }).notNull(),

    /** 白名单键，写入前经 Zod 校验（§10.5、§16.3） */
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),

    createdAt: createdAt(),
  },
  (t) => [
    check('chk_messages_role', sql`${t.role}${sql.raw(inClause(MESSAGE_ROLES))}`),

    // 唯一约束是 sequence 并发分配的最终防线（§10.4）
    uniqueIndex('uq_messages_conversation_sequence').on(t.conversationId, t.sequence),
    index('idx_messages_sequence').on(t.conversationId, t.sequence.desc()),
    index('idx_messages_created_at').on(t.conversationId, t.createdAt),
  ]
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
