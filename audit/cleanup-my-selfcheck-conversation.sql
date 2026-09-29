-- ============================================================
-- 清掉我自己那条软删除的占位会话
--
-- 来源：2026-09-29 做 docs/13 §6.1（P0 验证轨迹落库）时，
--       我发了一条【可观测性自检】消息，用 API 软删除。
--       软删除是**设计行为**（会话保留、标题置占位、消息物理删除），
--       所以列表里留下一行空的「[已删除的对话]」是正常的 ——
--       但它是我造的，不该占你的列表。
--
-- 🔴 安全：
--   · 按 id 精确删除
--   · 删除前断言「该会话 0 条消息」，带消息就中止
--   · 只删这 1 行，不碰你自己的会话
-- ============================================================

BEGIN;

DO $$
DECLARE
  msg_count int;
  target constant uuid := '8776509c-aeda-4a31-b393-5fd3d9338b1e';
BEGIN
  SELECT count(*) INTO msg_count FROM messages WHERE conversation_id = target;
  IF msg_count > 0 THEN
    RAISE EXCEPTION '目标会话仍有 % 条消息，中止（可能选错了目标）', msg_count;
  END IF;
END $$;

DELETE FROM conversation_summaries
 WHERE conversation_id = '8776509c-aeda-4a31-b393-5fd3d9338b1e';

DELETE FROM conversations
 WHERE id = '8776509c-aeda-4a31-b393-5fd3d9338b1e';

SELECT title, status,
       (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS msgs
FROM conversations c
WHERE c.user_id = (SELECT id FROM users ORDER BY created_at LIMIT 1)
ORDER BY c.created_at DESC;

COMMIT;
