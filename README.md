# LifeMate

> **个人长期记忆型 AI Agent** —— 以自然对话为入口，持续收集与整理具有长期价值的信息，让 AI 从一次性的聊天对象逐渐成为真正了解用户长期经历的数字伙伴。

**当前阶段：** 设计阶段（尚未开始编码）
**技术基线：** TypeScript + Node.js + Fastify + Drizzle + PostgreSQL 18 + pgvector + bge-m3
**架构形态：** 模块化单体（Modular Monolith）

---

## 目录结构

```text
LifeMate/
│
├── docs/                        设计文档（按依赖顺序编号）
│   ├── README.md                文档索引与阅读路径
│   ├── 01-prd.md                产品需求
│   ├── 02-architecture.md       系统架构
│   ├── 03-database-design.md    数据库设计 ← 当前基线
│   ├── 04-api-spec.md           接口契约
│   ├── 05-environment-setup.md  本地环境搭建（含验证与排错）
│   ├── 06-design-review.md      设计评审
│   ├── 07-git-conventions.md    Git 提交规范
│   └── archive/                 已弃用文档（仅作历史留档）
│
├── devops/                      环境与运维配置
│   └── postgres/init/           PostgreSQL 初始化脚本
│
├── src/                         （预留）TypeScript 源码
│   ├── agent/                   Agent Core
│   ├── conversation/            会话
│   ├── memory/                  Memory Engine
│   ├── timeline/                Timeline
│   ├── life-review/             Life Review
│   ├── llm/                     LLM / Embedding Provider
│   ├── database/                Schema / Migration / Repository
│   └── shared/                  共享工具
│
├── docker-compose.yml           PostgreSQL + Embedding 服务
├── .env.example                 环境变量模板（复制为 .env）
├── .gitmessage                  提交信息模板
├── .gitignore
└── .gitattributes
```

**分层原则：**

```text
devops/   环境与运维配置 —— 与 src/ 平级，不是应用代码
src/      应用代码 —— 按业务模块组织，不按技术类型堆放
docs/     文档 —— 与代码分离，便于交给别人看或整包导出
根目录     只放「必须在这一层」的配置：compose / env / git
```

> 💡 **为什么 `docker-compose.yml` 留在根目录？**
> Docker Compose 自动读取的 `.env` 位置**只跟 compose 文件所在目录有关**。
> 留在根目录，`docker compose up -d` 在任何目录下都能正常读环境变量；
> 移入子目录则会变成「必须先 cd 进去才能执行」的坑。
> 而 `.env` 含数据库密码，也不能为了它把配置散到子目录里。


---

## 文档阅读顺序

文档编号即推荐阅读顺序，因为存在依赖关系：架构依赖 PRD，数据库依赖架构，接口依赖数据库。

### 先读这四份（理解项目）

| 编号 | 文档 | 回答什么问题 |
| ---- | ---- | ---- |
| 01 | [产品需求](./docs/01-prd.md) | **要做什么？** 产品定位、功能范围、MVP 边界 |
| 02 | [系统架构](./docs/02-architecture.md) | **系统怎么组成？** 模块划分、数据流、技术选型 |
| 03 | [数据库设计](./docs/03-database-design.md) | **数据怎么存？** 表结构、约束、索引、生命周期 |
| 04 | [接口契约](./docs/04-api-spec.md) | **前后端怎么对话？** API 契约、错误码、分页 |

### 动手前必读

| 编号 | 文档 | 什么时候读 |
| ---- | ---- | ---- |
| 05 | [环境搭建手册](./docs/05-environment-setup.md) | **第一次启动环境时。** 含逐步验证与故障排查，建议照做不要跳步 |
| 07 | [Git 提交规范](./docs/07-git-conventions.md) | **第一次提交代码前。** 约定提交格式与粒度 |

### 参考与追溯

| 编号 | 文档 | 用途 |
| ---- | ---- | ---- |
| 06 | [设计评审](./docs/06-design-review.md) | **追溯设计决策的来源。** 记录了 39 项问题与对应方案，是 03 中多项设计的依据 |
| — | [docs/README.md](./docs/README.md) | 文档索引、版本状态、变更记录 |

