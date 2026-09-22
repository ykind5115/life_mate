-- ============================================================
-- 自定义 migration 0003
--
-- 内容：Drizzle Schema 无法表达的两个约束
--   ① excl_extraction_range —— EXCLUDE 排他约束（§11.3.2，C20/C32）
--   ② memory_sources 的 event_id / goal_id 外键（§23.1，C31）
--
-- 两者都需要后置 ALTER，原因不同：
--   ① Drizzle 不支持 EXCLUDE 约束
--   ② 建表顺序：memory_sources 早于 events / goals 建表，
--      无法在 schema 里表达前向引用
-- ============================================================

-- ------------------------------------------------------------
-- ① 成功的抽取区间不得两两重叠（§11.3.2）
--
-- 幂等键 uq_extraction_idempotency 只能拦住「起点相同」的重复触发；
-- 对「起点不同但区间重叠」无能为力，例如：
--     [1,5] 与 [3,10]  —— 起点不同，键不冲突，但消息 3~5 被抽了两遍
-- 因此需要排他约束补足。
--
-- 依赖 btree_gist 扩展（提供 uuid 的 GiST 等值操作符类），
-- 已在 devops/postgres/init/01-extensions.sql 中安装（C32）。
--
-- WHERE status='succeeded' 是刻意的：
--   failed 区间允许重叠，这样失败区间能被下一次触发自然覆盖，
--   无需特殊重试逻辑（见 §11.4 的 C21）。
-- ------------------------------------------------------------
ALTER TABLE "extraction_runs" ADD CONSTRAINT "excl_extraction_range"
  EXCLUDE USING gist (
    "conversation_id" WITH =,
    int8range("start_sequence", "end_sequence", '[]') WITH &&
  ) WHERE ("status" = 'succeeded');


-- ------------------------------------------------------------
-- ② memory_sources 的后置外键（§23.1，C31）
--
-- §15.2 / §23.1 承诺这两个指针为 ON DELETE SET NULL，
-- 但附录 A 的建表语句因顺序问题缺失，按附录 A 实现会留下悬空指针、
-- 且删除 Goal / Event 后投影记忆不被失效。
--
-- ⚠️ 代价与前提（务必理解，这是审计 F-02/F-03 的同类陷阱）：
--    SET NULL 会触发一次 UPDATE，而该 UPDATE 会重新校验
--    chk_sources_has_origin。因此删除 Event / Goal 时**必须**先按
--    §24 的策略清理依赖数据，不能依赖数据库级联：
--      删除 Goal  → 先失效投影记忆、再删来源行、最后删 Goal（C24）
--      删除 Event → 默认软删除，event_id 不会被置空；
--                   仅物理删除时才需同样清理
-- ------------------------------------------------------------
ALTER TABLE "memory_sources"
  ADD CONSTRAINT "fk_memory_sources_event"
  FOREIGN KEY ("event_id") REFERENCES "events"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "memory_sources"
  ADD CONSTRAINT "fk_memory_sources_goal"
  FOREIGN KEY ("goal_id") REFERENCES "goals"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
