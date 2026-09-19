# LifeMate 数据库设计说明书 V1.1

**项目名称：** LifeMate
**文档类型：** 数据库设计说明书
**版本：** V1.1
**文档状态：** 基线版本（含 P0 决策落地 + 契约审计修订，**可作为 Schema 编写依据**）
**数据库：** PostgreSQL 18
**向量扩展：** pgvector 0.8.x
**ORM：** Drizzle ORM
**适用阶段：** MVP / V1.0

> ✅ **本文档已通过契约审计并完成修订。**
> 审计发现的 9 项阻塞项已全部修复（登记为 §0.3 的 C19～C28），
> 并通过 `audit/constraint-test.sql` 实测回归。
> 详见《[设计契约审计报告](./08-contract-audit.md)》§7。

---

# 0. V1.1 变更说明

## 0.1 本版依据

本版本依据《LifeMate 设计评审与改进建议 V1.0》中的决策结论，对 V1.0 数据库设计做结构性修订。

**已锁定决策：**

| 编号 | 决策项 | 结论 | 影响范围 |
| ---- | ---- | ---- | ---- |
| Q1 | 记忆版本模型 | **A：不可变事实 + `superseded_by` + 双时间轴** | `memories` 表结构、全部记忆读写 |
| Q2 | 抽取输出契约 | **A：结构化 `subject/predicate/object` + 受控词表** | `memories` 新增 4 字段、去重与冲突判定 |
| Q4 | Embedding 模型 | **bge-m3，`VECTOR(1024)`，MIT 授权，本地部署** | `memory_embeddings` 表结构 |
| — | 向量索引策略 | **V1.0 不建向量索引，走精确检索** | 索引策略 |

## 0.2 V1.0 → V1.1 变更清单

| 编号 | 变更 | 类型 | 原因 |
| ---- | ---- | ---- | ---- |
| C1 | `memories` 改为不可变事实模型，新增 `superseded_by` | 🔴 结构性 | P0-1：原设计允许就地更新 `content`，与 `valid_from` 语义冲突且丢失历史 |
| C2 | `memories` 新增 `subject_key` / `predicate_key` / `object_value` / `polarity` | 🔴 结构性 | P0-2：无槽位信息则去重与冲突判定不可确定、不可回归测试 |
| C3 | `memory_embeddings` 维度冻结为 `VECTOR(1024)` | 🔴 结构性 | P0-3：pgvector 维度不可后改 |
| C4 | `memory_embeddings` 新增 `embedded_text` / `content_hash` / `dim` / `status` | 🟠 新增字段 | P0-3：原设计无法检测陈旧向量 |
| C5 | `memory_embeddings` 新增 `UNIQUE (memory_id, model)` | 🟠 新增约束 | P0-3：防止重复向量导致重复召回 |
| C6 | V1.0 不建 HNSW / IVFFlat 索引 | 🟠 策略调整 | 数据量 < 5 万条，精确检索更快且召回率 100% |
| C7 | **删除** `timeline_events` 表，Timeline 改为 `events` 的查询视图 | 🔴 结构性 | P0-5：双表写入无一致性保障、无重建路径 |
| C8 | `events` 新增 `source_type` / `source_message_id` / `timeline_visible` / `deleted_at` | 🟠 新增字段 | C7 的配套，使单表可承担原双表职责 |
| C9 | 明确 `goals` 与 `memory(type='goal')` 的边界与写入责任 | 🟠 语义明确 | P0-5：原设计两个入口，职责不清 |
| C10 | 新增 `extraction_runs` 表 | 🟠 新增表 | P0-6：抽取幂等键，无此表则必然重复记忆 |
| C11 | `messages` 明确 `sequence` 分配方式与唯一约束 | 🟠 新增约束 | P1-3：原设计存在并发竞态 |
| C12 | `memory_sources` 补充索引、唯一约束与外键行为 | 🟠 新增约束 | P1-6：删除级联与来源查询缺少索引支撑 |
| C13 | 新增第 17 节「约束设计」 | 🟠 新增章节 | P1-8：原文档只有字段类型，无任何 CHECK / NOT NULL |
| C14 | 新增第 18 节「检索过滤条件」 | 🟠 新增章节 | P1-2：软删除必须从所有召回路径排除 |
| C15 | 新增第 19 节「删除与级联策略」 | 🟠 新增章节 | P1-1：原文档「可以根据删除策略进行级联」未定义 |
| C16 | 明确 keyword 检索使用 `pg_trgm` | 🟠 新增 | P1-7：混合检索的关键词通道原本无库层实现 |
| C17 | `conversations` 新增 `status`、`deleted_at` | 🟡 新增字段 | 软删除语义完整化 |
| C18 | `conversation_summaries` 明细化生成策略与幂等键 | 🟡 补充说明 | P2-12 |

## 0.3 V1.1 内部修订（契约审计驱动）

V1.1 初稿经《设计契约审计报告》审计后，发现并修复以下缺陷。**这些是对 V1.1 自身的修订**，与上面 C1～C18（对 V1.0 的变更）性质不同。

| 编号 | 修订 | 类型 | 依据 |
| ---- | ---- | ---- | ---- |
| C19 | `extraction_runs` 幂等键由 `end_sequence` 改为 `start_sequence` | 🔴 缺陷修复 | 审计 F-01：`end_sequence` 每次触发都变，无法拦截范围重叠 |
| C20 | 新增 §11.3.2 区间不重叠排他约束（需 `btree_gist`） | 🟠 新增约束 | 审计 F-01 配套 |
| C21 | 新增 §11.4 进度计算定义（只统计 succeeded） | 🟠 补充说明 | 审计 F-08：失败区间可能被永久跳过 |
| C22 | **删除** `memory_sources.conversation_id` 冗余字段 | 🔴 结构性 | 审计 F-02：其 `SET NULL` 与来源约束冲突，导致删除会话失败 |
| C23 | `superseded_by` 去掉外键约束（保留为历史指针） | 🔴 结构性 | 审计 F-04：原外键使物理删除记忆必定失败 |
| C24 | 明确 `goal_projection` 记忆随 Goal 删除而失效 | 🟠 流程修订 | 审计 F-03：`goal_id` 置空会触发来源约束违约 |
| C25 | §13.1 明确「不可变」的字段范围 | 🟡 表述澄清 | 审计 F-07：原文易被误读为整行不可变 |
| C26 | `goals` 新增时间顺序约束 | 🟠 新增约束 | 审计 F-10：可写入逻辑矛盾的时间 |
| C27 | `model` 字段统一为 `BAAI/bge-m3` | 🟡 一致性 | 审计 F-11：两种写法并存会导致检索静默失配 |
| C28 | 补充部分唯一索引的适用范围说明 | 🟡 表述澄清 | 审计 F-13：无槽位记忆不受唯一约束，需明确为设计意图 |

## 0.3 与 V1.0 的不兼容说明

```text
⚠ 本版本不向后兼容 V1.0 的表结构。

原因：V1.0 尚未产生任何生产数据，此阶段做结构性修订的代价为零。
      若 V1.0 已有数据，则 C1 / C2 / C3 需要数据回填 + 全量重算 embedding。

后续如需修改 memories 的时间模型或 embedding 维度，
必须按「新增版本 → 双写 → 回填 → 切换」四步走，不得直接改表。
```

---

# 1. 文档概述

## 1.1 编写目的

本文档用于定义 LifeMate V1.0 的数据库结构、实体关系、字段规范、约束设计、索引策略、向量存储方案以及数据生命周期。

本文档作为以下工作的直接依据：

- Drizzle Schema 编写
- PostgreSQL 数据库初始化
- Migration 设计
- API 接口设计
- Memory Engine 开发
- Conversation Service 开发
- Timeline Service 开发
- 离线评测脚本（必须使用与线上一致的过滤条件）

## 1.2 阅读约定

```text
🔴 结构性变更   需要重新设计表，不能只加字段
🟠 新增         新增字段 / 表 / 约束
🟡 补充         文档说明补充，表结构不变

【必须】 表示该条是硬性约束，实现时不得绕过
```

---

# 2. 数据库设计目标

LifeMate 的数据库并不是单纯的「聊天记录数据库」。

它需要同时承担五类职责：

```text
┌─────────────────────────────────────────────┐
│              LifeMate Data                  │
├─────────────────────────────────────────────┤
│                                             │
│  ① 对话数据                                 │
│     conversations / messages / summaries    │
│                                             │
│  ② 长期记忆（认知层）                       │
│     memories / memory_embeddings            │
│     memory_sources / extraction_runs        │
│                                             │
│  ③ 人生结构化数据                           │
│     events / goals / relationships          │
│                                             │
│  ④ 时间视图（派生，非独立存储）              │
│     timeline = events 的查询视图             │
│                                             │
│  ⑤ 派生总结                                 │
│     life review = 运行时生成，不落库          │
│                                             │
└─────────────────────────────────────────────┘
```

核心要求：

1. 数据结构清晰
2. **支持记忆演化且不丢失历史（V1.1 强化）**
3. **支持确定性的去重与冲突判定（V1.1 新增）**
4. 支持向量检索
5. 支持时间查询
6. 支持来源追踪
7. 支持数据删除（含级联语义）
8. 支持数据导出
9. **约束下沉到数据库（V1.1 新增）**
10. 保证未来扩展空间
11. 避免 V1.0 过度设计

---

# 3. 数据库选型

## 3.1 PostgreSQL

V1.0 使用 PostgreSQL 18。

原因：

- 成熟稳定
- 关系模型适合结构化个人数据
- SQL 能力强
- JSONB 支持完善
- 时间数据处理能力强（`TIMESTAMPTZ` + 时区）
- 索引体系成熟（B-tree / GIN / 部分索引 / 表达式索引）
- 与 TypeScript / Node.js 生态良好
- 支持 pgvector
- **支持部分唯一索引（V1.1 的「当前有效记忆」判定依赖此特性）**

## 3.2 部署形态

```text
Docker Compose
  ├── postgres:18 + pgvector 0.8.x
  └── （后续）lifemate-app
```

镜像：`pgvector/pgvector:pg18`

---

# 4. 为什么使用 pgvector

## 4.1 语义检索需求

LifeMate 的长期记忆检索需要语义搜索。

例如数据库中保存：

```text
用户正在学习 TypeScript。
```

用户未来问：

```text
我最近那个 TS 项目怎么样了？
```

二者未必存在完全相同的关键词。

因此需要 Embedding：

```text
文本
  ↓
Embedding Model
  ↓
Vector
  ↓
pgvector
```

## 4.2 维度决策（Q4 已锁定）

> **V1.0 冻结为 `VECTOR(1024)`，对应模型 `bge-m3`。**

| 项目 | 值 |
| ---- | ---- |
| 模型 | `BAAI/bge-m3` |
| 维度 | **1024** |
| 参数规模 | 568M |
| 最大输入 | 8192 token |
| 授权 | MIT（可商用） |
| 部署 | 本地 GPU（RTX 4070 Laptop 8G，显存占用约 3.2 GB） |
| 输出 | dense（主用）+ sparse（可作关键词通道）+ multi-vector |

**为什么必须现在定维度：**

pgvector 的 `vector(N)` 在建表时确定，且索引同样绑定维度。所谓「Migration 时再定」等价于「写 Migration 的那天必须拍板」，而且那时是最不方便改动的时刻。

```text
【必须】 更换 Embedding 模型 = 一次显式数据迁移，不是改配置。
         流程：新增 model 记录 → 双写 → 回填 → 切换 → 清理旧 model。
         memory_embeddings 的 (memory_id, model) 多行设计正是为此预留。
```

## 4.3 向量类型与维度硬约束

pgvector 的能力边界（来源：pgvector 官方 README）：

| 类型 | 存储上限 | 索引上限 |
| ---- | ---- | ---- |
| `vector` | 16,000 维 | **2,000 维** |
| `halfvec` | 16,000 维 | 4,000 维 |
| `bit` | 64,000 维 | 64,000 维 |
| `sparsevec` | 16,000 非零元 | 1,000 非零元 |

这张表解释了为什么**排除**了一批候选模型：

```text
Qwen3-Embedding-4B     2560 维 → 超出 vector 索引上限，需 halfvec
Qwen3-Embedding-8B     4096 维 → 超出 vector 索引上限，需 halfvec
text-embedding-3-large 3072 维 → 超出且需出网
gte-Qwen2-1.5B         1536 维 → 可索引，但质量无优势且参数更大

bge-m3                 1024 维 → ✅ 稳定落在索引上限内，为未来留出空间
```

---

# 5. 总体数据模型

## 5.1 V1.1 数据表（11 张核心业务表）

```text
users
│
├── conversations
│      ├── messages
│      │      └── extraction_runs
│      └── conversation_summaries
│
├── memories
│      ├── memory_embeddings
│      └── memory_sources
│
├── events                       ← 同时承担 Timeline 职责
│
├── goals
│
└── relationships
```

## 5.2 整体关系

