/**
 * Repository 层导出入口
 *
 * 分层铁律（AGENTS.md §3）：只有 Repository 层碰数据库。
 * 上层（Service / Agent Tool / API Controller）通过本文件访问数据，
 * 不直接引用 schema 或 drizzle 实例 —— 这样将来换 ORM 或加缓存只改这一层。
 */
export * from './types.js';
export * from './conditions.js';
export * from './memory-types.js';
export * from './memory-queries.js';
export * from './memory-store.js';
export * from './extraction-runs.js';
export * from './conversation-queries.js';
export * from './conversation-store.js';
export * from './user-store.js';

// Schema 类型在这里再导出一次，方便上层使用而不必深入 schema 目录
export type { Memory, NewMemory } from '../schema/memories.js';
export type { MemoryEmbedding } from '../schema/memory-embeddings.js';
export type { MemorySource } from '../schema/memory-sources.js';
export type { Conversation, NewConversation } from '../schema/conversations.js';
export type { Message, NewMessage } from '../schema/messages.js';
export type { User } from '../schema/users.js';
export {
  MESSAGE_ROLES,
  CONVERSATION_STATUSES,
  EVENT_CATEGORIES,
} from '../schema/enums.js';
export type {
  MemoryStatus,
  MemoryType,
  MemoryPolarity,
  MessageRole,
  ConversationStatus,
  EventCategory,
  SourceType,
  PredicateKey,
} from '../schema/enums.js';
export { PREDICATE_KEYS, MEMORY_TYPES, MEMORY_STATUSES } from '../schema/enums.js';
