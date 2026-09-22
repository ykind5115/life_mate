-- ============================================================
-- PostgreSQL 侧验证（环境就绪后的实测）
-- 目的：清掉审计报告 §7.3 欠下的验证项
-- 执行：docker compose exec -T postgres psql -U lifemate -d lifemate -f -
-- ============================================================

\echo '=========== 1. 扩展与服务器参数 ==========='
SELECT extname, extversion FROM pg_extension ORDER BY extname;
SHOW server_version;
SHOW TimeZone;
SHOW server_encoding;

\echo ''
\echo '=========== 2. pgvector 维度约束（验证 VECTOR(1024) 生效）==========='
CREATE TEMP TABLE vtest (id int, embedding vector(1024));
INSERT INTO vtest VALUES (1, array_fill(1.0::real, ARRAY[1024])::vector);
INSERT INTO vtest VALUES (2, array_fill(0.9::real, ARRAY[1024])::vector);
\echo '-- 下面这条 512 维应当被拒绝：'
INSERT INTO vtest VALUES (3, array_fill(1.0::real, ARRAY[512])::vector);

\echo ''
\echo '=========== 3. 余弦相似度算子 ==========='
SELECT id, round((1 - (embedding <=> (SELECT embedding FROM vtest WHERE id=1)))::numeric, 6) AS cos_sim
  FROM vtest ORDER BY embedding <=> (SELECT embedding FROM vtest WHERE id=1);

\echo ''
\echo '=========== 4. 精确检索（应走 Seq Scan，证明未建索引）==========='
EXPLAIN (COSTS OFF)
SELECT id FROM vtest ORDER BY embedding <=> (SELECT embedding FROM vtest WHERE id=1) LIMIT 1;

\echo ''
\echo '=========== 5. 【关键】EXCLUDE 约束 + btree_gist（验证 C20/C32）==========='
CREATE TEMP TABLE runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL,
  start_sequence    bigint NOT NULL,
  end_sequence      bigint NOT NULL,
  extractor_version varchar(50) NOT NULL,
  status            varchar(20) NOT NULL,
  CONSTRAINT chk_runs_status CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  CONSTRAINT chk_runs_range  CHECK (end_sequence >= start_sequence)
);
CREATE UNIQUE INDEX uq_runs ON runs (conversation_id, start_sequence, extractor_version);

\echo '-- 5a. EXCLUDE 约束（成功区间不得重叠）：'
ALTER TABLE runs ADD CONSTRAINT excl_runs_range
  EXCLUDE USING gist (
    conversation_id WITH =,
    int8range(start_sequence, end_sequence, '[]') WITH &&
  ) WHERE (status = 'succeeded');
\echo '    EXCLUDE 约束创建成功 ← btree_gist 起作用'

INSERT INTO runs (conversation_id, start_sequence, end_sequence, extractor_version, status)
VALUES ('11111111-1111-1111-1111-111111111111', 1, 5, 'v1', 'succeeded');
\echo '-- 5b. 插入起点相同 [1,10] → 应被 UNIQUE 拦截：'
INSERT INTO runs (conversation_id, start_sequence, end_sequence, extractor_version, status)
VALUES ('11111111-1111-1111-1111-111111111111', 1, 10, 'v1', 'succeeded');
\echo '-- 5c. 插入起点不同但重叠 [3,10] → 应被 EXCLUDE 拦截：'
INSERT INTO runs (conversation_id, start_sequence, end_sequence, extractor_version, status)
VALUES ('11111111-1111-1111-1111-111111111111', 3, 10, 'v1', 'succeeded');
\echo '-- 5d. 插入不重叠 [6,10] → 应成功：'
INSERT INTO runs (conversation_id, start_sequence, end_sequence, extractor_version, status)
VALUES ('11111111-1111-1111-1111-111111111111', 6, 10, 'v1', 'succeeded');
\echo '-- 5e. failed 状态的区间可重叠（被 WHERE 排除）：'
INSERT INTO runs (conversation_id, start_sequence, end_sequence, extractor_version, status)
VALUES ('11111111-1111-1111-1111-111111111111', 7, 20, 'v1', 'failed');
SELECT start_sequence, end_sequence, status FROM runs ORDER BY start_sequence;

\echo ''
\echo '=========== 6. CHECK 约束的 PG 真实报错措辞 ==========='
CREATE TEMP TABLE ctest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status varchar(20) NOT NULL,
  superseded_by uuid,          -- 刻意无外键（C23）
  CONSTRAINT chk_ctest_status CHECK (status IN ('active','conflict','superseded','archived','deleted')),
  CONSTRAINT chk_ctest_superseded CHECK (status <> 'superseded' OR superseded_by IS NOT NULL)
);
INSERT INTO ctest (status, superseded_by) VALUES ('superseded', '22222222-2222-2222-2222-222222222222');
\echo '-- 下面这条应报 CHECK 违约（观察 PG 的措辞）：'
INSERT INTO ctest (status, superseded_by) VALUES ('superseded', NULL);

\echo ''
\echo '=========== 7. 中文 pg_trgm 关键词检索 ==========='
CREATE TEMP TABLE mtest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content text NOT NULL
);
CREATE INDEX idx_mtest_trgm ON mtest USING gin (content gin_trgm_ops);
INSERT INTO mtest (content) VALUES
  ('用户正在学习 TypeScript'),
  ('用户住在广州'),
  ('用户喜欢直接、具体的技术解释');

\echo '-- 7a. 中文子串匹配（pg_trgm 三元组）：'
SELECT content, similarity(content, 'TypeScript') AS sim
  FROM mtest WHERE content ILIKE '%TypeScript%';

\echo '-- 7b. 中文词匹配（验证中文能否被三元组命中）：'
SELECT content FROM mtest WHERE content LIKE '%技术解释%';

\echo '-- 7c. 三元组相似度排序：'
SELECT content, round(similarity(content, '用户学习TS')::numeric, 4) AS sim
  FROM mtest ORDER BY sim DESC;

\echo ''
\echo '=========== 8. gen_random_uuid() 无需 uuid-ossp ==========='
SELECT gen_random_uuid() AS uuid_v4_sample;

\echo ''
\echo '########## PG 验证结束 ##########'