```text
                          User
                           │
        ┌──────────┬───────┼────────┬──────────┐
        │          │       │        │          │
        ▼          ▼       ▼        ▼          ▼
  Conversation   Memory  Event    Goal   Relationship
        │          │       │
        ▼          │       │
    Message        │       │
        │          │       │
        ▼          │       │
    Summary        │       │
                   │       │
        ┌──────────┴───┐   │
        ▼              ▼   │
   Embedding       Source ─┘
                       │
                       └──→ 可指向 Message / Event / Goal / Relationship
```

## 5.3 五层数据职责

```text
原始数据层   Message              用户实际说过的话
认知层       Memory               系统从对话中提取的长期信息
人生层       Event / Goal / Relation  发生过什么 / 想完成什么 / 与谁有关
派生层       Timeline             事件的查询视图（不独立存储）
投影层       memory(type='goal')  Goal 的语义检索投影
```

---

# 6. 数据库命名规范

采用：

```text
snake_case
```

例如：

```text
created_at
updated_at
conversation_id
memory_type
importance_score
superseded_by
```

表名使用复数：

```text
users
messages
memories
events
```

主键统一使用：

```text
UUID
```

约束命名统一前缀：

```text
pk_   主键
fk_   外键
uq_   唯一约束
chk_  检查约束
idx_  普通索引
```

---

# 7. UUID 设计

所有核心实体使用 UUID 作为主键。

```text
id = 550e8400-e29b-41d4-a716-446655440000
```

原因：

- 不暴露数据数量
- 避免自增 ID 的可预测性
- 方便未来数据迁移
- 方便分布式扩展
- PostgreSQL 原生支持

实现：

```sql
DEFAULT gen_random_uuid()   -- PostgreSQL 13+ 内置，无需 uuid-ossp 扩展
```

虽然 V1.0 是单用户，但提前统一 UUID 成本很低。

---

# 8. users

## 8.1 用途

保存 LifeMate 用户基本信息。

V1.0 虽然是单用户，但仍保留 User 表，避免未来重构整个数据模型。

## 8.2 字段设计

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | UUID | PK | 主键 |
| name | VARCHAR(100) | | 用户名称 |
| timezone | VARCHAR(64) | | 用户时区，如 `Asia/Shanghai` |
| created_at | TIMESTAMPTZ | NOT NULL | 创建时间 |
| updated_at | TIMESTAMPTZ | NOT NULL | 更新时间 |

## 8.3 User Profile 的归属

> 对应评审 P1-4。

V1.0 明确区分两类「用户画像」：

```text
静态配置（放 users 表扩展字段或 settings）
  ├── 称呼 / 语言 / 回复风格 / 回复长度偏好
  └── 特点：少量、稳定、用户可编辑

动态认知（放 memories 表）
  ├── 职业变化 / 当前目标 / 近期状态
  └── 特点：随使用时间自然演化，由抽取流水线维护
```

**V1.0 决定：** 静态配置暂存 `users.settings JSONB`（见 8.4），不新增独立 profile 表。

```text
理由：
  ① 单用户场景下静态配置总量很小，独立表收益低
  ② 避免 V1.0 过度设计（本文档 §2 第 11 条要求）
  ③ settings 字段的键受白名单约束（见 §16），不会退化为杂物袋
```

## 8.4 settings 字段

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| settings | JSONB | NOT NULL DEFAULT '{}' | 用户偏好配置（白名单键） |

允许的键（白名单）：

```jsonc
{
  "display_name": "康康",
  "locale": "zh-CN",
  "response_style": "direct",        // direct | gentle | detailed
  "response_length": "medium",       // short | medium | long
  "auto_extract": true,              // 是否自动抽取记忆
  "sensitive_memory_local_only": true // 敏感记忆是否禁止出网（见 §20）
}
```

**禁止**把需要被 SQL 查询/过滤的业务字段放入 `settings`。

## 8.5 示例

```text
users

id:
xxxx-xxxx

name:
康康

timezone:
Asia/Shanghai

settings:
{ "locale": "zh-CN", "response_style": "direct" }
```

---

# 9. conversations

## 9.1 用途

表示一次独立的对话会话。

## 9.2 字段设计

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | UUID | PK | 主键 |
| user_id | UUID | FK → users(id), NOT NULL | 用户 |
| title | VARCHAR(200) | | 会话标题 |
| summary | TEXT | | 会话摘要（长摘要缓存在此，分段摘要见 §12） |
| status | VARCHAR(20) | NOT NULL DEFAULT 'active', CHECK | active / archived / deleted |
| created_at | TIMESTAMPTZ | NOT NULL | 创建时间 |
| updated_at | TIMESTAMPTZ | NOT NULL | 最后更新时间 |
| archived_at | TIMESTAMPTZ | | 归档时间 |
| deleted_at | TIMESTAMPTZ | | 软删除时间 |

> 🟡 C17：V1.0 仅有 `archived_at`，缺少完整的软删除语义，本版补齐。

## 9.3 status

```text
active      正常
archived    已归档，不在默认列表展示
deleted     已软删除
```

约束：

```sql
CHECK (status IN ('active','archived','deleted'))
CHECK (status <> 'deleted' OR deleted_at IS NOT NULL)
```

## 9.4 关系

```text
User 1 ───── N Conversation
```

---

# 10. messages

## 10.1 用途

保存实际聊天消息。

## 10.2 字段设计

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | UUID | PK | 主键 |
| conversation_id | UUID | FK → conversations(id), NOT NULL | 会话 |
| role | VARCHAR(20) | NOT NULL, CHECK | user / assistant / system / tool |
| content | TEXT | NOT NULL | 消息内容 |
| sequence | BIGINT | NOT NULL | 会话内消息顺序 |
| metadata | JSONB | NOT NULL DEFAULT '{}' | 附加信息（白名单键，见 §16） |
| created_at | TIMESTAMPTZ | NOT NULL | 创建时间 |

## 10.3 role

```text
user
assistant
system
tool
```

```sql
CHECK (role IN ('user','assistant','system','tool'))
```

## 10.4 sequence 的分配方式

> 🟠 C11，对应评审 P1-3。

V1.0 原设计用 `sequence` 保证顺序但未定义生成方式，`MAX(sequence)+1` 存在并发竞态（流式响应 + 后台抽取 + 用户连发正是并发场景）。

**V1.1 决定：** 使用**会话内单调序号**，由服务层在事务内分配。

```sql
-- 唯一约束
CREATE UNIQUE INDEX uq_messages_conversation_sequence
  ON messages (conversation_id, sequence);

-- 顺序查询索引
CREATE INDEX idx_messages_sequence
  ON messages (conversation_id, sequence DESC);
```

分配实现（服务层，必须在写入消息的同一事务内）：

```sql
-- 方式：取当前最大序号 + 1，配合唯一约束做乐观重试
INSERT INTO messages (conversation_id, role, content, sequence)
SELECT $1, $2, $3, COALESCE(MAX(sequence), 0) + 1
  FROM messages WHERE conversation_id = $1
RETURNING *;
```

```text
【必须】
  ① sequence 从 1 开始，会话内连续，且不可复用
  ② 唯一约束是最终防线，冲突时服务层重试（最多 3 次）
  ③ 不要用 created_at 判断顺序（同毫秒写入无法区分先后）
  ④ conversation_summaries 引用的 sequence 与此处同一序列
```

## 10.5 message metadata

部分 AI 运行数据不适合建立大量字段，因此保留 `metadata JSONB`。

允许的键（白名单）：

```jsonc
{
  "model": "xxx",
  "provider": "openai-compatible",
  "token_usage": { "input": 123, "output": 456 },
  "latency_ms": 1800,
  "finish_reason": "stop",
  "tool_calls": [],
  "loop_truncated": false,
  "extractor_version": "v1"
}
```

**注意：**

> metadata 用于辅助数据，不用于核心业务字段。

```text
【必须】 metadata 的键受 Zod schema 校验后才可写入；
         metadata 同样受 §21 的日志脱敏约束，
         若 tool_calls 中含用户正文，必须在落库前裁剪。
```

## 10.6 与抽取流水线的关系

```text
messages
   │
   └── 每 N 条 / 每空闲 M 分钟 / 用户显式请求
              ↓
        extraction_runs（记录「哪一段已被抽取」）
```

---

# 11. extraction_runs

> 🟠 C10 新增表。对应评审 P0-6。

## 11.1 用途

**这是为正确性服务的表，不是可观测性表。**

它解决的问题：Memory Extraction 是异步的、可能重试的、可能被重复触发的。没有幂等键，同一条「用户在学习 TypeScript」会被反复写入，直接导致 PRD 的 Memory Noise 指标失控。

```text
与 agent_runs 的区别（重要）

  extraction_runs   为「正确性」服务 —— 幂等键，必须落库   ← 本表
  agent_runs        为「可观测性」服务 —— V1.0 仅进日志    ← 不建表
```

## 11.2 字段设计

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | UUID | PK | 主键 |
| conversation_id | UUID | FK → conversations(id), NOT NULL | 所属会话 |
| start_sequence | BIGINT | NOT NULL | 本次抽取覆盖的起始消息序号 |
| end_sequence | BIGINT | NOT NULL | 本次抽取覆盖的结束消息序号 |
| extractor_version | VARCHAR(50) | NOT NULL | 抽取器 / 提示词 / 模型版本 |
| status | VARCHAR(20) | NOT NULL | pending / running / succeeded / failed / skipped |
| memories_created | INTEGER | NOT NULL DEFAULT 0 | 新建记忆数 |
| memories_updated | INTEGER | NOT NULL DEFAULT 0 | 更新（去重合并）数 |
| memories_superseded | INTEGER | NOT NULL DEFAULT 0 | 因冲突被替代数 |
| conflicts_found | INTEGER | NOT NULL DEFAULT 0 | 发现的冲突数 |
| error | TEXT | | 失败原因 |
| created_at | TIMESTAMPTZ | NOT NULL | 创建时间 |
| finished_at | TIMESTAMPTZ | | 完成时间 |

## 11.3 幂等键

```sql
CREATE UNIQUE INDEX uq_extraction_idempotency
  ON extraction_runs (conversation_id, start_sequence, extractor_version);
```

```text
【必须】 抽取执行前先尝试插入 extraction_runs。
         插入冲突（幂等键已存在）→ 直接返回，不重复抽取。
         这是防止重复记忆的唯一可靠机制。

extractor_version 的作用：
  提示词或模型升级后，可通过更换 version 对历史对话选择性重跑，
  而不会与旧版本的记录冲突。
```

### 11.3.1 为什么幂等键是 start_sequence 而不是 end_sequence

> 🔴 依据审计报告 F-01。V1.1 初稿曾使用 `end_sequence`，**这是错误的**。

`end_sequence` 是**每次触发时都会变化的值**，因此无法拦截范围重叠的重复抽取：

```text
错误设计（end_sequence 作键）：
  t1  空闲触发，扫描 [1, 5]   → 键 (conv, end=5,  v1)  ✅ 执行
  t2  空闲触发，扫描 [1, 10]  → 键 (conv, end=10, v1)  ✅ 执行 ← 重叠了 [1,5]
  t3  用户手动触发，扫描 [1,10] → 键与 t2 相同          ❌ 拦截

  → t2 把 [1,5] 重新抽了一遍，白白多调一次 LLM，
    且 source_count 被虚增，该信号不再可信。
```

**正确性不变量是「每条消息恰好被抽取一次」**，这由**起点单调递增**保证，与终点无关。因此幂等键必须标识「从哪开始」：

```text
正确设计（start_sequence 作键）：
  t1  扫描 [1, 5]   → 键 (conv, start=1,  v1)  ✅ 执行
  t2  扫描 [1, 10]  → 键 (conv, start=1,  v1)  ❌ 拦截（起点相同）
  t3  扫描 [6, 10]  → 键 (conv, start=6,  v1)  ✅ 执行
```

### 11.3.2 区间不重叠约束

仅靠幂等键还不足以保证区间不重叠（`[1,5]` 与 `[3,10]` 起点不同但重叠）。因此补充排他约束：

```sql
-- 成功的抽取区间不得两两重叠
ALTER TABLE extraction_runs ADD CONSTRAINT excl_extraction_range
  EXCLUDE USING gist (
    conversation_id WITH =,
    int8range(start_sequence, end_sequence, '[]') WITH &&
  ) WHERE (status = 'succeeded');
```

> ⚠️ `EXCLUDE` 需要 `btree_gist` 扩展。初始化脚本需补充：
> `CREATE EXTENSION IF NOT EXISTS btree_gist;`
>
> 若不想引入该扩展，可在服务层用事务 + `SELECT ... FOR UPDATE` 保证同一会话
> 的抽取串行化。**V1.0 建议引入 `btree_gist`**——数据库层的保证比服务层自觉可靠。

## 11.4 进度计算

