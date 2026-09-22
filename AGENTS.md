# AGENTS.md — 编码 Agent 工作规则

> 本文件面向在本仓库中执行编码任务的 AI Agent（DSH / Claude Code / Codex / Cursor 等）。
> 项目当前状态：**设计阶段已完成，工程代码尚未开始**（`src/` 为空，无 `package.json`）。
> 本文件的规则优先级高于 Agent 的个人习惯；与本文档冲突的"通常做法"一律以本文档为准。

---

## 0. 开工前必读（按顺序）

| 顺序 | 文件 | 用途 |
| ---- | ---- | ---- |
| 1 | `docs/03-database-design.md` | **Schema 的唯一依据**。表结构、约束、索引、状态机都在这里 |
| 2 | `docs/02-architecture.md` | 模块划分与分层原则 |
| 3 | `docs/04-api-spec.md` | 接口契约、错误码、分页 |
| 4 | `docs/07-git-conventions.md` | 提交信息格式与 scope 清单 |
| 5 | `docs/05-environment-setup.md` | 环境启动与验证（**注意：其中的绝对路径只适用于家里那台机器**） |

```text
不要读的：
  docs/archive/**          已弃用快照，任何内容都不得作为实现依据
  docs/06-design-review.md 决策来源与理由，可参考；但它的行号指向被评审的旧版文档，
                           且其中的「待决策」表述已过期，不要据此判断当前决策状态
```

---

## 1. 最高优先级规则

### R1（本规则必须逐字执行）

> **编码完成之后再次检查是否存在项目整体上的逻辑问题和脚本语法上的错误。**

这不是"再跑一次 lint"，而是**交活前的第二遍通读**，至少覆盖：

```text
□ 整体逻辑
    - 跨模块调用链是否闭环（Controller → Service → Repository 有没有断点）
    - 状态机是否有未处理分支（03 的 status 枚举、状态转移表）
    - 异常路径有没有被静默吞掉；错误码是否与 04 一致
    - 事务边界是否正确（03 §25.1 列出的必须使用事务的操作）
    - 软删除是否真的从所有召回路径排除（03 §18.3）
□ 脚本语法与可运行性
    - TypeScript / JavaScript：语法、类型、import 路径、是否有未使用的死代码
    - SQL：CHECK / UNIQUE / 外键 / 部分索引语法是否成立，建表顺序是否满足依赖
    - PowerShell / Shell：能否在**目标 shell** 上真的执行（见 §4）
    - 配置：新增的环境变量是否同步进了 `.env.example`
□ 一致性
    - 代码与 docs/03 是否一致；不一致时以文档为准并回报，不要偷偷改文档
```

### R2　不许"看起来对"就交付

任何声称"已完成 / 已通过 / 已修复"的结论，必须附上**实际执行过的命令和输出**。
无法在当前环境执行的（例如本机没有 Docker），必须明说"未验证"，不得省略。

### R3　设计不确定时停下来问，不要自行发明

`docs/` 没写清楚的地方 → 在回复里明确指出"文档未定义 X，我倾向方案 A，理由是……"，然后**等确认**。
严禁静默补一个设计进去，尤其是涉及表结构、检索公式、提示词契约的地方。

### R4　改动范围最小化

只改与当前任务相关的文件。不做顺手重构、不升级无关依赖、不调整格式、不改动文档里的既有事实。

---

## 2. 已锁定的决策（不得擅自更改）

| 编号 | 决策 | 结论 |
| ---- | ---- | ---- |
| Q1 | 记忆版本模型 | **不可变事实** + `superseded_by` + 双时间轴；记忆正文永不就地修改 |
| Q2 | 抽取输出契约 | **结构化槽位**（`subject_key` / `predicate_key` / `object_value`）+ 受控词表 |
| Q3 | 记忆写入路径 | **仅后台抽取流水线**；Agent 只读记忆，不持有写工具 |
| Q4 | Embedding | **bge-m3，`VECTOR(1024)`，本地部署**；换模型 = 一次显式数据迁移，不是配置项 |

需要推翻其中任何一条 → **停下来找人类确认**，不要以"更优实现"为由直接改。

配套的硬性约束：

```text
• V1.0 不建 HNSW / IVFFlat 向量索引，走精确检索（数据量 < 5 万条）
• 关键词通道用 pg_trgm（中文场景 PostgreSQL 默认全文检索不切词）
• Timeline 不是独立表，是 events 的查询视图
• 不得引入 Redis / 消息队列 / 工作流引擎（02 §41/§42）
• 新增依赖前先说明理由与替代方案，不要默默装包
```

---

## 3. 技术栈与目录

```text
TypeScript + Node.js(≥20) + Fastify + Drizzle ORM + pnpm
PostgreSQL 18 + pgvector（容器提供） + bge-m3（容器提供）

src/            按业务模块组织，不按技术类型堆放
  agent/ conversation/ memory/ timeline/ life-review/ llm/ database/ shared/
devops/         环境与运维配置（与 src/ 平级，不是应用代码）
docs/           设计文档
根目录          只放必须在这一层的配置：compose / env / git
```

分层铁律：

```text
API Controller  只做校验与协议转换（Zod）
Application Service  业务逻辑、事务边界
Repository      数据访问，只有这一层碰数据库
Agent Tool      不直接操作数据库，与 API 共享 Application Service
```

---

## 4. 数据库与环境规则

### 4.1 Schema 变更流程

