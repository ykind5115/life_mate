-- ============================================================
-- 清空全部内容数据，保留表结构与用户偏好
--
-- 【为什么需要它】
--   开发期间为了验证功能，往库里写了一堆**虚构的**记忆与对话
--   （「阿泽 / 团子 / 杭州 / 雅思 / 钢琴」等都是我编的测试数据）。
--   真实使用前必须清空 —— 否则 Agent 会把这些当成用户的事实。
--
-- 【保留什么】
--   users 一行：timezone 与 settings 是**配置**不是内容，保留。
--   表结构、索引、约束、extension：全部保留（DROP 是另一回事）。
--
-- 【删除顺序不可调换】
--   外键依赖链（RESTRICT 有多处）：
--     memory_sources.message_id → messages      ON DELETE RESTRICT
--     memory_sources.goal_id    → goals         ON DELETE RESTRICT
--     goals.user_id             → users         ON DELETE RESTRICT
--     memories.user_id          → users         ON DELETE RESTRICT
--   因此：来源行 → 记忆（连带向量与来源 CASCADE）→ 消息 → 摘要
--         → 会话 → 事件 → 目标
--
--   直接 TRUNCATE ... CASCADE 也能清，但那会连带清掉 users
--   （因为 users 被引用的方向相反，CASCADE 会向上传播），
--   把用户偏好一起删掉。显式 DELETE 更可控。
-- ============================================================

BEGIN;

-- ① 来源行（RESTRICT 要求最先清）
DELETE FROM memory_sources;

-- ② 记忆（memory_embeddings 由 ON DELETE CASCADE 自动清）
DELETE FROM memories;

-- ③ 消息（memory_sources 已清空，RESTRICT 不再阻塞）
DELETE FROM messages;

-- ④ 会话摘要
DELETE FROM conversation_summaries;

-- ⑤ 会话本身
DELETE FROM conversations;

-- ⑥ 事件（Timeline）
DELETE FROM events;

-- ⑦ 目标
DELETE FROM goals;

-- ⑧ 关系
DELETE FROM relationships;

-- ⑨ 抽取登记。
--    ⚠️ 必须清：它是「这段对话已经抽到第几条消息」的进度记录。
--       不清的话，新对话虽然 id 不同不受影响，但残留记录会让
--       「抽取进度」这类排查与统计看到不存在的历史。
DELETE FROM extraction_runs;

-- ---------- 顺带把自增/序列相关的状态复位（本库用 UUID，无需处理）----------

-- ---------- 检查 ----------
SELECT 'conversations' AS 表, count(*) AS 剩余 FROM conversations
UNION ALL SELECT 'messages', count(*) FROM messages
UNION ALL SELECT 'conversation_summaries', count(*) FROM conversation_summaries
UNION ALL SELECT 'memories', count(*) FROM memories
UNION ALL SELECT 'memory_embeddings', count(*) FROM memory_embeddings
UNION ALL SELECT 'memory_sources', count(*) FROM memory_sources
UNION ALL SELECT 'events', count(*) FROM events
UNION ALL SELECT 'goals', count(*) FROM goals
UNION ALL SELECT 'relationships', count(*) FROM relationships
UNION ALL SELECT 'extraction_runs', count(*) FROM extraction_runs
UNION ALL SELECT 'users（应保留 1）', count(*) FROM users;

COMMIT;