> 🔴 依据审计报告 F-08。V1.1 初稿只定义了触发条件，**没有定义「未抽取」如何计算**，会导致失败区间被永久跳过。

```text
【必须】 进度只统计 succeeded 记录：

  start_sequence = COALESCE(
      MAX(end_sequence) FROM extraction_runs
       WHERE conversation_id = ? AND status = 'succeeded',
    0) + 1
```

**为什么必须排除 failed：** 若把 failed 也算进 `MAX(end_sequence)`：

```text
run1  [1, 10]  failed        ← 抽取失败
run2  start = MAX(end_sequence) + 1 = 11
      → messages [1,10] 永远不会被重新抽取
      → 这 10 条消息里的记忆永久丢失，且无任何提示
```

排除 failed 后，失败区间会被下一次触发自然覆盖，无需特殊重试逻辑。

**failed 记录仍然保留**——它记录了「这次尝试失败过」，用于告警与质量回溯，只是不参与进度推进。

**重试的幂等处理：** 失败区间重试时起点不变，因此会命中同一幂等键：

```sql
INSERT INTO extraction_runs
  (conversation_id, start_sequence, end_sequence, extractor_version, status)
VALUES ($1, $2, $3, $4, 'running')
ON CONFLICT (conversation_id, start_sequence, extractor_version)
DO UPDATE SET status = 'running', error = NULL, finished_at = NULL
WHERE extraction_runs.status IN ('failed', 'pending');
```

```text
【必须】 ON CONFLICT 的 DO UPDATE 必须带 WHERE 条件限定可复用的状态。

  否则一次成功的抽取会被后续同起点的触发覆盖，
  导致「已经抽过的区间被重新执行」——正是幂等键要防止的事。
```

## 11.5 触发条件

V1.0 不依赖「对话结束」（流式场景下该时刻不可判定），改为满足任一条件即触发：

```text
① 对话空闲超过 N 分钟（默认 5）
② 未抽取的消息数达到 M 条（默认 10）
     未抽取数 = 会话最大 sequence − (MAX(end_sequence) WHERE succeeded)
③ 用户显式请求（「记住这个」）
④ 会话被归档 / 被关闭

对 POST /chat/stream：
  以「本轮 assistant 消息完整落库」为抽取边界，
  end_sequence 取本轮最后一条消息的 sequence。
```

## 11.6 status

```text
pending     已登记，未执行
running     执行中
succeeded   成功
failed      失败（可重试，重试时复用同一幂等键，见 §11.4）
skipped     已跳过（如用户关闭了 auto_extract）
```

```sql
CHECK (status IN ('pending','running','succeeded','failed','skipped'))
```

## 11.7 用途

```text
① 幂等：同一个 (conversation, start_sequence, version) 只抽一次
② 进度：由 succeeded 记录的 MAX(end_sequence) 推进（§11.4）
③ 进度查询：前端可显示「正在整理记忆…」
④ 离线评测：确定抽取是否已完成，作为评测的前置条件
⑤ 质量回溯：memories_created / conflicts_found 的时间序列，用于观察记忆质量趋势
⑥ 失败重试：failed 状态的记录可安全重跑
```

---

# 12. conversation_summaries

## 12.1 用途

保存长对话的阶段性摘要，避免把整个 Conversation 永久塞进 LLM Context。

## 12.2 字段设计

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | UUID | PK | 主键 |
| conversation_id | UUID | FK → conversations(id), NOT NULL | 会话 |
| summary | TEXT | NOT NULL | 摘要内容 |
| sequence_from | BIGINT | NOT NULL | 覆盖起始序号（含） |
| sequence_to | BIGINT | NOT NULL | 覆盖结束序号（含） |
| summarizer_version | VARCHAR(50) | NOT NULL | 摘要器版本 |
| status | VARCHAR(20) | NOT NULL DEFAULT 'active' | active / stale |
| created_at | TIMESTAMPTZ | NOT NULL | 创建时间 |

> 🟡 C18：V1.0 字段名为 `start_sequence` / `end_sequence`，与 `extraction_runs` 重名易混淆，本版改为 `sequence_from` / `sequence_to` 并在文档中统一术语。同时新增 `summarizer_version` 与 `status`。

## 12.3 生成策略

```text
触发条件：
  未摘要消息 > T 条（默认 30）或 > X tokens（默认 4000）
      ↓
  对最早的 M 条（默认 20）生成一段摘要

幂等键：
  UNIQUE (conversation_id, sequence_from, sequence_to)

失效：
  被覆盖的消息被删除时，摘要置 status='stale'，触发重新生成
```

```sql
CREATE UNIQUE INDEX uq_summaries_range
  ON conversation_summaries (conversation_id, sequence_from, sequence_to);
```

## 12.4 上下文拼接顺序

```text
System Prompt
  → User Profile / settings
  → 会话摘要（按时间正序，注明「以下是更早对话的摘要」）
  → 最近 N 条原文消息
  → Relevant Memories
  → 当前用户消息
```

摘要必须位于最近消息**之前**，否则模型会误判时间顺序。

---

# 13. memories

**这是 LifeMate 最重要的数据表。**

## 13.1 核心设计原则（V1.1 强化）

```text
【必须】 记忆的「事实内容」不可变。

  信息发生变化时：
    创建新记忆 + 将旧记忆标记为 superseded（写 valid_until + superseded_by）

  理由：
    ① 「用户过去住在广州」本身是一个需要被记住的历史事实
    ② 就地更新会让 valid_from 语义二义（是记录时间还是事实时间？）
    ③ 时间线与「我之前什么时候开始想做这个项目」依赖历史可还原
```

> 🟡 C25：**「不可变」的确切范围（审计 F-07）。**
>
> 原文写「记忆是不可变事实」，容易被误读为「整行不可变」，进而导致去重合并无法记录 `source_count`。精确边界如下：

```text
❌ 不可变字段（创建后禁止 UPDATE，改动即需新建记忆）
     content
     type
     subject_key / predicate_key / object_value / polarity
     valid_from
     created_at

✅ 允许更新字段（反映系统对同一事实的「认知」变化，不改变事实本身）
     source_count          被再次提到的次数（去重合并时 +1）
     confidence_score      置信度调整
     importance_score      重要性重估
     updated_at            认知更新时间
     status / valid_until / superseded_by    状态流转（见 §13.5）
     deleted_at            删除标记

判断准则：
  改这些字段不改变「用户说的是什么事实」，只改变「系统对它的判断」。
  一旦需要改动 content 的语义，就必须新建记忆（supersede），不得就地修改。
```

## 13.2 双时间轴模型

```text
                   事实时间（业务）          记录时间（系统）
                ┌──────────────────┐   ┌──────────────────┐
   记忆 A       │ valid_from       │   │ created_at        │
   「住广州」   │ 2026-01-01       │   │ 2026-01-05        │
                │ valid_until      │   │ updated_at        │
                │ 2026-09-10       │   │ 2026-09-10        │
                └──────────────────┘   └──────────────────┘
                          │
                          │ superseded_by
                          ▼
   记忆 B       valid_from  2026-09-10
   「住深圳」   valid_until NULL（当前有效）
```

两条时间轴回答两个不同的问题：

| 轴 | 字段 | 回答的问题 |
| ---- | ---- | ---- |
| 事实时间 | `valid_from` / `valid_until` | 这件事在现实中什么时候到什么时候成立？ |
| 记录时间 | `created_at` / `updated_at` | 系统是什么时候知道的？ |

两者可以不同。例如用户 2026-03 才告诉系统「我 2026-01 就搬到深圳了」，则 `valid_from=2026-01-01` 而 `created_at=2026-03-xx`。

## 13.3 字段设计

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | UUID | PK | 主键 |
| user_id | UUID | FK → users(id), NOT NULL | 用户 |
| type | VARCHAR(20) | NOT NULL, CHECK | 记忆类型 |
| content | TEXT | NOT NULL | 记忆正文（展示给用户） |
| subject_key | VARCHAR(100) | | 规范化主体（Q2） |
| predicate_key | VARCHAR(100) | | 规范化槽位，来自受控词表（Q2） |
| object_value | TEXT | | 规范化取值（Q2） |
| polarity | VARCHAR(10) | | affirm / deny（Q2） |
| importance_score | REAL | NOT NULL DEFAULT 0.5 | 重要性 |
| confidence_score | REAL | NOT NULL DEFAULT 1.0 | 置信度 |
| status | VARCHAR(20) | NOT NULL DEFAULT 'active' | 状态 |
| valid_from | TIMESTAMPTZ | | 事实生效时间 |
| valid_until | TIMESTAMPTZ | | 事实失效时间 |
| superseded_by | UUID | **无外键**（见下） | 被哪条记忆替代 |
| source_count | INTEGER | NOT NULL DEFAULT 1 | 来源计数（去重合并时递增） |
| created_at | TIMESTAMPTZ | NOT NULL | 记录时间 |
| updated_at | TIMESTAMPTZ | NOT NULL | 记录更新时间 |
| deleted_at | TIMESTAMPTZ | | 软删除时间 |

> 🔴 C1 / 🟠 C2：新增 `superseded_by`、`subject_key`、`predicate_key`、`object_value`、`polarity`、`source_count`。

> 🔴 C23：**`superseded_by` 刻意不加外键约束（审计 F-04）。**
>
> V1.1 初稿写作 `REFERENCES memories(id) ON DELETE SET NULL`，与约束 `chk_memories_superseded` 直接冲突：
>
> ```text
> 记忆 A：status='superseded', superseded_by='B'     ✅ 满足约束
> 物理删除 B → A.superseded_by 被 SET NULL
>            → status 仍为 'superseded'
>            → 约束要求 superseded_by IS NOT NULL，违约
>            → 整个 DELETE 被回滚
>
> 实测确认：CHECK constraint failed（见审计报告 §0.4 实验组 A2）
> ```
>
> 后果：§24.4 承诺的「永久删除」与架构 §37 承诺的「删除全部个人数据」**都无法执行**。
>
> **决定：保留为纯历史指针，不加外键。**
>
> ```text
> 理由：
>   ① 它回答「这条记忆被谁替代了」——即使替代者已被删除，
>      这个历史事实依然成立（只是指向一条不存在的记录）
>   ② 强制引用完整性会阻止合法的删除操作
>   ③ 应用层可容忍悬空引用：UI 显示「（替代者已删除）」即可
>   ④ 链条断裂不导致数据错误，只损失一点可解释性
>
> 实现要求：
>   遍历替代链时必须容忍断层，不得假设 superseded_by 一定可解析。
> ```

## 13.4 type

```text
fact          相对稳定的个人事实
preference    个人偏好
event         发生过的事情
goal          目标（注意：见 §13.10 的特殊约束）
relationship  人物及关系
state         阶段性状态
```

```sql
CHECK (type IN ('fact','preference','event','goal','relationship','state'))
```

## 13.5 status 与状态转移

V1.0 只有 `status`（4 值）而没有状态转移表，导致 `status` / `valid_until` / `deleted_at` 三者语义重叠、无法判断优先级。V1.1 明确如下。

**唯一真相来源规则：**

```text
status          表达「系统如何处置这条记忆」
valid_until     表达「这个事实在现实中何时失效」
deleted_at      表达「用户是否要求删除」

判定「当前有效」不看 status 单独一个字段，而看组合谓词（见 §13.6）。
```

**状态转移表：**

| 目标状态 | status | valid_until | superseded_by | deleted_at | 是否被召回 | 触发者 |
| ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| 当前有效 | `active` | NULL | NULL | NULL | ✅ | 抽取 / 用户新建 |
| 已被替代 | `superseded` | 非空 | 非空 | NULL | ❌ | 冲突解决流程 |
| 已归档 | `archived` | 非空 | NULL | NULL | ❌ | 长期未使用降级 |
| 已删除 | `deleted` | 保持原值 | 保持原值 | 非空 | ❌ | 用户操作 |

```sql
CHECK (status IN ('active','superseded','archived','deleted'))
CHECK (status <> 'superseded' OR superseded_by IS NOT NULL)
CHECK (status <> 'deleted' OR deleted_at IS NOT NULL)
```

## 13.6 「当前有效记忆」的判定谓词

```text
【必须】 所有面向用户的召回、列表、统计，统一使用以下谓词：

  status = 'active'
  AND deleted_at IS NULL
  AND valid_until IS NULL
  AND superseded_by IS NULL
```

**实现要求：** 该谓词必须在 Repository 层定义一次并被全局复用，**禁止在业务代码里手写**（否则必然漏，导致已删除记忆仍被召回）。

历史查询（时间线回溯）使用不同谓词：

```sql
-- 查询「在某个时间点上成立的事实」
WHERE valid_from <= $at AND (valid_until IS NULL OR valid_until > $at)
  AND deleted_at IS NULL
```

## 13.7 槽位字段与受控词表（Q2）

**为什么需要：** 冲突判定的最小单位不是「一条记忆文本」，而是**同一槽位上的两个取值**。

