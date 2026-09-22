/**
 * Drizzle Schema 汇总入口
 *
 * ⚠️ 本文件是 drizzle-kit 的 schema 入口（见 drizzle.config.ts）。
 *
 * 编写依据（唯一）：
 *   docs/03-database-design.md「LifeMate 数据库设计说明书 V1.1」
 *   —— 包含 C1～C38 全部修订，附录 A 有完整 DDL 可作校对基准
 *
 * ⚠️ 不要参考：
 *   docs/archive/**            已弃用快照
 *   docs/06-design-review.md   评审旧稿，其建议稿与最终设计不一致
 *
 * ------------------------------------------------------------
 * 进度
 * ------------------------------------------------------------
 * ✅ 第一批（基础对话链）
 *      users                    §8
 *      conversations            §9
 *      messages                 §10
 *      extraction_runs          §11
 *      conversation_summaries   §12
 *
 * ✅ 第三批（人生数据）
 *      events                   §20   含 category CHECK（C37）、Timeline 查询视图
 *      goals                    §21   含 chk_goals_time_order（C26）
 *      relationships            §22
 *
 * ⬜ 第四批（Drizzle 不支持、需自定义 SQL migration）
 *      excl_extraction_range    §11.3.2   EXCLUDE 约束（C20/C32）
 *      memory_sources 的 event_id / goal_id 外键（C31，因建表顺序需后置 ALTER）
 */

// ---------- 第一批：基础对话链 ----------
export * from './users.js';
export * from './conversations.js';
export * from './messages.js';
export * from './extraction-runs.js';
export * from './conversation-summaries.js';

// ---------- 第二批：记忆链 ----------
export * from './memories.js';
export * from './memory-embeddings.js';
export * from './memory-sources.js';

// ---------- 第三批：人生数据 ----------
export * from './events.js';
export * from './goals.js';
export * from './relationships.js';
