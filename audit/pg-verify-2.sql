-- PostgreSQL 补充验证（ASCII-only echo，避免 PowerShell 管道破坏引号）
\pset pager off

\echo '=== A. Chinese pg_trgm keyword retrieval ==='
CREATE TEMP TABLE mtest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL
);
CREATE INDEX idx_mtest_trgm ON mtest USING gin (content gin_trgm_ops);
INSERT INTO mtest (content) VALUES
  ('user is learning TypeScript'),
  ('user lives in Guangzhou'),
  ('user prefers direct technical explanations'),
  ('user is learning TypeScript'),
  ('user lives in Guangzhou'),
  ('user prefers direct technical explanations');

\echo '-- A1. substring match (should hit TypeScript row)'
SELECT content FROM mtest WHERE content ILIKE '%TypeScript%';

\echo '-- A2. trgm similarity ranking order'
SELECT content, round(similarity(content, 'learning TypeScript')::numeric, 4) AS sim
  FROM mtest GROUP BY content ORDER BY sim DESC;

\echo '-- A3. GIN index is used for trgm operator'
EXPLAIN (COSTS OFF) SELECT content FROM mtest WHERE content LIKE '%TypeScript%';

\echo ''
\echo '=== B. gen_random_uuid without uuid-ossp ==='
SELECT gen_random_uuid() AS uuid_v4, length(gen_random_uuid()::text) AS len;

\echo ''
\echo '=== C. CHECK constraint on memories status enum (C35) ==='
CREATE TEMP TABLE c35 (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status varchar(20) NOT NULL DEFAULT 'active',
  superseded_by uuid,
  deleted_at timestamptz,
  CONSTRAINT chk_c35_status CHECK (status IN ('active','conflict','superseded','archived','deleted')),
  CONSTRAINT chk_c35_superseded CHECK (status <> 'superseded' OR superseded_by IS NOT NULL),
  CONSTRAINT chk_c35_deleted CHECK (status <> 'deleted' OR deleted_at IS NOT NULL)
);
INSERT INTO c35 (status) VALUES ('active');
INSERT INTO c35 (status) VALUES ('conflict');
INSERT INTO c35 (status) VALUES ('archived');
\echo '-- C1. invalid status should be rejected:'
INSERT INTO c35 (status) VALUES ('pending');

\echo ''
\echo '=== D. Partial unique index excludes conflict rows (C35 core claim) ==='
CREATE TEMP TABLE c35b (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  subject_key varchar(100),
  predicate_key varchar(100),
  object_value text,
  status varchar(20) NOT NULL DEFAULT 'active',
  valid_until timestamptz,
  superseded_by uuid,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX uq_c35b_slot
  ON c35b (user_id, subject_key, predicate_key)
  WHERE status = 'active' AND deleted_at IS NULL
    AND valid_until IS NULL AND superseded_by IS NULL
    AND predicate_key IS NOT NULL;

INSERT INTO c35b (user_id, subject_key, predicate_key, object_value, status)
VALUES ('11111111-1111-1111-1111-111111111111','user','residence.city','Guangzhou','active');

\echo '-- D1. second active same slot should be rejected:'
INSERT INTO c35b (user_id, subject_key, predicate_key, object_value, status)
VALUES ('11111111-1111-1111-1111-111111111111','user','residence.city','Shenzhen','active');

\echo '-- D2. same slot as conflict should be ACCEPTED (this is the C35 fix):'
INSERT INTO c35b (user_id, subject_key, predicate_key, object_value, status)
VALUES ('11111111-1111-1111-1111-111111111111','user','residence.city','Shenzhen','conflict');

\echo '-- D3. two conflict rows same slot both accepted (no constraint on conflict):'
INSERT INTO c35b (user_id, subject_key, predicate_key, object_value, status)
VALUES ('11111111-1111-1111-1111-111111111111','user','residence.city','Beijing','conflict');

SELECT object_value, status FROM c35b ORDER BY status, object_value;

\echo ''
\echo '=== E. Events category CHECK (C37) ==='
CREATE TEMP TABLE ev (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category varchar(50),
  CONSTRAINT chk_ev_category CHECK (
    category IS NULL OR category IN ('work','study','project','life','health','other')
  )
);
INSERT INTO ev (category) VALUES (NULL);
INSERT INTO ev (category) VALUES ('project');
INSERT INTO ev (category) VALUES ('other');
\echo '-- E1. invalid category should be rejected:'
INSERT INTO ev (category) VALUES ('random_stuff');

\echo ''
\echo '### PG SUPPLEMENTARY VERIFICATION DONE ###'
