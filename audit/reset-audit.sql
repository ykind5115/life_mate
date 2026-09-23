-- 清理前审计：确认要删的内容都是测试产生的
\pset border 2

SELECT 'conversations' AS 表, count(*) AS 行数 FROM conversations
UNION ALL SELECT 'messages', count(*) FROM messages
UNION ALL SELECT 'conversation_summaries', count(*) FROM conversation_summaries
UNION ALL SELECT 'memories', count(*) FROM memories
UNION ALL SELECT 'memory_embeddings', count(*) FROM memory_embeddings
UNION ALL SELECT 'memory_sources', count(*) FROM memory_sources
UNION ALL SELECT 'events', count(*) FROM events
UNION ALL SELECT 'goals', count(*) FROM goals
UNION ALL SELECT 'extraction_runs', count(*) FROM extraction_runs
UNION ALL SELECT 'relationships', count(*) FROM relationships
UNION ALL SELECT 'users', count(*) FROM users;

\echo ''
\echo '--- 记忆内容（确认都是测试数据）---'
SELECT substring(content, 1, 44) AS content, type, status FROM memories ORDER BY created_at;

\echo ''
\echo '--- 用户 ---'
SELECT id, name, timezone, created_at FROM users;
