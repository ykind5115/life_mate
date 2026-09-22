/**
 * 共享枚举值
 *
 * 依据：《数据库设计 V1.1》§19.1 枚举约束清单
 *
 * 设计决定：用 text + CHECK 约束表达枚举，而不是 PostgreSQL 原生 ENUM 类型。
 *   理由（docs/03 §19 的取舍）：
 *     ① 原生 ENUM 增删值需要 ALTER TYPE，且不能在同一事务里使用新值
 *     ② 单用户项目里枚举会随需求演进（如 C35 刚给 memories.status 加了 conflict）
 *     ③ text + CHECK 的迁移成本最低，且同样能在库层拦住脏值
 *
 * 用途：
 *   - 供 Drizzle 的 check() 约束生成 CHECK (... IN (...))
 *   - 供应用层的 Zod 校验保持一致（避免两处枚举漂移）
 */

/** SQL 字面量转义：枚举值均为受控常量，不含单引号，但仍显式转义以防未来出错 */
function sqlList(values: readonly string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
}

/** 生成 ` IN ('a', 'b')` 片段，供 check() 直接拼接 */
export function inClause(values: readonly string[]): string {
  return ` IN (${sqlList(values)})`;
}

// ============================================================
// §9 conversations
// ============================================================

export const CONVERSATION_STATUSES = ['active', 'archived', 'deleted'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

// ============================================================
// §10 messages
// ============================================================

export const MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

// ============================================================
// §11 extraction_runs
// ============================================================

export const EXTRACTION_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

// ============================================================
// §12 conversation_summaries
// ============================================================

export const SUMMARY_STATUSES = ['active', 'stale'] as const;
export type SummaryStatus = (typeof SUMMARY_STATUSES)[number];

// ============================================================
// §13 memories
// ============================================================

export const MEMORY_TYPES = [
  'fact',
  'preference',
  'event',
  'goal',
  'relationship',
  'state',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * ⚠️ 含 'conflict'（C35，2026-09-22 决策）。
 *
 * 'conflict' 表示「疑似与既有记忆冲突、等待用户裁决」。
 * 该状态的记忆：
 *   - 不被召回（召回谓词要求 status='active'，§13.6）
 *   - 不参与部分唯一索引（该索引的 WHERE 只匹配 'active'，§13.11）
 *   - 不阻塞同槽位的新写入
 * 裁决流转与 30 天自动归档见 §13.5 的 C35 说明。
 */
export const MEMORY_STATUSES = [
  'active',
  'conflict',
  'superseded',
  'archived',
  'deleted',
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_POLARITIES = ['affirm', 'deny'] as const;
export type MemoryPolarity = (typeof MEMORY_POLARITIES)[number];

/**
 * 受控词表 v1（§13.7）
 *
 * ⚠️ predicate_key 必须是此表的取值，不接受模型自由生成。
 *    词表之外的信息不参与冲突判定，只存储并进入待补全队列。
 *    宁可漏判，不可错判。
 *
 * 新增槽位的成本：改这里 + 库层 CHECK + 迁移。这是刻意接受的成本。
 */
export const PREDICATE_KEYS = [
  'residence.city',
  'residence.country',
  'employment.company',
  'employment.role',
  'education.school',
  'education.major',
  'skill.learning',
  'interest.hobby',
  'preference.food',
  'preference.communication_style',
  'health.status',
  'habit.sleep',
  'habit.exercise',
  'goal.long_term',
  'plan.near_term',
  'relationship.person',
] as const;
export type PredicateKey = (typeof PREDICATE_KEYS)[number];

// ============================================================
// §14 memory_embeddings
// ============================================================

export const EMBEDDING_STATUSES = ['ready', 'stale', 'failed', 'deleted'] as const;
export type EmbeddingStatus = (typeof EMBEDDING_STATUSES)[number];

// ============================================================
// §15 memory_sources
// ============================================================

export const SOURCE_TYPES = [
  'conversation',
  'manual',
  'system',
  'goal_projection',
  'event_derived',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

// ============================================================
// §20 events
// ============================================================

/** C37：'other' 为兜底值，避免抽取器编造枚举外的分类 */
export const EVENT_CATEGORIES = [
  'work',
  'study',
  'project',
  'life',
  'health',
  'other',
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export const EVENT_SOURCE_TYPES = ['conversation', 'manual', 'system'] as const;
export type EventSourceType = (typeof EVENT_SOURCE_TYPES)[number];

// ============================================================
// §21 goals
// ============================================================

export const GOAL_STATUSES = [
  'active',
  'paused',
  'completed',
  'cancelled',
  'archived',
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

// ============================================================
// §22 relationships
// ============================================================

export const RELATIONSHIP_STATUSES = ['active', 'ended', 'archived'] as const;
export type RelationshipStatus = (typeof RELATIONSHIP_STATUSES)[number];
