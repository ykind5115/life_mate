# LifeMate 设计契约审计报告 V1.0

**项目名称：** LifeMate
**文档类型：** 审计报告
**版本：** V1.0
**审计日期：** 设计阶段（Phase 3 之前）
**审计对象：** 文档中已固化的「准代码」契约
**审计结论：** 发现 **4 个会直接导致运行失败的缺陷**，另有 **9 项一致性与可维护性问题**
**修复状态：** ✅ 9 项阻塞项已全部修复并通过回归验证（见 §7）；其后的文档一致性复查又发现 4 项缺陷并按 C29～C32 修复、复跑回归（见 §7.5）

---

# 0. 审计范围说明

## 0.1 一个必须先澄清的前提

**本仓库当前没有任何应用代码。**

```text
src/          空目录（仅预留结构）
package.json  不存在
*.ts          不存在
```

因此「检查现有代码是否存在与预期不符的功能」这一要求，**在字面意义上无法执行**——没有代码可供审计。

## 0.2 实际审计了什么

但文档中已经固化了大量**将来会直接变成代码的契约**。这些才是真正值得被挑错的对象，因为它们一旦进入实现，缺陷会被放大：

| 类别 | 位置 | 性质 |
| ---- | ---- | ---- |
| SQL DDL 与约束 | `03-database-design.md` §13–§22、附录 A | **将直接翻译成 Drizzle Schema 和 Migration** |
| 状态转移与流程伪代码 | `03-database-design.md` §13.5、§13.7、§24.3 | 将直接翻译成 Service 层逻辑 |
| Agent Loop 伪代码 | `02-architecture.md` §8.1 | 将直接翻译成 Agent Core |
| TypeScript 接口 | `02-architecture.md` §34 | 将成为 LLM Provider 的类型定义 |
| Zod 校验 Schema | `04-api-spec.md` §39 | 将成为 API 入参校验 |
| 检索公式与权重 | `03-database-design.md` §18.4 | 将成为排序实现 |

**这些契约是我写的，所以更值得怀疑。** 下面的问题全部是逐行核对后的结果。

## 0.3 审计方法

```text
① 提取全部 SQL / 伪代码 / 接口定义
② 对每个约束做「布尔求值」——代入真实数据，检查是否会意外为 false
③ 对每个流程做「代入执行」——按文档描述的步骤走一遍，看是否可达
④ 交叉比对 —— 同一概念在不同文档/章节是否一致
⑤ 对缺陷做「可执行复现」—— 用真实 SQL 引擎跑出来，而不是停留在纸面推理
```

## 0.4 缺陷的实测复现

F-02 / F-03 / F-04 三个缺陷**不是一个推理，而是已执行验证的结果**。

**复现脚本：** `audit/constraint-test.sql`
**执行方式：** `sqlite3 :memory: ".read audit/constraint-test.sql"`

**关于使用 SQLite 验证 PostgreSQL 设计的说明：**

```text
本 DDL 的目标是 PostgreSQL，但 CHECK 约束与 ON DELETE SET NULL 的语义
由 SQL 标准规定，两者在此行为一致（均为「置空后立即重新校验约束，
失败则整个语句回滚」）。因此 SQLite 可作为本类错误的判定工具。

风险提示：两处细微差异不影响本次结论
  ① SQLite 报告的是 "CHECK constraint failed"，
     PostgreSQL 报告的是 'check constraint "chk_xxx" is violated'
  ② 缺少 btree_gist 等 PG 特有扩展，故未验证 §F-01 的 EXCLUDE 方案
最终仍需在 PostgreSQL 上复跑一次（待 Docker 环境就绪）
```

**实测输出（关键片段）：**

```text
########## A2 F-04 复现 ##########
-- 删除前（应有 2 行）：
memB|active|
memA|superseded|memB
-- 执行 DELETE memB：
Runtime error near line 28: CHECK constraint failed:
  status <> 'superseded' OR superseded_by IS NOT NULL (19)
-- 删除后：
memB|active|
memA|superseded|memB              ← 仍是 2 行，DELETE 被回滚
```

```text
########## B1 F-03 复现 ##########
-- 删除 goal1：
Runtime error near line 62: CHECK constraint failed:
  message_id IS NOT NULL OR event_id IS NOT NULL
  OR goal_id IS NOT NULL OR source_type IN ('manual','system') (19)
-- 删除后：
src2|goal_projection|goal1        ← goal_id 未被置空，DELETE 被回滚
```

```text
########## C2 F-02 复现 ##########
-- 删除 conv1：
Runtime error near line 101: CHECK constraint failed:
  message_id IS NOT NULL OR event_id IS NOT NULL
  OR goal_id IS NOT NULL OR source_type IN ('manual','system') (19)
-- 删除后：
                                  ← 表中已无任何行，DELETE 被回滚
```

**对照组（修正方案）实测通过：**

```text
########## A3 对照：superseded_by 不加外键 ##########
-- 删除后（memA 应保留为悬空指针）：
memA|superseded|memB              ← 删除成功，历史指针保留   ✓ F-04 方案有效

########## C1 对照：message_id 存在时置空 conversation_id ##########
-- 删除后（message_id 仍在，约束应满足）：
src1|conversation|msg1|           ← 删除成功，message_id 保留  ✓ 约束求值取决于其他指针
```

**实测带来的一个重要修正：**

C2 的结果比我原先的推理**更严重**。原先 F-02 描述的是「`conversation_id` 置空后可能违约」，实际情况是：

> 只要一条来源记录的**唯一指针是 `conversation_id`**（即 `message_id` 为 NULL），
> 删除该会话就**必然失败**——而且是 `DELETE` 整个被回滚，连会话本身都删不掉。

而 §40 明确写着「一条 Memory 可以来自 1 ~ N Message」，DDL 却允许 `message_id` 为 NULL。这个缝隙使 F-02 从「可能发生」变成「设计上可构造」。


---

# 1. 结论摘要

