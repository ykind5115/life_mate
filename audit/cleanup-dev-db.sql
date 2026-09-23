-- 清理开发库里测试留下的数据。
--
-- 【背景】2026-09-23：HTTP 集成测试原先跑在开发库上，
--   导致数百个测试会话堆积、14 条真实记忆被清空。
--   测试已改为连 lifemate_test（见 src/shared/test-guard.ts），
--   本脚本把残留收拾干净。
--
-- 【为什么开发库里剩下的会话全都是垃圾】
--   这个库从未被真实使用过（项目还在开发中）。库里的会话有两种来源：
--     ① 我手动 curl / node 脚本做的端到端验证
--     ② 集成测试留下的
--   两类都不是需要保留的数据。因此这里用「清空」而不是「按特征筛选」——
--   筛选条件的边界情况只会让脚本更难写对（第一版就因为漏判 mem-test-*
--   用户名下的会话而整事务回滚）。
--
-- 【顺序不可调换】
--   memory_sources.message_id 是 ON DELETE RESTRICT，
--   必须先删来源行，messages 才删得掉（§24.3 的教训）。
--   users 被 conversations 以 RESTRICT 引用，必须最后删。
--
-- ⚠️ 破坏性操作，一次性使用。若将来开发库里有了真实对话，
--    不要再用本脚本 —— 那时应按会话逐个判断。

BEGIN;

-- ---------- ① 来源行（RESTRICT 要求先删）----------
DELETE FROM memory_sources
 WHERE message_id IN (SELECT id FROM messages);

-- ---------- ② 消息 ----------
DELETE FROM messages;

-- ---------- ③ 摘要 ----------
DELETE FROM conversation_summaries;

-- ---------- ④ 会话 ----------
-- 物理删除而不是软删除：软删除只是「不想在列表里看到」，
-- 而这些是垃圾数据，留着没有意义。
DELETE FROM conversations;

-- ---------- ⑤ 测试建出来的用户（必须在会话之后）----------
DELETE FROM users WHERE name LIKE 'mem-test-%';

SELECT (SELECT count(*) FROM memories) AS memories_left,
       (SELECT count(*) FROM memory_embeddings) AS embeddings_left,
       (SELECT count(*) FROM conversations) AS conversations_left,
       (SELECT count(*) FROM messages) AS messages_left,
       (SELECT count(*) FROM users) AS users_left;

COMMIT;
