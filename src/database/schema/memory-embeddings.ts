/**
 * memory_embeddings（§14）
 *
 * 单独建表而非 memories.embedding（§14.2），价值在于：
 *   ① 重算向量不影响记忆本体
 *   ② 同一维度下可共存多个模型（做效果对照）
 *   ③ 单条重算失败可标记 failed 并重试
 *
 * ⚠️ C36：但「平滑换模型」只在同一维度内成立。
 *    embedding 列类型是 VECTOR(1024)，非 1024 维模型无法入库。
 *    跨维度换模型 = 一次显式数据迁移 + 改表结构，不是配置项。
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { vector } from 'drizzle-orm/pg-core';

import { createdAt, primaryId } from './_columns.js';
import { EMBEDDING_STATUSES, inClause } from './enums.js';
import { memories } from './memories.js';

/**
 * 冻结的向量维度（§4.2，Q4 决策）。
 *
 * 对应模型 BAAI/bge-m3，本地部署，MIT 授权。
 * 该值同时出现在 src/shared/env.ts 的 EMBEDDING_DIM，
 * 两处必须一致 —— 不一致会导致写入被拒或检索静默失配（审计 F-11）。
 */
export const VECTOR_DIMENSIONS = 1024;

export const memoryEmbeddings = pgTable(
  'memory_embeddings',
  {
    id: primaryId(),

    memoryId: uuid('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),

    /**
     * 模型标识。取值必须来自单一常量（§14.5 C27）：
     *   'BAAI/bge-m3'
     * ⚠️ 不要写短名 'bge-m3' —— 写入与检索两处写法不一致会导致
     *    JOIN 静默失配，检索永远返回空且不报错。
     */
    model: varchar('model', { length: 100 }).notNull(),

    /** 维度冗余记录，防御性（与 VECTOR_DIMENSIONS 应始终一致） */
    dim: integer('dim').notNull(),

    /** 被向量化的确切文本快照，用于追溯与重算对比 */
    embeddedText: text('embedded_text').notNull(),

    /** hash(embedded_text)。用于检测陈旧向量 */
    contentHash: varchar('content_hash', { length: 64 }).notNull(),

    embedding: vector('embedding', { dimensions: VECTOR_DIMENSIONS }).notNull(),

    /** ready | stale | failed | deleted */
    status: varchar('status', { length: 20 }).notNull().default('ready'),

    createdAt: createdAt(),
  },
  (t) => [
    check('chk_embeddings_status', sql`${t.status}${sql.raw(inClause(EMBEDDING_STATUSES))}`),

    /**
     * 防止同一记忆在同一模型下存多个向量 ——
     * 否则重复向量会导致同一记忆被多次召回，且难以排查（§14.4）。
     */
    uniqueIndex('uq_embeddings_memory_model').on(t.memoryId, t.model),

    index('idx_embeddings_status').on(t.status),
  ]
);

export type MemoryEmbedding = typeof memoryEmbeddings.$inferSelect;
export type NewMemoryEmbedding = typeof memoryEmbeddings.$inferInsert;
