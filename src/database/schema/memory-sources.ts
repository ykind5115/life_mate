/**
 * memory_sources（§15）
 *
 * 回答「这条记忆是从哪里来的」—— 这是 LifeMate 与普通聊天记录搜索的
 * 核心区别，也是产品信任感的基础（§15.1）。
 *
 * ⚠️ 两个易踩的坑，都来自已实测的审计发现：
 *
 * ① C22：**没有 conversation_id 字段**。
 *    它曾是冗余字段（可由 message_id → messages.conversation_id 推出），
 *    但其 ON DELETE SET NULL 会触发本表的 chk_sources_has_origin
 *    重新校验并违约，导致删除会话时整个 DELETE 被回滚（审计 F-02）。
 *    按会话反查改用 JOIN，见文件末尾的注释。
 *
 * ② message_id 用 ON DELETE RESTRICT 而非 CASCADE。
 *    删除消息时必须先由服务层决定「派生记忆如何处置」（§24.3），
 *    静默级联会绕过这个决策，让用户的删除意图未被尊重。
 *
 * ⚠️ event_id / goal_id 的外键（C31）不在此处声明：
 *    本表在 events / goals 之前建表，Drizzle 无法表达前向引用，
 *    因此在自定义 SQL migration 中用后置 ALTER TABLE 添加。
 */
import { sql } from 'drizzle-orm';
import { check, index, pgTable, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { createdAt, primaryId } from './_columns.js';
import { SOURCE_TYPES, inClause } from './enums.js';
import { memories } from './memories.js';
import { messages } from './messages.js';

export const memorySources = pgTable(
  'memory_sources',
  {
    id: primaryId(),

    memoryId: uuid('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),

    /** conversation | manual | system | goal_projection | event_derived */
    sourceType: varchar('source_type', { length: 20 }).notNull(),

    /**
     * ⚠️ RESTRICT 是刻意的：见文件头 ② 的说明。
     */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'restrict' }),

    /** 外键在自定义 migration 中后置添加（C31） */
    eventId: uuid('event_id'),

    /** 外键在自定义 migration 中后置添加（C31） */
    goalId: uuid('goal_id'),

    createdAt: createdAt(),
  },
  (t) => [
    check('chk_sources_type', sql`${t.sourceType}${sql.raw(inClause(SOURCE_TYPES))}`),

    /**
     * 至少有一个来源指针非空。
     *
     * ⚠️ manual / system 豁免：用户手工创建或系统推导的记忆
     *    本来就没有消息来源。
     *
     * ⚠️ 不要为了消除报错而把 goal_projection / event_derived 加进豁免列表
     *    （审计 F-03 的教训）。那只是让违约消失，而「投影记忆失去目标」
     *    这种不一致状态会变成合法 —— 应该修的是删除策略（§13.10 的 C24）。
     */
    check(
      'chk_sources_has_origin',
      sql`${t.messageId} IS NOT NULL OR ${t.eventId} IS NOT NULL OR ${t.goalId} IS NOT NULL OR ${t.sourceType} IN ('manual','system')`
    ),

    /** 同一 (memory, message) 不重复 */
    uniqueIndex('uq_memory_sources_memory_message')
      .on(t.memoryId, t.messageId)
      .where(sql`${t.messageId} IS NOT NULL`),

    /** 支撑删除级联时反查（§24.3 第 ① 步）与来源展示 */
    index('idx_memory_sources_message').on(t.messageId),
    index('idx_memory_sources_memory').on(t.memoryId),
  ]
);

export type MemorySource = typeof memorySources.$inferSelect;
export type NewMemorySource = typeof memorySources.$inferInsert;

/**
 * 按会话反查派生记忆（替代已删除的 conversation_id 字段）：
 *
 *   SELECT DISTINCT ms.memory_id
 *     FROM memory_sources ms
 *     JOIN messages m ON m.id = ms.message_id
 *    WHERE m.conversation_id = $1;
 *
 * 走 idx_memory_sources_message + messages 主键，性能足够。
 * 见《数据库设计 V1.1》§15.4。
 */
