# LifeMate 文档索引

本目录存放 LifeMate 的全部设计文档。

**约定：** 文件名编号即推荐阅读顺序，因为文档之间存在依赖关系——架构依赖 PRD，数据库依赖架构，接口依赖数据库。

---

## 文档清单

| 编号 | 文件 | 文档标题 | 版本 | 状态 |
| ---- | ---- | ---- | ---- | ---- |
| 01 | [01-prd.md](./01-prd.md) | LifeMate 产品需求文档（PRD） | V1.0 | 基线 |
| 02 | [02-architecture.md](./02-architecture.md) | LifeMate 系统架构设计说明书 | V1.0 | 基线 |
| 03 | [03-database-design.md](./03-database-design.md) | LifeMate 数据库设计说明书 | V1.1 | **当前基线** |
| 04 | [04-api-spec.md](./04-api-spec.md) | LifeMate API 接口设计说明书 | V1.0 | 基线 |
| 05 | [05-environment-setup.md](./05-environment-setup.md) | 本地环境搭建操作手册 | V1.0 | 可用 |
| 06 | [06-design-review.md](./06-design-review.md) | 设计评审与改进建议 | V1.0 | 待决策项已闭环 |
| 07 | [07-git-conventions.md](./07-git-conventions.md) | Git 提交规范 | V1.0 | 生效 |
| 08 | [08-contract-audit.md](./08-contract-audit.md) | 设计契约审计报告 | V1.0 | 已修复并回归（C29～C32 为二次复查） |
| 09 | [09-evaluation-baseline.md](./09-evaluation-baseline.md) | 离线评测基线与指标定义 | V1.0 | 持续更新 |
| 10 | [10-usage-and-status.md](./10-usage-and-status.md) | **开发完成度与使用说明** | V1.0 | 面向使用者 |

**归档：**

| 文件 | 说明 |
| ---- | ---- |
| [archive/数据库设计V1.0-已弃用.md](./archive/数据库设计V1.0-已弃用.md) | 已被 03 取代，仅作历史留档。**不要据此编写 Schema** |

**注：** 09 与 10 不是设计文档，而是**工程产出物**：
- 09 记录「指标现在是多少」——调优时用来对比，防止把改动前后搞混
- 10 记录「做到哪了、怎么用」——面向使用者，也是接手项目时的第一份读物

---

## 依赖关系

```text
01-prd.md            要做什么
      │
      ▼
02-architecture.md   系统怎么组成
      │
      ▼
03-database-design.md  数据怎么存   ← 写 Drizzle Schema 的依据
      │
      ▼
04-api-spec.md       前后端怎么对话

横向支撑：
05-environment-setup.md   怎么把环境跑起来
06-design-review.md       为什么这么设计（决策来源）
07-git-conventions.md     怎么把改动记录下来

工程产出（非设计文档）：
09-evaluation-baseline.md 质量指标现在是多少
10-usage-and-status.md    做到哪了、怎么用
```

---

## 阅读路径

### 路径 A：快速了解项目（约 30 分钟）

```text
README.md（项目根目录）
      ↓
01-prd.md  §1 产品概述 → §7 功能范围 → §13 MVP 范围 → §15 成功标准
      ↓
02-architecture.md  §3 总体架构 → §49 最终架构图 → §48 设计原则
```

### 路径 B：准备开始编码（约 2 小时）

```text
03-database-design.md  全篇（这是实现依据）
      ↓
06-design-review.md  §5 待决策清单（确认决策已闭环）
      ↓
04-api-spec.md  全篇
      ↓
05-environment-setup.md  第 1～8 章（动手跑一遍）
```

### 路径 C：追溯某个设计决策的来源

```text
06-design-review.md
      ↓
用附录 E「问题索引」定位到具体编号（如 P0-1）
      ↓
按编号找到「原文证据」列出的文档与行号
      ↓
回到对应文档核对
```

### 路径 D：接手项目 / 想知道做到哪了（约 20 分钟）

```text
10-usage-and-status.md   ← 先读这个：做到哪了、怎么用、还剩什么
      ↓
09-evaluation-baseline.md  质量指标现状与已知局限
      ↓
AGENTS.md  §4 环境规则、§6 设计问题状态
      ↓
docs/03  §0.2 / §0.3       所有设计修订（C1～C38）的登记
```