```text
先改 docs/03-database-design.md  →  再改 Drizzle schema
     →  drizzle-kit generate  →  检查生成的 SQL  →  执行 migration
```

- **已应用的 migration 永不修改**，需要变更就追加新的。
- 约束要下沉到数据库（CHECK / UNIQUE / NOT NULL），不要只靠应用层自觉。
- 每次 Migration 都要在真实容器里执行过一次，并验证表结构与约束。

### 4.2 环境事实（Windows）

```text
• 目标机器：Windows + Docker Desktop（WSL2 后端）+ NVIDIA RTX 4070 Laptop 8G
• 仓库根目录两台机器不同（家里 D:\workspace\LifeMate，公司 E:\workspace\life_mate）
  → 代码、脚本、配置里一律使用相对路径；绝对路径只允许出现在文档里
• PostgreSQL 18 镜像的数据目录是 /var/lib/postgresql（不是 .../data），见 docker-compose.yml 注释
• docker compose down 不接受服务名；停单个服务用 stop + rm
• 二进制文件（如 pg_dump -Fc）不要用 PowerShell 重定向或管道传出：
  PowerShell 5.1 会破坏字节流，必须用 `docker compose cp` 从容器里取
  （若确要用管道，必须显式声明要求 PowerShell ≥ 7.4）
• 容器端口只绑 127.0.0.1
```

### 4.3 隐私（违反即为严重缺陷）

```text
• .env 永不提交；不得把密码、token、API Key 写进代码或示例
• 日志禁止记录消息正文与记忆内容（03 §29.1）
• 备份文件必须加密后才能留存
• 不要为了调试把真实记忆数据打印到控制台或提交到仓库
```

---

## 5. 交付前自检清单

```text
□ R1 二遍通读：整体逻辑 + 脚本语法（见 §1）
□ 类型检查 / Lint / 测试实际跑过，输出贴出来
□ 新增或修改的脚本在其目标 shell 上执行过一次（PowerShell 版本写清楚）
□ 涉及数据库的改动：docker compose up -d postgres 后真实执行过 SQL
□ docker compose config 校验通过（改了 compose 时）
□ 新增环境变量已进 .env.example
□ **改了表结构或约束时：附录 A 的 DDL、§17 索引清单、`devops/postgres/init/*.sql` 是否同步**
  （C31/C32 的教训：正文改了、附录与脚本没跟上，同一次提交里发作了两次）
□ **改了字段语义时：全仓库搜一遍旧写法**（`grep` 旧字段名 / 旧枚举值 / 旧模型名），
  确认 README、环境手册、示例代码、测试脚本都跟上了（C19/C27 的教训）
□ 测试脚本是否**照文档写的流程**执行，而不是照"更简单的等价写法"（C30 的教训）
□ git diff 逐个文件看过：没有调试代码、没有 .env、没有 dump/日志文件
□ 提交信息符合 docs/07 的 type(scope): subject 格式，一次提交只做一件事
```

---

## 6. 设计问题的状态（照 03 实现前先看这里）

`docs/03-database-design.md` V1.1 的修订都登记在它的 §0.2 / §0.3（C1～C34）。**写 Schema 前以最新登记的编号为准**，不要照抄 `docs/06-design-review.md` 附录里的建议稿（那是评审当时的旧稿）。

**已修复（不必再踩，但改动时要保持）：**

```text
✅ C22  memory_sources 不再有 conversation_id（反查改 JOIN）
✅ C23  superseded_by 无外键，物理删除可兑现
✅ C24  删除 Goal 前先失效投影记忆、再清来源
✅ C29  messages / 摘要为物理删除，只有会话是软删除
✅ C30  §24.3 步骤③：无剩余来源的记忆也要删除来源行
✅ C31  附录 A 补 event_id / goal_id 外键（后置 ALTER TABLE）
✅ C32  附录 A 补 EXCLUDE 约束；btree_gist 已在初始化脚本中
✅ C33  §19 约束清单与附录 A 逐列对齐
```

**仍未解决（实现到对应位置时先提出问题，不要自行发明方案）：**

| 位置 | 问题 | 影响 |
| ---- | ---- | ---- |
| §13.7 vs §13.11 | "真正冲突 → 标记待用户确认"与 `uq_memories_current_slot` 部分唯一索引冲突（同槽位不允许两条 active），且状态枚举里没有 `conflict` | 冲突分支无法落库；需要产品决策：加 `conflict` 状态、还是把冲突记忆写进独立的待确认队列 |
| §4.2 / §14.2 | 声称 `(memory_id, model)` 多行支持未来平滑换模型，但 `VECTOR(1024)` 写死列类型，非 1024 维模型无法入库 | 换模型时"双写 → 回填 → 切换"四步走目前不成立；需要先决定是否放宽该承诺 |
| §19 vs 附录 A | `events.category`、`conversation_summaries.status` 有文档枚举但库层无 CHECK（其余约束已在 C33 对齐） | 约束未下沉，与 §19「约束下沉」的目标不一致；补 CHECK 前先确认枚举是否会扩展 |
| §24.2 | 会话软删除时 `conversations.title` 仍是用户可见内容，未规定是否清空 | 隐私口径问题，需产品决策 |

---

## 7. 沟通约定

```text
• 用中文回复
• 结论先行：先说做了什么结论/改了什么，再给细节
• 报告事实而非表态：不要写"应该没问题"，写"已执行 X，输出 Y"
• 未验证的事情明确标注「未验证」
• 发现文档错误：回报 + 给出建议，不要顺手改设计文档
```
