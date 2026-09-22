/**
 * Drizzle Schema 汇总入口
 *
 * ⚠️ 本文件是 drizzle-kit 的 schema 入口（见 drizzle.config.ts）。
 *
 * 状态：空。表定义尚未编写。
 *
 * 编写依据（唯一）：
 *   docs/03-database-design.md「LifeMate 数据库设计说明书 V1.1」
 *   —— 包含 C1～C38 全部修订，附录 A 有完整 DDL 可作校对基准
 *
 * ⚠️ 不要参考：
 *   docs/archive/**            已弃用快照
 *   docs/06-design-review.md   评审旧稿，其建议稿与最终设计不一致
 *
 * 实现顺序建议（按文档章节依赖）：
 *   1. users                      §8
 *   2. conversations              §9
 *   3. messages                   §10   （依赖 conversations）
 *   4. extraction_runs            §11   （依赖 conversations）
 *   5. conversation_summaries     §12   （依赖 conversations）
 *   6. memories                   §13   （依赖 users）
 *   7. memory_embeddings          §14   （依赖 memories）
 *   8. memory_sources             §15   （依赖 memories / messages / events / goals）
 *   9. events                     §20   （依赖 users / messages）
 *  10. goals                      §21   （依赖 users）
 *  11. relationships              §22   （依赖 users）
 *  12. 后置 ALTER TABLE：memory_sources 的 event_id / goal_id 外键
 *      与 excl_extraction_range 排他约束（见附录 A 末尾）
 *
 * 落库时必须保持的硬性约束（详见文档）：
 *   - memories.status 枚举含 'conflict'（C35）
 *   - memories.superseded_by 无外键（C23）
 *   - memory_sources 无 conversation_id（C22）
 *   - 部分唯一索引 uq_memories_current_slot 仅覆盖 active 且 predicate_key 非空
 *   - 不建 HNSW / IVFFlat 向量索引（§18.1）
 */

// 表定义完成后在此导出，例如：
// export * from './users.js';
// export * from './conversations.js';

export {};
