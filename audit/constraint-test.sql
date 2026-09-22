-- ============================================================
-- 约束交互实测 · 修复后回归验证
--
-- 验证对象：《数据库设计 V1.1》（含审计修订 C19~C32）
-- 执行：sqlite3 :memory: ".read audit/constraint-test.sql"
--
-- 结构说明：
--   第 1 部分 —— 修复前 schema 的缺陷复现（保留为回归证据）
--   第 2 部分 —— 修复后 schema 的通过验证
--
-- C19~C28 来自《设计契约审计报告》；C29~C32 来自其后的文档一致性复查。
-- 本节新增的 [C30] 用例专门验证「删除会话」链路：第 1 部分演示初稿写法
-- （步骤③只在「有剩余来源」一支删除来源行）必然被 RESTRICT 外键挡住，
-- 第 2 部分按修正后的 §24.3 两支流程执行并断言 messages 能真正删除。
--
-- 已知局限（与首次回归相同）：SQLite 无法验证 EXCLUDE 约束（需 btree_gist）
-- 与 pgvector 相关项，这两项仍须在 PostgreSQL 上复跑。
-- ============================================================
PRAGMA foreign_keys = ON;

.print '============================================================'
.print '第一部分：修复前 schema —— 缺陷复现（应全部报错）'
.print '============================================================'

.print ''
.print '--- [F-04] superseded_by 带外键 + CHECK 约束 ---'
CREATE TABLE old_memories (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL,
  superseded_by TEXT REFERENCES old_memories(id) ON DELETE SET NULL,
  CHECK (status <> 'superseded' OR superseded_by IS NOT NULL)
);
INSERT INTO old_memories VALUES ('memB', 'active', NULL);
INSERT INTO old_memories VALUES ('memA', 'superseded', 'memB');
.print '删除前:'
SELECT id, status, superseded_by FROM old_memories;
.print 'DELETE memB → 预期报 CHECK constraint failed:'
DELETE FROM old_memories WHERE id = 'memB';
.print '删除后（应仍为 2 行，说明语句被回滚）:'
SELECT id, status, superseded_by FROM old_memories;

.print ''
.print '--- [F-03] goal_projection 的来源约束 ---'
CREATE TABLE old_goals (id TEXT PRIMARY KEY);
CREATE TABLE old_sources (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL,
  source_type TEXT NOT NULL,
  message_id  TEXT,
  event_id    TEXT,
  goal_id     TEXT REFERENCES old_goals(id) ON DELETE SET NULL,
  CHECK (message_id IS NOT NULL OR event_id IS NOT NULL
         OR goal_id IS NOT NULL OR source_type IN ('manual','system'))
);
INSERT INTO old_goals VALUES ('goal1');
INSERT INTO old_sources VALUES ('src2','mem2','goal_projection',NULL,NULL,'goal1');
.print 'DELETE goal1 → 预期报 CHECK constraint failed:'
DELETE FROM old_goals WHERE id = 'goal1';
.print '删除后（goal_id 应仍在，说明语句被回滚）:'
SELECT id, source_type, goal_id FROM old_sources;

.print ''
.print '--- [F-02] 唯一指针是 conversation_id 的来源 ---'
CREATE TABLE old_conv (id TEXT PRIMARY KEY);
CREATE TABLE old_sources2 (
  id              TEXT PRIMARY KEY,
  source_type     TEXT NOT NULL,
  message_id      TEXT,
  event_id        TEXT,
  goal_id         TEXT,
  conversation_id TEXT REFERENCES old_conv(id) ON DELETE SET NULL,
  CHECK (message_id IS NOT NULL OR event_id IS NOT NULL
         OR goal_id IS NOT NULL OR source_type IN ('manual','system'))
);
INSERT INTO old_conv VALUES ('conv1');
INSERT INTO old_sources2 VALUES ('src9','conversation',NULL,NULL,NULL,'conv1');
.print 'DELETE conv1 → 预期报 CHECK constraint failed:'
DELETE FROM old_conv WHERE id = 'conv1';
.print '删除后（应为空，说明 conv1 未能删除）:'
SELECT id, source_type, conversation_id FROM old_sources2;


.print ''
.print '--- [C30] 修复前：步骤③只在「有剩余来源」一支删除来源行 ---'
CREATE TABLE old3_conv (id TEXT PRIMARY KEY);
CREATE TABLE old3_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES old3_conv(id) ON DELETE CASCADE
);
CREATE TABLE old3_mem (id TEXT PRIMARY KEY, status TEXT NOT NULL);
CREATE TABLE old3_sources (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL,
  source_type TEXT NOT NULL,
  message_id  TEXT REFERENCES old3_messages(id) ON DELETE RESTRICT,
  event_id    TEXT,
  goal_id     TEXT
);
INSERT INTO old3_conv VALUES ('conv1');
INSERT INTO old3_messages VALUES ('msg1','conv1');
INSERT INTO old3_mem VALUES ('mem1','active');
INSERT INTO old3_sources VALUES ('src1','mem1','conversation','msg1',NULL,NULL);