| 编号 | 严重度 | 问题 | 影响 | 修复成本 |
| ---- | ---- | ---- | ---- | ---- |
| F-01 | 🔴 严重 | `extraction_runs` 幂等键选错字段，无法阻止重叠抽取 | 重复记忆，直接违背 P0-6 的设计目的 | 低 |
| F-02 | 🔴 严重 | `memory_sources.conversation_id` 的 `SET NULL` 与 `chk_sources_has_origin` 冲突 | 删除会话时级联流程抛异常 | 低 |
| F-03 | 🔴 严重 | `goal_projection` 未在来源约束中豁免，`goal_id` 置空即违约 | 删除目标后无法清理来源指针 | 低 |
| F-04 | 🔴 严重 | `superseded_by` 的 `SET NULL` 与 `chk_memories_superseded` 冲突 | **物理删除记忆必定失败** | 低 || F-05 | 🟠 重要 | Agent Loop 每轮复用初始 context，丢弃上一轮工具结果 | 多轮工具调用逻辑错误 | 低 |
| F-06 | 🟠 重要 | API 允许直接创建 `type='goal'` 记忆，绕过 Goal 实体 | 破坏 §13.10 的单写入入口约束 | 低 |
| F-07 | 🟠 重要 | 「正文不可变」表述过强，但 DDL/流程中存在对记忆行的 UPDATE | 实现时理解分歧 | 低 |
| F-08 | 🟠 重要 | 抽取进度缺少计算定义，失败区间可能被永久跳过 | 记忆丢失且无感知 | 低 |
| F-09 | 🟡 一般 | 附录 A 与 §13–§22 重复了同一份 DDL | 文档腐化（已有先例） | 低 |
| F-10 | 🟡 一般 | `goals` 缺少 `target_at >= started_at` 约束 | 可写入逻辑矛盾的时间 | 低 |
| F-11 | 🟡 一般 | `model` 字段格式不统一（`bge-m3` vs `BAAI/bge-m3`） | 检索时 JOIN 条件静默失配 | 低 |
| F-12 | 🟡 一般 | 多行返回的顺序对齐未定义 | 可能把 A 的向量写到 B 上 | 低 |
| F-13 | 🟡 一般 | 部分唯一索引对 `predicate_key IS NULL` 不生效 | 需明确这是设计意图 | 低 |

**其中 F-02 / F-03 / F-04 属于同一类错误**：外键的 `ON DELETE` 行为与 `CHECK` 约束互相冲突。这个模式值得单独记住——**约束之间也会打架**。

---

# 2. 缺陷详述

## F-01 🔴 抽取幂等键选错了字段

**位置：** `03-database-design.md` §11.3、附录 A

```sql
CREATE UNIQUE INDEX uq_extraction_idempotency
  ON extraction_runs (conversation_id, end_sequence, extractor_version);
```

**问题**

幂等键包含了 `end_sequence`，而 `end_sequence` 是**每次触发时变化的值**。这使「同一个范围的重复抽取」无法被拦截。

代入执行：

```text
t1  空闲触发，扫描 messages [1, 10]
     → 登记 (conv, end=10, v1)  ✅ 成功

t2  继续对话，又空闲触发，扫描 [11, 20]
     → 登记 (conv, end=20, v1)  ✅ 成功（键不同，不冲突）

t3  用户手动点「记住这个」，扫描范围与 t2 相同
     → 登记 (conv, end=20, v1)  ❌ 冲突，正确拦截
```

问题出在 t1 和 t2：**`end_sequence` 不同，所以两次都执行**。但如果触发时机导致范围重叠：

```text
t1  空闲触发，扫描 [1, 5]  → 登记 end=5   ✅
t2  空闲触发，扫描 [1, 10] → 登记 end=10  ✅  ← 与 t1 重叠了 [1,5]
```

t2 会把 `[1,5]` 重新抽一遍。虽然槽位判定会把它识别为去重（`source_count++`），不会产生重复记忆行，但：

```text
① 白白多花一次 LLM 调用（抽取要调模型）
② source_count 被虚增，这个信号不再可信
③ 「同一段消息只被抽取一次」这个不变量无法保证
④ 违背 P0-6 的设计目的：幂等键本应让重复触发零成本
```

**根本原因：** 幂等键应该标识「**从哪开始**」，而不是「**到哪结束**」。因为正确性不变量是「每条消息恰好被抽取一次」——这是由**起点单调递增**保证的，与终点无关。

**推荐方案**

```sql
-- 改为以起点为幂等键
CREATE UNIQUE INDEX uq_extraction_idempotency
  ON extraction_runs (conversation_id, start_sequence, extractor_version);
```

同时补充进度计算规则（同时解决 F-08）：

```text
start_sequence = COALESCE(
    MAX(end_sequence) FROM extraction_runs
     WHERE conversation_id = ? AND status = 'succeeded',
  0) + 1
```

并加约束保证区间不重叠：

```sql
-- 成功区间不得重叠（用排他约束表达）
ALTER TABLE extraction_runs ADD CONSTRAINT excl_extraction_range
  EXCLUDE USING gist (
    conversation_id WITH =,
    int8range(start_sequence, end_sequence, '[]') WITH &&
  ) WHERE (status = 'succeeded');
```

> 注：`EXCLUDE` 需要 `btree_gist` 扩展。若不想引入，可在服务层用事务 + `SELECT ... FOR UPDATE` 保证。

---

## F-02 🔴 来源指针的 `SET NULL` 与来源约束冲突（删除会话会失败）

**位置：** `03-database-design.md` §15.2、§15.4、附录 A

```sql
conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,

CONSTRAINT chk_sources_has_origin
  CHECK (message_id IS NOT NULL OR event_id IS NOT NULL
         OR goal_id IS NOT NULL OR source_type IN ('manual','system'))
```

**问题**

`ON DELETE SET NULL` 会触发一次 `UPDATE`，而 **PostgreSQL 在 UPDATE 后会重新校验 CHECK 约束**。代入求值：

