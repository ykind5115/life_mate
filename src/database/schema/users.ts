/**
 * users（§8）
 *
 * 单用户系统仍保留该表，避免未来重构整个数据模型（§8.1）。
 */
import { sql } from 'drizzle-orm';
import { jsonb, pgTable, varchar } from 'drizzle-orm/pg-core';

import { createdAt, primaryId, updatedAt } from './_columns.js';

export const users = pgTable('users', {
  id: primaryId(),

  name: varchar('name', { length: 100 }).notNull(),

  /** IANA 时区名，如 Asia/Shanghai。与数据库服务器时区相互独立 */
  timezone: varchar('timezone', { length: 64 })
    .notNull()
    .default('Asia/Shanghai'),

  /**
   * 用户偏好配置（§8.4）。
   *
   * ⚠️ 白名单键，禁止放入需要被 SQL 查询/过滤的业务字段（§16.2）。
   *    写入前须经 Zod 校验（§16.3）。允许的键：
   *      display_name, locale, response_style, response_length,
   *      auto_extract, sensitive_memory_local_only
   */
  settings: jsonb('settings')
    .notNull()
    .default(sql`'{}'::jsonb`),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 单用户场景，仅按需要建索引；users 无高频查询，故不额外建索引 */
export const usersIndexes = {
  // 占位：当前无索引需求
};

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