```text
记忆 A：用户住在广州         句子相似度高 → 但和「搬到深圳」是冲突的
记忆 B：用户已经搬到深圳

记忆 C：用户计划学习 Python
记忆 D：用户现在主要使用 TS   句子相似度也高 → 但两者可以共存
```

向量相似度无法区分这两种情况（「相似」与「矛盾」是正交维度）。有槽位信息后，判定变为确定性流程。

**受控词表 v1（15～25 个高频槽位）：**

```text
residence.city                居住城市
residence.country             居住国家
employment.company            任职公司
employment.role               职位角色
education.school              就读学校
education.major               专业
skill.learning                正在学习的技能
interest.hobby                兴趣爱好
preference.food               饮食偏好
preference.communication_style 沟通风格偏好
health.status                 健康状态
habit.sleep                   作息习惯
habit.exercise                运动习惯
goal.long_term                长期目标
plan.near_term                近期计划
relationship.person           人际关系（object_value 存人名）
```

```text
【必须】
  ① predicate_key 必须是上表枚举值，不接受模型自由生成
  ② 词表之外的信息不参与冲突判定，只存储并记录到待补全队列
  ③ 宁可漏判，不可错判
```

**冲突判定流程（服务层，确定性）：**

```text
候选记忆
   │
   ├── 取 (user_id, subject_key, predicate_key) 相同 且 当前有效的已有记忆
   │
   ├── 无命中 ────────────────→ 新增
   │
   ├── object_value 相同/等价 ─→ 去重：source_count += 1,
   │                             confidence 取较优值, 更新 updated_at
   │                             不新增记录，不重算 embedding
   │
   ├── object_value 不同 ──────→ 交给 LLM 做「三选一」窄任务
   │                             ├─ 状态变化 → 旧记忆写 valid_until +
   │                             │              superseded_by，新记忆插入
   │                             ├─ 真正冲突 → 新记忆 confidence 降低，
   │                             │              标记待用户确认
   │                             └─ 可共存   → 检查 predicate 是否实际不同，
   │                                           修正后按「新增」处理
   │
   └── predicate_key 为空 ─────→ 只存储，不参与冲突判定
```

## 13.8 importance_score

范围 `0.0 ~ 1.0`，表示这条信息对长期理解用户的重要程度。

```text
用户喜欢某种零食                    0.2
用户正在学习 TypeScript             0.7
用户准备完成一个长期项目            0.9
```

影响：

- 检索优先级
- Context 注入优先级
- 是否进入「关键记忆摘要」

## 13.9 confidence_score

范围 `0.0 ~ 1.0`，表示系统认为这条记忆可靠的程度。

> **importance ≠ confidence**

```text
「用户准备明年创业」
importance = 0.9   （很重要）
confidence = 0.6   （但只是一个计划）
```

## 13.10 goals 与 memory(type='goal') 的边界

> 🟠 C9，对应评审 P0-5。

V1.0 允许 `memory.type='goal'` 又有独立的 `goals` 表，但未说明二者分工，实现时会出现两个写入入口。

**V1.1 明确：**

```text
goals 表              = 一等实体，有完整生命周期状态机
memory(type='goal')   = goals 的语义检索投影

【必须】
  ① 只允许 GoalService 在写入 goals 时同步生成/更新对应的 goal 投影记忆
  ② 抽取器不得直接创建 type='goal' 的记忆
  ③ 用户不可直接新建 type='goal' 的记忆（必须通过 Goal 实体）
  ④ 投影记忆的 memory_sources.source_type = 'goal_projection'
```

这样「目标」只有一个写入入口，而语义检索仍能命中它。

> 🔴 C24：**Goal 删除时的投影记忆处理（审计 F-03）。**
>
> 投影记忆的来源指针是 `goal_id`。若删除 Goal 时任由外键把它 `SET NULL`，来源约束 `chk_sources_has_origin` 会违约（`goal_projection` 不在豁免列表），**删除整个被回滚**。
>
> ```text
> 实测确认：CHECK constraint failed（见审计报告 §0.4 实验组 B1）
> ```
>
> **【必须】 删除 Goal 时的正确顺序：**
>
> ```text
> BEGIN
>   ① 将该 Goal 的投影记忆置为失效
>        UPDATE memories SET status='deleted', deleted_at=now()
>         WHERE id IN (
>           SELECT ms.memory_id FROM memory_sources ms
>            WHERE ms.goal_id = $1 AND ms.source_type='goal_projection'
>         );
>   ② 同步失效其 embedding
>        UPDATE memory_embeddings SET status='deleted'
>         WHERE memory_id IN (...);
>   ③ 删除来源记录
>        DELETE FROM memory_sources WHERE goal_id = $1;
>   ④ 删除 Goal
>        DELETE FROM goals WHERE id = $1;
> COMMIT
> ```
>
> **不要把 `goal_projection` 加进来源约束的豁免列表。** 那只是让违约消失，而「投影记忆失去目标」这个不一致状态会变成合法——比失败更糟。
>
> **`event_derived` 无需同样处理：** Event 默认软删除（`deleted_at`），
> `events` 行不会物理消失，因此 `event_id` 不会被置空。仅当用户要求
> 物理删除 Event 时才需要走同样的清理顺序。

## 13.11 索引

```sql
-- 「当前有效记忆」的部分唯一索引：同一槽位在同一时间只能有一条当前有效记忆
CREATE UNIQUE INDEX uq_memories_current_slot
  ON memories (user_id, subject_key, predicate_key)
  WHERE status = 'active'
    AND deleted_at IS NULL
    AND valid_until IS NULL
    AND superseded_by IS NULL
    AND predicate_key IS NOT NULL;

-- 常用查询
CREATE INDEX idx_memories_user_status_type ON memories (user_id, status, type);
CREATE INDEX idx_memories_user_updated     ON memories (user_id, updated_at DESC);
CREATE INDEX idx_memories_slot             ON memories (user_id, subject_key, predicate_key);
CREATE INDEX idx_memories_type_time        ON memories (user_id, type, valid_from DESC);

-- 关键词检索（见 §17.4）
CREATE INDEX idx_memories_content_trgm
  ON memories USING gin (content gin_trgm_ops);
```

---

# 14. memory_embeddings

## 14.1 用途

保存 Memory 对应的向量。

## 14.2 为什么单独建表

而不是 `memories.embedding`：

```text
Memory
   │
   ├── Embedding Model A（bge-m3）
   ├── Embedding Model B（未来升级）
   └── Embedding Model C（备选）
```

这样可以在不破坏 Memory 本身的前提下重新生成向量、平滑迁移模型。

## 14.3 字段设计

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | UUID | PK | 主键 |
| memory_id | UUID | FK → memories(id) ON DELETE CASCADE, NOT NULL | Memory |
| model | VARCHAR(100) | NOT NULL | Embedding 模型标识 |
| dim | INTEGER | NOT NULL | 维度（冗余记录，防御性） |
| embedded_text | TEXT | NOT NULL | 被向量化的确切文本快照 |
| content_hash | VARCHAR(64) | NOT NULL | `hash(embedded_text)`，用于陈旧检测 |
| embedding | VECTOR(1024) | NOT NULL | 向量 |
| status | VARCHAR(20) | NOT NULL DEFAULT 'ready' | ready / stale / failed / deleted |
| created_at | TIMESTAMPTZ | NOT NULL | 创建时间 |

> 🔴 C3 / 🟠 C4：V1.0 只有 `id / memory_id / embedding / model / created_at`，缺 `dim`、`embedded_text`、`content_hash`、`status`，导致**无法检测陈旧向量**。

## 14.4 唯一约束

```sql
CREATE UNIQUE INDEX uq_embeddings_memory_model
  ON memory_embeddings (memory_id, model);

CREATE INDEX idx_embeddings_status ON memory_embeddings (status);
```

```text
【必须】 没有 (memory_id, model) 唯一约束时，
         重复向量会导致同一记忆被多次召回，且难以排查。
```

## 14.5 embedded_text 的构成

这是一个**效果决策**，必须在实现前确定。

```text
embedded_text = "{type}｜{主体}｜{content}｜{时间提示}"

示例：
"fact｜用户｜用户住在广州｜2026-01-01 起有效"
"preference｜用户｜用户喜欢直接、具体的技术解释"
"state｜用户｜用户最近工作状态比较疲惫｜2026-09-10"
```

**为什么把 type 与时间并入向量文本：** 只嵌入 `content` 时，「广州」这个词本身不带类型与时间信息，导致「用户住在广州」与「用户去广州出差」在向量空间里非常接近。加上 `type` 与时间提示能显著改善区分度。

> 🟡 C27（审计 F-11）：**`model` 的取值规范。**
>
> ```text
> 【必须】 memory_embeddings.model 一律使用 HuggingFace 完整模型 ID：
>
>     BAAI/bge-m3
>
> ❌ 不要写 'bge-m3'（短名）
>
> 理由：
>   ① 与 .env 的 EMBEDDING_MODEL 及 docker-compose 的 --model-id 一致，无需转换
>   ② 未来切换 provider 时不会与本地路径混淆
>
> 后果警示：写入时用 'BAAI/bge-m3'、检索时过滤 'bge-m3'，
>   JOIN 条件会静默失配，检索永远返回空结果且不报错。
>   这类「功能看似正常但永远召回不到东西」的问题极难排查。
>
> 实现要求：该值必须来自单一常量（如 EMBEDDING_MODEL_ID），
>   不得在检索、写入、评测等多处手写字面量。
> ```

## 14.6 陈旧向量的检测与修复

> 🟠 C4 的配套。这是 V1.0 完全缺失的机制。

```text
写入路径（统一在 Service 层）：

  memory.content 变化
      ↓
  计算 hash(embedded_text)
      ↓
  与 memory_embeddings.content_hash 比较
      ├── 相同 → 不动（避免无谓的 API/GPU 开销）
      └── 不同 → 置 status='stale'，投递重嵌入任务

检索路径：

  只召回 status='ready' 的向量
  若某条高分记忆的向量为 stale，
    则降低其 confidence 并在日志中告警

恢复路径：

  重嵌入完成后置 status='ready' 并更新 content_hash
```

```text
【必须】 缺少 content_hash 时，任何绕过服务层的写入、
         任何重试、任何数据迁移都会静默留下过期向量，
         而检索会照常返回它们 —— 这是最难定位的一类记忆质量事故。
```

## 14.7 status

```text
ready     向量可用，参与召回
stale     正文已变，向量过期，不参与召回
failed    嵌入失败，可重试
deleted   对应记忆已删除
```

```sql
CHECK (status IN ('ready','stale','failed','deleted'))
```

---

# 15. memory_sources

## 15.1 用途

Memory 必须知道「这条记忆是从哪里来的」。

这是 LifeMate 与普通「聊天历史搜索」的重要区别，也是产品信任感的核心。

## 15.2 字段设计

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | UUID | PK | 主键 |
| memory_id | UUID | FK → memories(id) ON DELETE CASCADE, NOT NULL | Memory |
| source_type | VARCHAR(20) | NOT NULL | 来源类型 |
| message_id | UUID | FK → messages(id) ON DELETE RESTRICT | 来源消息 |
| event_id | UUID | FK → events(id) ON DELETE SET NULL | 来源事件 |
| goal_id | UUID | FK → goals(id) ON DELETE SET NULL | 来源目标 |
| created_at | TIMESTAMPTZ | NOT NULL | 创建时间 |

> 🔴 C22：**V1.1 初稿曾有一个 `conversation_id` 冗余字段，已删除。**
> 它与来源约束的 `SET NULL` 行为冲突，会导致删除会话时整个 `DELETE` 被回滚（审计 F-02）。
> 该字段本可由 `message_id → messages.conversation_id` 推出，属冗余。
> 按会话反查记忆改用 JOIN，见 §15.4。

> 🟠 C12：V1.0 仅有 `memory_id` / `message_id` / `source_type` / `created_at`，无法表达记忆来自 Event / Goal，也没有索引与外键行为定义。

## 15.3 source_type

```text
conversation        从对话抽取（主路径）
manual              用户手工创建或修改
system              系统推导（如冲突解决时生成的新记忆）
goal_projection     Goal 的投影记忆（见 §13.10）
event_derived       从 Event 派生
```

```sql
CHECK (source_type IN ('conversation','manual','system','goal_projection','event_derived'))
```

## 15.4 约束与索引

```sql
-- 同一 (memory, message) 不重复
CREATE UNIQUE INDEX uq_memory_sources_memory_message
  ON memory_sources (memory_id, message_id)
  WHERE message_id IS NOT NULL;

-- 支撑「删除会话时反查派生记忆」（见 §24）
CREATE INDEX idx_memory_sources_message ON memory_sources (message_id);
CREATE INDEX idx_memory_sources_memory  ON memory_sources (memory_id);

-- 约束：至少有一个来源指针非空
CONSTRAINT chk_sources_has_origin
  CHECK (message_id IS NOT NULL OR event_id IS NOT NULL
         OR goal_id IS NOT NULL OR source_type IN ('manual','system'))
```

