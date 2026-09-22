/**
 * relationships（§22）
 *
 * V1.0 不建立复杂的人际关系图谱，只保存基本关系信息（§22.3）。
 * 未来可演化为 Person Entity / Relationship Graph / Knowledge Graph。
 *
 * 与 memory 的连接方式：记忆中的「某人」通过
 *   predicate_key = 'relationship.person' AND object_value = 人名
 * 关联到本表，而**不是外键硬绑定**。
 * 理由：即使关系记录尚不存在，记忆也不会写失败 ——
 *       关系是事后逐步补全的，不应成为记忆写入的前置条件。
 */
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { createdAt, nullableTime, primaryId, updatedAt } from './_columns.js';
import { RELATIONSHIP_STATUSES, inClause } from './enums.js';
import { users } from './users.js';

export const relationships = pgTable(
  'relationships',
  {
    id: primaryId(),

    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    /** 对方名称 */
    name: varchar('name', { length: 100 }).notNull(),

    /** family | friend | colleague | mentor | partner 等，自由文本 */
    relationType: varchar('relation_type', { length: 50 }),

    description: text('description'),

    /** active | ended | archived */
    status: varchar('status', { length: 20 }).notNull().default('active'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: nullableTime('deleted_at'),
  },
  (t) => [
    check('chk_relationships_status', sql`${t.status}${sql.raw(inClause(RELATIONSHIP_STATUSES))}`),

    index('idx_relationships_user_status').on(t.userId, t.status),

    /** 同一用户下未删除的关系名唯一，避免重复录入同一个人 */
    uniqueIndex('uq_relationships_user_name')
      .on(t.userId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
  ]
);

export type Relationship = typeof relationships.$inferSelect;
export type NewRelationship = typeof relationships.$inferInsert;
