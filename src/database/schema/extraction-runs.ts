/**
 * extraction_runs（§11）
 *
 * 这是为**正确性**服务的表，不是可观测性表（§11.1）。
 * 它与 agent_runs（可观测性，V1.0 只进日志）是两件事。
 *
 * 幂等键：(conversation_id, start_sequence, extractor_version)
 *   ⚠️ 是 start_sequence 而非 end_sequence（C19，审计 F-01）。
 *      end_sequence 每次触发都变，无法拦截范围重叠的重复抽取。
 *
 * 进度推进只统计 succeeded（C21，审计 F-08）：
 *      start_sequence = COALESCE(MAX(end_sequence) WHERE succeeded, 0) + 1
 *   若把 failed 也算进去，失败区间会被永久跳过且无提示。
 *
 * 区间不重叠由 excl_extraction_range 排他约束保证（C20/C32）——
 *   Drizzle 不支持 EXCLUDE，该约束在自定义 SQL migration 中添加。
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { createdAt, nullableTime, primaryId } from './_columns.js';
import { EXTRACTION_STATUSES, inClause } from './enums.js';
import { conversations } from './conversations.js';

export const extractionRuns = pgTable(
  'extraction_runs',
  {
    id: primaryId(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),

    startSequence: bigint('start_sequence', { mode: 'number' }).notNull(),
    endSequence: bigint('end_sequence', { mode: 'number' }).notNull(),

    /** 抽取器 / 提示词 / 模型版本。升级后可据此对历史对话选择性重跑 */
    extractorVersion: varchar('extractor_version', { length: 50 }).notNull(),

    status: varchar('status', { length: 20 }).notNull().default('pending'),

    memoriesCreated: integer('memories_created').notNull().default(0),
    memoriesUpdated: integer('memories_updated').notNull().default(0),
    memoriesSuperseded: integer('memories_superseded').notNull().default(0),
    conflictsFound: integer('conflicts_found').notNull().default(0),

    error: text('error'),
    createdAt: createdAt(),
    finishedAt: nullableTime('finished_at'),
  },
  (t) => [
    check('chk_extraction_status', sql`${t.status}${sql.raw(inClause(EXTRACTION_STATUSES))}`),
    check('chk_extraction_range', sql`${t.endSequence} >= ${t.startSequence}`),

    // 幂等键（C19）
    uniqueIndex('uq_extraction_idempotency').on(
      t.conversationId,
      t.startSequence,
      t.extractorVersion
    ),
    index('idx_extraction_conversation').on(t.conversationId, t.createdAt.desc()),
    // 部分索引：只覆盖待处理与失败的记录
    index('idx_extraction_pending')
      .on(t.status)
      .where(sql`${t.status} IN ('pending','running','failed')`),
  ]
);

export type ExtractionRun = typeof extractionRuns.$inferSelect;
export type NewExtractionRun = typeof extractionRuns.$inferInsert;