**路径 D 是给「过一段时间回来继续做」或「换人接手」用的。**
它跳过全部设计论证，直接回答三个问题：现在能跑什么、质量如何、还剩哪些坑。

---

## 文档之间的对应关系

数据库设计（03）中的每个关键决策，都能追溯到评审报告（06）的具体问题编号：

| 03 中的设计 | 依据 | 06 中的问题编号 |
| ---- | ---- | ---- |
| `memories` 不可变事实 + `superseded_by` | 记忆版本模型矛盾 | P0-1 |
| `subject_key` / `predicate_key` / `object_value` | 去重与冲突无法确定性判定 | P0-2 |
| `VECTOR(1024)` + `content_hash` / `status` | 维度不可逆、无陈旧检测 | P0-3 |
| RRF + 归一化两阶段检索（§18.4） | 评分公式缺项且量纲不可加 | P0-4 |
| 删除 `timeline_events`，改为查询视图 | 双表写入无一致性保障 | P0-5 |
| `extraction_runs` 幂等键 | 抽取重复触发 | P0-6 |
| `pg_trgm` 关键词通道 | 中文全文检索不切词 | P1-7 |
| 约束设计章节（§19） | 原文档无任何 CHECK / NOT NULL | P1-8 |
| 删除与级联策略（§24） | 派生记忆的处理未定义 | P1-1 |
| 检索过滤条件章节（§18.3） | 软删除未从召回路径排除 | P1-2 |

---

## 版本与命名

### 文件命名

```text
NN-<english-name>.md
 │       │
 │       └── ASCII 短横线命名：避免 grep / cat / URL 转义问题
 └────────── 两位编号：决定阅读顺序
```

**注意：** 文件名使用 ASCII，但**文档内容全部为中文**。文档身份以文件内的标题为准，例如 `03-database-design.md` 的标题是《LifeMate 数据库设计说明书 V1.1》。

### 版本规则

```text
主版本（V1.0 → V2.0）
  架构级变更，或表结构不兼容变更
  → 新建文件，旧版本移入 archive/

次版本（V1.0 → V1.1）
  新增章节、修正表述、补充字段
  → 原地更新，在文档头部记录变更
```

**当前基线的锁定状态：**

| 文档 | 可以改动吗 |
| ---- | ---- |
| 01-prd.md | 可以，但改动功能范围需同步检查 02～04 |
| 02-architecture.md | 可以，但改动模块划分需同步检查 03 |
| 03-database-design.md | **首次 Migration 前可自由改动；之后需走迁移流程** |
| 04-api-spec.md | 可以，注意同步前端类型定义 |

---

## 维护要求

```text
□ 新增文档 → 在本索引登记，并分配下一个编号
□ 文档被取代 → 移入 archive/，并在本索引标注
□ 不再写死「共 N 份文档」这类数字，以清单为准
□ 重要决策变更 → 同步更新 06-design-review.md 的记录
```

---

## 尚未编写的文档

规划中但当前不需要，等对应阶段再补：

| 计划文档 | 触发时机 |
| ---- | ---- |
| 部署与运维手册 | 首次部署到非本机时 |
| 数据导出与迁移说明 | 实现 PRD §12.2 的导出功能时 |

**已补齐的（原先列在这里，现已完成）：**

```text
✅ Agent 行为规范    → 实现为 src/conversation/prompts.ts 与 src/memory/extraction-prompt.ts
                       （提示词即行为规范；版本号 AGENT_PROMPT_VERSION / EXTRACTOR_VERSION
                         用于追溯行为变化）
✅ 记忆算法设计      → 实现为 src/memory/ 下的 candidate-processor / slot-adjudicator /
                       extraction-pipeline，设计依据写在各自的文件头注释里
✅ 受控词表定义      → src/database/schema/enums.ts 的 PREDICATE_KEYS（与库层 CHECK 同源）
✅ 记忆评测方案      → docs/09-evaluation-baseline.md + src/evaluation/
```

**这一节的教训：** 上面四项当初被列为「待写的文档」，但实际实现时都变成了**代码里的注释与常量**，而不是独立文档。原因是它们必须与代码同步演进——独立文档写一遍、代码改一遍，两边必然漂移（C19/C27 就是这么发生的）。
因此**新增设计文档前先问一句：它会不会需要跟代码同步？** 会的话，写在代码里更可靠。