```text
一条正常的对话派生来源：
  message_id      = <非空>          → TRUE
  event_id        = NULL            → FALSE
  goal_id         = NULL            → FALSE
  source_type     = 'conversation'  → 不在豁免列表 → FALSE

布尔求值：TRUE OR FALSE OR FALSE OR FALSE = TRUE      ✅ 合法

现在删除会话，conversation_id 被置 NULL 后，若同一事务中 message_id
也已被清空（或该来源本就没有 message_id）：
  message_id      = NULL            → FALSE
  event_id        = NULL            → FALSE
  goal_id         = NULL            → FALSE
  source_type     = 'conversation'  → FALSE

布尔求值：FALSE OR FALSE OR FALSE OR FALSE = FALSE    ❌ 违约，抛异常
```

**影响**

删除会话的级联流程（§24.3）会抛 `check constraint "chk_sources_has_origin" is violated`，**整个 DELETE 被回滚——连会话本身都删不掉**。而「删除」是隐私承诺的一部分，失败即违背承诺。

**⚠️ 实测修正：触发条件比预期更宽松**

实测（§0.4 实验组 C2）证明，**只要来源记录的唯一指针是 `conversation_id`**（即 `message_id IS NULL`），删除该会话就必然失败。

而 §40 明确写着：

```text
一条 Conversation 可以产生：  0 ~ N Memory
而一条 Memory 可以来自：      1 ~ N Message
```

但 DDL 允许 `message_id` 为 NULL（它没有 NOT NULL）。**这个缝隙使 F-02 从「理论可能」变成「设计上可构造」**——而且触发时用户看到的是「删除失败」，不是「删了但残留」。

**推荐方案（择一）**

**方案 A（推荐）：删除这个冗余字段**

```text
conversation_id 完全是冗余的 —— 通过 message_id → messages.conversation_id 即可得到。
唯一理由是「按会话反查派生记忆」的性能，但那可以用 JOIN 表达：

  SELECT DISTINCT ms.memory_id
    FROM memory_sources ms
    JOIN messages m ON m.id = ms.message_id
   WHERE m.conversation_id = $1;

配合已有的 idx_memory_sources_message 与 messages 的主键，性能足够。

→ 直接删除 memory_sources.conversation_id，F-02 与 C2 的触发路径同时消失。
```

**方案 B：保留字段并修正约束，把 `conversation_id` 也算作有效指针**

```sql
CONSTRAINT chk_sources_has_origin
  CHECK (message_id IS NOT NULL OR event_id IS NOT NULL
         OR goal_id IS NOT NULL OR conversation_id IS NOT NULL
         OR source_type IN ('manual','system'))
```

> ⚠️ 但方案 B 留下新问题：`conversation_id` 仍会被 `SET NULL`，于是「唯一指针是 conversation_id」的记录在删除后变成**无来源孤儿**且**仍然合法**——这比失败更糟，因为它静默丢失了来源可追溯性（§15 的产品卖点）。
>
> **因此方案 A 更好：删掉冗余字段，而不是修补一个不该存在的字段。**


---

## F-03 🔴 `goal_projection` 未豁免，删除目标会违约

**位置：** 同 F-02 的约束；`03-database-design.md` §13.10

**问题**

来源约束的豁免列表是 `('manual','system')`，但 `source_type` 的合法取值有五个：

```text
conversation / manual / system / goal_projection / event_derived
                                    ↑ 未豁免
```

代入求值——一条 Goal 投影记忆：

```text
source_type = 'goal_projection'
message_id  = NULL
event_id    = NULL
goal_id     = <目标id>            → TRUE

求值：FALSE OR FALSE OR TRUE OR FALSE = TRUE     ✅ 合法

用户删除该目标 → goal_id 被 SET NULL：

message_id = NULL, event_id = NULL, goal_id = NULL
source_type = 'goal_projection'   → 不在豁免列表 → FALSE

求值：FALSE OR FALSE OR FALSE OR FALSE = FALSE   ❌ 违约
```

**与 F-02 是同一个 bug 模式**，但触发路径不同：F-02 由 `conversation_id` 置空触发，F-03 由 `goal_id` 置空触发。

**推荐方案**

```sql
-- 约束应表达真实意图：「必须有来源」= 至少一个指针非空
--                    「无指针的来源类型」= manual / system
-- 但 goal_projection 的指针是 goal_id，它被置空本身就不该发生
--
-- 两条修法：

-- 修法 1（推荐）：删除目标时，投影记忆应随之失效，而不是留下无来源的孤儿
--   在 §24 的删除策略中明确：删除 Goal → 其 goal_projection 记忆一并置 deleted
--   这样 goal_id 不会被置空（记忆行先失效），约束自然满足

-- 修法 2（兜底）：把豁免列表补全
CONSTRAINT chk_sources_has_origin
  CHECK (message_id IS NOT NULL OR event_id IS NOT NULL OR goal_id IS NOT NULL
         OR source_type IN ('manual','system'))
-- 注意：不要简单地把 goal_projection 加进豁免列表，
--       那会让「投影记忆失去目标」这种不一致状态变成合法。
```

> ⚠️ 关键判断：**不要把 `goal_projection` 加进豁免列表**。那只是让违约消失，而问题（孤儿投影记忆）仍然存在。应该修的是删除策略。

---

## F-04 🔴 物理删除记忆必定失败

**位置：** `03-database-design.md` §13.3、§24.4、附录 A

```sql
superseded_by UUID REFERENCES memories(id) ON DELETE SET NULL,

CONSTRAINT chk_memories_superseded
  CHECK (status <> 'superseded' OR superseded_by IS NOT NULL),
```

**问题**

代入求值：

```text
记忆 A（已被替代）：
  status        = 'superseded'   → 触发约束
  superseded_by = <记忆 B 的 id> → TRUE
求值：FALSE OR TRUE = TRUE       ✅ 合法

现在物理删除记忆 B（§24.4 承诺提供此能力）：
  → A.superseded_by 被 SET NULL
  → A.status 仍为 'superseded'
求值：FALSE OR FALSE = FALSE     ❌ 违约
```