.print '步骤③（初稿写法）：mem1 无剩余来源 → 只改状态，不删来源行'
UPDATE old3_mem SET status='deleted' WHERE id='mem1';

.print '步骤④：删除 messages → 预期报 FOREIGN KEY constraint failed:'
DELETE FROM old3_messages WHERE conversation_id='conv1';
.print '删除后（msg1 与来源行仍在，说明步骤④未能执行）:'
SELECT (SELECT COUNT(*) FROM old3_messages) AS msg_left,
       (SELECT COUNT(*) FROM old3_sources)  AS sources_left;

.print ''
.print '============================================================'
.print '第二部分：修复后 schema —— 应全部通过'
.print '============================================================'

.print ''
.print '--- [C23] superseded_by 去掉外键，保留为历史指针 ---'
CREATE TABLE new_memories (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL,
  superseded_by TEXT,                       -- 修正：无 REFERENCES
  CHECK (status <> 'superseded' OR superseded_by IS NOT NULL)
);
INSERT INTO new_memories VALUES ('memB', 'active', NULL);
INSERT INTO new_memories VALUES ('memA', 'superseded', 'memB');
DELETE FROM new_memories WHERE id = 'memB';
.print '删除后（memA 保留，指针悬空但合法）:'
SELECT id, status, superseded_by FROM new_memories;
.print '>>> 通过：物理删除能力可兑现'

.print ''
.print '--- [C22 + C29 + C30] 删除会话：严格按 §24.3 的顺序，两支都要删来源行 ---'
CREATE TABLE new_conv (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE new_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES new_conv(id) ON DELETE CASCADE,
  sequence        INTEGER NOT NULL
);
CREATE TABLE new_summaries (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES new_conv(id) ON DELETE CASCADE
);
CREATE TABLE new_mem (id TEXT PRIMARY KEY, status TEXT NOT NULL);
CREATE TABLE new_emb (memory_id TEXT PRIMARY KEY, status TEXT NOT NULL);
CREATE TABLE new_sources (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL,
  source_type TEXT NOT NULL,
  message_id  TEXT REFERENCES new_messages(id) ON DELETE RESTRICT,
  event_id    TEXT,
  goal_id     TEXT,
  -- 修正 C22：无 conversation_id
  CHECK (message_id IS NOT NULL OR event_id IS NOT NULL
         OR goal_id IS NOT NULL OR source_type IN ('manual','system'))
);

-- conv1 是待删除的会话；conv2 提供「剩余来源」，用于覆盖步骤③的 a 支
INSERT INTO new_conv VALUES ('conv1','active',NULL);
INSERT INTO new_conv VALUES ('conv2','active',NULL);
INSERT INTO new_messages VALUES ('msg1','conv1',1);
INSERT INTO new_messages VALUES ('msg2','conv2',1);
INSERT INTO new_summaries VALUES ('sum1','conv1');
INSERT INTO new_mem VALUES ('mem1','active');   -- 来源全部指向 conv1 → b 支
INSERT INTO new_mem VALUES ('mem2','active');   -- 还有一个 conv2 的来源 → a 支
INSERT INTO new_emb VALUES ('mem1','ready');
INSERT INTO new_sources VALUES ('src1','mem1','conversation','msg1',NULL,NULL);
INSERT INTO new_sources VALUES ('src2','mem2','conversation','msg1',NULL,NULL);
INSERT INTO new_sources VALUES ('src3','mem2','conversation','msg2',NULL,NULL);

.print '步骤①：经 messages JOIN 反查受影响的记忆（替代 conversation_id 字段）:'
SELECT DISTINCT ms.memory_id
  FROM new_sources ms
  JOIN new_messages m ON m.id = ms.message_id
 WHERE m.conversation_id = 'conv1';

.print '步骤②：统计剩余有效来源数（mem1 = 0，mem2 = 1）:'
SELECT memory_id, COUNT(*) AS remaining
  FROM new_sources
 WHERE memory_id IN ('mem1','mem2') AND message_id <> 'msg1'
 GROUP BY memory_id;

.print '步骤③a：有剩余来源 → 保留记忆，只删指向被删消息的来源行'
DELETE FROM new_sources WHERE memory_id = 'mem2' AND message_id = 'msg1';