**按会话反查派生记忆（替代已删除的 `conversation_id` 字段）：**

```sql
-- 删除会话时，先找出受影响的记忆（§24.3 第 ① 步）
SELECT DISTINCT ms.memory_id
  FROM memory_sources ms
  JOIN messages m ON m.id = ms.message_id
 WHERE m.conversation_id = $1;
```

> 💡 该查询走 `idx_memory_sources_message` + `messages` 的主键索引，性能足够。
> **冗余字段换来的不是必要性，而是上文 F-02 那个约束冲突。**

```text
【必须】 message_id 的外键行为为 ON DELETE RESTRICT 而非 CASCADE。

  理由：删除消息时必须先由服务层决定「派生记忆如何处理」（见 §24），
        静默级联会绕过这个决策，导致用户的删除意图未被尊重。
```

```text
【必须】 来源约束的三个后果必须一起理解（审计 F-02 / F-03 的教训）：

  ① 任何 ON DELETE SET NULL 都会触发一次 UPDATE，
     而该 UPDATE 会重新校验 chk_sources_has_origin —— 可能违约
  ② 因此 event_id / goal_id 的引用方必须保证：
     删除 Event / Goal 时，先按 §24 处理好依赖的记忆与来源记录
  ③ 新增任何指向本表的外键时，必须重新做一次上面的布尔求值
```

## 15.5 用户可见的效果

```text
记忆：
用户正在学习 TypeScript。

来源：
2026-09-10 某次对话        ← 可点击跳转到原始对话
```

未来可做到：点击记忆 → 跳转到原始对话。

若原始对话已被删除，必须显式显示「原始对话已删除」，而不是空白或错误。

---

# 16. metadata 与 JSONB 使用规范

> 🟠 对应评审 P2-13。

## 16.1 允许使用 JSONB 的字段

```text
users.settings
messages.metadata
```

## 16.2 明确禁止

```text
❌ 任何需要被 SQL 查询 / 过滤 / 排序的业务字段
❌ 任何级别的敏感正文副本（message content、memory content）
❌ 任何有唯一性要求的数据
```

## 16.3 强制手段

```text
【必须】
  ① 写入前用 Zod schema 校验 JSONB 结构
  ② 白名单模式（只允许已知键），不是黑名单过滤
  ③ JSONB 同样受 §21 的日志脱敏约束
```

---

# 17. 索引设计

## 17.1 users

```sql
PRIMARY KEY (id)
```

## 17.2 conversations

```sql
CREATE INDEX idx_conversations_user_updated ON conversations (user_id, updated_at DESC);
CREATE INDEX idx_conversations_user_status  ON conversations (user_id, status);
```

用于：查询用户最近的会话、按状态过滤。

## 17.3 messages

```sql
CREATE UNIQUE INDEX uq_messages_conversation_sequence ON messages (conversation_id, sequence);
CREATE INDEX idx_messages_sequence   ON messages (conversation_id, sequence DESC);
CREATE INDEX idx_messages_created_at ON messages (conversation_id, created_at);
```

## 17.4 memories

```sql
CREATE UNIQUE INDEX uq_memories_current_slot ON memories (user_id, subject_key, predicate_key)
  WHERE status = 'active' AND deleted_at IS NULL AND valid_until IS NULL
    AND superseded_by IS NULL AND predicate_key IS NOT NULL;

CREATE INDEX idx_memories_user_status_type ON memories (user_id, status, type);
CREATE INDEX idx_memories_user_updated     ON memories (user_id, updated_at DESC);
CREATE INDEX idx_memories_slot             ON memories (user_id, subject_key, predicate_key);
CREATE INDEX idx_memories_type_time        ON memories (user_id, type, valid_from DESC);

-- 关键词检索：pg_trgm（见 §18.5）
CREATE INDEX idx_memories_content_trgm
  ON memories USING gin (content gin_trgm_ops);
```

> 🟠 C16：V1.0 明确要求混合检索的 Keyword 通道，但索引清单中没有任何全文检索索引，且中文场景下 PostgreSQL 默认全文检索不支持中文分词。V1.1 决定使用 `pg_trgm`。

> 🟡 C28：**`uq_memories_current_slot` 的适用范围（审计 F-13）。**
>
> 该索引带 `predicate_key IS NOT NULL` 条件，因此**无槽位的记忆完全不受唯一性约束**（`memories` 里 `predicate_key = NULL` 的行）。
>
> ```text
> 这是设计意图，不是漏洞：
>   ① 无法判断两条无槽位记忆是否在讲同一个事实
>   ② 强行约束会导致合法的不同事实被拒绝写入
>
> 代价（必须知道）：
>   无槽位记忆的重复由抽取器的语义判重负责，数据库不兜底。
>   因此 Memory Noise 指标需要把「有槽位」与「无槽位」分开统计 ——
>   有槽位的重复是数据库级缺陷（可直接告警），
>   无槽位的重复是抽取质量问题（需靠评测集发现）。
> ```

**为什么用 `pg_trgm` 而不是 `tsvector`：**

```text
中文场景下 PostgreSQL 默认的全文检索配置不支持中文分词，
直接使用 plainto_tsquery 会得到「关键词通道形同虚设」的结果。

pg_trgm 按字符三元组匹配，无需分词器，适合记忆这种短文本（1～2 句）。

V2 若需要更好的关键词效果，可在应用层分词后写入 tsvector。
```

## 17.5 memory_embeddings

```sql
CREATE UNIQUE INDEX uq_embeddings_memory_model ON memory_embeddings (memory_id, model);
CREATE INDEX idx_embeddings_status ON memory_embeddings (status);
```

## 17.6 extraction_runs

```sql
CREATE UNIQUE INDEX uq_extraction_idempotency
  ON extraction_runs (conversation_id, start_sequence, extractor_version);

CREATE INDEX idx_extraction_conversation ON extraction_runs (conversation_id, created_at DESC);
CREATE INDEX idx_extraction_pending
  ON extraction_runs (status) WHERE status IN ('pending','running','failed');
```

## 17.7 conversation_summaries

```sql
CREATE UNIQUE INDEX uq_summaries_range
  ON conversation_summaries (conversation_id, sequence_from, sequence_to);
```

## 17.8 events

```sql
CREATE INDEX idx_events_user_time     ON events (user_id, event_time DESC);
CREATE INDEX idx_events_user_category ON events (user_id, category);
CREATE INDEX idx_events_timeline
  ON events (user_id, event_time DESC)
  WHERE timeline_visible = true AND deleted_at IS NULL;
```

## 17.9 goals

```sql
CREATE INDEX idx_goals_user_status ON goals (user_id, status);
```

## 17.10 relationships

```sql
CREATE INDEX idx_relationships_user_status ON relationships (user_id, status);
CREATE UNIQUE INDEX uq_relationships_user_name
  ON relationships (user_id, name) WHERE deleted_at IS NULL;
```

## 17.11 memory_sources

```sql
CREATE UNIQUE INDEX uq_memory_sources_memory_message
  ON memory_sources (memory_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_memory_sources_message ON memory_sources (message_id);
CREATE INDEX idx_memory_sources_memory  ON memory_sources (memory_id);
```

---

# 18. 向量检索

## 18.1 V1.0 不建向量索引

> 🟠 C6。**这是 V1.1 的一个重要简化。**

pgvector 默认执行**精确最近邻搜索**（顺序扫描），召回率 100%。索引（HNSW / IVFFlat）是用召回率换速度。

数据量估算：

```text
单用户数年积累 < 50,000 条记忆
50,000 × 1024 维 × 4 字节 ≈ 200 MB
精确扫描 200 MB（已缓存于内存）→ 几十毫秒
```

结论：

```text
【V1.0 决定】 不创建 HNSW / IVFFlat 索引。

  ① 数据量下精确检索足够快
  ② 召回率 100%，避免「加了索引反而漏召回」的隐蔽问题
  ③ 避免 HNSW 的构建参数调优（ef_construction / m）与内存开销
  ④ 符合「避免 V1.0 过度设计」原则
```

**何时引入索引：**

```text
当记忆条数 > 50,000，或精确检索 p95 > 200 ms 时，
再创建 HNSW 索引（见 §18.6）。
```

## 18.2 检索流程

```text
User Query
     │
     ▼
Embedding（bge-m3）
     │
     ▼
pgvector 精确检索（按 §18.3 的过滤条件）
     │
     ▼
Candidate Memories（Top-50）
     │
     ▼
关键词通道（pg_trgm，Top-50）
     │
     ▼
RRF 融合
     │
     ▼
重排（归一化加权）
     │
     ▼
Top-N（默认 8）+ token 预算裁剪
```

## 18.3 检索过滤条件

> 🟠 C14，对应评审 P1-2。

```text
【必须】 所有召回路径（向量 / 关键词 / 结构化 / 重排）
         在 SQL 层面统一包含以下条件：

  user_id = $1
  AND status = 'active'
  AND deleted_at IS NULL
  AND valid_until IS NULL
  AND superseded_by IS NULL
```

**实现要求：**

```text
该条件必须在 Repository 层定义为单一常量 / 单一查询片段，
被检索、列表、统计、离线评测脚本共同引用。

❌ 禁止在业务代码里手写过滤条件
   （否则必然漏，导致已删除记忆仍被召回 —— 这是隐私事故）
```

参考查询：

```sql
SELECT m.id, m.content, m.type, m.importance_score,
       1 - (e.embedding <=> $1::vector) AS similarity
  FROM memories m
  JOIN memory_embeddings e ON e.memory_id = m.id
 WHERE m.user_id = $2
   AND m.status = 'active'
   AND m.deleted_at IS NULL
   AND m.valid_until IS NULL
   AND m.superseded_by IS NULL
   AND e.status = 'ready'
   AND e.model = 'BAAI/bge-m3'
 ORDER BY e.embedding <=> $1::vector
 LIMIT 50;
```

## 18.4 混合检索的评分

> 🟠 对应评审 P0-4。

V1.0 的公式 `语义×w1 + 重要性×w2 + 时效×w3 + 相关性×w4` 有三个问题：关键词通道无对应项、量纲不同无法相加、时效项一刀切会伤害长期记忆。

**V1.1 改为两阶段：**

**阶段一：RRF 融合（只依赖排名，不依赖分数分布，绕开量纲问题）**

```text
各通道独立取 Top-50：
  ├── 向量通道
  ├── 关键词通道（pg_trgm）
  └── 结构化通道（type / predicate_key / 时间窗过滤）

RRF 融合：
  score = Σ 1 / (k + rank_i)        k = 60（常量）

取 Top-30 进入重排
```

**阶段二：归一化加权重排**

```text
final = 0.55 × norm(vector_score)
      + 0.20 × importance_score
      + 0.15 × type_aware_recency
      + 0.10 × source_count_signal

所有权重集中在单一配置文件，由离线评测脚本调优。
```

**按类型区分的时效项：**

```text
type_aware_recency:
  fact       → 1.0                        （不衰减）
  preference → 0.5 + 0.5 × decay(t)
  goal       → 1.0 if status=active else 0
  event      → 1.0                        （不降权，按时间排序即可）
  state      → decay(t, 半衰期 14 天)      （快速衰减）
  relationship → 1.0                      （不衰减）
```

```text
【重要】 fact 类不衰减。
  两年前的「用户是软件工程师」依然有效，
  不应因为「旧」被系统性降权 —— 这与长期记忆的产品定位直接冲突。
```

## 18.5 注入预算

```text
【必须】 检索与注入分离，注入受 token 预算约束：

  MemoryRetrievalService.search(query, options) → Memory[]   （纯检索，可离线评测）
  ContextBuilder.inject(memories, budget)       → 上下文片段

  默认注入 Top-8，预算 ≤ 2000 tokens
  超出时按重排分数从低到高裁剪
```

## 18.6 未来引入 HNSW 的参考

```sql
-- 数据量增长后再执行
CREATE INDEX CONCURRENTLY idx_embeddings_hnsw
  ON memory_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
```

注意事项（来自 pgvector 官方文档）：

```text
① 过滤条件下 HNSW 会先扫索引再过滤，
   若过滤比例高则召回率下降，需启用迭代扫描：
     SET hnsw.iterative_scan = strict_order;
② 建议在数据加载完成后建索引，并提高 maintenance_work_mem
③ 可用 SET LOCAL hnsw.ef_search = 100 提升召回
```

---

# 19. 约束设计

> 🟠 C13 新增章节。对应评审 P1-8。

V1.0 只有字段类型，没有任何 `CHECK` / `NOT NULL` / `UNIQUE` 定义。实现时 Drizzle schema 通常也不会自动补 CHECK，最终靠应用层自觉——而应用层是最不可靠的一层（脚本、迁移、手工修数据都会绕过）。

## 19.1 枚举约束