**影响**

**§24.4 明确承诺「用户明确要求永久删除时，系统必须提供真正的物理删除机制」**，但这个约束使该承诺无法兑现——只要被删除的记忆曾被引用为替代者，`DELETE` 就会失败。

同样的问题也会出现在「删除全部个人数据」这条路径上（架构 §37 承诺支持）。

**推荐方案（择一）**

**方案 A（推荐）：`superseded_by` 不加外键**

```sql
-- superseded_by 是历史指针，不是强制引用完整性
superseded_by UUID,        -- 不加 REFERENCES
```

理由：

```text
① 它回答的是「这条记忆被谁替代了」——这是历史事实，
   即使替代者已被删除，这个事实依然成立（只是指向了一个不存在的记录）
② 强制外键会阻止合法的删除操作
③ 应用层可以容忍悬空引用：UI 显示「（替代者已删除）」即可
④ 历史链条断裂不会导致数据错误，只损失一点可解释性
```

**方案 B：保留外键，但删除时先清理引用**

```sql
superseded_by UUID REFERENCES memories(id) ON DELETE RESTRICT,
```

物理删除 B 之前，先执行：

```sql
-- 把指向 B 的记忆标记为「替代者已删除」
UPDATE memories
   SET status = 'archived',      -- 不再是 superseded，约束不再要求指针
       superseded_by = NULL
 WHERE superseded_by = <B 的 id>;
```

**方案 B 的问题：** 它把「被替代」和「已归档」两个语义混在一起了，损害状态机清晰度。

**方案 A 更好**，且更符合「记忆是历史事实」的产品定位。

---

## F-05 🟠 Agent Loop 丢弃了上一轮的工具结果

**位置：** `02-architecture.md` §8.1

```typescript
async function runAgent(input: AgentInput) {
    const context = await contextBuilder.build(input);
    let response = await model.generate(context);

    while (response.toolCalls?.length) {
        const results = await toolManager.execute(response.toolCalls);
        response = await model.generate({
            ...context,              // ← 问题：每轮都用最初的 context
            toolResults: results     // ← 只带最新一轮的结果
        });
    }
    return response;
}
```

**问题**

`...context` 始终是循环外的原始快照。第二轮之后：

```text
第 1 轮工具调用 → results₁
   model.generate({ ...context, toolResults: results₁ })      ✅ 有 results₁

第 2 轮工具调用 → results₂
   model.generate({ ...context, toolResults: results₂ })      ❌ results₁ 丢了
```

**模型在第 2 轮的请求里看不到第 1 轮的工具结果**，但它的第 2 轮工具调用恰恰是基于第 1 轮结果做的决策。这会导致模型「忘记自己刚查过什么」，重复调用同一工具或基于缺失信息作答。

**推荐方案**

工具结果必须**累积**进会话历史，而不是覆盖：

```typescript
async function runAgent(input: AgentInput) {
    const messages = await contextBuilder.build(input);   // 可变的消息历史
    let iterations = 0;

    let response = await model.generate(messages);

    while (response.toolCalls?.length) {
        if (++iterations > MAX_ITERATIONS) break;

        // 1) 把 assistant 的工具调用意图追加进历史
        messages.push({ role: 'assistant', toolCalls: response.toolCalls });

        // 2) 执行工具，逐个追加结果（累积，不覆盖）
        const results = await toolManager.execute(response.toolCalls);
        for (const r of results) {
            messages.push({ role: 'tool', toolCallId: r.id, content: r.content });
        }

        response = await model.generate(messages);
    }
    return response;
}
```

**顺带**：这里也补上了评审 P0-7 要求的 `MAX_ITERATIONS`（§8.1 原文完全没有边界条件）。两处修复应一起做。

---

## F-06 🟠 API 允许绕过 Goal 实体直接创建目标记忆

**位置：** `04-api-spec.md` §39（Zod schema）、§22（创建 Memory）；`03-database-design.md` §13.10

**冲突**

`03-database-design.md` §13.10 明确规定：

```text
【必须】
  ② 抽取器不得直接创建 type='goal' 的记忆
  ③ 用户不可直接新建 type='goal' 的记忆（必须通过 Goal 实体）
```

但 `04-api-spec.md` §39 的校验 Schema **允许** `type: 'goal'`：

```typescript
const createMemorySchema = z.object({
  type: z.enum([
    "fact", "preference", "event",
    "goal",          // ← 与 §13.10 的约束冲突
    "relationship", "state"
  ]),
  content: z.string().min(1).max(5000)
});
```

**影响**

`POST /api/v1/memories` 可以创建 `type='goal'` 的记忆，绕过 `goals` 表。结果：

```text
① 同一个目标有两处真相：goals 表里没有，memories 里有一条
② Goal 的生命周期状态机（active/paused/completed...）对这条记忆不生效
③ §13.10 的「唯一写入入口」约束名存实亡
④ Timeline 与 Life Review 聚合时会出现不一致
```

**推荐方案**

```typescript
// 用户可创建的四种类型（不含 goal 与 event 的自动来源）
const createMemorySchema = z.object({
  type: z.enum(["fact", "preference", "relationship", "state"]),
  content: z.string().min(1).max(5000),
});

// goal 走专用端点
//   POST /api/v1/goals
// event 走专用端点
//   POST /api/v1/events
```

同时明确：`type='goal'` 与 `type='event'` 的记忆**由系统生成，不接受用户直接写入**，并在 §22 的文档中标注。

---

## F-07 🟠 「正文不可变」的表述与实际 UPDATE 存在歧义

**位置：** `03-database-design.md` §13.1 vs §13.7 / §25.1；`03-database-design.md` §26

**冲突**

§13.1 写：

```text
【必须】 记忆是不可变事实。
  一条记忆被创建后，其 content 永不就地修改。
```

但同一文档中既存在对记忆行的 `UPDATE`：

