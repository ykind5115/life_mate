-- ============================================================
-- 约束交互实测 · 隔离版
-- 每组实验独立建表，一组失败不影响其他组
-- ============================================================
PRAGMA foreign_keys = ON;

.print '########## A1 基线：自引用外键插入是否可行 ##########'
CREATE TABLE t1 (id TEXT PRIMARY KEY, superseded_by TEXT REFERENCES t1(id));
INSERT INTO t1 VALUES ('memA', 'memB');
.print '-- 结果（预期报 FK 违约，因为 memB 还不存在）：'
INSERT INTO t1 VALUES ('memB', NULL);
.print '-- 插入 memB 后：'
SELECT id, superseded_by FROM t1;

.print ''
.print '########## A2 F-04 复现：先插 memB，再插 memA ##########'
CREATE TABLE t2 (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL,
  superseded_by TEXT REFERENCES t2(id) ON DELETE SET NULL,
  CHECK (status <> 'superseded' OR superseded_by IS NOT NULL)
);
INSERT INTO t2 VALUES ('memB', 'active', NULL);
INSERT INTO t2 VALUES ('memA', 'superseded', 'memB');
.print '-- 删除前（应有 2 行）：'
SELECT id, status, superseded_by FROM t2;
.print '-- 执行 DELETE memB：'
DELETE FROM t2 WHERE id = 'memB';
.print '-- 删除后：'
SELECT id, status, superseded_by FROM t2;

.print ''
.print '########## A3 对照组：superseded_by 不加外键 ##########'
CREATE TABLE t3 (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL,
  superseded_by TEXT,
  CHECK (status <> 'superseded' OR superseded_by IS NOT NULL)
);
INSERT INTO t3 VALUES ('memB', 'active', NULL);
INSERT INTO t3 VALUES ('memA', 'superseded', 'memB');
DELETE FROM t3 WHERE id = 'memB';
.print '-- 删除后（memA 应保留为悬空指针）：'
SELECT id, status, superseded_by FROM t3;

.print ''
.print '########## B1 F-03 复现：goal_projection 的 goal_id 被置空 ##########'
CREATE TABLE b_goals (id TEXT PRIMARY KEY);
CREATE TABLE b_sources (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL,
  source_type TEXT NOT NULL,
  message_id  TEXT,
  event_id    TEXT,
  goal_id     TEXT REFERENCES b_goals(id) ON DELETE SET NULL,
  CHECK (message_id IS NOT NULL OR event_id IS NOT NULL
         OR goal_id IS NOT NULL OR source_type IN ('manual','system'))
);
INSERT INTO b_goals VALUES ('goal1');
INSERT INTO b_sources VALUES ('src2','mem2','goal_projection',NULL,NULL,'goal1');
.print '-- 删除 goal1：'
DELETE FROM b_goals WHERE id = 'goal1';
.print '-- 删除后：'
SELECT id, source_type, goal_id FROM b_sources;

.print ''
.print '########## C1 对照：message_id 存在时置空 conversation_id 是否安全 ##########'
CREATE TABLE c_conv (id TEXT PRIMARY KEY);
CREATE TABLE c_sources (
  id              TEXT PRIMARY KEY,
  source_type     TEXT NOT NULL,
  message_id      TEXT,
  event_id        TEXT,
  goal_id         TEXT,
  conversation_id TEXT REFERENCES c_conv(id) ON DELETE SET NULL,
  CHECK (message_id IS NOT NULL OR event_id IS NOT NULL
         OR goal_id IS NOT NULL OR source_type IN ('manual','system'))
);
INSERT INTO c_conv VALUES ('conv1');
INSERT INTO c_sources VALUES ('src1','conversation','msg1',NULL,NULL,'conv1');
.print '-- 删除 conv1：'
DELETE FROM c_conv WHERE id = 'conv1';
.print '-- 删除后（message_id 仍在，约束应满足）：'
SELECT id, source_type, message_id, conversation_id FROM c_sources;

.print ''
.print '########## C2 F-02 复现：无 message_id 时置空 conversation_id ##########'
CREATE TABLE c2_conv (id TEXT PRIMARY KEY);
CREATE TABLE c2_sources (
  id              TEXT PRIMARY KEY,
  source_type     TEXT NOT NULL,
  message_id      TEXT,
  event_id        TEXT,
  goal_id         TEXT,
  conversation_id TEXT REFERENCES c2_conv(id) ON DELETE SET NULL,
  CHECK (message_id IS NOT NULL OR event_id IS NOT NULL
         OR goal_id IS NOT NULL OR source_type IN ('manual','system'))
);
INSERT INTO c2_conv VALUES ('conv1');
-- conversation 来源但只有 conversation_id 一个指针（如按会话聚合生成的记忆）
INSERT INTO c2_sources VALUES ('src9','conversation',NULL,NULL,NULL,'conv1');
.print '-- 删除 conv1：'
DELETE FROM c2_conv WHERE id = 'conv1';
.print '-- 删除后：'
SELECT id, source_type, message_id, conversation_id FROM c2_sources;

.print ''
.print '########## END ##########'