```sql
ALTER TABLE conversations      ADD CONSTRAINT chk_conversations_status
  CHECK (status IN ('active','archived','deleted'));
ALTER TABLE messages           ADD CONSTRAINT chk_messages_role
  CHECK (role IN ('user','assistant','system','tool'));
ALTER TABLE memories           ADD CONSTRAINT chk_memories_type
  CHECK (type IN ('fact','preference','event','goal','relationship','state'));
ALTER TABLE memories           ADD CONSTRAINT chk_memories_status
  CHECK (status IN ('active','superseded','archived','deleted'));
ALTER TABLE memories           ADD CONSTRAINT chk_memories_polarity
  CHECK (polarity IS NULL OR polarity IN ('affirm','deny'));
ALTER TABLE memory_embeddings  ADD CONSTRAINT chk_embeddings_status
  CHECK (status IN ('ready','stale','failed','deleted'));
ALTER TABLE extraction_runs    ADD CONSTRAINT chk_extraction_status
  CHECK (status IN ('pending','running','succeeded','failed','skipped'));
ALTER TABLE events             ADD CONSTRAINT chk_events_source_type
  CHECK (source_type IN ('conversation','manual','system'));
ALTER TABLE goals              ADD CONSTRAINT chk_goals_status
  CHECK (status IN ('active','paused','completed','cancelled','archived'));
ALTER TABLE memory_sources     ADD CONSTRAINT chk_sources_type
  CHECK (source_type IN ('conversation','manual','system','goal_projection','event_derived'));
```

## 19.2 取值范围

```sql
ALTER TABLE memories ADD CONSTRAINT chk_memories_importance
  CHECK (importance_score BETWEEN 0 AND 1);
ALTER TABLE memories ADD CONSTRAINT chk_memories_confidence
  CHECK (confidence_score BETWEEN 0 AND 1);
ALTER TABLE events   ADD CONSTRAINT chk_events_importance
  CHECK (importance_score BETWEEN 0 AND 1);
ALTER TABLE goals    ADD CONSTRAINT chk_goals_priority
  CHECK (priority BETWEEN 0 AND 1);
```

## 19.3 时间一致性

```sql
ALTER TABLE memories ADD CONSTRAINT chk_memories_valid_range
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from);

ALTER TABLE conversation_summaries ADD CONSTRAINT chk_summaries_range
  CHECK (sequence_to >= sequence_from);

ALTER TABLE extraction_runs ADD CONSTRAINT chk_extraction_range
  CHECK (end_sequence >= start_sequence);

-- 🟠 C26（审计 F-10）：goals 的时间顺序
-- 原先只有 memories / summaries / extraction_runs 有区间约束，goals 漏了，
-- 可以写入「目标时间早于开始时间」这类逻辑矛盾数据。
ALTER TABLE goals ADD CONSTRAINT chk_goals_time_order
  CHECK (
    (target_at    IS NULL OR started_at IS NULL OR target_at    >= started_at)
    AND
    (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
  );
```

## 19.4 状态与字段的一致性

```sql
-- superseded 必须指向替代者
ALTER TABLE memories ADD CONSTRAINT chk_memories_superseded
  CHECK (status <> 'superseded' OR superseded_by IS NOT NULL);

-- deleted 必须有删除时间
ALTER TABLE memories ADD CONSTRAINT chk_memories_deleted
  CHECK (status <> 'deleted' OR deleted_at IS NOT NULL);
ALTER TABLE conversations ADD CONSTRAINT chk_conversations_deleted
  CHECK (status <> 'deleted' OR deleted_at IS NOT NULL);
```

## 19.5 必填字段

```text
NOT NULL 字段清单（按表）：

conversations          id, user_id, status, created_at, updated_at
messages               id, conversation_id, role, content, sequence, metadata, created_at
memories               id, user_id, type, content, importance_score, confidence_score,
                       status, source_count, created_at, updated_at
memory_embeddings      id, memory_id, model, dim, embedded_text, content_hash,
                       embedding, status, created_at
memory_sources         id, memory_id, source_type, created_at
extraction_runs        id, conversation_id, start_sequence, end_sequence,
                       extractor_version, status, created_at
conversation_summaries id, conversation_id, summary, sequence_from, sequence_to,
                       summarizer_version, status, created_at
events                 id, user_id, title, event_time, source_type, timeline_visible, created_at
goals                  id, user_id, title, status, priority, created_at, updated_at
relationships          id, user_id, name, relation_type, status, created_at, updated_at
```

## 19.6 约束与文档的一致性要求

```text
【必须】 约束清单与 §13.5 的状态转移表保持一致。
         若状态转移表新增一个状态，必须同步更新 CHECK 约束。
```

---

# 20. events（含 Timeline）

## 20.1 V1.1 的关键简化

> 🔴 C7，对应评审 P0-5。

V1.0 同时存在 `events` 和 `timeline_events` 两张表，「职责不同」。但代价是：

```text
① 同一件事写两次，且文档在别处刚强调过要避免同类不一致
② timeline_events 若落后于 events，没有任何重建路径
   （因为部分 timeline 数据并非来自 events，来源不可判定）
③ event_id 是否可空未定义 —— 若可空，说明 timeline 有自己的数据源，
   那它就不是「视图」而是「第二真相」
④ 接口层对 /timeline 提供了完整写接口，等于把风险开放给用户操作
```

**V1.1 决定：删除 `timeline_events`，Timeline 成为 `events` 的查询视图。**

```text
events 表（唯一的真相）
   │
   └── Timeline = 查询，不是实体
         SELECT * FROM events
          WHERE user_id = $1
            AND timeline_visible = true
            AND deleted_at IS NULL
            AND event_time BETWEEN $2 AND $3
          ORDER BY event_time DESC;
```

好处：单一写入路径、无一致性风险、编辑即时生效、可随时重建。

## 20.2 字段设计

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | UUID | PK | 主键 |
| user_id | UUID | FK → users(id), NOT NULL | 用户 |
| title | VARCHAR(200) | NOT NULL | 事件名称 |
| description | TEXT | | 事件描述 |
| event_time | TIMESTAMPTZ | NOT NULL | 事件在现实中发生的时间 |
| category | VARCHAR(50) | | 分类：work / study / project / life / health |
| importance_score | REAL | NOT NULL DEFAULT 0.5 | 重要性 |
| source_type | VARCHAR(20) | NOT NULL DEFAULT 'conversation' | 来源类型 |
| source_message_id | UUID | FK → messages(id) ON DELETE SET NULL | 来源消息（可追溯） |
| timeline_visible | BOOLEAN | NOT NULL DEFAULT true | 是否出现在时间线 |
| created_at | TIMESTAMPTZ | NOT NULL | 创建时间 |
| updated_at | TIMESTAMPTZ | NOT NULL | 更新时间 |
| deleted_at | TIMESTAMPTZ | | 软删除时间 |

> 🟠 C8：新增 `source_type` / `source_message_id` / `timeline_visible` / `deleted_at`。

## 20.3 时间线效果

```text
2026-08
│
├── 开始工作
│
├── 开始独立负责项目
│
└── 完成某项任务

2026-09
│
├── 开始学习 TypeScript
│
├── 开始设计 LifeMate
│
└── 完成系统架构设计
```

Timeline 不是简单按照聊天记录排列，而是从生活事件角度组织用户的人生记录。

## 20.4 Memory 与 Event 的关系

V1.0 不强制绑定，二者允许独立存在：

```text
Memory
「用户正在学习 TypeScript」     → 不一定是一个 Event

Memory + Event + （Timeline）
「用户第一次完成 LifeMate MVP」  → 可以同时形成
```

关联通过 `memory_sources.event_id` 表达（见 §15.2），而不是把两种数据塞进一张表。

---

# 21. goals

## 21.1 用途

保存用户长期目标。

```text
学习 TypeScript
完成 LifeMate
提升技术能力
```

## 21.2 字段设计

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | UUID | PK | 主键 |
| user_id | UUID | FK → users(id), NOT NULL | 用户 |
| title | VARCHAR(200) | NOT NULL | 目标名称 |
| description | TEXT | | 目标描述 |
| status | VARCHAR(20) | NOT NULL DEFAULT 'active' | 状态 |
| priority | REAL | NOT NULL DEFAULT 0.5 | 优先级 |
| started_at | TIMESTAMPTZ | | 开始时间 |
| target_at | TIMESTAMPTZ | | 目标时间 |
| completed_at | TIMESTAMPTZ | | 完成时间 |
| created_at | TIMESTAMPTZ | NOT NULL | 创建时间 |
| updated_at | TIMESTAMPTZ | NOT NULL | 更新时间 |
| deleted_at | TIMESTAMPTZ | | 软删除时间 |

## 21.3 status

```text
active
paused
completed
cancelled
archived
```

## 21.4 与 memory(type='goal') 的关系

见 §13.10。摘要：

```text
goals                = 一等实体，唯一写入入口
memory(type='goal')  = 投影，仅供语义检索，由 GoalService 维护

【必须】 抽取器不得直接创建 type='goal' 的记忆。
```

---

# 22. relationships

## 22.1 用途

记录用户与其他人的关系。

```text
朋友
同事
家人
老师
合作伙伴
```

## 22.2 字段设计

| 字段 | 类型 | 约束 | 说明 |
| ---- | ---- | ---- | ---- |
| id | UUID | PK | 主键 |
| user_id | UUID | FK → users(id), NOT NULL | 用户 |
| name | VARCHAR(100) | NOT NULL | 对方名称 |
| relation_type | VARCHAR(50) | | 关系类型：family / friend / colleague / mentor / partner |
| description | TEXT | | 描述 |
| status | VARCHAR(20) | NOT NULL DEFAULT 'active' | active / ended / archived |
| created_at | TIMESTAMPTZ | NOT NULL | 创建时间 |
| updated_at | TIMESTAMPTZ | NOT NULL | 更新时间 |
| deleted_at | TIMESTAMPTZ | | 软删除时间 |

## 22.3 设计原则

V1.0 不建立复杂的人际关系图谱，暂时只保存上述字段。

未来如果需要，可以演化为：

```text
Person Entity
Relationship Graph
Knowledge Graph
```

但 V1.0 不做。

**与 memory 的连接：** 记忆中的「某人」通过 `predicate_key = 'relationship.person'` 且 `object_value = 人名` 关联到本表，而不是通过外键硬绑定。这样即使关系记录尚不存在，记忆也不会写失败。

---

# 23. 外键关系

```text
users
 │
 ├── conversations
 │       │
 │       ├── messages
 │       │      └── extraction_runs
 │       │
 │       └── conversation_summaries
 │
 ├── memories
 │       │
 │       ├── memory_embeddings
 │       │
 │       └── memory_sources
 │               │
 │               └──→ messages / events / goals（多态来源）
 │
 ├── events
 │
 ├── goals
 │
 └── relationships
```

## 23.1 外键行为汇总

| 外键 | 行为 | 理由 |
| ---- | ---- | ---- |
| conversations.user_id → users.id | RESTRICT | 用户不可静默删除 |
| messages.conversation_id → conversations.id | CASCADE | 消息随会话 |
| extraction_runs.conversation_id → conversations.id | CASCADE | 抽取记录随会话 |
| conversation_summaries.conversation_id → conversations.id | CASCADE | 摘要随会话 |
| memories.user_id → users.id | RESTRICT | |
| memory_embeddings.memory_id → memories.id | CASCADE | 向量随记忆 |
| memory_sources.memory_id → memories.id | CASCADE | 来源指针随记忆 |
| **memory_sources.message_id → messages.id** | **RESTRICT** | **必须先由服务层决定派生记忆的去向（§24）** |
| memory_sources.event_id → events.id | SET NULL | ⚠️ 见下方警告 |
| memory_sources.goal_id → goals.id | SET NULL | ⚠️ 见下方警告 |
| events.user_id → users.id | RESTRICT | |
| events.source_message_id → messages.id | SET NULL | 来源删除后事件保留 |
| goals.user_id → users.id | RESTRICT | |
| relationships.user_id → users.id | RESTRICT | |

> ⚠️ **`SET NULL` 不是「安全地失效」，而是「会触发 CHECK 重新校验」（审计 F-02/F-03 的教训）。**
>
> 上表两处 `SET NULL` 都作用于 `memory_sources` 的来源指针，而该表有约束
> `chk_sources_has_origin`（§15.4）。**任一指针被置空都可能使该约束违约，
> 导致整个删除语句回滚。**
>
> 因此使用这两条的删除路径**必须**先按 §24 清理依赖数据，不能依赖数据库级联。
>
> `memory_sources.conversation_id` 已按 C22 删除，不再存在该风险点。

```text
【必须】 memory_sources.message_id 使用 RESTRICT 而非 CASCADE。

  理由：用户删除对话时，「派生记忆是保留还是一并失效」是一个产品决策，
        不能被数据库静默决定。服务层必须先执行 §24 的策略，
        再删除消息。
```

---

# 24. 删除与级联策略

> 🟠 C15 新增章节。对应评审 P1-1。