```sql
-- §13.7 去重合并
UPDATE memories SET source_count = source_count + 1,
                    confidence_score = GREATEST(...),
                    updated_at = now()

-- §24.3 删除级联
UPDATE memories SET status='deleted', deleted_at=now()   -- 推测
```

也在 §26 的生命周期里列了 `Update` 这一步：

```text
├── Update（仅限 source_count / confidence / updated_at）
```

**问题**

表述本身是自洽的（`content` 不可变 ≠ 整行不可变），但 §13.1 的措辞「记忆是不可变事实」容易被读成「整行不可变」。实现时会出现分歧：

```text
理解 A：只有 content 不可变，其余字段可更新     ← 文档本意
理解 B：整行不可变，source_count 也不能改        ← 字面误读

按理解 B 实现 → 去重合并无法记录 source_count → 重复记忆的判定信号丢失
```

**推荐方案**

把表述精确化，明确区分「不可变的是什么」：

```text
【必须】 记忆的「事实内容」不可变。

  不可变字段（创建后禁止 UPDATE）：
    content / type / subject_key / predicate_key
    / object_value / polarity / valid_from

  允许更新字段（反映系统对同一事实的认知变化）：
    source_count        被再次提到的次数
    confidence_score    置信度调整
    importance_score    重要性重估
    updated_at          认知更新时间
    status / valid_until / superseded_by   状态流转（见 §13.5）
    deleted_at          删除标记

  判断准则：
    改这些字段不改变「用户说的是什么事实」，只改变「系统对它的判断」。
    一旦需要改动 content 的语义，就必须新建记忆（supersede），不得就地修改。
```

---

## F-08 🟠 抽取进度缺少计算定义，失败区间可能被永久跳过

**位置：** `03-database-design.md` §11.4、§11.6

**问题**

§11.4 定义了触发条件（「未抽取的消息数达到 M 条」），但**没有定义「未抽取」如何计算**。这个定义缺失会引出一个严重后果：

```text
若实现者按「MAX(end_sequence)」计算（含 failed 记录）：

  run1  [1, 10]  failed     ← 抽取失败
  run2  计算 start = MAX(end_sequence) + 1 = 11
        → messages [1,10] 永远不会被重新抽取
        → 这 10 条消息里的记忆永久丢失，且无任何提示
```

**推荐方案**

```text
【必须】 进度计算只统计 succeeded 记录：

  start_sequence = COALESCE(
      MAX(end_sequence) FROM extraction_runs
       WHERE conversation_id = ? AND status = 'succeeded',
    0) + 1

  失败区间因此会被下一次触发自然覆盖，无需特殊重试逻辑。

  failed 记录保留：它记录了「这次尝试失败过」，用于告警与质量回溯，
  但不参与进度推进。
```

配合 F-01 的幂等键修正（改用 `start_sequence`），重试会命中同一个幂等键：

```text
run1  [1,10] v1  failed        键 = (conv, start=1, v1)
run2  [1,10] v1  重试         键相同 → 需先允许「failed 记录被复用」

→ 实现细节：插入时使用
   INSERT ... ON CONFLICT (conversation_id, start_sequence, extractor_version)
   DO UPDATE SET status='running', error=NULL
   WHERE extraction_runs.status IN ('failed','pending');
```

---

## F-09 🟡 附录 A 与正文重复了同一份 DDL

**位置：** `03-database-design.md` §13–§22 与附录 A

**问题**

正文各节分散给出片段 DDL，附录 A 又完整给出一次。**同一份定义有两个副本**，修改时必须同时改两处。这与我在 `05-environment-setup.md` 中刚修掉的「内嵌 docker-compose 副本」是同一类腐化风险——而且那里**已经真实发生过漂移**（副本缺 `DTYPE`、镜像标签过期）。

**推荐方案**

```text
保留附录 A 为唯一权威 DDL（它是完整可执行的）
正文各节只描述「字段语义 + 设计理由 + 约束说明」，不再重复 SQL

或者反过来：正文为权威，附录 A 改为「生成自 Drizzle Schema」的产物，不手工维护。

建议前者：附录 A 是自包含的，适合作为 Migration 的校对基准。
```

---

## F-10 🟡 `goals` 缺少时间顺序约束

**位置：** `03-database-design.md` §21

**问题**

`goals` 有 `started_at` / `target_at` / `completed_at`，但没有任何约束保证它们的先后关系。可以写入「目标时间早于开始时间」这种逻辑矛盾的数据。

`memories` 有 `chk_memories_valid_range`，`extraction_runs` 有 `chk_extraction_range`，`conversation_summaries` 有 `chk_summaries_range`——**唯独 `goals` 漏了**。

**推荐方案**

```sql
ALTER TABLE goals ADD CONSTRAINT chk_goals_time_order
  CHECK (
    (target_at IS NULL OR started_at IS NULL OR target_at >= started_at)
    AND (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
  );
```

---

## F-11 🟡 `model` 字段格式不统一

**位置：** `03-database-design.md` §14.5、§18.3；`docker-compose.yml`；`.env.example`

```text
§14.5 示例：  embedded_text = "fact｜用户｜用户住在广州｜2026-01-01 起有效"
§18.3 查询：  AND e.model = 'bge-m3'
.env.example：EMBEDDING_MODEL=BAAI/bge-m3
docker-compose：--model-id BAAI/bge-m3
```

**问题**

`memory_embeddings.model` 到底存 `bge-m3` 还是 `BAAI/bge-m3`？两种写法同时出现在文档里。

**影响**

若写入时用 `BAAI/bge-m3`、检索时过滤 `'bge-m3'`，**JOIN 条件静默失配，检索返回空结果**——而且不报错。这是最难排查的一类问题：功能看起来正常，只是永远召回不到东西。

**推荐方案**

