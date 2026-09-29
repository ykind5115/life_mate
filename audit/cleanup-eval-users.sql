-- ============================================================
-- 清理评测脚本因 cleanup 缺陷残留的用户
--
-- 背景：run-extraction-eval.ts 的 cleanup 原先只删
--       conversations / messages / memories，
--       漏了 events / goals / relationships —— 而它们对 users 都是
--       RESTRICT 外键。于是 `delete from users` 失败，
--       整个评测用户与它的数据留在库里。
--
--       已修复 cleanup（覆盖全部 5 张 RESTRICT 表）。
--       本脚本清掉本次留下的两行。
--
-- 🔴 安全：只删 name LIKE 'eval-%' 的用户，绝不碰 'me'。
-- ============================================================

BEGIN;

-- 先确认目标里没有真实用户
DO $$
DECLARE
  bad int;
BEGIN
  SELECT count(*) INTO bad FROM users
   WHERE name LIKE 'eval-%' AND name = 'me';
  IF bad > 0 THEN
    RAISE EXCEPTION '目标里出现了真实用户名，中止';
  END IF;
END $$;

-- 按依赖顺序清（与脚本里的 cleanup 一致）
DELETE FROM memory_sources
 WHERE memory_id IN (
   SELECT m.id FROM memories m JOIN users u ON u.id = m.user_id WHERE u.name LIKE 'eval-%'
 );
DELETE FROM memories
 WHERE user_id IN (SELECT id FROM users WHERE name LIKE 'eval-%');
DELETE FROM events
 WHERE user_id IN (SELECT id FROM users WHERE name LIKE 'eval-%');
DELETE FROM goals
 WHERE user_id IN (SELECT id FROM users WHERE name LIKE 'eval-%');
DELETE FROM relationships
 WHERE user_id IN (SELECT id FROM users WHERE name LIKE 'eval-%');
DELETE FROM messages
 WHERE conversation_id IN (
   SELECT c.id FROM conversations c JOIN users u ON u.id = c.user_id WHERE u.name LIKE 'eval-%'
 );
DELETE FROM conversations
 WHERE user_id IN (SELECT id FROM users WHERE name LIKE 'eval-%');
DELETE FROM users WHERE name LIKE 'eval-%';

SELECT name FROM users ORDER BY name;

COMMIT;