## 24.1 为什么必须明确

```text
用户删除一段私密对话，是期望「这段内容不再存在」。

但由它派生的记忆会以「用户……（无来源）」的形式继续存在，
甚至继续被召回并出现在回答里 ——
这直接违背用户的删除意图，是隐私事故。
```

## 24.2 删除 Conversation 的两种语义

```text
① 级联失效（默认）
     - messages / summaries 软删除
     - 由这些消息派生的 Memory：
         若 memory_sources 全部指向被删消息 → 一并置 deleted
         若仍有其他来源                   → 保留，但移除指向被删消息的 source
     - 被失效 Memory 的 embedding 置 status='deleted'，不再参与召回
     - 返回给前端「本次删除了 N 条派生记忆」

② 仅删对话
     - 保留全部 Memory（适用于「只是想清理聊天列表」）
     - 前端需明确提示两种语义的差异
```

无论哪种，Memory Viewer 中来源不可解析时必须显式显示「原始对话已删除」。

## 24.3 服务层执行顺序

```text
BEGIN

  ① 找出受影响的记忆（经 messages JOIN，因 conversation_id 字段已删除，见 §15.4）
     SELECT DISTINCT ms.memory_id
       FROM memory_sources ms
       JOIN messages m ON m.id = ms.message_id
      WHERE m.conversation_id = $1;

  ② 对每条受影响记忆，统计其剩余有效来源数
     SELECT memory_id, COUNT(*) FROM memory_sources
      WHERE memory_id = ANY($2) AND message_id <> ALL($3)
      GROUP BY memory_id;

  ③ 无剩余来源者 → memories.status='deleted', deleted_at=now()
                     memory_embeddings.status='deleted'
     有剩余来源者 → DELETE 指向被删消息的 memory_sources 行

  ④ 删除 messages（此时 RESTRICT 外键已无阻碍）
     messages 软删除或物理删除，取决于配置

  ⑤ conversations.status='deleted', deleted_at=now()

COMMIT
```

```text
【必须】 顺序不可调换。

  若先删 messages 再处理 memory_sources，会立刻撞上
  message_id 的 ON DELETE RESTRICT 外键。
  而那个 RESTRICT 是刻意的设计（§15.4）——
  它强迫服务层先做出「派生记忆如何处置」的决策，
  而不是让数据库静默级联。
```

```text
【必须】 第 ① 步不要改写成「先删来源记录再反查」。

  来源记录（memory_sources）是「记忆从哪来」的唯一凭证。
  一旦先删掉它，就无法再判断某条记忆是否还有其他来源，
  第 ② 步的「剩余来源数」会全部变成 0，
  导致所有派生记忆被误判为「应一并删除」。
```

## 24.4 Memory 的软删除与物理删除

```text
默认：软删除（status='deleted', deleted_at=now()）

好处：
  - 防止误删
  - 支持恢复
  - 保留数据一致性
  - 便于调试

但是：

【必须】 用户明确要求永久删除时，系统必须提供真正的物理删除机制。
         删除时必须同时清理：
           memories
           memory_embeddings
           memory_sources
         并在同一事务内完成。
```

## 24.5 软删除的检索侧语义

见 §18.3。核心要求重申：

```text
【必须】 deleted_at IS NOT NULL 或 status='deleted' 的记录，
         必须同时从以下路径排除：
           ✓ 向量召回
           ✓ 关键词召回
           ✓ 结构化查询
           ✓ 列表与统计
           ✓ 离线评测脚本（避免评测与线上不一致）
           ✓ memory_embeddings（status='deleted'）
```

---

# 25. 数据一致性原则

## 25.1 必须使用事务的操作

```text
① 记忆替代（冲突解决）
     BEGIN
       INSERT 新记忆
       UPDATE 旧记忆 SET valid_until, superseded_by, status='superseded'
       INSERT memory_sources
     COMMIT

② 记忆去重合并
     BEGIN
       UPDATE memories SET source_count = source_count + 1,
                           confidence_score = GREATEST(...),
                           updated_at = now()
       INSERT memory_sources
     COMMIT

③ 记忆删除（级联，见 §24.3）

④ 消息写入（含 sequence 分配，见 §10.4）

⑤ 抽取登记（extraction_runs 插入 + 状态流转）
```

## 25.2 事务与 embedding 的关系

```text
【必须】 生成 embedding 是外部调用（GPU 推理），不能在数据库事务内完成。

  正确顺序：
    ① 事务 A：写入记忆 + 标记 embedding 为 pending/stale
    ② 事务外：调用 bge-m3 生成向量
    ③ 事务 B：写入 memory_embeddings

  失败处理：
    ② 失败 → 记忆保留，embedding 状态为 failed，由重试任务补齐
             记忆仍可用关键词通道召回（降级但可用）
```

## 25.3 Embedding 更新策略

```text
memory.content（或 embedded_text 任一组成项）发生变化时：

  content changed
        ↓
  重新计算 embedded_text
        ↓
  比较 content_hash
        ├── 相同 → 不重算
        └── 不同 → 置 stale → 重新生成 → 更新 content_hash + status='ready'

【必须】 embedding 必须始终对应当前 memory 内容。
```

---

# 26. 数据生命周期

```text
Conversation
     │
     ▼
Message
     │
     ▼
extraction_runs（幂等登记）
     │
     ▼
Memory Extraction
     │
     ▼
Candidate Memory（含结构化槽位）
     │
     ▼
槽位判定
     ├── 无槽位     → 新增（不参与冲突判定）
     ├── 槽位命中且值相同 → 去重合并（source_count++）
     ├── 槽位命中且值不同 → 冲突三选一
     └── 无命中     → 新增
     │
     ▼
Memory
     │
     ├── Update（仅限 source_count / confidence / updated_at）
     ├── Supersede（创建新记忆 + 旧记忆写 valid_until + superseded_by）
     ├── Archive（长期未使用，status='archived'）
     └── Delete（软删除或物理删除）
     │
     ▼
memory_embeddings（ready / stale / failed / deleted）
```

```text
【重要】 注意 Update 与 Supersede 的区别：

  Update    = 同一事实的强化（又被提到一次）→ 不产生新记录
  Supersede = 事实发生变化           → 产生新记录，旧记录保留为历史

  V1.0 没有区分这两者，是 P0-1 与 P0-2 的共同后果。
  在「不可变事实」模型下，正文永远不属于 Update 的范畴。
```

---

# 27. 数据导出

## 27.1 导出格式

系统最终应该支持导出 JSON：

```json
{
  "version": "1.1",
  "exported_at": "2026-09-10T16:30:00+08:00",
  "user": {},
  "conversations": [],
  "messages": [],
  "memories": [],
  "memory_sources": [],
  "events": [],
  "goals": [],
  "relationships": []
}
```

## 27.2 导出选项

```text
① 完整导出（默认）
     包含原始对话 + 记忆 + 结构化数据

② 仅记忆导出
     不含原始对话内容（隐私友好）

③ 加密导出
     使用密码短语加密（见 §28）

【必须】 导出文件为明文时，必须明确提示「导出内容为明文，请妥善保管」。
```

## 27.3 可迁移性承诺

用户的数据必须可以导出。不能出现「你的所有人生记忆都锁死在这个软件里面」。

未来可增加：

```text
Markdown
CSV
SQLite
```

---

# 28. 数据备份与恢复

## 28.1 备份策略

```text
频率       每日一次 pg_dump
保留       ≥ 30 天
异地       ≥ 1 份
加密       必须（含用户私密数据）
恢复演练   每季度 1 次，并记录耗时
```

## 28.2 为什么备份比普通系统更重要

```text
LifeMate 的数据价值主要不是数据库本身，
而是长期积累的人生数据 —— 它是不可重建的。

因此备份的重要性高于普通业务系统。
```

## 28.3 pg_dump 示例

```bash
docker compose exec -T postgres \
  pg_dump -U lifemate -d lifemate -Fc \
  > backup/lifemate-$(date +%Y%m%d).dump
```

---

# 29. 数据隐私

## 29.1 日志脱敏

**不允许：**

```text
DEBUG LOG
    ↓
完整输出 Message Content
```

**推荐：**

```text
DEBUG LOG
    ↓
message_id
conversation_id
token_usage
latency
```

```text
【必须】 使用结构化日志 + 白名单，而不是黑名单过滤。
         永不记录的字段：message.content、memory.content、relationship.name
         开发环境同样默认脱敏（避免样例数据泄露到日志文件）。
```

## 29.2 出网数据

> 🟠 对应评审 P2-8。

```text
【V1.0 决定】 Embedding 使用本地 bge-m3，不出网。

  但 LLM 仍可能使用云端 API，因此必须：
    ① 在设置页与隐私说明中列出「哪些数据会发送到哪个 Provider」
    ② 提供 sensitive_memory_local_only 选项（见 §8.4）：
       敏感记忆不参与云端 LLM 上下文
    ③ 保留 Local LLM 的接入能力（D2 §34 的 Provider 抽象已支持）
```

## 29.3 静态加密

```text
① 数据库磁盘加密（或至少宿主目录加密）
② 备份文件强制加密（见 §28）
③ 导出文件加密选项（见 §27.2）
```

---

# 30. V1.0 数据库最终表清单

```text
核心对话：
  conversations
  messages
  conversation_summaries

长期记忆：
  memories
  memory_embeddings
  memory_sources
  extraction_runs

人生结构：
  events                 ← 同时承担 Timeline 职责
  goals
  relationships
```

共 **11 张核心业务表**。

> 🟡 注：V1.0 文档声称「11 张」但实际只列出 10 张（漏了 `memory_sources`）。
> V1.1 已修正：11 张为准，且清单完整。

```text
【维护要求】
  不再依赖文档里的数字，改为「表清单为准」。
  每次增删表必须同步更新本节与 §5.1 的关系图。
```

## 30.1 已删除的表

```text
timeline_events     → 合并入 events（C7）
```

## 30.2 V1.0 暂不建立的表

```text
agents
agent_runs          ← 可观测性，V1.0 仅进日志（与 extraction_runs 不同）
tools
tool_calls
subagents
mcp_servers
knowledge_graph_nodes
knowledge_graph_edges
vector_documents
documents
files
tasks
workflows
notifications
life_reviews        ← 运行时生成，不落库
```

原因：这些属于后续能力。V1.0 的数据库必须围绕 **Conversation + Memory + Events** 建立。

---

# 31. 数据库核心设计原则

## 原则一：聊天记录是原始数据

```text
Message
```

保存用户实际说过的话。

## 原则二：Memory 是不可变事实

```text
Memory
```

保存从对话中提取出的长期信息，且**创建后正文永不就地修改**。

信息变化 → 新记忆 + 旧记忆 supersede。

## 原则三：Event 是人生事件层

```text
Event
```

表达「发生过什么」。Timeline 是它的视图，不是第二份数据。

## 原则四：Goal 是目标层

```text
Goal
```

表达「用户想完成什么」，且是唯一的写入入口。

## 原则五：Embedding 是检索基础设施

```text
Embedding
```

不是业务数据，而是为了实现语义搜索。因此它必须带有「对应当前正文」的证明（`content_hash`）。

## 原则六：约束下沉到数据库

```text
CHECK / NOT NULL / UNIQUE 必须写在 schema 里，
不能只依赖应用层校验。
```

## 原则七：删除意图必须被完整执行

```text
用户删除对话 → 派生记忆必须一并处理
用户删除记忆 → 必须能从所有召回路径消失
```

---

# 32. V1.0 数据架构最终结论

LifeMate 的数据体系分成五层：

```text
                     LifeMate Data
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
    原始数据             认知数据            人生数据
        │                  │                  │
  Conversation           Memory        Event / Goal / Relation
        │                  │                  │
     Message           Embedding              │
        │             Source                  │
   Extraction         Extraction Run          │
        │                  │                  │
        └──────────────────┼──────────────────┘
                           ▼
                     Timeline（视图）
                           │
                           ▼
                Life Review（运行时生成）
```

最终形成：

> **「用户说过什么」→「系统记住什么」→「用户经历了什么」→「用户正在追求什么」→「这些事情如何构成用户的人生时间线」。**

---

# 33. 数据库设计基线

LifeMate V1.0 数据库正式确定：

```text
Database        PostgreSQL 18
Extension       pgvector 0.8.x
Extension       pg_trgm
ORM             Drizzle ORM
Primary Key     UUID (gen_random_uuid())
Time            TIMESTAMPTZ
JSON            JSONB（白名单键）
Vector          VECTOR(1024)  ← bge-m3，已冻结
Vector Index    V1.0 不建（精确检索）
Architecture    Relational + Vector
Core Tables     11
```

核心数据关系：

```text
User
 │
 ├── Conversation
 │       ├── Message
 │       │      └── ExtractionRun
 │       └── Summary
 │
 ├── Memory
 │       ├── Embedding
 │       └── Source
 │
 ├── Event          （Timeline 由此派生）
 ├── Goal
 └── Relationship
```