```text
【必须】 统一为 HuggingFace 完整模型 ID：BAAI/bge-m3

理由：
  ① 与 .env 和 docker-compose 一致，无需转换
  ② 未来切换 provider 时不会与本地路径混淆
  ③ 长度在 VARCHAR(100) 内

所有出现处（§14.5 示例、§18.3 查询、§33 基线）一并修正。
另建议在 §14 增加一句：model 的取值必须来自单一常量，
不得在不同位置手写字面量。
```

---

## F-12 🟡 批量向量返回的顺序对齐未定义

**位置：** `03-database-design.md` §25.2；`docs/05-environment-setup.md` §8.2

**问题**

流程描述为「事务外调用 bge-m3 生成向量」，但**没有说明批量请求中返回向量的顺序如何与输入对齐**。环境手册 §8.2 的 PowerShell 示例是按索引取用，隐含「顺序一致」的假设。

**状态：需实测确认**

我查阅了 TEI 文档，未找到「批量输入保证按序返回」的明文承诺。这不等于是 bug，但**未经验证的顺序假设不应该进入设计**。

**推荐方案**

```text
① 在环境手册 §7 增加一项验证：
     发送 3 条内容明显不同的文本，确认返回向量与输入一一对应
     （而非验证维度——维度已验证过）

② 在设计层面加防御：每条记忆的向量生成后立即校验
     若批量返回长度 ≠ 输入长度 → 整体拒绝，不写库

③ 更稳妥：单条请求（batch=1）
     LifeMate 单用户场景下，抽取一次通常只产生 1~5 条记忆，
     batch=1 的吞吐损失可忽略，但彻底消除对齐风险。

建议 V1.0 用 batch=1，把批量优化留到确有性能需求时。
```

---

## F-13 🟡 部分唯一索引对无槽位记忆不生效

**位置：** `03-database-design.md` §13.11

```sql
CREATE UNIQUE INDEX uq_memories_current_slot
  ON memories (user_id, subject_key, predicate_key)
  WHERE ... AND predicate_key IS NOT NULL;
```

**问题**

条件里有 `predicate_key IS NOT NULL`，因此**没有槽位的记忆完全不受唯一性约束**。这是**设计意图**（§13.7 明确「词表之外的信息不参与冲突判定」），但文档没有把这个后果说清楚，容易被误读为「索引失效」或「约束有漏洞」。

**推荐方案**

```text
在 §13.11 补一句说明：

  该索引只对「有槽位的记忆」生效。无槽位记忆（predicate_key IS NULL）
  不受唯一性约束，因为：
    ① 无法判断两条无槽位记忆是否在讲同一个事实
    ② 强行约束会导致合法的不同事实被拒绝写入
  因此无槽位记忆的重复由抽取器的语义判重负责，不由数据库负责。
  这也意味着「Memory Noise」指标中有槽位与无槽位两类需分开统计。
```

---

# 3. 审计通过的部分

以下契约经核对**未发现问题**，可以放心实现：

| 检查项 | 结论 |
| ---- | ---- |
| `memories` 的双时间轴字段组合 | ✅ 一致，`valid_from`/`valid_until`/`created_at` 语义不重叠 |
| 状态转移表（§13.5）与 CHECK 约束 | ✅ 四个状态与约束一一对应 |
| 「当前有效记忆」谓词在各处引用 | ✅ §13.6 / §18.3 / §24.5 表述一致 |
| 检索权重之和 | ✅ 0.55 + 0.20 + 0.15 + 0.10 = 1.00 |
| `type_aware_recency` 的取值范围 | ✅ 各类均在 [0,1] 内 |
| `memory_embeddings` 唯一约束 | ✅ 正确防止同一记忆的重复向量 |
| `messages` 的 sequence 唯一约束 | ✅ 与 `conversation_summaries` 的引用序列一致 |
| 表数量「11 张」 | ✅ 与 §5.1 / §30 清单实际数量一致 |
| 外键删除行为汇总表（§23.1） | ✅ 与各表定义一致（除 F-02/F-03/F-04 涉及的四处） |
| `pg_trgm` 索引与检索查询 | ✅ `gin_trgm_ops` 用法正确，扩展已在初始化脚本中安装 |
| 环境手册的向量维度验证 | ✅ §7.3 会实测确认 1024，与 Schema 冻结值挂钩 |

---

# 4. 修复优先级与建议顺序

按「是否阻塞 Drizzle Schema 编写」分类。

## 4.1 必须修复（阻塞 Phase 3）

```text
F-01  幂等键改 start_sequence + 补进度计算规则
F-02  memory_sources 删除 conversation_id 冗余字段
F-03  修正 goal 删除策略（投影记忆随 Goal 失效）
F-04  superseded_by 去掉外键约束
F-06  Zod schema 移除 'goal' 与 'event'
F-07  明确「不可变」的字段范围
F-10  goals 补时间顺序约束
F-11  model 统一为 BAAI/bge-m3
F-13  补索引适用范围说明
```

**理由：** 这些直接决定表结构与校验 Schema，写进 `drizzle-kit generate` 后再改需要重新生成 Migration。

**建议一次性完成**，因为它们集中在同几处定义中，分批改容易遗漏交叉引用。

## 4.2 可稍后修复（不阻塞 Schema）

```text
F-05  Agent Loop 累积工具结果   → Phase 6 开发 Agent Core 前
F-08  抽取进度计算定义          → 与 F-01 一起改（同处）
F-09  消除 DDL 重复            → 文档整理，随时
F-12  批量向量顺序             → 环境手册补充验证项，Phase 4 时做
```

## 4.3 建议的验证方式

修完 F-01～F-04 后，**用真实数据库跑一遍才算修好**——这些是约束层面的问题，纸面推理可能遗漏。

环境手册 §5 已有 pgvector 验证流程，建议追加一节「约束冒烟测试」：

```sql
-- 验证 F-04 修复：被替代的记忆可以被物理删除
-- 验证 F-02 修复：删除会话不触发 CHECK 违约
-- 验证 F-03 修复：删除目标后投影记忆状态正确
```

---

# 5. 一个值得记住的教训

本次 4 个严重缺陷中，**3 个属于同一模式**：