.print '步骤③b：无剩余来源 → 失效记忆与向量，并删除来源行（初稿漏了最后一步）'
UPDATE new_mem SET status = 'deleted' WHERE id = 'mem1';
UPDATE new_emb SET status = 'deleted' WHERE memory_id = 'mem1';
DELETE FROM new_sources WHERE memory_id = 'mem1' AND message_id = 'msg1';

.print '步骤④：删除 messages（此时 RESTRICT 外键才真的没有阻碍）'
DELETE FROM new_messages WHERE conversation_id = 'conv1';

.print '步骤⑤：删除该会话的摘要（C29：摘要随消息一起物理删除）'
DELETE FROM new_summaries WHERE conversation_id = 'conv1';

.print '步骤⑥：软删除会话（C29：只有会话是软删除）'
UPDATE new_conv SET status = 'deleted', deleted_at = '2026-01-01T00:00:00Z'
 WHERE id = 'conv1';

.print '结果（mem1 失效 / mem2 保留 / src3 仍在 / msg1 与摘要已删除 / 会话仅软删除）:'
SELECT (SELECT status FROM new_mem WHERE id = 'mem1')        AS mem1_status,
       (SELECT status FROM new_emb WHERE memory_id = 'mem1') AS mem1_emb,
       (SELECT status FROM new_mem WHERE id = 'mem2')        AS mem2_status,
       (SELECT COUNT(*) FROM new_sources)                    AS sources_left,
       (SELECT COUNT(*) FROM new_messages)                   AS msgs_left,
       (SELECT COUNT(*) FROM new_summaries)                  AS summaries_left,
       (SELECT status FROM new_conv WHERE id = 'conv1')      AS conv1_status;
.print '注：msgs_left = 1 是 conv2 的 msg2（本用例保留它作为 mem2 的剩余来源）；'
.print '    conv1 的 msg1 已被删除 —— 这正是步骤③b 补上「删除来源行」之后才成立的。'
.print '>>> 通过：按 §24.3 的两支流程执行后，messages 才能被真正删除'

.print ''
.print '--- [C24] 删除 Goal 时先清理投影记忆与来源 ---'
CREATE TABLE new_goals (id TEXT PRIMARY KEY);
CREATE TABLE new_sources_g (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL,
  source_type TEXT NOT NULL,
  message_id  TEXT,
  event_id    TEXT,
  goal_id     TEXT REFERENCES new_goals(id) ON DELETE SET NULL,
  CHECK (message_id IS NOT NULL OR event_id IS NOT NULL
         OR goal_id IS NOT NULL OR source_type IN ('manual','system'))
);
CREATE TABLE new_mem_g (id TEXT PRIMARY KEY, status TEXT NOT NULL);

INSERT INTO new_goals VALUES ('goal1');
INSERT INTO new_mem_g VALUES ('mem2','active');
INSERT INTO new_sources_g VALUES ('src2','mem2','goal_projection',NULL,NULL,'goal1');

.print '按 C24 的顺序：先失效记忆 → 再删来源 → 最后删 Goal'
UPDATE new_mem_g SET status='deleted'
 WHERE id IN (SELECT memory_id FROM new_sources_g
               WHERE goal_id='goal1' AND source_type='goal_projection');
DELETE FROM new_sources_g WHERE goal_id='goal1';
DELETE FROM new_goals WHERE id='goal1';

.print '结果（记忆应已失效，目标应已删除）:'
SELECT (SELECT status FROM new_mem_g WHERE id='mem2') AS memory_status,
       (SELECT COUNT(*) FROM new_goals)               AS goals_left,
       (SELECT COUNT(*) FROM new_sources_g)           AS sources_left;
.print '>>> 通过：删除目标不再违约，且投影记忆被正确失效'

.print ''
.print '--- [C19] 幂等键改用 start_sequence ---'
CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL,
  start_sequence    INTEGER NOT NULL,
  end_sequence      INTEGER NOT NULL,
  extractor_version TEXT NOT NULL,
  status            TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_run ON runs (conversation_id, start_sequence, extractor_version);

INSERT INTO runs VALUES ('r1','conv1',1,5,'v1','succeeded');
.print '尝试插入起点相同的重复抽取 [1,10] → 预期报 UNIQUE 违约:'
INSERT INTO runs VALUES ('r2','conv1',1,10,'v1','succeeded');
.print '尝试插入起点不同的区间 [6,10] → 预期成功:'
INSERT INTO runs VALUES ('r3','conv1',6,10,'v1','succeeded');
SELECT id, start_sequence, end_sequence, status FROM runs ORDER BY start_sequence;
.print '>>> 通过：重叠范围的重复触发被正确拦截'

.print ''
.print '########## 回归验证结束 ##########'