已锁定的四项决策：

```text
Q1 记忆版本模型     不可变事实 + superseded_by + 双时间轴
Q2 抽取输出契约     结构化 subject/predicate/object + 受控词表
Q4 Embedding        bge-m3，VECTOR(1024)，本地部署，MIT
   向量索引          V1.0 不建，精确检索
```

---

# 34. 后续实现顺序

本文档（V1.1）落地后的实现顺序：

```text
① 初始化项目骨架（pnpm + TypeScript + Fastify + Drizzle）
        ↓
② 编写 Drizzle Schema（以本文档为准）
        ↓
③ drizzle-kit generate → 生成 Migration SQL
        ↓
④ 拉起 PostgreSQL + pgvector 容器
        ↓
⑤ 执行 Migration，验证表结构与约束
        ↓
⑥ 验证 pgvector 可用（VECTOR(1024) 插入 + 相似度查询）
        ↓
⑦ 部署 bge-m3 本地推理服务（验证 1024 维输出）
        ↓
⑧ Repository 层
        ↓
⑨ Application Service 层
        ↓
⑩ 抽取流水线（extraction_runs 幂等 + 槽位判定）
        ↓
⑪ 检索流水线（RRF + 重排）
        ↓
⑫ API Controller
```

**LifeMate 数据库设计 V1.1 至此完成。**
后续 Drizzle Schema、Migration、API 和业务代码均应以本文档为基准。

---

# 附录 A　完整建表 DDL 参考

> 供 `drizzle-kit generate` 的产物校对使用。正式实现以 Drizzle Schema 为准，本 DDL 用于验证语意一致。

```sql
-- ============ 扩展 ============
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============ users ============
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  timezone    VARCHAR(64)  NOT NULL DEFAULT 'Asia/Shanghai',
  settings    JSONB        NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ============ conversations ============
CREATE TABLE conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title       VARCHAR(200),
  summary     TEXT,
  status      VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  deleted_at  TIMESTAMPTZ,
  CONSTRAINT chk_conversations_status CHECK (status IN ('active','archived','deleted')),
  CONSTRAINT chk_conversations_deleted CHECK (status <> 'deleted' OR deleted_at IS NOT NULL)
);
CREATE INDEX idx_conversations_user_updated ON conversations (user_id, updated_at DESC);
CREATE INDEX idx_conversations_user_status  ON conversations (user_id, status);

-- ============ messages ============
CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            VARCHAR(20) NOT NULL,
  content         TEXT NOT NULL,
  sequence        BIGINT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_messages_role CHECK (role IN ('user','assistant','system','tool'))
);
CREATE UNIQUE INDEX uq_messages_conversation_sequence ON messages (conversation_id, sequence);
CREATE INDEX idx_messages_sequence   ON messages (conversation_id, sequence DESC);
CREATE INDEX idx_messages_created_at ON messages (conversation_id, created_at);

-- ============ extraction_runs ============
CREATE TABLE extraction_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  start_sequence    BIGINT NOT NULL,
  end_sequence      BIGINT NOT NULL,
  extractor_version VARCHAR(50) NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending',
  memories_created  INTEGER NOT NULL DEFAULT 0,
  memories_updated  INTEGER NOT NULL DEFAULT 0,
  memories_superseded INTEGER NOT NULL DEFAULT 0,
  conflicts_found   INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  CONSTRAINT chk_extraction_status CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  CONSTRAINT chk_extraction_range  CHECK (end_sequence >= start_sequence)
);
CREATE UNIQUE INDEX uq_extraction_idempotency
  ON extraction_runs (conversation_id, start_sequence, extractor_version);
CREATE INDEX idx_extraction_conversation ON extraction_runs (conversation_id, created_at DESC);
CREATE INDEX idx_extraction_pending
  ON extraction_runs (status) WHERE status IN ('pending','running','failed');

-- ============ conversation_summaries ============
CREATE TABLE conversation_summaries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id    UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  summary            TEXT NOT NULL,
  sequence_from      BIGINT NOT NULL,
  sequence_to        BIGINT NOT NULL,
  summarizer_version VARCHAR(50) NOT NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_summaries_range CHECK (sequence_to >= sequence_from)
);
CREATE UNIQUE INDEX uq_summaries_range
  ON conversation_summaries (conversation_id, sequence_from, sequence_to);

-- ============ memories ============
CREATE TABLE memories (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  type             VARCHAR(20) NOT NULL,
  content          TEXT NOT NULL,
  subject_key      VARCHAR(100),
  predicate_key    VARCHAR(100),
  object_value     TEXT,
  polarity         VARCHAR(10),
  importance_score REAL NOT NULL DEFAULT 0.5,
  confidence_score REAL NOT NULL DEFAULT 1.0,
  status           VARCHAR(20) NOT NULL DEFAULT 'active',
  valid_from       TIMESTAMPTZ,
  valid_until      TIMESTAMPTZ,
  superseded_by    UUID,   -- 注意：刻意不加外键，理由见 §13.3 下的 C23 说明
  source_count     INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  CONSTRAINT chk_memories_type       CHECK (type IN ('fact','preference','event','goal','relationship','state')),
  CONSTRAINT chk_memories_status     CHECK (status IN ('active','superseded','archived','deleted')),
  CONSTRAINT chk_memories_polarity   CHECK (polarity IS NULL OR polarity IN ('affirm','deny')),
  CONSTRAINT chk_memories_importance CHECK (importance_score BETWEEN 0 AND 1),
  CONSTRAINT chk_memories_confidence CHECK (confidence_score BETWEEN 0 AND 1),
  CONSTRAINT chk_memories_valid_range CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  CONSTRAINT chk_memories_superseded CHECK (status <> 'superseded' OR superseded_by IS NOT NULL),
  CONSTRAINT chk_memories_deleted    CHECK (status <> 'deleted' OR deleted_at IS NOT NULL)
);
CREATE UNIQUE INDEX uq_memories_current_slot
  ON memories (user_id, subject_key, predicate_key)
  WHERE status = 'active' AND deleted_at IS NULL
    AND valid_until IS NULL AND superseded_by IS NULL
    AND predicate_key IS NOT NULL;
CREATE INDEX idx_memories_user_status_type ON memories (user_id, status, type);
CREATE INDEX idx_memories_user_updated     ON memories (user_id, updated_at DESC);
CREATE INDEX idx_memories_slot             ON memories (user_id, subject_key, predicate_key);
CREATE INDEX idx_memories_type_time        ON memories (user_id, type, valid_from DESC);
CREATE INDEX idx_memories_content_trgm     ON memories USING gin (content gin_trgm_ops);

-- ============ memory_embeddings ============
CREATE TABLE memory_embeddings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id     UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  model         VARCHAR(100) NOT NULL,
  dim           INTEGER NOT NULL,
  embedded_text TEXT NOT NULL,
  content_hash  VARCHAR(64) NOT NULL,
  embedding     VECTOR(1024) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'ready',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_embeddings_status CHECK (status IN ('ready','stale','failed','deleted'))
);
CREATE UNIQUE INDEX uq_embeddings_memory_model ON memory_embeddings (memory_id, model);
CREATE INDEX idx_embeddings_status ON memory_embeddings (status);

-- ============ memory_sources ============
CREATE TABLE memory_sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id       UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  source_type     VARCHAR(20) NOT NULL,
  message_id      UUID REFERENCES messages(id) ON DELETE RESTRICT,
  event_id        UUID,
  goal_id         UUID,
  -- 注意：没有 conversation_id（C22 已删除该冗余字段，见 §15.2）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_sources_type
    CHECK (source_type IN ('conversation','manual','system','goal_projection','event_derived')),
  CONSTRAINT chk_sources_has_origin
    CHECK (message_id IS NOT NULL OR event_id IS NOT NULL OR goal_id IS NOT NULL
           OR source_type IN ('manual','system'))
);
CREATE UNIQUE INDEX uq_memory_sources_memory_message
  ON memory_sources (memory_id, message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_memory_sources_message ON memory_sources (message_id);
CREATE INDEX idx_memory_sources_memory  ON memory_sources (memory_id);

-- ============ events（含 Timeline）============
CREATE TABLE events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title             VARCHAR(200) NOT NULL,
  description       TEXT,
  event_time        TIMESTAMPTZ NOT NULL,
  category          VARCHAR(50),
  importance_score  REAL NOT NULL DEFAULT 0.5,
  source_type       VARCHAR(20) NOT NULL DEFAULT 'conversation',
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  timeline_visible  BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  CONSTRAINT chk_events_source_type CHECK (source_type IN ('conversation','manual','system')),
  CONSTRAINT chk_events_importance  CHECK (importance_score BETWEEN 0 AND 1)
);
CREATE INDEX idx_events_user_time     ON events (user_id, event_time DESC);
CREATE INDEX idx_events_user_category ON events (user_id, category);
CREATE INDEX idx_events_timeline
  ON events (user_id, event_time DESC)
  WHERE timeline_visible = true AND deleted_at IS NULL;

-- ============ goals ============
CREATE TABLE goals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title        VARCHAR(200) NOT NULL,
  description  TEXT,
  status       VARCHAR(20) NOT NULL DEFAULT 'active',
  priority     REAL NOT NULL DEFAULT 0.5,
  started_at   TIMESTAMPTZ,
  target_at    TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  CONSTRAINT chk_goals_status   CHECK (status IN ('active','paused','completed','cancelled','archived')),
  CONSTRAINT chk_goals_priority CHECK (priority BETWEEN 0 AND 1),
  CONSTRAINT chk_goals_time_order CHECK (
    (target_at    IS NULL OR started_at IS NULL OR target_at    >= started_at)
    AND
    (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at)
  )
);
CREATE INDEX idx_goals_user_status ON goals (user_id, status);

-- ============ relationships ============
CREATE TABLE relationships (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name          VARCHAR(100) NOT NULL,
  relation_type VARCHAR(50),
  description   TEXT,
  status        VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  CONSTRAINT chk_relationships_status CHECK (status IN ('active','ended','archived'))
);
CREATE INDEX idx_relationships_user_status ON relationships (user_id, status);
CREATE UNIQUE INDEX uq_relationships_user_name
  ON relationships (user_id, name) WHERE deleted_at IS NULL;
```

---

# 附录 B　术语表

| 术语 | 含义 |
| ---- | ---- |
| 事实时间 | `valid_from` / `valid_until`，事实在现实中成立的时间区间 |
| 记录时间 | `created_at` / `updated_at`，系统何时知道这件事 |
| 槽位 | `subject_key + predicate_key` 的组合，冲突判定的最小单位 |
| 受控词表 | `predicate_key` 的允许取值枚举，不接受模型自由生成 |
| 当前有效 | `status='active' AND deleted_at IS NULL AND valid_until IS NULL AND superseded_by IS NULL` |
| Supersede | 事实发生变化时，创建新记忆并将旧记忆标记为已被替代 |
| 去重合并 | 同一槽位同一取值被再次提到，只递增 `source_count` |
| 陈旧向量 | `content_hash` 与当前 `embedded_text` 不匹配的 embedding |
| 幂等键 | `(conversation_id, start_sequence, extractor_version)` |
| Timeline | `events` 的查询视图，不是独立存储的实体 |
| Goal 投影 | `memory(type='goal')`，Goal 实体在语义检索层的镜像 |

---

# 附录 C　待办与依赖

## C.1 本文档落地后的立即待办

```text
□ 编写 Drizzle Schema（以本文档 §13–§22 为准）
□ 生成 Migration 并人工审阅 SQL
□ 拉起 PostgreSQL + pgvector 容器
□ 验证 CREATE EXTENSION vector / pg_trgm
□ 验证 VECTOR(1024) 插入与相似度查询
□ 部署 bge-m3 并确认输出维度为 1024
□ 编写受控词表的 TypeScript 枚举（§13.7）
□ 编写「当前有效记忆」谓词的单一常量（§13.6）
□ 编写离线评测脚本的共用过滤条件（§18.3）
```

## C.2 需在其他文档中同步的修订

```text
D1 PRD
  □ 需求编号（FR / NFR）
  □ 非功能指标具体数字
  □ 阶段划分插入评测任务
  □ §11 实体清单与本档对齐

D2 架构
  □ §36 API 端点补 /v1
  □ §8.1 Agent Loop 补迭代上限与超时
  □ §9 补上下文预算表
  □ §20 检索公式改为 RRF + 归一化重排
  □ §31 核心表清单补 memory_sources / extraction_runs，删除 timeline_events
  □ §21 移除 Agent 写工具（save / update / delete_memory）

D4 接口
  □ §43 说明 extraction_runs 与 agent_runs 的区别
  □ 删除 /timeline 的写接口（§28–30），改为操作 events
  □ §11 SSE 事件契约补全
  □ §8 分页策略区分游标与 offset
  □ 定义 MemoryView 统一视图对象
  □ §41 鉴权方案落地
```

---

**结束。**