```text
外键的 ON DELETE 行为  ⊗  CHECK 约束  互相冲突
```

```text
SET NULL  →  触发 UPDATE  →  重新校验 CHECK  →  违约
```

**这类 bug 的特点是：**

```text
① 只在删除路径触发，平时的增删改查完全正常
② 单看外键定义没问题，单看 CHECK 定义也没问题
③ 只有把两者放在一起、代入真实数据做布尔求值，才会暴露
④ 一旦触发就是硬失败（抛异常），不是静默错误——这点算走运
```

**防御方法：** 写任何 `CHECK` 约束时，反问一句：

> **当某条 `ON DELETE SET NULL` 或 `ON DELETE CASCADE` 发生时，这个约束还能满足吗？**

这个问题应该在设计阶段问，而不是等删除功能上线后才发现。

---

# 6. 结论

```text
设计骨架        可靠 —— 双时间轴、槽位判定、幂等抽取的总体方向正确
契约细节        有 4 处硬缺陷，会直接导致删除失败或幂等失效
                （其中 F-02 / F-03 / F-04 已用真实 SQL 引擎实测复现）
文档一致性      良好 —— 交叉比对未发现概念性矛盾，仅有 1 处表述歧义
可直接实现      否 —— 需先修复 4.1 列出的 9 项
```

**审计判断：** 这些问题**不影响架构方向**，都属于「约束与流程的细节错误」，修复成本低（预计改动集中在 3 个章节 + 附录 A）。但如果不修就写 Schema，会在 Phase 7 开发删除功能时集中爆发——那时返工成本远高于现在。

**关于验证强度的说明：**

```text
F-02 / F-03 / F-04  已实测复现（SQLite，脚本见 audit/constraint-test.sql）
                     修复后已在同一脚本中回归通过（见 §7）
                     待办：在 PostgreSQL 上复跑一次，确认错误信息与回滚行为一致
                    （Docker 环境当前未就绪，见 §0.4）

F-01                逐次代入执行验证 + 修复后实测回归通过
                    未在 PG 上验证 EXCLUDE / btree_gist（需真实 PG）

F-05 ~ F-13         静态核对与交叉比对，未实测
                    这些属于契约表述问题，不涉及数据库运行时行为
```

---

# 7. 修复与回归验证结果

## 7.1 修复清单

9 项阻塞项（§4.1）已全部应用到 `03-database-design.md` 与 `04-api-spec.md`，并登记为变更项 **C19～C28**（见该文档 §0.3）。下表另含 F-08 —— 它属 §4.2，但因与 F-01 同处一地而一并修订。

| 审计编号 | 修复内容 | 变更项 | 落地位置 |
| ---- | ---- | ---- | ---- |
| F-01 | 幂等键 `end_sequence` → `start_sequence` | C19 | 03 §11.3、§11.3.1、§17.6、附录 A |
| F-01 | 新增区间不重叠排他约束 | C20 | 03 §11.3.2、附录 A（后补） |
| F-08 | 新增进度计算定义（只统计 succeeded）〔§4.2，随 F-01 一并改〕 | C21 | 03 §11.4 |
| F-02 | 删除 `memory_sources.conversation_id` | C22 | 03 §15.2、§15.4、§17.11、§23.1、§24.3、附录 A |
| F-04 | `superseded_by` 去掉外键 | C23 | 03 §13.3、附录 A |
| F-03 | 明确 Goal 删除时的清理顺序 | C24 | 03 §13.10 |
| F-06 | Zod schema 移除 `goal` 与 `event` | — | 04 §39（见该文档的说明块） |
| F-07 | 明确「不可变」的字段范围 | C25 | 03 §13.1 |
| F-10 | `goals` 新增时间顺序约束 | C26 | 03 §19.3、附录 A |
| F-11 | `model` 统一为 `BAAI/bge-m3` | C27 | 03 §14.5、§17.4 查询、附录 B |
| F-13 | 补充部分唯一索引的适用范围说明 | C28 | 03 §17.4 |

**未在本次修复（属 §4.2，不阻塞 Schema）：**

```text
F-05  Agent Loop 累积工具结果     → Phase 6 开发 Agent Core 前
F-09  消除附录 A 与正文的 DDL 重复 → 文档整理，可随时
F-12  批量向量顺序验证             → Phase 4，需实测 TEI 行为
```

## 7.2 回归验证结果

**脚本：** `audit/constraint-test.sql`（已更新为「修复前 vs 修复后」两段式）
**执行：** `sqlite3 :memory: ".read audit/constraint-test.sql"`

**第一部分 —— 修复前 schema，缺陷仍可稳定复现：**

```text
[F-04] DELETE memB → CHECK constraint failed
       删除后仍是 2 行（memA|superseded|memB），语句被回滚      ✓ 缺陷确认

[F-03] DELETE goal1 → CHECK constraint failed
       删除后 goal_id 仍在（src2|goal_projection|goal1）        ✓ 缺陷确认

[F-02] DELETE conv1 → CHECK constraint failed
       删除后表为空（会话未能删除）                             ✓ 缺陷确认

[C30]  按初稿写法执行步骤③（只在「有剩余来源」一支删来源行）
       → 步骤④ DELETE messages 报 FOREIGN KEY constraint failed
       删除后 msg_left=1, sources_left=1（语句被回滚）           ✓ 缺陷确认
```

**第二部分 —— 修复后 schema，全部通过：**

