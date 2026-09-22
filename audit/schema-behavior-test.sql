-- ============================================================
-- memories / memory_embeddings / memory_sources 行为验证
--
-- 目的：确认 migration 生成的约束在真实 PostgreSQL 上按设计工作，
--       而不只是「DDL 里写了」。
--
-- 运行方式（避免 PowerShell 管道破坏 SQL）：
--   docker compose cp audit/schema-behavior-test.sql postgres:/tmp/t.sql
--   docker compose exec -T postgres psql -U lifemate -d lifemate -f /tmp/t.sql
--
-- 每个用例用 SAVEPOINT 隔离：预期内的报错不会 abort 整个事务、
-- 也不会让后续用例失效。全部在事务中，结尾 ROLLBACK，不留数据。
-- ============================================================

\pset pager off
\set ON_ERROR_STOP off

BEGIN;

INSERT INTO users (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'test');

-- 前置数据：T8/T9 的 extraction_runs 与 summaries 都引用会话，
-- 缺了它失败原因会变成外键违约而非预期的 CHECK 违约，
-- 导致事务 abort、后续用例全部失效（测试就没证明力了）。
INSERT INTO conversations (id, user_id, title) VALUES
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'test conv');

\echo ''
\echo '=== T1 partial unique index: one active per slot ==='
SAVEPOINT s1;
INSERT INTO memories (user_id, type, content, subject_key, predicate_key, object_value, status)
VALUES ('00000000-0000-0000-0000-000000000001','fact','user lives in Guangzhou','user','residence.city','Guangzhou','active');
\echo 'T1a first active inserted -> expect success'
RELEASE SAVEPOINT s1;

SAVEPOINT s2;
INSERT INTO memories (user_id, type, content, subject_key, predicate_key, object_value, status)
VALUES ('00000000-0000-0000-0000-000000000001','fact','user lives in Shenzhen','user','residence.city','Shenzhen','active');
\echo 'T1b second active same slot -> expect ERROR uq_memories_current_slot'
ROLLBACK TO SAVEPOINT s2;

\echo ''
\echo '=== T2 C35: conflict rows CAN be stored ==='
SAVEPOINT s3;
INSERT INTO memories (user_id, type, content, subject_key, predicate_key, object_value, status)
VALUES ('00000000-0000-0000-0000-000000000001','fact','user lives in Shenzhen','user','residence.city','Shenzhen','conflict');
\echo 'T2a conflict inserted -> expect success'
RELEASE SAVEPOINT s3;

SAVEPOINT s4;
INSERT INTO memories (user_id, type, content, subject_key, predicate_key, object_value, status)
VALUES ('00000000-0000-0000-0000-000000000001','fact','user lives in Beijing','user','residence.city','Beijing','conflict');
\echo 'T2b second conflict same slot -> expect success'
RELEASE SAVEPOINT s4;

\echo 'T2c distribution for this slot -> expect active=1, conflict=2'
SELECT status, count(*) AS n FROM memories WHERE predicate_key='residence.city' GROUP BY status ORDER BY status;

\echo ''
\echo '=== T3 no-slot memories are NOT constrained (C28 by design) ==='
SAVEPOINT s5;
INSERT INTO memories (user_id, type, content) VALUES
  ('00000000-0000-0000-0000-000000000001','fact','user likes coffee'),
  ('00000000-0000-0000-0000-000000000001','fact','user likes coffee'),
  ('00000000-0000-0000-0000-000000000001','fact','user likes coffee');
\echo 'T3a three duplicate no-slot rows -> expect success (DB does not dedupe these)'
SELECT count(*) AS no_slot_rows FROM memories WHERE predicate_key IS NULL;
RELEASE SAVEPOINT s5;

\echo ''
\echo '=== T4 chk_memories_superseded + C23 dangling pointer allowed ==='
SAVEPOINT s6;
INSERT INTO memories (user_id, type, content, status)
VALUES ('00000000-0000-0000-0000-000000000001','fact','x','superseded');
\echo 'T4a superseded without superseded_by -> expect ERROR chk_memories_superseded'
ROLLBACK TO SAVEPOINT s6;

SAVEPOINT s7;
INSERT INTO memories (user_id, type, content, status, superseded_by, valid_until)
VALUES ('00000000-0000-0000-0000-000000000001','fact','old fact','superseded',
        '99999999-9999-9999-9999-999999999999', now());
\echo 'T4b superseded pointing to non-existent id -> expect success (no FK, by design C23)'
RELEASE SAVEPOINT s7;

\echo ''
\echo '=== T5 state/field consistency checks ==='
SAVEPOINT s8;
INSERT INTO memories (user_id, type, content, status)
VALUES ('00000000-0000-0000-0000-000000000001','fact','x','deleted');
\echo 'T5a deleted without deleted_at -> expect ERROR chk_memories_deleted'
ROLLBACK TO SAVEPOINT s8;

