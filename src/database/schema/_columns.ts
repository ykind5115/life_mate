/**
 * 共享列定义助手
 *
 * 依据：《数据库设计 V1.1》§6 命名规范、§7 UUID 设计
 *
 * 统一三件事，避免每张表重复且写法漂移：
 *   ① 主键：UUID v4，由 gen_random_uuid() 生成（C34：PG13+ 内置，无需 uuid-ossp）
 *   ② 时间：TIMESTAMPTZ（§33 基线），默认 now()
 *   ③ 时间精度：PostgreSQL 默认 timestamp(6)，这里显式保持默认
 */
import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * 主键列。
 *
 * C34 记录了为什么用 v4 而非 v7：
 *   - v4 随机，不泄露创建顺序与数据量
 *   - v7 时间有序、索引局部性更好，但会泄露创建时间
 *   - 本项目是单用户、低写入量，索引局部性不是瓶颈
 *   - 切换条件已在 §7 写明（若未来出现高写入或需要时间排序的主键场景）
 */
export const primaryId = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);

/** 创建时间。所有表都有 */
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`);

/** 更新时间。仅可变的表才有 */
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`);

/** 可空的业务时间列（如 valid_from / event_time / started_at） */
export const nullableTime = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

/** 必填的业务时间列 */
export const requiredTime = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' }).notNull();
