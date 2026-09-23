-- 清理后复核：内容为空、结构完整、用户偏好保留
\pset border 2

\echo '=== 内容数据（应全为 0）==='
SELECT 'conversations' AS t, count(*) AS n FROM conversations
UNION ALL SELECT 'messages', count(*) FROM messages
UNION ALL SELECT 'memories', count(*) FROM memories
UNION ALL SELECT 'memory_embeddings', count(*) FROM memory_embeddings
UNION ALL SELECT 'memory_sources', count(*) FROM memory_sources
UNION ALL SELECT 'events', count(*) FROM events
UNION ALL SELECT 'goals', count(*) FROM goals
UNION ALL SELECT 'extraction_runs', count(*) FROM extraction_runs
ORDER BY t;

\echo ''
\echo '=== 用户（保留，且偏好未被破坏）==='
SELECT name, timezone, settings FROM users;

\echo ''
\echo '=== 表结构完整（应 11 张业务表）==='
SELECT count(*) AS 表数 FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

\echo ''
\echo '=== 关键约束仍在（抽查部分唯一索引与 CHECK）==='
SELECT conname FROM pg_constraint
 WHERE conname IN ('chk_memories_status','chk_goals_time_order','chk_events_category')
 ORDER BY conname;
SELECT indexname FROM pg_indexes
 WHERE indexname = 'uq_memories_current_slot';

\echo ''
\echo '=== 扩展仍在 ==='
SELECT extname FROM pg_extension ORDER BY extname;