SAVEPOINT s9;
INSERT INTO memories (user_id, type, content, importance_score)
VALUES ('00000000-0000-0000-0000-000000000001','fact','x', 1.5);
\echo 'T5b importance out of range -> expect ERROR chk_memories_importance'
ROLLBACK TO SAVEPOINT s9;

SAVEPOINT s10;
INSERT INTO memories (user_id, type, content, valid_from, valid_until)
VALUES ('00000000-0000-0000-0000-000000000001','fact','x',
        '2026-09-10'::timestamptz, '2026-01-01'::timestamptz);
\echo 'T5c valid_until before valid_from -> expect ERROR chk_memories_valid_range'
ROLLBACK TO SAVEPOINT s10;

\echo ''
\echo '=== T6 memory_embeddings dimension and uniqueness ==='
SAVEPOINT s11;
INSERT INTO memory_embeddings (memory_id, model, dim, embedded_text, content_hash, embedding)
SELECT id, 'BAAI/bge-m3', 1024, 'fact|user|test', 'deadbeef',
       array_fill(1.0::real, ARRAY[1024])::vector
  FROM memories WHERE predicate_key='residence.city' AND status='active' LIMIT 1;
\echo 'T6a 1024-dim insert -> expect success'
RELEASE SAVEPOINT s11;

SAVEPOINT s12;
INSERT INTO memory_embeddings (memory_id, model, dim, embedded_text, content_hash, embedding)
SELECT id, 'BAAI/bge-m3', 1024, 'dup', 'cafe',
       array_fill(1.0::real, ARRAY[1024])::vector
  FROM memories WHERE predicate_key='residence.city' AND status='active' LIMIT 1;
\echo 'T6b same (memory_id, model) again -> expect ERROR uq_embeddings_memory_model'
ROLLBACK TO SAVEPOINT s12;

SAVEPOINT s13;
INSERT INTO memory_embeddings (memory_id, model, dim, embedded_text, content_hash, embedding)
SELECT id, 'other-model', 512, 'wrong dim', 'ffff',
       array_fill(1.0::real, ARRAY[512])::vector
  FROM memories WHERE predicate_key='residence.city' AND status='active' LIMIT 1;
\echo 'T6c 512-dim -> expect ERROR expected 1024 dimensions'
ROLLBACK TO SAVEPOINT s13;

\echo ''
\echo '=== T7 chk_sources_has_origin ==='
SAVEPOINT s14;
INSERT INTO memory_sources (memory_id, source_type)
SELECT id, 'conversation' FROM memories WHERE predicate_key='residence.city' LIMIT 1;
\echo 'T7a conversation with no pointer -> expect ERROR chk_sources_has_origin'
ROLLBACK TO SAVEPOINT s14;

SAVEPOINT s15;
INSERT INTO memory_sources (memory_id, source_type)
SELECT id, 'manual' FROM memories WHERE predicate_key='residence.city' LIMIT 1;
\echo 'T7b manual with no pointer -> expect success (manual is exempt)'
RELEASE SAVEPOINT s15;

SAVEPOINT s16;
INSERT INTO memory_sources (memory_id, source_type)
SELECT id, 'goal_projection' FROM memories WHERE predicate_key='residence.city' LIMIT 1;
\echo 'T7c goal_projection with no goal_id -> expect ERROR (NOT exempt)'
ROLLBACK TO SAVEPOINT s16;

\echo ''
\echo '=== T8 range checks on summaries and extraction_runs ==='
SAVEPOINT s17;
INSERT INTO conversation_summaries
  (conversation_id, summary, sequence_from, sequence_to, summarizer_version)
VALUES ('00000000-0000-0000-0000-000000000002','s', 10, 5, 'v1');
\echo 'T8a summaries to < from -> expect ERROR chk_summaries_range'
ROLLBACK TO SAVEPOINT s17;

SAVEPOINT s18;
INSERT INTO extraction_runs
  (conversation_id, start_sequence, end_sequence, extractor_version)
VALUES ('00000000-0000-0000-0000-000000000002', 10, 5, 'v1');
\echo 'T8b extraction end < start -> expect ERROR chk_extraction_range'
ROLLBACK TO SAVEPOINT s18;

\echo ''
\echo '=== T9 EXCLUDE: successful extraction ranges must not overlap (C20/C32) ==='
SAVEPOINT s19;
INSERT INTO extraction_runs (conversation_id, start_sequence, end_sequence, extractor_version, status)
VALUES ('00000000-0000-0000-0000-000000000002', 1, 5, 'v1', 'succeeded');
\echo 'T9a [1,5] succeeded -> expect success'
RELEASE SAVEPOINT s19;