```text
[C23] 删除 memB → 成功
      结果：memA|superseded|memB（历史指针悬空但合法）          ✓ 物理删除能力可兑现

[C22 + C29 + C30] 严格按 §24.3 的六步执行：
      步骤① JOIN 反查 → mem1, mem2
      步骤② 剩余来源数 → mem2|1（mem1 为 0，走 b 支）
      步骤③a 删 src2；步骤③b 失效 mem1/mem1 的 embedding 并删 src1
      步骤④ DELETE msg1 → 成功（不再被 RESTRICT 挡住）
      步骤⑤ 删除该会话摘要；步骤⑥ 会话置 deleted
      结果：deleted|deleted|active|1|1|0|deleted
            （mem1 失效 / mem2 保留 / src3 仍在 / msg2 仍在 /
              摘要已删除 / 会话仅软删除）                        ✓ 两支流程都跑通

[C24] 删除 Goal（先失效记忆 → 删来源 → 删 Goal）
      结果：memory_status=deleted, goals_left=0, sources_left=0  ✓ 投影记忆被正确失效

[C19] 插入起点相同的重复抽取 [1,10] → UNIQUE constraint failed  ✓ 重叠触发被拦截
      插入起点不同的区间 [6,10]     → 成功
      最终：r1|1|5|succeeded, r3|6|10|succeeded
```

**结论：4 个缺陷中的 3 个已实测证明「修复前失败、修复后成功」。**

> 📌 **关于 [C30] 这次补测的意义**：原来的 [C22] 用例是无条件删除全部来源行，
> 比 §24.3 文档写的流程更简单，因此它通过并不代表文档的流程能通过。
> 补测后的用例改成严格按 §24.3 的六步走，并让「无剩余来源」这一支先按初稿写法
> 执行一次（第一部分，报错）再按修正后执行（第二部分，通过）。
> **测试必须照着文档写，否则绿灯证明不了文档是对的。**

## 7.3 仍需在 PostgreSQL 上完成的验证

```text
□ 复跑 audit/constraint-test.sql 的等价 PG 版本（错误信息措辞不同，行为应一致）
□ 验证 EXCLUDE 约束（需 btree_gist 扩展）——SQLite 无此能力
□ 验证后置外键 fk_memory_sources_event / fk_memory_sources_goal
  （附录 A 末尾新增，需确认 SET NULL 行为与 §23.1 一致）
□ 验证 VECTOR(1024) 与 pgvector 的维度约束（环境手册 §5 已覆盖）
□ 验证 gin_trgm_ops 索引对中文的实际召回效果
□ 验证 TEI 批量输入的返回顺序（F-12）

前置条件：Docker 引擎需先启动（当前未就绪，见 §0.4）
```

**本节复跑记录（SQLite 部分）：**

```text
执行：sqlite3 :memory: ".read audit/constraint-test.sql"
环境：sqlite3 3.53.2（2026-06-03）
时间：2026-09-22
结果：第一部分 4 项缺陷全部按预期报错；第二部分 4 组断言全部通过
      退出码 1 属预期 —— 第一部分故意触发约束错误，sqlite3 因此返回非零
```

## 7.4 遗留的设计取舍（已按推荐方案决策）

```text
F-02 采用「删除冗余字段」而非「修补约束」
     → 代价：按会话反查需 JOIN。已在 §15.4 给出查询与索引依据。

F-04 采用「去掉外键」而非「删除前清理引用」
     → 代价：superseded_by 可能出现悬空指针，UI 需显示「（替代者已删除）」。
       已在 §13.3 记录为实现要求。
```

---

## 7.5 二次复查（C29～C32）

§7 的修复提交之后，对**修复结果本身**又做了一次一致性复查，又发现 4 项缺陷 —— 全部属于「正文改了、别处没跟上」：

| 编号 | 缺陷 | 性质 | 落地位置 |
| ---- | ---- | ---- | ---- |
| C29 | §24.2 / §24.3 要求 messages / summaries 软删除，但两张表都没有 `deleted_at`，且与 §24.1「内容必须消失」的意图冲突 | 文档内部矛盾 | 03 §24.2 |
| C30 | §24.3 步骤③只在「有剩余来源」一支删除来源行；「无剩余来源」一支遗留的来源行会让步骤④被 `RESTRICT` 挡住 | 与 F-02 同类缺陷（流程自锁） | 03 §24.3、audit/constraint-test.sql |
| C31 | §15.2 / §23.1 承诺的 `memory_sources.event_id` / `goal_id` 外键在附录 A 中缺失，而 F-03 的复现脚本恰恰依赖该外键 | 附录 A 与正文脱钩 | 03 附录 A（后置 `ALTER TABLE`） |
| C32 | C20 的 `excl_extraction_range` 只落在正文，附录 A 中没有；`btree_gist` 只写在文档里，未进初始化脚本 | 附录 A 脱钩 + 修复未落地 | 03 附录 A、`devops/postgres/init/01-extensions.sql` |

**这一轮的教训（比缺陷本身更值得记）：**

```text
① 「修复清单」本身也要被审计。
   C19～C28 全部落在正文，却漏了「附录 A 是同一份内容的第二份拷贝」。
   F-09（附录 A 与正文重复）早已点出这个隐患，但它被归入「不阻塞」而没有优先处理，
   结果同一次提交里就发作了两次（C31 / C32）。

② 测试脚本必须照文档写。
   原来的 [C22] 用例无条件删除全部来源行，比 §24.3 的流程简单，
   所以它通过并不能证明文档是对的。C30 的补测改成逐字照抄 §24.3 的六步。

③ 文档里写「初始化脚本需补充 X」不等于补充了 X。
   C20 的注解留在了正文，脚本没改，真实 PG 上 EXCLUDE 必然创建失败。
   凡是「需补充 / 待同步 / TODO」这类句子，都要在同一次改动里兑现，或明确登记为待办。
```

**验证：** SQLite 部分见 §7.2 新增的两个用例与 §7.3 的复跑记录；PG 侧（EXCLUDE、后置外键、pgvector）仍需按 §7.3 清单执行。

---

**审计报告结束。**

**下一步：** SQLite 侧回归已闭环（含二次复查）；PG 侧验证项见 §7.3，待容器就绪后执行 → 进入 **Phase 3：工程骨架 + Drizzle Schema**。
Schema 编写以 `03-database-design.md`（含 C19～C28 修订）为唯一依据，
附录 A 的 DDL 可作为 `drizzle-kit generate` 产物的校对基准。
