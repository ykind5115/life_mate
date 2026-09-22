/**
 * memories（§13）—— LifeMate 最重要的数据表
 *
 * 核心设计（Q1 决策）：**不可变事实**
 *   记忆的「事实内容」创建后永不就地修改。
 *   信息变化 → 新建记忆 + 旧记忆写 valid_until + superseded_by。
 *
 * 不可变 vs 可更新的边界（C25，审计 F-07）：
 *   ❌ 不可变：content / type / subject_key / predicate_key /
 *              object_value / polarity / valid_from / created_at
 *   ✅ 可更新：source_count / confidence_score / importance_score /
 *              updated_at / status / valid_until / superseded_by / deleted_at
 *   判断准则：改这些不改变「用户说的是什么事实」，只改变「系统对它的判断」。
 *
 * 双时间轴（§13.2）：
 *   事实时间 valid_from / valid_until —— 事实在现实中何时成立
 *   记录时间 created_at / updated_at —— 系统何时知道
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { createdAt, nullableTime, primaryId, updatedAt } from './_columns.js';
import { MEMORY_POLARITIES, MEMORY_STATUSES, MEMORY_TYPES, inClause } from './enums.js';
import { users } from './users.js';

export const memories = pgTable(
  'memories',
  {
    id: primaryId(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    type: varchar('type', { length: 20 }).notNull(),

    /** 展示给用户的自然语言正文。不可变 */
    content: text('content').notNull(),

    // ---------- 结构化槽位（Q2，§13.7）----------
    // 冲突判定的最小单位是「同一槽位上的两个取值」，
    // 向量相似度无法区分「相似」与「矛盾」，必须有槽位信息。
    subjectKey: varchar('subject_key', { length: 100 }),
    /** 取自受控词表 PREDICATE_KEYS；空表示不参与冲突判定 */
    predicateKey: varchar('predicate_key', { length: 100 }),
    objectValue: text('object_value'),
    polarity: varchar('polarity', { length: 10 }),

    // ---------- 评分（§13.8 / §13.9）----------
    /** importance ≠ confidence：「准备明年创业」重要 0.9 但置信 0.6 */
    importanceScore: real('importance_score').notNull().default(0.5),
    confidenceScore: real('confidence_score').notNull().default(1.0),

    // ---------- 状态（§13.5，含 C35 的 conflict）----------
    status: varchar('status', { length: 20 }).notNull().default('active'),

    // ---------- 双时间轴（§13.2）----------
    validFrom: nullableTime('valid_from'),
    validUntil: nullableTime('valid_until'),

    /**
     * 被哪条记忆替代。
     *
     * ⚠️ C23：**刻意不加外键约束**。
     *    加 ON DELETE SET NULL 会与 chk_memories_superseded 冲突：
     *    替代者被物理删除时 superseded_by 被置空，而 status 仍是
     *    'superseded'，约束要求非空 → 违约 → 整个 DELETE 回滚，
     *    使 §24.4 承诺的「永久删除」无法兑现（审计 F-04 已实测复现）。
     *
     *    保留为纯历史指针：即使替代者已删除，这个历史事实依然成立。
     *    遍历替代链时必须容忍断层，UI 显示「（替代者已删除）」。
     */
    supersededBy: uuid('superseded_by'),

    /** 去重合并时递增（同一事实被再次提到） */
    sourceCount: integer('source_count').notNull().default(1),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: nullableTime('deleted_at'),
  },
  (t) => [
    check('chk_memories_type', sql`${t.type}${sql.raw(inClause(MEMORY_TYPES))}`),
    check('chk_memories_status', sql`${t.status}${sql.raw(inClause(MEMORY_STATUSES))}`),
    check(
      'chk_memories_polarity',
      sql`${t.polarity} IS NULL OR ${t.polarity}${sql.raw(inClause(MEMORY_POLARITIES))}`
    ),
    check('chk_memories_importance', sql`${t.importanceScore} BETWEEN 0 AND 1`),
    check('chk_memories_confidence', sql`${t.confidenceScore} BETWEEN 0 AND 1`),
    check(
      'chk_memories_valid_range',
      sql`${t.validUntil} IS NULL OR ${t.validFrom} IS NULL OR ${t.validUntil} >= ${t.validFrom}`
    ),
    check(
      'chk_memories_superseded',
      sql`${t.status} <> 'superseded' OR ${t.supersededBy} IS NOT NULL`
    ),
    check('chk_memories_deleted', sql`${t.status} <> 'deleted' OR ${t.deletedAt} IS NOT NULL`),

    /**
     * 「当前有效记忆」的部分唯一索引（§13.11）。
     *
     * 同一槽位在同一时间只能有一条当前有效记忆。
     *
     * ⚠️ 只对有槽位的记忆生效（predicate_key IS NOT NULL，C28）：
     *    无槽位记忆不受唯一性约束，其重复由抽取器的语义判重负责，
     *    数据库不兜底。因此 Memory Noise 指标需按「有槽位/无槽位」分开统计。
     *
     * ⚠️ 只匹配 status='active'，因此 'conflict' 记忆不参与该约束（C35）——
     *    这正是冲突记忆能落库且不阻塞同槽位写入的原因。
     */
    uniqueIndex('uq_memories_current_slot')
      .on(t.userId, t.subjectKey, t.predicateKey)
      .where(
        sql`${t.status} = 'active' AND ${t.deletedAt} IS NULL AND ${t.validUntil} IS NULL AND ${t.supersededBy} IS NULL AND ${t.predicateKey} IS NOT NULL`
      ),

    index('idx_memories_user_status_type').on(t.userId, t.status, t.type),
    index('idx_memories_user_updated').on(t.userId, t.updatedAt.desc()),
    index('idx_memories_slot').on(t.userId, t.subjectKey, t.predicateKey),
    index('idx_memories_type_time').on(t.userId, t.type, t.validFrom.desc()),

    /**
     * 关键词检索索引（§17.4，C16）。
     *
     * 用 pg_trgm 而非 tsvector：中文场景下 PostgreSQL 默认全文检索
     * 不支持中文分词，plainto_tsquery 会得到「关键词通道形同虚设」的结果。
     * pg_trgm 按字符三元组匹配，无需分词器，适合记忆这种短文本。
     */
    index('idx_memories_content_trgm').using('gin', t.content.op('gin_trgm_ops')),
  ]
);

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
