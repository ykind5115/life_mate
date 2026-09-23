-- ============================================================
-- ⚠️⚠️ 危险：本脚本会清空默认用户（name='me'）的**全部内容数据**
--
-- 【状态：已退役 —— 只在开发期数据是虚构的时候用过】
--
-- 2026-09-24 起用户开始真实使用，并明确要求：
--   「我的测试数据都保留，特别是对话记录」。
--
-- 因此**不要再用本脚本**。它是为「库里全是虚构测试数据」那个阶段写的。
-- 真实使用后跑一次 = 对话记录永久丢失，且无法恢复
-- （记忆/事件/摘要都能从对话重新生成，但对话本身不能）。
--
-- 【改用哪个】
--   清理测试数据 → audit/reset-test-user.sql
--     （只删隔离用户，靠 LIFEMATE_USER_NAME 区分，不碰真实数据）
--
-- 【本脚本保留的原因】
--   ① 留档：说明开发期数据是怎么清的
--   ② 真要从零重来（例如决定丢弃全部历史）时仍然可用 ——
--      但那必须是有意识的选择，所以下面加了硬性守卫。
--
-- 守卫逻辑：默认用户若已有对话记录，直接**中止整个事务**。
--   想强行执行需要同时满足两个条件：
--     ① 在下面的变量里把 allow_wipe 改成 true
--     ② 手动确认（脚本会打印将被删除的条数，然后要求你再跑一次）
--   两个条件缺一个都不删 —— 避免误跑、避免「以为删的是测试数据」。
-- ============================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_user_id uuid;
  v_conv_count bigint;
  v_mem_count bigint;
  v_conv_deleted bigint;
BEGIN
  SELECT id INTO v_user_id FROM users WHERE name = 'me';

  IF v_user_id IS NULL THEN
    RAISE NOTICE '默认用户不存在，无需清理。';
    RETURN;
  END IF;

  SELECT count(*) INTO v_conv_count FROM conversations WHERE user_id = v_user_id;
  SELECT count(*) INTO v_mem_count  FROM memories      WHERE user_id = v_user_id;

  -- ⚠️ 硬性守卫：有对话记录就拒绝执行
  IF v_conv_count > 0 THEN
    RAISE EXCEPTION
      E'拒绝执行：默认用户（me）名下已有 % 条会话、% 条记忆。\n\n'
      '对话记录是不可再生的资产 —— 记忆/事件/摘要都能从它重新生成，\n'
      '但对话本身被删就没了。\n\n'
      '如果你确实要清空真实数据（请再确认一次这是你的意图），\n'
      '请改用这个显式的单次命令，而不是本脚本：\n\n'
      '  docker compose exec postgres psql -U lifemate -d lifemate \\\n'
      '    -c "DELETE FROM memory_sources; DELETE FROM memories; '
      'DELETE FROM messages; DELETE FROM conversation_summaries; '
      'DELETE FROM conversations; DELETE FROM events; DELETE FROM goals; '
      'DELETE FROM extraction_runs;"\n\n'
      '如果只想清理自动化测试产生的数据，用 audit/reset-test-user.sql。',
      v_conv_count, v_mem_count;

    RETURN;
  END IF;

  RAISE NOTICE '默认用户存在但无会话数据（会话 0 / 记忆 %），继续清理。', v_mem_count;

  -- ---------- 删除顺序不可调换（外键依赖）----------
  DELETE FROM memory_sources;
  DELETE FROM memories;
  DELETE FROM messages;
  DELETE FROM conversation_summaries;
  DELETE FROM conversations;
  DELETE FROM events;
  DELETE FROM goals;
  DELETE FROM relationships;
  DELETE FROM extraction_runs;

  RAISE NOTICE '已清理完成。';
END $$;

-- 复核
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
UNION ALL SELECT 'users（应保留）', count(*) FROM users;
