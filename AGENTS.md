# AGENTS.md — 编码 Agent 工作规则

> 本文件面向在本仓库中执行编码任务的 AI Agent（DSH / Claude Code / Codex / Cursor 等）。
> 项目当前状态：**设计阶段已完成，V1.0 功能面齐备，等待真实使用与调优**。
> 已完成：数据库 Schema + 迁移、Repository 层、LLM Provider、Agent Loop、
> 记忆抽取流水线、记忆召回、HTTP 层（chat / SSE / conversations / memories /
> settings / timeline / life-review / goals）、会话摘要、离线评测。
> 未完成：Agent 只读记忆工具、Web UI、检索质量评测、摘要接入 Life Review。
> 详见 `docs/README.md`、`docs/09-evaluation-baseline.md` 与最近若干次提交。
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

### 4.2.1 绝不用写文件的命令碰 `.env`（事故换来的）

```text
🔴 2026-09-23：为验证 `node --env-file` 多个文件时的覆盖顺序，
   用 Set-Content 往 .env 写了一个探测值，把真实内容整个冲掉。
   .env 在 .gitignore 里 → 没有版本可回滚 → LLM_API_KEY 永久丢失，
   用户只能重新申请/查找。

   .env 里的数据库密码之所以能恢复，是因为它恰好等于 .env.example 的默认值；
   BGE_M3_MODEL_DIR 是从运行中的容器挂载点读回来的。这是运气，不是方法。

规则：
  □ 任何需要「验证读取行为」的实验，写到临时文件（.env.probe）并当场删掉
  □ 需要读 .env 的某个值时，用 Select-String 取单行，**不要整文件读出来**
    （整文件读会把明文密钥带进会话记录）
  □ 改 .env 只用 edit 工具做定点替换，不要整体重写
  □ 提醒用户：.env 里的密钥建议另存一份到密码管理器 —— 它没有版本历史
```

### 4.3 隐私（违反即为严重缺陷）

```text
• .env 永不提交；不得把密码、token、API Key 写进代码或示例
• 日志禁止记录消息正文与记忆内容（03 §29.1）
• 备份文件必须加密后才能留存
• 不要为了调试把真实记忆数据打印到控制台或提交到仓库
```

### 4.4 测试必须连独立的测试库

```text
🔴 这条是事故换来的，不要绕过。

2026-09-23：HTTP 集成测试原先跑在开发库上（DATABASE_URL 指向 lifemate），
而测试夹具为了让列表断言稳定会删除「默认用户」名下的记忆 ——
结果是每跑一次 pnpm test 就清空一次真实记忆。
发现时库里的记忆与向量全没了，另有 324 个测试会话堆积。

两道防线（改测试时必须保持有效）：

① src/shared/test-guard.ts
   任何会写数据的测试夹具，入口处调用 assertTestDatabase('调用点')。
   库名不含 "test" 就抛错终止 —— 默认拒绝，不是默认允许。

② package.json 的 test 脚本指定 --env-file=.env.test
   测试根本不读 .env，即使有人绕过①也碰不到开发库。

新增写数据的测试时：
  □ 在夹具入口加 assertTestDatabase('文件名 / 夹具名')
  □ 确认清理逻辑只删自己造的数据，或至少限制在测试库内
  □ 不要把断言写成「全表 count == N」——那依赖执行顺序（见 §5 的同类教训）
```

### 4.5 测试串行执行（不要改成并发）

```text
test 脚本带了 --test-isolation=process --test-concurrency=1。

原因：多个 HTTP 集成测试文件共用**同一个默认用户**（单用户系统只有一条
users 记录），而为了断言稳定，夹具会在用例开始时清空该用户名下的数据。
并发跑时 A 文件的清理会删掉 B 文件正在用的数据 ——

  实测踩到两次：
    ① timeline-routes 的清理删掉了 memory-routes 正在断言的记忆
    ② 反过来，memory-routes 留下的记忆让「无材料时不调 LLM」用例误判

代价是测试变慢（约多几秒），换来的是确定性。
要恢复并发，得先让各文件用**不同的用户** —— 那需要给路由加 userId 注入点，
而单用户系统不该为测试改 API。因此当前选择串行。
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
✅ C35  memories.status 新增 'conflict'；记忆召回不返回它（已实现并用真实数据验证）
✅ C37  events.category / conversation_summaries.status 的 CHECK 已加
✅ C38  会话删除时 title 置 '[已删除的对话]'、summary 清空（已实现并测试）
```

**仍未解决（实现到对应位置时先提出问题，不要自行发明方案）：**

| 位置 | 问题 | 影响 |
| ---- | ---- | ---- |
| §4.2 / §14.2 | 声称 `(memory_id, model)` 多行支持未来平滑换模型，但 `VECTOR(1024)` 写死列类型，非 1024 维模型无法入库 | 换模型时"双写 → 回填 → 切换"四步走目前不成立；需要先决定是否放宽该承诺 |
| §24.2 | 会话删除已按 C38 清空 title/summary，但**「删派生记忆」这条路要在 HTTP 层显式传参**才生效（`?delete_derived_memories=true`）。文档说"前端需明确提示两种语义的差异"，前端尚未实现 | 前端未做，用户暂时只有保守语义（保留记忆）可用 |

**文档之间口径不一致、已按保守方案实现并回报（需人类决策）：**

| 位置 | 冲突 | 当前实现 |
| ---- | ---- | ---- |
| docs/04 §23 vs Q1 | §23 允许 `PATCH /memories/:id` 改 `content` 并重算 embedding；Q1 与 docs/03 §13.1 禁止就地改正文 | 按 Q1 拒绝（422）。改内容应走「新建 + 替代」语义，那个端点尚未实现 |
| docs/04 §46 | 只规定"V1.0 纳入 Idempotency-Key"，未定存储方案 | 进程内存储（docs/06 P2-6 给的候选之一）。代价：重启后失效 |
| docs/04 §48 | 推荐维护 OpenAPI 3.x | 未引入类型 provider，Zod 校验是手写的，没有生成 schema |
| docs/02 §9 | Context Builder 的结构含"User Profile" | 未实现（users.settings 目前无人读） |

---

## 7. 沟通约定

```text
• 用中文回复
• 结论先行：先说做了什么结论/改了什么，再给细节
• 报告事实而非表态：不要写"应该没问题"，写"已执行 X，输出 Y"
• 未验证的事情明确标注「未验证」
• 发现文档错误：回报 + 给出建议，不要顺手改设计文档
```