SAVEPOINT s20;
INSERT INTO extraction_runs (conversation_id, start_sequence, end_sequence, extractor_version, status)
VALUES ('00000000-0000-0000-0000-000000000002', 1, 10, 'v1', 'succeeded');
\echo 'T9b [1,10] same start -> expect ERROR uq_extraction_idempotency'
ROLLBACK TO SAVEPOINT s20;

SAVEPOINT s21;
INSERT INTO extraction_runs (conversation_id, start_sequence, end_sequence, extractor_version, status)
VALUES ('00000000-0000-0000-0000-000000000002', 3, 10, 'v1', 'succeeded');
\echo 'T9c [3,10] different start but overlaps -> expect ERROR excl_extraction_range'
ROLLBACK TO SAVEPOINT s21;

SAVEPOINT s22;
INSERT INTO extraction_runs (conversation_id, start_sequence, end_sequence, extractor_version, status)
VALUES ('00000000-0000-0000-0000-000000000002', 6, 10, 'v1', 'succeeded');
\echo 'T9d [6,10] no overlap -> expect success'
RELEASE SAVEPOINT s22;

SAVEPOINT s23;
INSERT INTO extraction_runs (conversation_id, start_sequence, end_sequence, extractor_version, status)
VALUES ('00000000-0000-0000-0000-000000000002', 7, 20, 'v1', 'failed');
\echo 'T9e [7,20] failed overlapping -> expect success (WHERE excludes non-succeeded)'
RELEASE SAVEPOINT s23;

\echo 'T9f resulting ranges:'
SELECT start_sequence, end_sequence, status FROM extraction_runs
 WHERE conversation_id='00000000-0000-0000-0000-000000000002'
 ORDER BY start_sequence;

\echo ''
\echo '=== T10 deferred FKs on memory_sources (C31) ==='
SAVEPOINT s25;
INSERT INTO events (id, user_id, title, event_time) VALUES
  ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-000000000001','evt', now());
INSERT INTO goals (id, user_id, title) VALUES
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000001','goal');
\echo 'T10a insert event + goal -> expect success'

INSERT INTO memory_sources (memory_id, source_type, event_id)
SELECT id, 'event_derived', '00000000-0000-0000-0000-0000000000e1'
  FROM memories WHERE predicate_key='residence.city' LIMIT 1;
\echo 'T10b event_derived source with event_id -> expect success'

INSERT INTO memory_sources (memory_id, source_type, goal_id)
SELECT id, 'goal_projection', '00000000-0000-0000-0000-0000000000a1'
  FROM memories WHERE predicate_key='residence.city' LIMIT 1;
\echo 'T10c goal_projection source with goal_id -> expect success'

\echo 'T10d event_id pointing to non-existent event -> expect ERROR fk_memory_sources_event'
SAVEPOINT s26;
INSERT INTO memory_sources (memory_id, source_type, event_id)
SELECT id, 'event_derived', '00000000-0000-0000-0000-00000000dead'
  FROM memories WHERE predicate_key IS NULL LIMIT 1;
ROLLBACK TO SAVEPOINT s26;

\echo 'T10e C24 flow: delete goal AFTER clearing sources -> expect success'
DELETE FROM memory_sources WHERE goal_id='00000000-0000-0000-0000-0000000000a1';
DELETE FROM goals WHERE id='00000000-0000-0000-0000-0000000000a1';
SELECT count(*) AS goals_left FROM goals;
RELEASE SAVEPOINT s25;

\echo ''
\echo '=== T11 events category check (C37) ==='
SAVEPOINT s27;
INSERT INTO events (user_id, title, event_time, category) VALUES
  ('00000000-0000-0000-0000-000000000001','ok', now(), 'other');
\echo 'T11a category=other -> expect success'
RELEASE SAVEPOINT s27;

SAVEPOINT s28;
INSERT INTO events (user_id, title, event_time, category) VALUES
  ('00000000-0000-0000-0000-000000000001','bad', now(), 'random_stuff');
\echo 'T11b category=random_stuff -> expect ERROR chk_events_category'
ROLLBACK TO SAVEPOINT s28;

\echo ''
\echo '=== T12 goals time order check (C26) ==='
SAVEPOINT s29;
INSERT INTO goals (user_id, title, started_at, target_at) VALUES
  ('00000000-0000-0000-0000-000000000001','bad order', now(), now() - interval '10 days');
\echo 'T12a target_at before started_at -> expect ERROR chk_goals_time_order'
ROLLBACK TO SAVEPOINT s29;

\echo ''
\echo '=== FINAL STATE (inside transaction) ==='
SELECT status, count(*) AS n FROM memories GROUP BY status ORDER BY status;
SELECT count(*) AS embeddings FROM memory_embeddings;
SELECT source_type, count(*) AS n FROM memory_sources GROUP BY source_type ORDER BY source_type;
SELECT count(*) AS extraction_runs FROM extraction_runs;
SELECT count(*) AS events FROM events;

ROLLBACK;

\echo ''
\echo '### behavior verification done (rolled back) ###'