---

## 快速开始

### 1. 本地环境

```bash
# 复制环境变量模板并设置密码
cp .env.example .env

# 启动数据库与 Embedding 服务
docker compose up -d

# 验证
docker compose ps
```

完整步骤（含 GPU 穿透验证、向量维度校验、故障排查）见
[环境搭建手册](./docs/05-environment-setup.md)。

### 2. 环境依赖

| 组件 | 版本 | 说明 |
| ---- | ---- | ---- |
| Node.js | ≥ 20 | Runtime |
| pnpm | ≥ 9 | 包管理 |
| Docker Desktop | 最新版 | 需 WSL2 后端 |
| PostgreSQL | 18 | 由容器提供 |
| pgvector | 0.8.x | 由 `pgvector/pgvector:pg18` 镜像提供 |
| bge-m3 | — | 由 TEI 容器提供，1024 维 |

---

## 核心设计决策

以下四项决策已经锁定，是全部实现工作的前提：

| 编号 | 决策 | 结论 |
| ---- | ---- | ---- |
| Q1 | 记忆版本模型 | **不可变事实** + `superseded_by` + 双时间轴。记忆正文永不就地修改，变化时新建并标记旧记忆 |
| Q2 | 抽取输出契约 | **结构化槽位**（`subject_key` / `predicate_key` / `object_value`）+ 受控词表，使去重与冲突可确定性判定 |
| Q3 | 记忆写入路径 | **仅后台抽取流水线**。Agent 只读记忆，不持有写工具 |
| Q4 | Embedding | **bge-m3，`VECTOR(1024)`，本地部署**（MIT 授权，显存约 3.2 GB） |

配套要点：

```text
• 向量索引    V1.0 不建 HNSW / IVFFlat，走精确检索（10 万条以内够用且召回率 100%）
• 关键词通道  使用 pg_trgm（中文场景下 PostgreSQL 默认全文检索不切词）
• 抽取幂等    extraction_runs 表，幂等键 (conversation_id, end_sequence, extractor_version)
• Timeline    不是独立表，而是 events 的查询视图
```

决策的完整论证与替代方案见 [设计评审](./docs/06-design-review.md)。

---

## 开发路线

```text
✅ Phase 0  产品设计          docs/01
✅ Phase 1  技术架构          docs/02
✅ Phase 2  数据库设计        docs/03
                          ─────────────────
⬜ Phase 3  工程基础          pnpm + TypeScript + Fastify + Drizzle
⬜ Phase 4  本地环境          容器 + pgvector + bge-m3        ← docs/05
⬜ Phase 5  离线评测基石      金标数据集 + 评测脚本
⬜ Phase 6  Chat Agent        Agent Loop（只读工具）
⬜ Phase 7  Memory V1         抽取 + 存储 + 检索
⬜ Phase 8  Memory 智能       去重 + 冲突 + 演化
⬜ Phase 9  Timeline / Review
⬜ Phase 10 Web UI
⬜ Phase 11 回归与 Release
```

**下一步：** 进入 Phase 3，初始化工程骨架并编写 Drizzle Schema。

---

## 当前状态

| 项目 | 状态 |
| ---- | ---- |
| 设计文档 | ✅ 完成（PRD / 架构 / 数据库 / 接口 四份基线） |
| 设计评审 | ✅ 完成（39 项问题已给出方案，P0 阻塞项已解决） |
| 环境配置 | ✅ 完成（compose / 初始化脚本 / 模板文件） |
| 容器环境 | ⬜ 待启动验证（见 docs/05） |
| 应用代码 | ⬜ 未开始 |

---

## 注意

```text
⚠️ 本项目保存的是高度私密的生活数据，因此：
   • .env 永不提交（已在 .gitignore 中排除）
   • 容器端口默认只绑 127.0.0.1，不对局域网暴露
   • 日志禁止记录消息正文与记忆内容
   • 备份文件必须加密

⚠️ 数据库表结构在首次 Migration 前仍可自由调整，
   一旦开始积累真实记忆数据，结构变更需走迁移流程。
```
