-- ============================================================
-- 清理**隔离测试用户**的数据（安全，不碰真实数据）
--
-- 【与 reset-dev-data.sql 的区别】
--   reset-dev-data.sql  清的是默认用户（me）—— 那是**真实数据**，已加硬性守卫
--   本脚本               只清 name <> 'me' 的用户 —— 也就是测试产生的
--
-- 【为什么按用户名区分而不是按「是不是测试会话」】
--   没有任何可靠特征能区分「我手动测试产生的对话」与「自动化测试产生的对话」——
--   两者都是「用户与 Agent 的对话」，内容上无从分辨。
--   唯一可靠的判据是**数据属于哪个用户**。
--
--   因此隔离必须在**写入时**就成立（靠 LIFEMATE_USER_NAME 指向独立用户），
--   而不是事后靠特征去筛。本脚本只是那个隔离策略的配套清理工具。
--
-- 【用法】
--   1) 起一个指向测试用户的服务：
--        $env:LIFEMATE_USER_NAME="test-agent"; pnpm start
--   2) 跑你的测试
--   3) 清理：
--        docker compose cp audit/reset-test-user.sql postgres:/tmp/rtu.sql
--        docker compose exec -T postgres psql -U lifemate -d lifemate -f /tmp/rtu.sql
--
-- ⚠️ 不会删 users 行本身（保留时区与设置，也避免与并发创建打架）。
--    想连用户一起删：本脚本末尾有注释掉的语句。
-- ============================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_ids uuid[];
  v_names text;
BEGIN
  SELECT array_agg(id), string_agg(name, ', ')
    INTO v_ids, v_names
    FROM users
   WHERE name <> 'me';

  IF v_ids IS NULL THEN
    RAISE NOTICE '没有隔离测试用户（users 里只有 me），无需清理。';
    RETURN;
  END IF;

  RAISE NOTICE '将清理以下测试用户的数据：%', v_names;

  -- ---------- 顺序不可调换（外键依赖）----------
  -- memory_sources.message_id / goal_id 都是 RESTRICT，
  -- 因此来源行必须先删。
  DELETE FROM memory_sources WHERE memory_id IN (
    SELECT id FROM memories WHERE user_id = ANY(v_ids)
  );
  DELETE FROM memory_sources WHERE goal_id IN (
    SELECT id FROM goals WHERE user_id = ANY(v_ids)
  );

  DELETE FROM memories  WHERE user_id = ANY(v_ids);
  -- memory_embeddings 由 ON DELETE CASCADE 随 memories 一起清

  DELETE FROM messages  WHERE conversation_id IN (
    SELECT id FROM conversations WHERE user_id = ANY(v_ids)
  );
  DELETE FROM conversation_summaries WHERE conversation_id IN (
    SELECT id FROM conversations WHERE user_id = ANY(v_ids)
  );
  DELETE FROM conversations WHERE user_id = ANY(v_ids);

  DELETE FROM events        WHERE user_id = ANY(v_ids);
  DELETE FROM goals         WHERE user_id = ANY(v_ids);
  DELETE FROM relationships WHERE user_id = ANY(v_ids);

  -- extraction_runs 只按会话关联，会话已删则其记录也应清
  DELETE FROM extraction_runs WHERE conversation_id NOT IN (
    SELECT id FROM conversations
  );

  -- 想连测试用户一起删（默认不删，避免与并发创建打架）：
  -- DELETE FROM users WHERE id = ANY(v_ids);

  RAISE NOTICE '测试数据已清理，真实数据（me）未受影响。';
END $$;

-- ---------- 复核：真实数据应完好，测试数据应为空 ----------
\echo ''
\echo '=== 真实用户（me）的数据 —— 应完好无损 ==='
SELECT
  (SELECT count(*) FROM conversations c JOIN users u ON u.id = c.user_id WHERE u.name = 'me') AS 会话,
  (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
     JOIN users u ON u.id = c.user_id WHERE u.name = 'me') AS 消息,
  (SELECT count(*) FROM memories WHERE user_id = (SELECT id FROM users WHERE name = 'me')) AS 记忆,
  (SELECT count(*) FROM events WHERE user_id = (SELECT id FROM users WHERE name = 'me')) AS 事件;

\echo ''
\echo '=== 测试用户的数据 —— 应为 0 ==='
SELECT
  (SELECT count(*) FROM conversations c JOIN users u ON u.id = c.user_id WHERE u.name <> 'me') AS 会话,
  (SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
     JOIN users u ON u.id = c.user_id WHERE u.name <> 'me') AS 消息,
  (SELECT count(*) FROM memories WHERE user_id IN (SELECT id FROM users WHERE name <> 'me')) AS 记忆;
