# LifeMate 设计评审与改进建议 V1.0

**项目名称：** LifeMate
**文档类型：** 设计评审报告 / 计划补充文档
**版本：** V1.0
**文档状态：** 评审结论（Q1～Q12 已决策并回写，见 §5 与《数据库设计 V1.1》§0.1）
**评审对象：**

| 编号 | 文档（现行文件名） | 被评审版本 | 行数 |
| ---- | ---- | ---- | ---- |
| D1 | [`docs/01-prd.md`](./01-prd.md) | V1.0 | 1093 |
| D2 | [`docs/02-architecture.md`](./02-architecture.md) | V1.0 | 2030 |
| D3 | [`docs/archive/数据库设计V1.0-已弃用.md`](./archive/数据库设计V1.0-已弃用.md) | V1.0（历史快照） | 1685 |
| D4 | [`docs/04-api-spec.md`](./04-api-spec.md) | V1.0 | 1605 |

> ⚠️ **关于 `D3` 与本文中的行号（必读）**
>
> 本文的行号引用指向**被评审时的旧版快照**，不是当前基线：
>
> ```text
> D3 = 数据库设计 V1.0 → 已归档到 docs/archive/数据库设计V1.0-已弃用.md
>      当前基线是 docs/03-database-design.md（V1.1），章节与字段均已重排，
>      因此本文的「D3 §… / 第 N 行」不能用来定位 V1.1 的内容。
>      归档件在开头加了 16 行弃用横幅，故 D3 的行号在归档件中要 +16 才是原文位置。
>
> D1 / D2 / D4 的内容未变，仅文件名变更（见上表），其行号引用仍然有效。
> ```
>
> 需要追溯某个决策时，请以《数据库设计 V1.1》§0.2 / §0.3 的变更清单（C1～C32）为准。
>
> ⚠️ **本文所有「推荐方案」都是评审当时的建议稿**，不是最终设计。V1.1 采纳时做过若干调整
> （例：抽取幂等键由 `end_sequence` 改为 `start_sequence`；messages / 摘要定为物理删除）。
> 凡与 `docs/03-database-design.md` 不一致之处，**一律以 03 为准**，不要照抄本文的建议稿。

**文档定位：**
本文档是 D1～D4 四份基线文档的**补充与修订依据**，不替代任何一份基线文档。全文问题均标注原文出处（文档 + 章节 + 行号），便于逐条核对与回写。

**使用方式：**

```text
本文档提出问题与方案
        ↓
人工决策（见第 5 章「待决策清单」）   ← ✅ 已完成
        ↓
回写到 D1 / D2 / D3 / D4 对应章节，并把文档标记为 V1.1   ← D3 已完成（V1.1）
        ↓
再进入编码阶段
```

**当前进度：**

```text
✅ Q1～Q12 已决策（结论见《数据库设计 V1.1》§0.1）
✅ D3 已回写并升为 V1.1（含 C1～C32 变更，见该文档 §0.2 / §0.3）
⬜ D1 / D2 / D4 的修订项已登记在《数据库设计 V1.1》附录 C.2，随 Phase 3 一并处理
⬜ 变更以 D3 的 C 编号为准；本文的「原文证据」仅保留为决策来源（行号说明见上方 ⚠️）
```

---

## 目录

- [1. 评审结论摘要](#1-评审结论摘要)
- [2. 总体判断](#2-总体判断)
- [3. 值得保留的设计（不建议改动）](#3-值得保留的设计不建议改动)
- [4. 问题清单与解决方案](#4-问题清单与解决方案)
  - [4.1 P0 阻塞级（编码前必须解决）](#41-p0-阻塞级编码前必须解决)
  - [4.2 P1 重要级（首个迭代内必须解决）](#42-p1-重要级首个迭代内必须解决)
  - [4.3 P2 改进级](#43-p2-改进级)
  - [4.4 P3 文档一致性修订项](#44-p3-文档一致性修订项)
- [5. 待决策清单](#5-待决策清单)
- [6. 落地路线（建议插入现有开发阶段）](#6-落地路线建议插入现有开发阶段)
- [7. 附录](#7-附录)

---

## 1. 评审结论摘要

| 维度 | 评价 | 说明 |
| ---- | ---- | ---- |
| 文档分层（PRD → 架构 → 数据库 → 接口） | ✅ 良好 | 边界清楚，不互相越层，是正规工程分层 |
| 范围控制 | ✅ 优秀 | 明确砍掉微服务 / K8s / 多 Agent / MCP / 语音 / 移动端 |
| 技术选型 | ✅ 合适 | TypeScript + Fastify + Drizzle + PostgreSQL + pgvector + 模块化单体，与单用户规模匹配 |
| 数据模型骨架 | ⚠️ 有硬伤 | 记忆版本化模型自相矛盾；`events`/`timeline_events` 双写；Goal 双重定义 |
| 算法契约 | ❌ 不足 | 抽取 / 去重 / 冲突 / 排序均只有流程图，缺输入输出定义，无法实现、无法验收 |
| 接口设计 | ⚠️ 基本可用 | 存在路由冲突风险、分页选型问题、SSE 事件契约过薄、视图对象未统一 |
| 可验证性 | ❌ 缺失 | PRD 第 15 节定义 6 项成功指标，但全文未说明「如何测量」 |
| 安全与隐私 | ⚠️ 有缺口 | 「生产环境不得关闭鉴权」但方案待定；缺静态加密 / 删除级联 / 向量残留处理 |
| 工期估算 | ❌ 偏乐观 | 12～16 周，且未为记忆质量评测留出时间预算 |

**一句话结论：**

> 分层思路与工程克制都是对的，作为立项文档质量在平均线以上；但作为「可以照着写代码」的基线，还差最关键的一层——**记忆实例化模型、冲突判定契约、混合检索打分**这三个决定项目成败的算法点，目前都停留在流程图级别。

**优先级分布：**

```text
P0 阻塞级   9 条   ← 不解决就开始编码，会产出需要数据回填的返工
P1 重要级   8 条   ← 首个迭代内必须解决
P2 改进级  14 条   ← 可在实现中修正
P3 一致性   8 条   ← 文档回写即可
```

---

## 2. 总体判断

### 2.1 这份设计「对」在哪里

LifeMate 的四份文档在以下三点上明显优于同类个人项目：

1. **抓住了真问题。** 「记住人，而不是保存聊天记录」不只是口号——它落到了 `memory_sources` 来源追溯（D3 §22–24）、`importance ≠ confidence`（D3 §17）、`Conversation ≠ Memory`（D3 §40）这些具体设计上。
2. **工程克制。** D2 §41/§42 专门写了「为什么现在不用 Redis / 消息队列」，这种「写清楚为什么不」的习惯比「用了什么」更有价值，能有效防止后续被技术名词牵着走。
3. **容错意识。** D4 §45 明确「Memory Extraction 失败不能导致聊天失败」，D2 §39 定义了 LLM 超时降级路径，D4 §37 决定 Agent Tool 不绕自己的 HTTP API 而与 Service 共享业务逻辑——这三条都省掉了后面的大量麻烦。

### 2.2 这份设计「差」在哪里

问题集中在一个模式上：**把「机制」写成了「意图」。**

| 文档写法 | 实际缺的东西 |
| ---- | ---- |
| 「系统应该识别它们是潜在冲突」（D2 §16） | 什么叫冲突？按什么字段判定？判定不确定时怎么办？ |
| 「相似记忆合并」（D1 §8.3） | 相似度阈值多少？合并后保留哪个 `content`？来源怎么并？ |
| `Final Score = 语义×w1 + 重要性×w2 + 时效×w3 + 相关性×w4`（D2 §20） | 各项量纲不同无法相加；关键词通道列了却没有对应权重项 |
| 「对话结束后，系统可以启动 Memory Extraction」（D2 §12） | 「结束」的判定条件？重复触发怎么办？和 Agent 的 `save_memory` 工具谁优先？ |
| 「Memory Precision / Recall」（D1 §15） | 怎么测？测什么数据集？谁标注？ |

这些不是文档不够详细，而是**设计尚未完成**。它们无法通过「把文档写得更长」解决，只能通过**做决策**解决。本文档第 4 章为每一条给出了可决策的具体方案。

---

## 3. 值得保留的设计（不建议改动）

评审中明确建议**保留**的决策，避免在后续修订中被误改：

| 编号 | 决策 | 出处 | 保留理由 |
| ---- | ---- | ---- | ---- |
| K1 | 模块化单体，不做微服务 | D2 §4.1 | 单用户规模下，拆服务产生的复杂度与产品价值无关 |
| K2 | 短期上下文与长期记忆严格分离 | D2 §23 | 大量同类项目在此翻车 |
| K3 | `Conversation ≠ Memory`，通过 `memory_sources` 关联 | D3 §40 | 支撑来源追溯与「为什么你记得这件事」的可解释性 |
| K4 | `importance ≠ confidence` 双评分 | D3 §17 | 「很重要但只是计划」这类场景必须靠两者区分 |
| K5 | Agent Tool 与 HTTP API 共享 Application Service | D4 §37/§38 | 避免 Agent 回调自己的 HTTP 层，减少一次序列化与一类故障 |
| K6 | 抽取失败不影响聊天主链路 | D4 §45 | 主链路与增强链路解耦，正确 |
| K7 | 不引入 Redis / 消息队列 / 复杂 Workflow Engine | D2 §41/§42/§45 | V1.0 不是刚需，且写明了引入时机 |
| K8 | Provider 抽象（LLM 与 Embedding 各自） | D2 §34/§35 | 避免绑定单一厂商 |
| K9 | 软删除 + 保留物理删除能力 | D3 §38 | 既防误删，又不违背用户的删除权 |
| K10 | API 从第一天就带 `/v1` 前缀 | D4 §2 | 后期改接口不必让前端整体重构 |

---

## 4. 问题清单与解决方案

> **阅读说明**
> 每条问题包含：**现象 → 原文证据 → 为什么是问题 → 影响 → 推荐方案 → 验收标准**
> 严重度定义：
> - **P0 阻塞级**：不解决就开始编码，会产生需要数据回填或架构返工的后果。
> - **P1 重要级**：首个迭代内必须解决，否则功能会「看起来能跑但指标不可控」。
> - **P2 改进级**：可在实现过程中修正，影响范围局部。
> - **P3 一致性**：文档回写即可，不涉及设计决策。

---

### 4.1 P0 阻塞级（编码前必须解决）

---

#### P0-1　记忆「版本化」模型自相矛盾，且必须在首次 Migration 前定死

**现象**
系统既要求记忆可演化、可追溯历史、可支撑人生时间线，又把可变的 `content` 和表示历史有效期的 `valid_from / valid_until` 放在同一行上，同时对外暴露「就地 PATCH 记忆内容」的接口。

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D3 | §13.2（第 453–466 行） | `memories` 同表含 `content`、`valid_from`、`valid_until`、`updated_at`、`status` |
| D3 | §18（第 580–618 行） | 用户搬到深圳时：**旧行**写 `valid_until`，**新行**写 `valid_from` |
| D4 | §23（第 674–696 行） | `PATCH /memories/:id` 更新 content → 重算 embedding → 更新 `updated_at` |
| D3 | §15（第 487–514 行） | `status` 含 `superseded` / `archived`，与 `valid_until` / `deleted_at` 语义重叠 |
| D1 | §3.3 / §4.4（第 127–147、190–196 行） | 要求记忆具备「历史版本」并形成个人生活时间线 |

**为什么是问题**

1. **两种语义在同一行上打架。** 一条记忆「用户住在广州，`valid_from=2026-01-01`」被 PATCH 成「用户住在深圳」后，`valid_from` 到底是「这条记忆开始被相信的时间」还是「广州这个事实开始的时间」？两种解释都说得通，代码里必然二义。
2. **历史会被覆盖。** 就地更新 `content` 会永久丢失「系统在过去认为用户住在广州」这一事实。而 D1 §4.4 的「查询过去」场景（「我之前什么时候开始想做这个项目的？」）依赖这句话。
3. **三个字段语义重叠。** `status`（4 值）+ `valid_until` + `deleted_at`：一条 `archived` 且 `valid_until` 已设且 `deleted_at IS NULL` 的记忆，算不算当前有效？文档没有状态转移表，实现者只能猜。
4. **不可逆。** 这是**表结构级选择**，写进第一次 Migration 后再改需要数据回填 + 重算 embedding。

**影响**
检索结果出现重复且互相矛盾的记忆；时间线无法还原真实历史；「记忆演化」退化成一个状态字段摆设；PRD 的 Long-term Consistency 指标无法达标。

**推荐方案（择一，建议 A）**

**方案 A：记忆是不可变事实，永不就地更新（推荐）**

```text
memories 只做 INSERT + 状态字段更新，正文永不原地修改。

时间采用双时间轴（bi-temporal）：
  ├── valid_from / valid_until   客观事实在现实中的有效期（业务时间）
  └── created_at / updated_at    系统何时知道它（记录时间）

新增字段：
  └── superseded_by UUID NULL    指向替代它的那条记忆

判定「当前有效记忆」：
  valid_until IS NULL
  AND superseded_by IS NULL
  AND deleted_at IS NULL
  AND status = 'active'
```

用户在前端 PATCH 一条记忆的行为，在服务层翻译为一次事务：

```text
BEGIN
  ① INSERT 新记忆（新的 content / embedding / valid_from）
  ② UPDATE 旧记忆 SET valid_until = <新记忆 valid_from>, superseded_by = <新记忆 id>
  ③ INSERT memory_sources 记录「本次修改由用户手工发起」（source_type = 'manual'）
COMMIT
```

好处：Timeline、Life Review、「我什么时候开始想做这个项目」全部自然可查；对应用户「修改记忆」的需求；不额外引入版本表。

**方案 B：可变行 + 独立版本快照表**

保留 `memories.content` 可变，另建 `memory_versions(memory_id, version, content, embedding?, created_at, reason)`，每次修改追加一行快照。

优点：前端展示当前态最直接，查询不用过滤历史。
缺点：所有查询必须显式排除历史；快照与主表可能不一致；实现更啰嗦。

**无论选哪个方案，都必须补一张「状态转移表」**，明确唯一真相来源，例如：

| 目标状态 | `status` | `valid_until` | `deleted_at` | 是否可被检索 | 触发者 |
| ---- | ---- | ---- | ---- | ---- | ---- |
| 当前有效 | `active` | `NULL` | `NULL` | ✅ | 抽取 / 用户新建 |
| 已被替代 | `superseded` | 非空 | `NULL` | ❌（可被历史查询） | 抽取冲突解决 |
| 已归档 | `archived` | 非空 | `NULL` | ❌ | 长期未使用降级 |
| 已删除 | `deleted` | 保持原值 | 非空 | ❌ | 用户操作 |

**验收标准**
- [ ] D3 §13 表结构已按选定方案改写，并新增 `superseded_by` 或 `memory_versions`。
- [ ] 文档中存在一张覆盖全部状态组合的状态转移表。
- [ ] 明确写出「就地更新正文」是被禁止的（或明确其约束条件）。
- [ ] 明确写出「当前有效记忆」的判定谓词，且与部分唯一索引一致。

---

#### P0-2　「冲突检测」与「去重」缺少可实现的判定依据

**现象**
去重与冲突检测被定义为系统的核心能力，甚至写入产品成功指标，但两者的判定单位都是「一句自由文本 + 一个 LLM 提示词」。

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D2 | §15（第 658–693 行） | 「系统应该识别它们语义高度相似，并合并」——未给相似度定义与阈值 |
| D2 | §16（第 695–747 行） | 「系统需要区分：真正冲突 / 状态变化 / 可以共存」——未给判定方法 |
| D1 | §8.2/8.3/8.4（第 562–617 行） | 同上，全部为意图描述 |
| D1 | §15（第 912–940 行） | 把 Memory Precision / Noise / Conflict 列为成功标准 |
| D3 | §14（第 470–484 行） | `type` 六类，但无任何属性/槽位概念 |

**为什么是问题**

冲突判定的最小单位不是「一条记忆」，而是**同一槽位上的两个取值**。

```text
记忆 A：用户住在广州
记忆 B：用户已经搬到深圳

字面相似度：低（用词无重叠）
向量相似度：中等（同属「居住地」语义域，但表述差异大）
结论：这两句是冲突的。
```

反例：

```text
记忆 A：用户计划学习 Python
记忆 B：用户现在主要使用 TypeScript

字面相似度：中
向量相似度：高（都属「编程语言」语义域）
真实关系：可以共存，不冲突。
```

**向量相似度无法区分这两种情况**——因为「相似」和「矛盾」是两个正交维度。没有槽位（subject + predicate）信息，系统就没有任何可依赖的确定性依据，只能完全依赖 LLM 的临场判断，而这个判断**不可复现、不可回归测试**，直接导致 D1 §15 的指标无法测量。

**影响**
重复记忆与矛盾记忆累积，违背 PRD 第二目标（「理解越来越准确，而不是越来越混乱」）；Memory Noise 指标随使用时间单调恶化。

**推荐方案**

**① 抽取契约结构化（最小改动、最大收益）**

抽取器的输出从「自由文本」升级为固定 JSON 结构，`content` 仍是给用户看的自然语言，同时额外产出判定用的槽位字段：

```jsonc
{
  "type": "fact",
  "content": "用户住在广州",          // 展示用，自然语言
  "subject_key": "user",             // 规范化主体（V1.0 单用户，可固定）
  "predicate_key": "residence.city", // 规范化槽位，来自受控词表
  "object_value": "广州",             // 规范化取值
  "polarity": "affirm",              // affirm | deny
  "valid_from": "2026-01-01",
  "confidence": 0.9
}
```

**② 判定逻辑变成确定性流程**

```text
候选记忆 → 取 (user_id, subject_key, predicate_key) 相同 且 当前有效的已有记忆
   │
   ├── 无命中 ──────────────→ 新增
   │
   ├── object_value 相同/等价 → 去重：只更新 source_count / confidence / updated_at，
   │                             不新增记录（且不重算 embedding）
   │
   ├── object_value 不同 ────→ 冲突：交给 LLM 只做「三选一」的窄任务
   │                             ├─ 状态变化 → 旧记录置 valid_until + superseded_by
   │                             ├─ 真正冲突 → 标记 conflict，降 confidence，提示用户确认
   │                             └─ 可共存   → 检查 predicate 是否实际不同（词表问题），
   │                                          修正 predicate_key 后按「新增」处理
   │
   └── predicate_key 缺失 ───→ 落入「未分类」桶，只存储不参与冲突判定，
                                 并记录到待补全队列（用于后续词表迭代）
```

**③ 引入受控词表**

`predicate_key` 必须是**预先定义好的枚举**，而不是模型自由生成，否则槽位无法对齐。V1.0 建议先覆盖 15～25 个高频槽位即可：

```text
residence.city          residence.country       employment.company
employment.role         education.school        education.major
skill.learning          interest.hobby          preference.food
preference.communication_style                  health.status
relationship.<name>     goal.long_term          habit.sleep
plan.near_term
```

词表之外的信息不强行归类——宁可漏判，不可错判。

**④ 存储层补充**

```text
memories 新增：
  subject_key    VARCHAR NULL
  predicate_key  VARCHAR NULL   -- 来自受控词表
  object_value   TEXT    NULL
  polarity       VARCHAR NULL
  superseded_by  UUID    NULL   -- 与 P0-1 共用

新增索引：
  INDEX (user_id, subject_key, predicate_key) WHERE status = 'active' AND deleted_at IS NULL
```

**验收标准**
- [ ] 抽取器的输出 schema 已在文档中定义（字段、类型、取值范围）。
- [ ] 冲突判定流程已写成确定性伪代码，LLM 只承担「三选一」的窄任务。
- [ ] 受控词表 v1 已列出，并明确「词表外信息不参与冲突判定」。
- [ ] 有至少 10 组正反例测试（冲突 / 可共存 / 应去重）可以跑回归。

---

#### P0-3　Embedding 维度不是「以后再说」，而是 Migration 当天必须做出的不可逆决定

**现象**
文档认为维度可以在 Migration 阶段再定，并把「不写死维度」当作灵活性的体现。

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D3 | §20（第 642–668 行） | 「不能在当前阶段随便写死一个数字」，「数据库 Migration 时再最终确定」 |
| D3 | §19.2（第 632–638 行） | `memory_embeddings` 只有 `id / memory_id / embedding / model / created_at` |
| D3 | §43（第 1318–1338 行） | 「content 变化 → 重新生成 embedding」，但未说明如何检测陈旧 |
| D3 | §36（第 1105–1127 行） | HNSW / IVFFlat 二选一，依赖维度 |

**为什么是问题**

1. **pgvector 的 `vector(N)` 必须在建表时确定 N**，HNSW / IVFFlat 索引同样绑定维度。所谓「Migration 时再定」等价于「写 Migration 的那个人当天必须拍板」——这不是灵活性，只是把决策往后推，并且推迟到了最不方便的时刻。
2. **没有陈旧向量检测机制。** §43 说「内容变了就重算」，但系统凭什么知道内容变了？缺少被向量化文本的指纹时，任何一次绕过服务层的写入、任何一次重试、任何一次迁移都会静默留下过期向量，而检索会照常返回它们。
3. **`(memory_id, model)` 没有唯一约束**，重复向量会产生重复检索结果，且难以排查。
4. **没有 `stale` 标记**，检索时无处降权，只能返回错误结果。

**影响**
静默的记忆质量事故：用户看到「系统记错了」，但数据库内容其实是对的——错的是向量。这类问题极难定位。

**推荐方案**

**① 在文档中把维度定为冻结决策**

```text
V1.0 冻结 Embedding 模型与维度：
  模型：<待选，见第 5 章 D3>
  维度：<N>
  更换模型 = 一次显式的数据迁移，不是配置项
  文档中删除「Migration 时再定」的表述
```

**② 补全表结构**

```text
memory_embeddings
  ├── id             UUID PK
  ├── memory_id      UUID FK
  ├── model          VARCHAR      -- 例：text-embedding-3-small
  ├── dim            INTEGER      -- 冗余记录，防御性
  ├── embedded_text  TEXT         -- 【新增】被向量化的确切文本快照
  ├── content_hash   VARCHAR      -- 【新增】hash(embedded_text)，用于陈旧检测
  ├── embedding      VECTOR(N)
  ├── created_at     TIMESTAMPTZ
  └── status         VARCHAR      -- 【新增】ready | stale | failed

唯一约束：
  UNIQUE (memory_id, model)
```

**③ 定义陈旧检测与重嵌入流程**

```text
写入路径（统一在 Service 层）：
  memory.content 变化
      ↓
  计算 hash(待嵌入文本)
      ↓
  与 memory_embeddings.content_hash 比较
      ├── 相同 → 不动（避免无谓的 API 花费）
      └── 不同 → 置 status='stale'，投递重嵌入任务

检索路径：
  只召回 status='ready' 的向量
  若某条高分记忆的向量为 stale，返回时降低 confidence 并在日志中告警
```

**④ 明确「嵌入什么文本」**

这是一个必须提前定的效果决策，建议：

```text
embedded_text = "{type}｜{规范化主体}｜{content}｜{时间提示}"

例：
"fact｜用户｜用户住在广州｜2026-01-01 起有效"
```

把类型与时间并入向量文本，通常显著优于只嵌入 `content`，因为「广州」这个词本身不带时间与类型信息。

**验收标准**
- [ ] 文档明确写出冻结的模型名与维度数字。
- [ ] `memory_embeddings` 含 `content_hash`、`embedded_text`、`status` 与 `UNIQUE(memory_id, model)`。
- [ ] 有「陈旧向量如何被发现、如何被修复」的完整流程描述。
- [ ] 明确 `embedded_text` 的拼接规则。

---

#### P0-4　混合检索的评分公式既缺项又不可相加

**现象**
检索方案列出了向量、关键词、元数据、重要性、时效五个通道，但给出的综合公式漏掉了关键词项，且把量纲不同的分数直接加权求和。

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D2 | §20（第 863–900 行） | 列出因含 `Keyword Search`，但公式只有 `Semantic Similarity / Importance / Recency / Relevance` 四项，并称「具体权重在实际测试阶段确定」 |
| D2 | §18（第 789–822 行） | 检索流程含 Query Analysis / Candidate Retrieval / Reranking |
| D3 | §37（第 1131–1155 行） | 检索流程含 Metadata Filtering + Reranking + Top K |
| D1 | §7.3（第 419–453 行） | 「目标不是找最多的记忆，而是找到当前最有用的记忆」 |

**为什么是问题**

1. **列出的通道没有对应分数项。** 第 865 行的 `Keyword Search` 在公式里找不到归属——`Relevance` 是关键词得分吗？文档没定义。这属于设计与公式不一致。
2. **量纲不一致。** 余弦相似度落在 `[-1, 1]`，`importance` 落在 `[0, 1]`，`recency` 若用指数衰减在 `[0, 1]`，三者直接加权求和是典型的 RAG 反模式：权重不可解释，调参变成玄学。
3. **`Recency` 作为独立项会伤害长期记忆。** 两年前的「用户是软件工程师」依然完全有效，却会因「旧」被系统性降权——这与产品「长期记忆」的核心定位直接冲突。
4. **时效的正确形式依赖于记忆类型**，而这点全文未提：

```text
fact        → 几乎不衰减（居住城市、职业、母语）
preference  → 缓慢衰减（饮食偏好、沟通风格）
state       → 快速衰减（最近很累、正在赶项目）
event       → 不衰减，但应按「距今时长」参与排序，而非按「新旧」降权
goal        → 视 status 而定（completed 后停止参与）
```

5. **缺少「检索」与「注入」的分离。** 文档把召回和塞进上下文混为一谈，但没有 token 预算、没有条数上限、没有「召回但不注入」的中间态。

**推荐方案**

**① 采用两阶段：先用 RRF 融合排名，再用归一化打分重排**

```text
阶段一：候选生成（各通道独立，量纲互不影响）
  ├── Vector Top-50
  ├── Keyword Top-50（PostgreSQL 全文 / pg_trgm）
  └── 结构化过滤（type / status / 时间窗 / predicate_key）
        ↓
      RRF 融合：score = Σ 1 / (k + rank_i)      k 取 60
        ↓
      取 Top-30 进入重排

阶段二：重排（各分量先归一化到 [0,1]，再加权）
  final = 0.55 × norm(vector_score)
        + 0.20 × importance
        + 0.15 × type_aware_recency
        + 0.10 × source_count_signal
        （所有权重集中在一个配置文件，便于离线调优）
        ↓
      取 Top-N（默认 8）注入上下文，并受 token 预算约束
```

RRF 的价值在于：**它只依赖排名，不依赖分数分布**，因此完全绕开了量纲问题。先用它把候选收敛，再对少量候选做可解释的加权重排。

**② 时效项按类型区分**

```text
type_aware_recency:
  fact       → 1.0                     （不衰减）
  preference → 0.5 + 0.5 × decay(t)
  goal       → 1.0 if active else 0
  event      → 1.0                     （不降权，按时间排序即可）
  state      → decay(t, 半衰期 14 天)   （快速衰减）
```

**③ 把检索与注入拆成两个可独立测试的单元**

```text
MemoryRetrievalService.search(query, options) → Memory[]（纯检索，可离线评测，有内部接口）
ContextBuilder.inject(memories, budget)       → 受 token 预算裁剪后的上下文片段
```

否则离线评测无法进行——因为指标会被「上下文怎么拼」这一层污染。

**④ 明确过滤与索引的配合**

```text
召回必须带上前置过滤：
  user_id = ?
  AND status = 'active'
  AND deleted_at IS NULL
  AND valid_until IS NULL

注意 pgvector 与前置过滤的交互：
  HNSW 在过滤比例高时召回率下降，V1.0 数据量小，可先「不过度过滤 + 后置过滤」，
  但必须在文档里记录这个已知取舍，而不是当作不存在。
```

**验收标准**
- [ ] 公式已改为 RRF + 归一化重排两阶段。
- [ ] 关键词通道在公式中有明确归属。
- [ ] 时效项按 `type` 区分，且写明「fact 类不衰减」。
- [ ] 检索与注入拆分为两个可独立调用的单元。
- [ ] 权重集中配置，且标注「由离线评测脚本调优」。

---

#### P0-5　`events` 与 `timeline_events` 双表写入是同步地狱

**现象**
同一件事需要同时写入两张表以分别满足「业务实体」与「时间线展示」两种用途，但文档未定义任何同步、重建或补偿机制。

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D3 | §31（第 926–948 行） | 「二者职责不同……这样以后 Timeline 可以聚合」 |
| D3 | §25 / §30（第 768–799、906–923 行） | 两张表各自拥有几乎重复的字段（`title`、`description`、`event_time`、`importance_score`） |
| D3 | §42（第 1287–1315 行） | 强调「避免 Memory 已更新但 Embedding 还是旧的」，主动引入双写风险 |
| D3 | §41（第 1254–1283 行） | 「三者允许独立存在」（Memory / Event / Timeline Event） |

**为什么是问题**

1. **自相矛盾。** §42 刚用事务来防止同类不一致，§31 却主动制造了一个没有一致性保障的双写。
2. **没有重建路径。** 如果 `timeline_events` 因某次 bug 落后于 `events`，没有任何方法能重放恢复——因为 `timeline_events` 里的事件有些并非来自 `events`（可能来自 Memory / Goal），来源不可判定。
3. **`event_id` 可为空的语义不明。** D3 §30 的 `timeline_events.event_id` 是否允许 NULL？如果允许，说明 timeline 有自己的数据源，那它就不是「视图」而是「第二真相」。
4. **接口层暴露了双写。** D4 §28/§29/§30 对 `/timeline` 提供了完整的 POST/PATCH/DELETE，等于把这个风险直接开放给用户操作。

**影响**
时间线出现重复条目、漏条目或与事件详情不一致；用户编辑一个事件后时间线不更新；Life Review 基于两份不一致的数据生成，结论不可信。

**推荐方案**

**方案 A（推荐）：单一 `events` 表 + Timeline 作为查询视图**

```text
events 表（唯一的真相）
  ├── id, user_id
  ├── title, description
  ├── event_time          -- 事件在现实中发生的时间
  ├── category
  ├── importance_score
  ├── source_type         -- conversation | manual | system
  ├── source_message_id   -- 可空，可追溯
  ├── timeline_visible    -- bool，控制是否出现在时间线
  ├── deleted_at
  ├── created_at, updated_at

Timeline = 查询，不是实体：
  SELECT * FROM events
   WHERE user_id = ? AND timeline_visible = true AND deleted_at IS NULL
     AND event_time BETWEEN ? AND ?
   ORDER BY event_time DESC;
```

好处：单一写入路径、无一致性风险、编辑即时生效、可随时重建。

**方案 B：保留双表，但把 `timeline_events` 明确降级为可重建的物化投影**

```text
硬性要求：
  ① timeline_events 必须能从源数据完全重建（提供 rebuild 脚本）
  ② 每次写入走同一事务，或由后台 Job 幂等重建
  ③ timeline_events 不对外提供写接口（删除 D4 §28/§29/§30）
  ④ 文档中明确标注「这是缓存/投影，不是真相」
```

若选方案 B，**D4 的 `/timeline` 写接口必须一并删除或改为操作 `events`**，否则投影会被用户直接改写而失去可重建性。

**附带解决：Goal 的双重定义**

D3 §14 允许 `memory.type = 'goal'`，D3 §26 又有独立的 `goals` 表，D1 §11 也把 `Goal` 与 `Memory` 并列为实体。需要一句话写清边界，建议：

```text
goals 表        = 一等实体，有生命周期状态机（active/paused/completed/cancelled/archived）
memory(type=goal) = goals 的摘要投影，仅供语义检索使用

约束：
  ① 只允许 GoalService 写入 goals 时同步生成/更新对应的 goal 记忆
  ② 不允许抽取器直接创建 type='goal' 的记忆（避免两个入口）
  ③ 文档中写明该字段由系统维护，用户不可直接新建
```

**验收标准**
- [ ] `events` / `timeline_events` 的关系已按方案 A 或 B 明确，并删除了冲突的描述。
- [ ] 若保留双表，文档包含重建脚本的设计与「不可对外写」的约束。
- [ ] `goals` 与 `memory.type='goal'` 的边界与写入责任方已写明。

---

#### P0-6　记忆写入有两个入口，且抽取触发条件未定义

**现象**
系统同时存在「对话结束后自动抽取」与「Agent 主动调用 `save_memory`」两条写入路径，文档从未说明二者分工，也未定义「对话结束」的判定条件与重复触发的防护。

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D2 | §12（第 567–596 行） | 「每次对话结束后，系统可以启动 Memory Extraction」——「可以」含义不明 |
| D2 | §21（第 904–915 行） | Agent 暴露 `save_memory / update_memory / delete_memory` 工具 |
| D4 | §37（第 990–1037 行） | Agent Tool 列表同样包含写操作 |
| D4 | §10（第 259–300 行） | 流程图显示 `API → ... → 返回 API`，之后箭头指向 Memory Extraction |
| D4 | §9.3（第 236–255 行） | `POST /chat` 响应中没有任何抽取状态字段 |
| D4 | §11（第 304–332 行） | `POST /chat/stream` 的「结束」时刻未定义 |
| D1 | §15（第 924–928 行） | Memory Noise（垃圾记忆数量）是成功标准之一 |

**为什么是问题**

1. **必然重复。** 「用户想学 TypeScript」会被自动抽取器写入一次，又可能被 Agent 的 `save_memory` 写入一次；用户网络超时重发消息再抽一次。
2. **抽取不幂等。** 没有唯一键约束「哪一段对话已经被抽取过了」，任何重试、重启、补跑都会重复产出。
3. **流式场景下「结束」不成立。** `POST /chat/stream` 断流后算不算结束？用户打字中途断开呢？
4. **`delete_memory` 由模型调用违背产品原则。** D1 §10.2 明确「不能把推测当成事实」，那么更不应该让模型直接删除用户记忆。
5. **前端无法感知状态。** D4 §9.3 的响应里没有抽取进度，用户刚说完就发下一句时，可能后端还没抽取出记忆，导致「刚说的事它不记得」。

**推荐方案**

**① V1.0 写入路径唯一化：只保留后台抽取流水线**

```text
Agent 工具集（V1.0 只读）：
  ✅ search_memory()
  ✅ get_memory()
  ✅ get_timeline()
  ❌ save_memory()      ← 移除
  ❌ update_memory()    ← 移除
  ❌ delete_memory()    ← 移除

理由：
  ① 写入路径唯一 → Memory Precision 才有意义，才可测
  ② 模型不再有直接篡改用户记忆的能力，符合 D1 §10.2 的产品原则
  ③ 冲突解决逻辑集中在 Memory Engine 一处，不会与 Agent 的自由写入互相打架

删除类操作（无论谁发起）一律走「提议 → 用户确认 → 用户在前端执行」：
  Agent 可以表达「这条记忆似乎已经过时了」，
  但不能自行删除，只能生成一条 pending 提议。
```

**② 新增 `extraction_runs` 表，实现幂等**

> 注意：这与 D4 §43 提到的 `agent_run_id`（可观测性概念）**不是同一件事**。`extraction_runs` 是为**正确性**服务的，属于必须建的表。

```text
extraction_runs
  ├── id                 UUID PK
  ├── conversation_id    UUID FK
  ├── start_sequence     INTEGER
  ├── end_sequence       INTEGER
  ├── extractor_version  VARCHAR      -- 提示词/模型版本，变更后可选择性重跑
  ├── status             VARCHAR      -- pending | running | succeeded | failed | skipped
  ├── memories_created   INTEGER
  ├── memories_updated   INTEGER
  ├── error              TEXT NULL
  ├── created_at         TIMESTAMPTZ
  └── finished_at        TIMESTAMPTZ NULL

唯一约束：
  UNIQUE (conversation_id, end_sequence, extractor_version)
```

这张表的唯一约束就是幂等键：同一次抽取无论被触发多少次，只会真正执行一次；失败后可安全重试；`extractor_version` 变更后可选择性地对历史对话重跑。

**③ 明确「对话结束」的定义**

```text
统一策略（建议）：
  不依赖「结束」，改为「达到触发条件即抽取」

  触发条件（任一满足）：
    ① 对话空闲超过 N 分钟（默认 5）
    ② 未抽取的消息数达到 M 条（默认 10）
    ③ 用户显式请求（"记住这个"）
    ④ 会话被归档 / 被关闭

  对 POST /chat/stream：
    以「这一轮 assistant 消息完整落库」为抽取边界，
    抽取作为该轮的后置异步任务，不阻塞响应，
    且以 (conversation_id, end_sequence=本轮最后一条消息的 sequence) 作为幂等键。
```

**④ 前端可见的抽取状态**

```text
POST /chat 响应扩展：
  "extraction": {
    "status": "pending" | "completed" | "skipped",
    "run_id": "uuid"
  }

并提供一个查询接口：
  GET /api/v1/memories/extraction-status?conversation_id=<uuid>

用途：
  ① 前端可以显示「正在整理记忆…」
  ② 调试与离线评测可以确定抽取是否已完成
```

**验收标准**
- [ ] V1.0 的写工具已被移除或明确标注为「V2 再启用」。
- [ ] `extraction_runs` 表已加入 D3 的最终表清单（表数量随之更新）。
- [ ] 「对话结束」被替换为可判定的触发条件集合。
- [ ] `POST /chat` 响应包含抽取状态，并有对应的查询接口。

---

#### P0-7　Agent Loop 缺少终止条件与副作用防护

**现象**
Agent Loop 的伪代码只有「有工具调用就继续循环」，没有任何上界与防护。

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D2 | §8.1（第 377–400 行） | `while (response.toolCalls?.length) { ... }` —— 无迭代上限 |
| D2 | §21（第 904–965 行） | 工具集包含 `delete_memory` 等有副作用的操作 |
| D4 | §49（第 1386–1399 行） | 要求「对 LLM 请求设置超时」，但 Loop 层无对应约束 |
| D2 | §39（第 1511–1536 行） | 定义了错误分类与重试，但未说明重试与工具副作用的交互 |

**为什么是问题**

1. **`while` 无上限。** 模型如果陷入「调用工具 → 得到结果 → 再调用同一工具」的循环，会产生无限 LLM 调用与费用。
2. **重试会重复副作用。** LLM 调用失败重试时，之前已执行的 `save_memory` 是否重放？没有说明。
3. **无预算控制。** 没有单轮 token 上限、没有工具调用次数上限、没有整体超时。

**影响**
费用失控、请求挂起、重复写入、极端情况下服务不可用。

**推荐方案**

```text
V1.0 Agent Loop 必须显式约束（写入 D2 §8）：

  MAX_ITERATIONS        = 5      // 工具调用轮次上限
  MAX_TOOL_CALLS        = 10     // 单轮执行工具调用总数上限
  MAX_TOOL_RESULT_CHARS = 8000   // 单个工具结果注入上限（超出则截断并标记）
  LOOP_TIMEOUT_MS       = 60000  // 整个 Agent 执行超时
  TOOL_TIMEOUT_MS       = 10000  // 单个工具超时

  达到任一上限 → 停止循环，用已有信息生成回答，
                 并在 metadata 中标记 "loop_truncated": true

副作用幂等：
  每个工具调用携带 (agent_run_id, tool_call_id) 作为幂等键
  重试时同一 tool_call_id 不重复执行副作用
```

**验收标准**
- [ ] D2 §8.1 伪代码已补上迭代上限与超时。
- [ ] 各上限的具体数值已写入文档并集中配置。
- [ ] 副作用幂等策略（幂等键）已明确。
- [ ] 截断行为（继续生成回答 vs 报错）已定义。

---

#### P0-8　没有认证方案，但要求「生产环境不得关闭鉴权」

**现象**
系统保存的是用户全部私人生活数据，鉴权却被推迟到「部署阶段确定」，仅规定本地可关闭、生产不可关闭。

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D4 | §41（第 1146–1166 行） | 「具体鉴权方案在部署阶段确定」「本地开发环境可以暂时关闭」 |
| D2 | §40（第 1540–1566 行） | 部署为 Docker Compose |
| D2 | §37（第 1453–1487 行） | 强调数据高度私密、要求数据最小化 |
| D1 | §12.1（第 757–772 行） | 隐私为高优先级要求 |

**为什么是问题**

Docker Compose 部署意味着服务监听端口。**一旦绑到 `0.0.0.0` 或放到有公网 IP 的机器上，整个记忆库就是公开可读写的**——包括用户的情绪、人际关系、健康抱怨。对这类数据，「以后再补鉴权」的窗口期风险与收益完全不成比例。

**推荐方案（V1.0 最小可用，不做多用户）**

```text
① 传输层
   强制 HTTPS（反向代理终止 TLS）
   开发环境 HTTP 可以，但不得使用真实敏感数据

② 认证
   单用户 + 长期 token（或密码换 session cookie）
   所有 /api/v1/* 默认要求认证，白名单仅 /health 与 /api/docs（生产建议关闭 docs）

③ 网络
   Docker Compose 默认只绑 127.0.0.1
   如需远程访问，明确要求走 HTTPS + 认证，并在部署文档中作为前置条件

④ 文档修订
   D4 §41 的「部署阶段确定」改为直接给出方案；
   「本地开发可以关闭」改为「通过环境变量 AUTH_DISABLED=true 显式关闭，
   启动日志打印醒目警告」
```

**验收标准**
- [ ] D4 §41 已写明具体鉴权方案，而非待定。
- [ ] 默认端口绑定策略写入部署文档。
- [ ] 认证开关为显式环境变量，默认开启。

---

#### P0-9　成功指标无法测量——缺少评测集与离线评测流程

**现象**
PRD 定义了 6 项产品成功指标，全部与记忆质量有关，但四份文档没有任何一处说明如何计算这些数字。架构中「测试 / Benchmark」仅占 Phase 8 的一行。

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D1 | §15（第 898–948 行） | 六项指标：Precision / Recall / Noise / Conflict / Consistency / UX |
| D1 | §16（第 950–994 行） | Phase 8 仅一行「测试 / Benchmark」；总工期 12～16 周 |
| D2 | §38（第 1490–1508 行） | 日志字段清单，但无检索/抽取质量的记录项 |
| D1 | §12.4（第 826–841 行） | 提出「为什么这个记忆没有被召回？」，但无实现路径 |

**为什么是问题**

1. **指标不可测 = 不可优化。** 「记忆研究占很大比例」（D1 §16）这句话成立的前提是有一个可反复运行的度量。没有它，提示词调优就是盲调，无法判断改动是变好还是变坏。
2. **回归风险。** 修改抽取提示词修好了 A 场景却弄坏了 B 场景，没有评测集就发现不了。
3. **工期缺乏依据。** Phase 8 只有一行，却承担了决定项目成败的验证工作，工期内没有为「评测 → 迭代」循环留出时间。

**推荐方案**

**① 建立金标数据集（Golden Set）**

```text
规模：50～100 条（不必多，但要准）
来源：真实（脱敏后）或精心构造的对话片段

每条样本标注：
  ├── input：对话片段（1～N 条消息）
  ├── should_extract：true | false
  ├── expected_type：fact | preference | event | goal | state | relationship | null
  ├── expected_content（语义等价的多个可接受答案）
  ├── related_existing：相关联的已有记忆 id（用于测去重/冲突）
  └── expected_relation：duplicate | conflict | coexist | none

其中必须包含针对性的难例：
  ├── 强冲突但字面不像（"住在广州" vs "搬到深圳"）
  ├── 高相似但不冲突（"计划学 Python" vs "在用 TypeScript"）
  ├── 应去重的四种同义表述（对应 D1 §8.3 的例子）
  ├── 不应被记忆的闲聊（"今天中午吃了个鸡腿"）
  └── 情绪表达不应被诊断为事实（对应 D1 §10.2）
```

**② 离线评测脚本**

```text
输入：金标数据集
执行：直接调用 Memory Engine（不走 HTTP、不依赖 UI）
输出：

  Extraction Precision / Recall / F1
  Type Accuracy                    （类型判定正确率）
  Dedup Accuracy                   （应合并的是否合并）
  Conflict Detection Precision/Recall
  Noise Rate                       （金标中不应抽取却被抽取的比例）
  Retrieval Recall@8               （应当被召回的，有多少真的进了 Top-8）
  Retrieval p95 延迟
  单次对话的平均 token 成本

要求：
  ① 一次命令跑完，输出可对比的 JSON + Markdown 报告
  ② 每次改动抽取提示词 / 检索权重后必须重跑
  ③ 报告归档，形成可以看趋势的历史记录
```

**③ 把评测前移**

```text
D1 §16 的阶段调整为：

  Phase 2  工程基础
           └── 【新增】金标数据集 v1 + 评测脚本骨架   ← 提前到这里
  Phase 4  Memory V1
           └── 【新增】抽取/去重指标达标门槛
  Phase 5  Memory Intelligence
           └── 【新增】冲突检测与检索指标达标门槛
  Phase 8  测试 / Benchmark
           └── 收敛为「端到端验证」而非「从零开始搭评测」
```

**④ 补齐非功能需求的具体数字**

D1 §12.4 与 D2 §38 只列了要记录什么，建议直接给出目标值：

```text
检索 p95 延迟         < 300 ms（不含 LLM）
首 token 延迟         < 1.5 s
单轮对话成本上限       < ¥0.5
上下文记忆注入预算     < 2000 tokens
抽取失败率            < 2%
```

**验收标准**
- [ ] 金标数据集 v1 已存在于仓库，含难例分类。
- [ ] 一条命令可输出全部质量指标的报告。
- [ ] 开发阶段已插入评测相关任务，且不再集中在 Phase 8。
- [ ] NFR 有具体数字，而非仅「需要记录」。

---

### 4.2 P1 重要级（首个迭代内必须解决）

---

#### P1-1　删除级联规则未定义：删了会话，派生记忆怎么办

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D3 | §39（第 1188–1206 行） | 「可以根据删除策略进行级联处理」——未定义策略 |
| D3 | §38（第 1159–1184 行） | Memory 软删除，并承诺「用户明确要求永久删除时提供物理删除」 |
| D4 | §16（第 469–484 行） | `DELETE /conversations/:id` 默认软删除，未提记忆 |
| D2 | §37（第 1478–1486 行） | 承诺支持删除「单条 Memory / 整个 Conversation / 全部个人数据」 |

**为什么是问题**
用户删除一段私密对话，是期望「这段内容不再存在」。但由它派生的记忆会以「用户……（无来源）」的形式继续存在，甚至继续被召回并出现在回答里——这直接违背用户的删除意图，是隐私事故。

**推荐方案**

```text
删除 Conversation 时提供两种语义，默认第一种：

  ① 级联失效（默认）
     - messages / summaries 软删除
     - 由这些消息派生的 Memory：
         若 memory_sources 全部指向被删消息 → 一并置 deleted
         若仍有其他来源             → 保留，但移除指向被删消息的 source
     - 被失效 Memory 的 embedding 置 status='deleted'，不再参与召回
     - 返回给前端「本次删除了 N 条派生记忆」

  ② 仅删对话
     - 保留全部 Memory（适用于「只是想清理聊天列表」）
     - 前端需明确提示差异

无论哪种，Memory Viewer 中「来源」不可解析时必须显式显示
「原始对话已删除」，而不是显示空白或错误。
```

**验收标准**
- [ ] 级联策略已定义，且区分「级联失效」与「仅删对话」。
- [ ] `DELETE /conversations/:id` 文档中说明了派生记忆的处理方式与返回信息。
- [ ] 明确 embedding 随记忆失效的处理。

---

#### P1-2　软删除的检索侧语义未定义

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D3 | §38（第 1159–1184 行） | 只说明软删除「防止误删、支持恢复」 |
| D3 | §37（第 1131–1155 行） | 检索流程中无 `deleted_at` / `status` 过滤 |
| D2 | §18（第 789–822 行） | 检索流程同样无删除态过滤 |
| D4 | §25（第 722–738 行） | 提供 restore 接口，但未说明恢复后 embedding 是否可用 |

**为什么是问题**
仅写入 `deleted_at` 而不从所有召回路径排除，会出现「用户删了记忆，Agent 依然提起」——这是最容易被用户察觉、也最伤信任的一类 bug。此外，向量库中的向量若不标记状态，语义检索会照常命中。

**推荐方案**

```text
统一约束（写入 D3 §37 与 D2 §18）：

  所有召回路径（向量 / 关键词 / 结构化 / 重排）在 SQL 层面必须包含：
    status = 'active'
    AND deleted_at IS NULL
    AND valid_until IS NULL      （按 P0-1 选定方案）
    AND superseded_by IS NULL

  软删除时同步：memory_embeddings.status = 'deleted'
  恢复时同步：  memory_embeddings.status = 'ready'

  离线评测脚本使用同一套过滤条件（避免评测与线上不一致）

  建议以数据库视图或 Repository 的统一默认条件实现，
  禁止在业务代码里手写过滤（否则必然漏）
```

**验收标准**
- [ ] 召回过滤条件在文档中集中定义一次，并被检索与评测共同引用。
- [ ] 软删除 / 恢复同步处理 embedding 状态。
- [ ] 明确「禁止业务代码手写过滤」的约束。

---

#### P1-3　`messages.sequence` 的并发竞态

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D3 | §10.4（第 345–364 行） | 用 `sequence` 保证顺序，但未给唯一约束与生成方式 |
| D3 | §35（第 1058–1064 行） | 索引有 `conversation_id + sequence`，但非唯一 |
| D3 | §42（第 1287–1315 行） | 强调事务一致性，但未覆盖 sequence |
| D4 | §11（第 304–332 行） | 流式响应与抽取可能并发写消息 |

**为什么是问题**
`MAX(sequence) + 1` 是读-改-写，两个并发写入会得到相同 sequence。流式响应 + 后台抽取 + 用户快速连发，正是并发场景。

**推荐方案**

```text
二选一：

  ① 复合唯一约束（推荐）
     UNIQUE (conversation_id, sequence)
     配合事务内的 SELECT ... FOR UPDATE 或重试

  ② 会话内单调列
     使用 BIGSERIAL 全局单调，前端展示时按 (conversation_id, id) 排序
     （简单，且天然无竞态；代价是 sequence 不再从 1 开始）

  明确写入 D3 §10.4，并说明 conversation_summaries 的
  start_sequence / end_sequence 引用的是哪一种序列。
```

**验收标准**
- [ ] `(conversation_id, sequence)` 有唯一约束，或 `sequence` 改为数据库生成的单调列。
- [ ] `conversation_summaries` 的 sequence 语义与之统一。

---

#### P1-4　`users` 表无法承载 Context Builder 需要的 User Profile

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D2 | §9（第 412–453 行） | 上下文结构含 `User Profile`，并注入 LLM |
| D3 | §8.2（第 241–250 行） | `users` 只有 `id / name / timezone / created_at / updated_at` |
| D1 | §11（第 715–751 行） | 实体清单中没有 Profile |
| D4 | §34（第 918–942 行） | Settings 返回 model / memory / timezone，无 profile |

**为什么是问题**
架构要求注入 `User Profile`，但数据模型中不存在这个实体。实现时必然临时把偏好塞进 `users`（改表）或塞进 `memories`（污染记忆质量指标）。这是一个「文档之间对不上」的缺口。

**推荐方案**

```text
明确二选一：

  ① 扩展 users 表
       + display_name, locale, communication_style, response_length_preference,
         occupation, custom_instructions, updated_at
     适合：少量、稳定、用户可编辑的配置项

  ② 明确由 Memory 承担，并在 D2 §9 中把 "User Profile" 改名为
     "Top Memories / 关键记忆摘要"
     即：上下文中的用户画像 = 从高 importance 的 Memory 动态聚合而来
     适合：希望画像随时间自然演化

  建议：采用 ① + ② 组合
    - 静态配置（语言、风格、称呼）放 users
    - 动态认知（职业变化、当前目标）放 Memory
    并在文档中写明各自边界，避免实现时随意放置
```

**验收标准**
- [ ] `User Profile` 的数据来源已明确（表结构或由 Memory 聚合）。
- [ ] Context Builder 的输入清单与实际表结构一致。
- [ ] Settings API 返回的字段与 users 表一致。

---

#### P1-5　抽取时机与流式的交互、以及前端状态可见性

> 本条的**方案**已在 P0-6 中给出（触发条件集合 + `extraction.status` + 状态查询接口）。此处仅补充接口层面的必改项，避免重复。

**D4 需同步修改**

| 位置 | 现状 | 修改 |
| ---- | ---- | ---- |
| §9.3（第 236–255 行） | 响应只有 `conversation_id` + 两条消息 | 增加 `extraction` 字段（status / run_id） |
| §11（第 304–332 行） | SSE 只有 `token` / `done` | 增加 `error` / `usage` / `extraction` 事件；`done` 必须携带消息 id |
| §10（第 259–300 行） | 流程图末段箭头指向抽取 | 标注「异步、不阻塞响应、幂等」 |

**验收标准**
- [ ] `POST /chat` 与 `/chat/stream` 的响应契约包含抽取状态。
- [ ] SSE 事件类型清单完整（含错误与用量）。
- [ ] 抽取的异步语义在流程图中标注清楚。

---

#### P1-6　`memory_sources` 缺失相关索引与外键约束

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D3 | §23（第 712–722 行） | 定义 `memory_sources` 字段 |
| D3 | §35（第 1031–1103 行） | 索引清单中**完全未提及** `memory_sources` |
| D3 | §48（第 1449–1480 行） | 最终表清单声明 11 张，但未列出 `memory_sources`（见 P3-2） |

**为什么是问题**
删除会话时需要反查「哪些记忆派生于这条消息」（P1-1），没有反向索引会全表扫描；来源追溯是产品的核心卖点，却没有任何索引支撑。同时缺唯一约束会让同一 (memory, message) 重复插入。

**推荐方案**

```sql
CREATE UNIQUE INDEX ON memory_sources (memory_id, message_id);

CREATE INDEX ON memory_sources (message_id);          -- 支撑删除级联
CREATE INDEX ON memory_sources (memory_id);           -- 支撑来源展示

外键：
  memory_id  → memories(id) ON DELETE CASCADE
  message_id → messages(id) ON DELETE RESTRICT（或 SET NULL，需与 P1-1 策略一致）
```

**验收标准**
- [ ] `memory_sources` 出现在索引清单中，含上述三项。
- [ ] 外键删除行为与 P1-1 的级联策略一致。

---

#### P1-7　缺少关键字检索的数据库层设计

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D2 | §20（第 863–900 行） | 明确要求 `Keyword Search` |
| D3 | §35（第 1031–1103 行） | 索引清单中没有任何全文检索索引 |
| D3 | §3.1（第 88–89 行） | 仅泛泛提到「索引体系成熟」 |
| D4 | §20（第 566–595 行） | `/memories/search` 有 `q` 参数，但实现方式未定 |

**为什么是问题**
混合检索的两条腿只能落地一条。而且中文场景下 PostgreSQL 默认的全文检索配置不支持中文分词，直接照搬会得到「关键词通道形同虚设」的结果。

**推荐方案**

```text
中文场景建议（按实现成本排序）：

  ① pg_trgm + GIN（推荐起步）
     - 无需分词器，对中文按字符三元组匹配
     - 适合短文本（记忆内容通常 1～2 句）
     - CREATE INDEX USING gin (content gin_trgm_ops);

  ② pg_bigm
     - 对中文/日文更友好，但需额外扩展

  ③ 应用层分词（jieba 等）后写入 tsvector
     - 效果最好，成本最高，建议 V2

  V1.0 建议：① + 记忆条数不大时直接 ILIKE 也可接受
  但必须在文档中记录选型与理由，而不是留白
```

**验收标准**
- [ ] D3 §35 增加关键词检索的索引方案。
- [ ] 明确中文分词的取舍与理由。
- [ ] Keyword 通道有对应的分数项进入检索公式（与 P0-4 联动）。

---

#### P1-8　缺少数据库约束与完整性设计

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D3 | 全文 | 未出现任何 `CHECK` / `NOT NULL` / `UNIQUE` 约束的定义 |
| D3 | §16/§17（第 518–578 行） | `importance_score` / `confidence_score` 声明 0.0～1.0，但无 CHECK |
| D3 | §14（第 470–484 行） | `type` 六类，但无约束保证 |
| D3 | §15（第 487–514 行） | `status` 四类，同样无约束 |
| D3 | §27（第 836–844 行） | `goals.status` 五类，同样无约束 |

**为什么是问题**
数据库文档只描述了「类型」，没有描述「约束」。实现时 Drizzle schema 通常也不会自动补 CHECK，最终靠应用层自觉——而应用层是最不可靠的一层（脚本、迁移、手工修数据都会绕过）。

**推荐方案**

```sql
-- 枚举用 CHECK 兜底（V1.0 单用户，不必上原生 ENUM，改起来麻烦）
CHECK (type IN ('fact','preference','event','goal','relationship','state'))
CHECK (status IN ('active','superseded','archived','deleted'))
CHECK (importance_score BETWEEN 0 AND 1)
CHECK (confidence_score BETWEEN 0 AND 1)
CHECK (polarity IN ('affirm','deny') OR polarity IS NULL)

-- 时间一致性
CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)

-- 状态与字段的一致性（配合 P0-1 的状态转移表）
CHECK (status <> 'deleted' OR deleted_at IS NOT NULL)

-- 必填
NOT NULL: user_id, type, content, status, created_at, updated_at
```

**验收标准**
- [ ] D3 新增一节「约束设计」，列出全部 CHECK / NOT NULL / UNIQUE。
- [ ] 约束与状态转移表（P0-1）一致。

---

### 4.3 P2 改进级

---

#### P2-1　`/memories/search` 与 `/memories/:id` 的路由关系需要显式约束

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D4 | §19（第 538–540 行） | `GET /api/v1/memories/:id` |
| D4 | §20（第 568–570 行） | `GET /api/v1/memories/search` |
| D4 | §50（第 1424–1433 行） | 两个端点并列列出 |

**说明**
Fastify 使用 radix tree 路由，静态段优先于参数段，因此 `/memories/search` 会正确命中，**不会**被 `:id` 吞掉。但文档层面仍应加约束，因为：
1. 换路由库、加代理、或前端拼接时容易出错；
2. `search` 成为一个隐式保留字，未来新增 `/memories/favorites` 之类的静态路径会踩同样的坑。

**推荐方案**

```text
二选一：

  ① 保持现状，但文档中加约束说明：
     - `:id` 必须做 UUID 格式校验（否则 "search" 会进入 id 分支）
     - 明确列出 `memories` 下的保留字清单

  ② 移出同级（更稳妥）：
     GET /api/v1/memories:search
     或 GET /api/v1/memory-search
     或统一为 GET /api/v1/memories?q=xxx（合并到列表接口）
```

**验收标准**
- [ ] 保留字约束或路径调整已写入 D4。
- [ ] `:id` 参数的 UUID 校验在文档中明确要求。

---

#### P2-2　分页选型：消息列表应使用游标分页

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D4 | §8（第 162–191 行） | 统一使用 `?page=1&page_size=20` |
| D4 | §14（第 411–436 行） | 消息列表同样使用 offset 分页 |
| D3 | §10.4（第 354–364 行） | 消息是持续追加的序列 |

**为什么是问题**
Offset 分页在数据持续追加时会**重复或漏条**：用户在第 1 页停留期间新消息插入，翻到第 2 页时会看到第 1 页末尾的重复内容。聊天消息恰恰是最典型的追加型时间序列。

**推荐方案**

```text
按数据性质区分：

  追加型时间序列（messages、timeline events、memories 按时间）
    → 游标分页
      GET /conversations/:id/messages?before_sequence=100&limit=50
      返回 { items, next_cursor, has_more }

  低频管理型列表（conversations 列表、memories 管理页）
    → offset 分页可接受，但建议补 total 之外同时返回 has_more

  检索型（/memories/search）
    → 只返回 Top-K，不用分页
```

**验收标准**
- [ ] D4 §8 区分两种分页策略并说明适用场景。
- [ ] 消息接口改为游标分页。

---

#### P2-3　SSE 事件契约过薄

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D4 | §11（第 304–332 行） | 只有 `token` 与 `done` 两种事件 |

**为什么是问题**
缺少错误事件会导致流中断时前端无法区分「正常结束」与「服务异常」；缺少 `done` 携带的消息 id 会导致前端无法对上数据库记录；缺少用量与工具调用信息，无法实现调试视图。

**推荐方案**

```text
事件类型（建议最小集合）：

  data: {"type":"start","conversation_id":"...","message_id":"..."}
  data: {"type":"token","content":"可以"}
  data: {"type":"tool_call","name":"search_memory","status":"running"}
  data: {"type":"memory_used","memory_ids":["..."]}       // 可选，用于可解释性 UI
  data: {"type":"usage","input_tokens":123,"output_tokens":456}
  data: {"type":"error","code":"LLM_ERROR","message":"AI 服务暂时不可用"}
  data: {"type":"done","message_id":"...","extraction":{"status":"pending"}}

补充约定：
  - 每个事件带 event: 名称以便前端用 EventSource 分派
  - 心跳（: keep-alive）防止代理断连
  - 客户端断开时服务端必须中止 LLM 调用（避免白花钱）
```

**验收标准**
- [ ] D4 §11 列出完整事件类型与字段。
- [ ] 心跳与客户端断开处理已说明。

---

#### P2-4　Memory 视图对象未统一定义

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D4 | §18（第 510–532 行） | 列表项含 `valid_from` / `valid_until`，不含 `sources` |
| D4 | §19（第 544–561 行） | 详情含 `sources`，不含 `valid_from` / `valid_until` |
| D4 | §22（第 658–669 行） | 创建响应含 `status`，不含时间字段与 `sources` |
| D4 | §20（第 581–594 行） | 搜索响应只有 5 个字段，且用 `score` |

**为什么是问题**
前端需要为同一实体处理四种不同的形状，TypeScript 类型无法复用，容易在字段缺失时崩溃。

**推荐方案**

```text
在 D4 中定义一次实体视图，其余接口引用：

  MemoryView（完整）
    id, type, content, importance_score, confidence_score, status,
    valid_from, valid_until, created_at, updated_at,
    subject_key, predicate_key, object_value,       // 若采纳 P0-2
    sources?: MemorySourceView[],
    score?: number                                   // 仅检索接口返回

  MemoryListItem = Pick<MemoryView, 'id'|'type'|'content'|'importance_score'
                                  |'confidence_score'|'status'|'updated_at'>

  规则：
    - 列表接口统一返回 MemoryListItem
    - 详情/创建/更新统一返回 MemoryView
    - 检索接口返回 MemoryListItem & { score: number }
    - sources 仅在详情接口返回（列表不返回，避免 N+1）
```

**验收标准**
- [ ] D4 有独立的「视图对象定义」章节。
- [ ] 所有 Memory 相关接口的响应与该定义一致。

---

#### P2-5　错误码表与错误处理策略不匹配

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D4 | §5（第 109–120 行） | 定义了 `409 CONFLICT` |
| D4 | 全文 | 没有任何接口使用 `409` |
| D4 | §44（第 1220–1255 行） | LLM 错误返回 `LLM_ERROR`，HTTP 状态未指明（表中为 502） |
| D4 | §45（第 1259–1293 行） | 抽取失败静默处理，但错误码表中无对应项 |

**推荐方案**

```text
  ① 记忆冲突是 409 的天然用户：
     PATCH /memories/:id 若触发冲突且需用户裁决 → 409 + 冲突详情

  ② 明确各错误码的触发点（在表中增加「使用场景」列）

  ③ 补充缺失错误码：
     EXTRACTION_FAILED     （抽取失败，非致命，可能只在日志与状态接口中出现）
     EMBEDDING_ERROR       （向量化失败）
     IDEMPOTENCY_CONFLICT  （幂等键重复但参数不同）

  ④ 明确「静默失败」的边界：
     抽取失败不返回给 chat，但必须可在状态接口与日志中查到
```

**验收标准**
- [ ] 错误码表增加「使用场景」列，且每个错误码至少被一处使用。
- [ ] 补充缺失错误码。

---

#### P2-6　幂等性只覆盖了 Chat，且没有统一定义

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D4 | §46（第 1297–1329 行） | 仅讨论 Chat 的 `Idempotency-Key`，且称「V1.0 实现时纳入」 |
| D4 | §22/§28（第 634、808 行） | `POST /memories`、`POST /timeline` 同样是一次性写操作 |

**推荐方案**

```text
统一定义（写入 D4 §46）：

  适用端点：所有 POST / PATCH
  请求头：  Idempotency-Key: <uuid>（客户端生成）

  服务端行为：
    - 记录 (key, endpoint, request_hash, response, created_at)，TTL 24h
    - 相同 key + 相同 request_hash → 直接返回缓存响应
    - 相同 key + 不同 request_hash → 409 IDEMPOTENCY_CONFLICT
    - 无 key → 照常执行（不强制）

  V1.0 可不建表，用一张轻量 idempotency_keys 表或内存缓存即可；
  但抽取流水线自身的幂等由 extraction_runs 保证（见 P0-6），二者互补。
```

**验收标准**
- [ ] D4 §46 覆盖所有写端点，并给出服务端行为定义。
- [ ] 明确与 `extraction_runs` 幂等的分工。

---

#### P2-7　缺少性能、成本、备份等非功能目标

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D1 | §12（第 755–841 行） | 非功能需求只覆盖隐私、可迁移、可替换模型、可观测性 |
| D2 | §38（第 1490–1508 行） | 只说明「记录什么」，未说明「达到什么水平」 |
| D3 | §46（第 1396–1416 行） | 建议定期 `pg_dump`，但无频率、无保留策略、无恢复演练 |
| D1 | §15（第 942–947 行） | 用户体验指标只有定性描述 |

**推荐方案**

```text
在 D1 新增「非功能指标」小节（数值为 V1.0 目标，非承诺）：

  性能
    检索 p95（不含 LLM）      < 300 ms
    首 token 延迟             < 1.5 s
    单轮对话端到端 p95        < 8 s
    抽取单次耗时              < 10 s

  成本
    单轮对话 token 上限       输入 < 8k，输出 < 2k
    单轮对话成本上限           < ¥0.5
    记忆注入预算              < 2000 tokens

  容量
    V1.0 预期记忆条数          < 50,000（单用户数年量级）
    预期消息条数              < 500,000
    （据此判断 pgvector 是否需要调参、是否要分区）

  可靠性
    抽取失败率                < 2%
    LLM 调用失败重试          最多 2 次，指数退避
    降级策略                  检索失败 → 无记忆回答；抽取失败 → 仅记录

  备份
    pg_dump 频率              每日
    保留                      ≥ 30 天
    异地                      ≥ 1 份
    恢复演练                  每季度 1 次（并记录耗时）
    备份加密                  必须（含用户私密数据）
```

**验收标准**
- [ ] D1 或 D2 有量化的非功能指标。
- [ ] 备份策略含频率、保留、加密、恢复演练。

---

#### P2-8　隐私设计缺少「出网数据」与「静态加密」

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D1 | §12.1（第 757–772 行） | 隐私要求：数据默认私有、API Key 不进库、日志不记完整聊天 |
| D2 | §37（第 1453–1487 行） | 数据最小化 / 可导出 / 可删除 |
| D2 | §1.1 与 §50 | 使用外部 LLM API（云端） |
| D3 | §45（第 1369–1392 行） | 导出为明文 JSON |

**为什么是问题**
「数据默认私有」在架构上是矛盾的：**用户最私密的情绪与人际关系内容会被发送到第三方 LLM API，并被写入 Embedding API 的请求**。这一点在文档中完全没被提及，而它恰恰是这个产品最大的隐私暴露面。此外，导出为明文 JSON 也存在泄露风险。

**推荐方案**

```text
  ① 出网数据透明化（必须有）
     - 在 Settings / 隐私说明中列出「哪些数据会发送到哪个 Provider」
     - 提供 Local Model / Local Embedding 选项作为隐私模式（D2 §35 已有抽象层，落地即可）
     - 提供「敏感记忆标记」：标记后的记忆不参与云端 embedding，只用本地模型或关键词检索

  ② 日志脱敏规则具体化
     - 定义「永不记录」字段清单（message.content、memory.content、relationship.name）
     - 使用结构化日志 + 白名单，而不是黑名单过滤
     - 开发环境也需要默认脱敏（避免样例数据泄露到日志文件）

  ③ 静态加密
     - 数据库磁盘加密（或至少宿主目录加密）
     - 备份文件强制加密（与 P2-7 联动）

  ④ 导出安全
     - 导出文件默认加密（密码短语）或明确提示「导出内容为明文，请妥善保管」
     - 提供「仅导出记忆、不含原始对话」的选项（隐私友好）

  ⑤ 文档修订
     D1 §12.1 增加「出网数据披露」与「隐私模式」两条要求。
```

**验收标准**
- [ ] 文档明确列出数据会发送到哪些外部服务。
- [ ] 日志脱敏使用白名单机制。
- [ ] 备份与导出有加密方案或明确的风险提示。
- [ ] 至少存在一条「不依赖云端」的降级路径。

---

#### P2-9　缺少 Context 预算与工具结果裁剪

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D2 | §9（第 412–453 行） | Context 结构列出了组成，但没有 token 预算 |
| D2 | §24（第 1036–1057 行） | 摘要用于降低 token，但无触发阈值 |
| D2 | §21.1（第 919–925 行） | `search_memory` 无返回条数上限 |
| D4 | §49（第 1393–1399 行） | 要求限制 payload 大小，但未涉及上下文 |

**推荐方案**

```text
在 D2 §9 明确「上下文预算表」：

  System Prompt            ≤ 800 tokens
  User Profile / 画像       ≤ 300 tokens
  Relevant Memories        ≤ 2000 tokens（默认最多 8 条）
  Recent Conversation      ≤ 3000 tokens（默认最近 N 条，超出则触发摘要）
  Tool Definitions         ≤ 500 tokens
  Current User Message     ≤ 2000 tokens
  ────────────────────────────────────────
  合计上限                  ≤ 8600 tokens

超预算时的裁剪顺序（从先裁到后裁）：
  ① Recent Conversation 的中间段（保留首尾）
  ② Relevant Memories 的低分条目
  ③ 触发更早的会话摘要

工具结果：
  单个工具返回结果 > MAX_TOOL_RESULT_CHARS 时截断，并显式标注
  「结果已截断」以避免模型以为看到了全部
```

**验收标准**
- [ ] D2 §9 有上下文预算表与裁剪顺序。
- [ ] 工具结果有字符上限与截断标注。

---

#### P2-10　开发顺序与阶段划分的调整建议

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D4 | §53（第 1531–1565 行） | 实现顺序：项目初始化 → … → 前端 Chat → Memory UI |
| D1 | §16（第 950–994 行） | 阶段划分：Phase 0～8，Phase 8 为测试/Benchmark |
| D1 | §16（第 985–993 行） | 工期 12～16 周 |

**为什么需要调整**

1. **评测太晚。** 金标数据集与评测脚本必须早于 Memory Engine（见 P0-9）。
2. **前端在 Memory 之后。** 顺序没问题，但没有为「手动检查记忆质量」的工具留位置——而在没有 Evaluation 的阶段，人工检查是唯一反馈来源。
3. **工期偏乐观。** 12～16 周对单人 + 无现成记忆框架 + 需要自己实现抽取/去重/冲突/混合检索的项目，压力很大；尤其当 P0-1/P0-2 的决策做完后，实现复杂度会明显上升。

**推荐调整**

```text
  Phase 0  产品设计                    （已完成，纳入本文档结论）
  Phase 1  技术架构                    （已完成）
  Phase 2  工程基础
             └─ 【新增】金标数据集 v1 + 评测脚本骨架
  Phase 3  Chat Agent
             └─ 【新增】最小记忆查看页（用于人工核查，不必完整 UI）
  Phase 4  Memory V1（抽取 + 存储 + 检索）
             └─ 【新增】指标门槛：Extraction F1、Retrieval Recall@8
  Phase 5  Memory Intelligence（去重 + 冲突 + 演化）
             └─ 【新增】指标门槛：Dedup Accuracy、Conflict F1
  Phase 6  Timeline / Life Review
  Phase 7  Web UI（完整）
  Phase 8  端到端验证与回归
             └─ 收敛为「跑评测 + 修尾」，而不是从零搭评测

  工期建议：改为 16～20 周，或保持 12～16 周但明确
            「V1.0 只保证 P0 问题的方案全部落地，Memory Intelligence
              的指标优化持续迭代」。
```

**验收标准**
- [ ] D1 §16 的阶段划分包含评测相关任务。
- [ ] 工期描述与调整后的范围一致，或明确说明取舍。

---

#### P2-11　可观测性缺少「为什么没召回」的实现路径

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D1 | §12.4（第 826–841 行） | 提出「为什么这个记忆没有被召回？」 |
| D2 | §38（第 1490–1508 行） | 记录检索数量，但不记录检索过程 |
| D4 | §43（第 1193–1216 行） | `agent_run_id` 概念，但 V1.0 不建表 |

**为什么是问题**
「检索了 5 条记忆」不足以定位问题。要回答「为什么没召回」，必须能重建**当时的检索输入**：查询文本、查询向量、各通道候选、融合后排名、最终注入了哪些、模型是否真的用了。

**推荐方案**

```text
  ① 结构化检索日志（JSON 行，落文件或表）
     {
       "request_id": "...",
       "agent_run_id": "...",
       "query": "...",
       "channels": {
         "vector":   [{"id":"...","rank":1,"score":0.83}, ...],
         "keyword":  [{"id":"...","rank":1,"score":0.4}, ...]
       },
       "fused_top": ["..."],
       "reranked":  [{"id":"...","final":0.71}, ...],
       "injected":  ["..."],
       "truncated_by_budget": ["..."],
       "latency_ms": {"retrieval": 120, "rerank": 30}
     }

  ② 「为什么没召回」的判定路径
     目标记忆 id 是否出现在任一通道候选？
       ├── 否 → 候选生成问题（向量质量 / 关键词覆盖 / 过滤条件过严）
       └── 是 → 排名问题（看 fused 与 reranked 的名次，调权重）
             或预算问题（看 truncated_by_budget）

  ③ 提供一个开发用接口
     GET /api/v1/debug/retrieval?query=...&trace_id=...
     （生产环境默认关闭）
```

**验收标准**
- [ ] 检索过程有结构化日志，且能重建当时的候选与排名。
- [ ] 存在开发用的检索调试接口或等价的离线工具。

---

#### P2-12　`conversation_summaries` 的生成与失效策略未定义

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D3 | §12（第 397–437 行） | 定义了 `start_sequence` / `end_sequence`，但无生成时机 |
| D2 | §24（第 1036–1057 行） | 只说「随着对话越来越长」需要摘要，无阈值 |
| D2 | §9 / §22 | 摘要用于上下文，但未说明与最近消息如何拼接 |
| D1 | §7.1（第 337–347 行） | 要求「旧消息 → Summary → 保留最近消息」，但无触发条件 |

**推荐方案**

```text
  触发条件：
    当会话内「未摘要消息」超过 T 条（默认 30）或超过 X tokens（默认 4000）时，
    对最早的 M 条（默认 20）生成一段摘要

  幂等与防重：
    UNIQUE (conversation_id, start_sequence, end_sequence)
    摘要生成同样记录版本（summarizer_version），便于重跑

  失效：
    摘要覆盖的消息被删除时，摘要标记 stale，触发重新生成

  上下文拼接顺序（写入 D2 §9）：
    System → Profile → 摘要（按时间正序）→ 最近 N 条原文 → 相关记忆 → 当前消息
    （摘要必须在最近消息之前，且注明「以下是更早对话的摘要」）
```

**验收标准**
- [ ] 摘要的触发阈值、幂等键、失效策略已定义。
- [ ] 摘要与最近消息在上下文中的拼接顺序已明确。

---

#### P2-13　`metadata` JSONB 的使用规范

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D3 | §11（第 368–393 行） | `metadata JSONB` 可存 model / token_usage / latency |
| D3 | §47（第 1420–1445 行） | 日志脱敏要求，但未约束 metadata |
| D3 | §11（第 391–393 行） | 「metadata 用于辅助数据，不用于核心业务字段」——但无强制手段 |

**为什么需要注意**
JSONB 是最容易被滥用的字段。一旦有人把业务字段塞进 metadata，索引、约束、类型安全全部失效，且难以回滚（数据在 JSON 里）。

**推荐方案**

```text
  ① 文档给出 metadata 的允许键白名单：
     model, provider, token_usage, latency_ms, finish_reason,
     tool_calls, loop_truncated, extractor_version

  ② 明确禁止：
     - 任何需要被查询/过滤的业务字段
     - 任何级别的敏感正文（message content 的副本、memory content）

  ③ 建议在应用层用 Zod 校验 metadata 结构后再写入

  ④ 敏感字段的风险提示：
     metadata 同样受 D3 §47 的日志脱敏约束；
     若 tool_calls 中含用户正文，必须在落库前裁剪
```

**验收标准**
- [ ] metadata 的允许键与禁止项已写入 D3。
- [ ] 明确 metadata 也受日志脱敏约束。

---

#### P2-14　文档工程化：需求编号与可追溯性

**原文证据**

| 文档 | 位置 | 内容 |
| ---- | ---- | ---- |
| D1 | 全文 | 无需求编号（FR-xxx / NFR-xxx） |
| D1 | 第 1–3 行、第 1041–1053 行 | 文档以对话口吻写作（「给你」「你可以直接回答」），混入元评论 |
| D1 | §16 起 | 开发阶段无验收标准 |
| D2/D3/D4 | 全文 | 无「本文档与上游文档的对应关系」小节 |

**为什么需要改**
1. **无法追溯。** 编码时无法回答「这个功能对应 PRD 哪一条」，需求变更时无法评估影响面。
2. **无法验收。** 没有编号就没有可勾选的验收清单。
3. **风格不一致。** PRD 的对话体（来自 AI 生成过程）与其余三份的正式文档体不统一，作为基线文档不合适。

**推荐方案**

```text
  ① 为 PRD 的功能需求编号
     FR-CHAT-01 新建会话
     FR-MEM-01  自动记忆抽取
     FR-MEM-02  记忆去重
     FR-MEM-03  记忆冲突检测
     ...
     NFR-PRIV-01 数据默认私有
     NFR-PERF-01 检索 p95 < 300ms

  ② 在架构/数据库/接口文档中引用编号
     例：D3 §13 memories 表 → 服务 FR-MEM-01 ~ 03

  ③ 新增「需求追溯矩阵」附录（可放本文档或单独文档）

  ④ 清理 PRD 的对话体开头与结尾的元评论段落
     （第 1–3 行、第 1051–1093 行的「建议就定在这里」部分）
     保留其信息量，改为正式的「文档边界说明」

  ⑤ 为每个 Phase 增加「完成标准（DoD）」
     例：Phase 4 完成 = 抽取 F1 ≥ X，检索 Recall@8 ≥ Y，且评测脚本可重复运行
```

**验收标准**
- [ ] PRD 有 FR/NFR 编号。
- [ ] 存在需求追溯矩阵。
- [ ] PRD 文体统一为正式文档体。
- [ ] 每个 Phase 有可判定的完成标准。

---

### 4.4 P3 文档一致性修订项

以下为跨文档的事实性不一致，回写即可，不涉及设计决策。

---

#### P3-1　API 前缀不一致（架构缺 `/v1`）

| 文档 | 位置 | 现状 |
| ---- | ---- | ---- |
| D2 | §36（第 1426–1447 行） | `/api/chat`、`/api/memories`、`/api/conversations/:id` …（**无 `/v1`**） |
| D4 | §2（第 42–54 行） | 统一前缀 `/api/v1` |

**修订：** D2 §36 全部端点补 `/v1`，并加一句「以 D4 为准」。

---

#### P3-2　「11 张核心业务表」与实际列出的表数量不符

| 文档 | 位置 | 现状 |
| ---- | ---- | ---- |
| D3 | §48（第 1449–1480 行） | 声称「11 张核心业务表」，实际列出：users、conversations、messages、conversation_summaries、memories、memory_embeddings、events、goals、relationships、timeline_events = **10 张** |
| D3 | §22–23（第 696–722 行） | 另定义了 `memory_sources`，但未计入清单 |
| D2 | §31（第 1305–1319 行） | 核心表清单同样漏掉 `memory_sources` |

**修订：** 补上 `memory_sources`。若同时采纳 P0-6（`extraction_runs`）与 P0-5 的方案 A（合并 timeline），最终表数量需重新统计并写明。

**建议表述：** 不再写死数字，改为「核心表清单」并注明数量在每次修订时同步。

---

#### P3-3　PRD 实体清单与数据库实际表名/粒度不一致

| PRD（D1 §11，第 715–751 行） | 数据库（D3） | 差异 |
| ---- | ---- | ---- |
| `User` | `users` | 命名规范（复数） |
| `Conversation` | `conversations` | 命名规范 |
| `Message` | `messages` | 命名规范 |
| `Memory` | `memories` | 命名规范 |
| `MemoryEmbedding` | `memory_embeddings` | 命名规范 |
| `Event` | `events` | 一致 |
| `Goal` | `goals` | 一致 |
| `Relationship` | `relationships` | 一致 |
| `Timeline` | `timeline_events` | **粒度不一致**（概念 vs 表） |
| `Summary` | `conversation_summaries` | **粒度不一致** |
| （未列出） | `memory_sources` | **PRD 缺失** |

**修订：** D1 §11 的实体清单改为与 D3 对齐，并注明「概念实体的物理表名以 D3 为准」。

---

#### P3-4　架构文档技术栈表不完整

| 文档 | 位置 | 现状 |
| ---- | ---- | ---- |
| D2 | §5.1（第 253–279 行） | 只列 TypeScript / Node.js / Fastify / Zod / Drizzle / pnpm |
| D2 | §34/§35（第 1372–1420 行） | 另有 LLM Provider 与 Embedding Provider 抽象，但未进技术栈表 |
| D2 | §38（第 1490 行起） | 有可观测性要求，但无日志/追踪库选型 |
| D2 | §40（第 1540 行起） | Docker Compose，但无镜像/编排细节 |
| D1 | §12.4 | 要求可观测性，但无实现选型 |

**修订：** 技术栈表补充：

```text
Embedding        Provider 抽象 + 具体模型（待定，见 P0-3）
日志             结构化日志库（如 pino）
追踪             request_id / agent_run_id 的传递方式
测试             Vitest / node:test（二选一并写明）
前端数据层       fetch / TanStack Query（若需要）
迁移             drizzle-kit
容器             Dockerfile 基础镜像与 Node 版本
```

---

#### P3-5　架构文档的核心模块清单位置散乱

| 文档 | 位置 | 现状 |
| ---- | ---- | ---- |
| D2 | §7.1（第 320–334 行） | Agent Core 的 6 个子模块 |
| D2 | §43（第 1636–1646 行） | 目录结构 |
| D2 | §50（第 1997–2005 行） | 核心业务模块清单 |

**修订：** 在文档前部（§3 之后）增加一节「模块总览」，集中列出全部模块、职责与依赖方向，后续章节引用该节，避免读者在三处拼装同一信息。

---

#### P3-6　`agent_run_id` 定义了但无处存储

| 文档 | 位置 | 现状 |
| ---- | ---- | ---- |
| D4 | §43（第 1193–1216 行） | 明确 `agent_run_id` 概念与传播路径 |
| D4 | 同节（第 1216 行） | 「V1.0 暂时不建立 `agent_runs` 表，但日志层需要保留这个概念」 |
| D4 | §42（第 1170–1190 行） | `request_id` 同样只存在于日志 |

**说明与建议**

不建 `agent_runs` 表的选择是合理的（可观测性不急于落库）。但需要与 P0-6 的 `extraction_runs` **区分清楚**，避免读者混淆：

```text
  agent_runs        可观测性概念，V1.0 只进日志        ← 不建表，OK
  extraction_runs   正确性所需（幂等键），必须建表      ← 见 P0-6
```

**修订：** 在 D4 §43 加一段对照说明，并在 D3 表清单中补 `extraction_runs`。

---

#### P3-7　`409 CONFLICT` 与 `422 VALIDATION_ERROR` 的使用边界

| 文档 | 位置 | 现状 |
| ---- | ---- | ---- |
| D4 | §5（第 109–120 行） | 两者都在表中 |
| D4 | §39（第 1086–1116 行） | Zod 校验失败时未说明返回 400 还是 422 |

**修订：** 明确

```text
  400 BAD_REQUEST        请求格式本身错误（非法 JSON、缺 header）
  422 VALIDATION_ERROR   JSON 合法但字段不满足 schema（Zod 失败）
  409 CONFLICT           业务语义冲突（记忆冲突、幂等键冲突、唯一约束冲突）
```

---

#### P3-8　PRD 文体与元评论清理

| 文档 | 位置 | 现状 |
| ---- | ---- | ---- |
| D1 | 第 1–3 行 | 「可以。我们这次就把它当成正式立项文档来写……」 |
| D1 | 第 1041–1093 行 | 「如果以后有人问你……」「我建议就定在这里」「所以现在先不要写代码」 |

**修订：** 保留信息量，改写为正式的：

```text
  §0 文档边界说明
     本文档定义「做什么」，不定义「怎么做」。
     技术选型见《系统架构设计说明书》，
     表结构见《数据库设计说明书》，
     接口契约见《API 接口设计说明书》。

  末尾增加「后续文档关系图」，替代对话式的收尾段落。
```

---

## 5. 待决策清单

以下决策**必须先拍板，再动手编码**。建议按顺序逐条确认并回写到基线文档。

| 编号 | 决策项 | 选项 | 建议 | 影响范围 | 关联问题 |
| ---- | ---- | ---- | ---- | ---- | ---- |
| Q1 | 记忆版本模型 | A 不可变事实 + `superseded_by` + 双时间轴 / B 可变行 + 版本快照表 | **A** | 首次 Migration、全部记忆读写、时间线 | P0-1 |
| Q2 | 抽取输出契约 | A 结构化（subject/predicate/object + 受控词表） / B 保持自由文本 + 纯 LLM 判定 | **A** | 抽取器、去重、冲突、评测 | P0-2 |
| Q3 | 记忆写入路径 | A 仅后台抽取（Agent 只读） / B 抽取 + Agent 双写 | **A** | Agent 工具集、Precision 可测性 | P0-6 |
| Q4 | Embedding 模型与维度 | 具体厂商 + 维度数字 | 需你选定 | 表结构（不可逆）、成本、隐私 | P0-3 |
| Q5 | `events` / `timeline_events` | A 单表 + 查询视图 / B 保留双表 + 可重建投影（并删除 `/timeline` 写接口） | **A** | 表结构、API、Life Review | P0-5 |
| Q6 | `goals` 与 `memory.type='goal'` | A 仅 Goal 表，记忆为投影 / B 二者独立 | **A** | 写入责任、语义检索 | P0-5 |
| Q7 | 认证方案 | A 单用户长期 token + 强制 HTTPS / B 密码 + session cookie | **A** | 部署、全部 API | P0-8 |
| Q8 | 评测集来源 | A 人工构造 50～100 条 / B 用真实数据脱敏 | **A 起步，逐步用 B 补充** | Phase 2 起的工作量 | P0-9 |
| Q9 | 工期与范围 | A 保持 12～16 周但明确只保证 P0 落地 / B 放宽到 16～20 周 | **B** | 整个计划 | P2-10 |
| Q10 | 隐私模式 | A 仅支持云端 / B 提供本地模型或敏感记忆不外发方案 | **B（至少预留接口）** | Embedding 抽象、成本、隐私承诺 | P2-8 |
| Q11 | 会话删除语义 | A 默认级联失效派生记忆 / B 默认仅删对话 | **A** | 删除 API、隐私承诺 | P1-1 |
| Q12 | 分页策略 | A 消息用游标、管理列表用 offset / B 全部 offset | **A** | 消息接口、前端 | P2-2 |

---

## 6. 落地路线（建议插入现有开发阶段）

按依赖关系排序。**注意 Q1 / Q2 / Q5 是其余工作的前提**，必须先定。

```text
【第 0 步】决策
  完成第 5 章的 Q1 ～ Q12
        ↓
【第 1 步】回写基线文档（预计 1～2 天）
  D3 重写：memories 表、memory_embeddings 表、
           memory_sources 索引、约束设计、状态转移表、
           新增 extraction_runs、调整 events/timeline
  D2 修订：检索公式（RRF + 归一化）、Agent Loop 边界、
           上下文预算、模块总览、技术栈补全
  D4 修订：视图对象、SSE 事件、分页策略、幂等、鉴权、
           抽取状态字段、错误码使用场景
  D1 修订：需求编号、非功能指标数字、阶段划分、
           实体清单对齐、文体清理
        ↓
【第 2 步】Phase 2 工程基础 + 评测前置（P0-9）
  金标数据集 v1（50～100 条，含难例）
  评测脚本骨架（一条命令输出全部指标）
  → 此时还没有 Memory Engine，评测脚本先对 mock 跑通
        ↓
【第 3 步】Phase 3 Chat Agent + 手动记忆查看页
  Agent Loop（含 P0-7 的边界约束）
  只读工具：search_memory / get_memory / get_timeline
  最小记忆查看页（人工核查用，不必完整 UI）
        ↓
【第 4 步】Phase 4 Memory V1
  抽取（结构化契约，P0-2）
  存储（P0-1 的时间轴模型）
  embedding（P0-3 的 hash 与陈旧检测）
  检索（P0-4 的 RRF + 重排）
  → 门槛：Extraction F1、Retrieval Recall@8 达标
        ↓
【第 5 步】Phase 5 Memory Intelligence
  去重（按 predicate 命中判定）
  冲突（三选一窄任务 + 用户裁决）
  演化（supersede / archive）
  → 门槛：Dedup Accuracy、Conflict F1 达标
        ↓
【第 6 步】Phase 6 Timeline / Life Review
        ↓
【第 7 步】Phase 7 Web UI（完整）
        ↓
【第 8 步】Phase 8 端到端回归
  跑评测历史趋势、修尾、准备 Release
```

**关于「先写代码」的说明**

D1 结尾写着「所以现在先不要写代码」。这个判断是对的，但**前提是把第 5 章的决策做完**——否则「不写代码」会变成单纯的等待。完成第 0 步与第 1 步之后即可开工，无需等待更多文档。

---

## 7. 附录

### 附录 A　建议的 `memories` 表结构（对应 P0-1 + P0-2 + P0-3 方案）

> 仅作方案示意，正式定义需回写到 D3。依据 Q1～Q4 的决策可能微调。

```sql
CREATE TABLE memories (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),

  -- 业务字段
  type             VARCHAR NOT NULL,
  content          TEXT    NOT NULL,

  -- 结构化槽位（P0-2）
  subject_key      VARCHAR,
  predicate_key    VARCHAR,          -- 来自受控词表
  object_value     TEXT,
  polarity         VARCHAR,          -- affirm | deny

  -- 评分
  importance_score REAL NOT NULL DEFAULT 0.5,
  confidence_score REAL NOT NULL DEFAULT 1.0,

  -- 状态与时间（P0-1 双时间轴）
  status           VARCHAR NOT NULL DEFAULT 'active',
  valid_from       TIMESTAMPTZ,
  valid_until      TIMESTAMPTZ,
  superseded_by    UUID REFERENCES memories(id),

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,

  CONSTRAINT chk_type     CHECK (type IN ('fact','preference','event','goal','relationship','state')),
  CONSTRAINT chk_status   CHECK (status IN ('active','superseded','archived','deleted')),
  CONSTRAINT chk_importance CHECK (importance_score BETWEEN 0 AND 1),
  CONSTRAINT chk_confidence CHECK (confidence_score BETWEEN 0 AND 1),
  CONSTRAINT chk_valid_range CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  CONSTRAINT chk_deleted_consistency CHECK (status <> 'deleted' OR deleted_at IS NOT NULL)
);

-- 「当前有效记忆」的部分唯一索引：
-- 同一槽位在同一时间只能有一条当前有效记忆（仅在启用受控词表时适用）
CREATE UNIQUE INDEX uq_memories_current_slot
  ON memories (user_id, subject_key, predicate_key)
  WHERE status = 'active'
    AND deleted_at IS NULL
    AND valid_until IS NULL
    AND superseded_by IS NULL
    AND predicate_key IS NOT NULL;

-- 常用查询索引
CREATE INDEX idx_memories_user_status_type ON memories (user_id, status, type);
CREATE INDEX idx_memories_user_updated     ON memories (user_id, updated_at DESC);
CREATE INDEX idx_memories_slot             ON memories (user_id, subject_key, predicate_key);
```

### 附录 B　建议的 `memory_embeddings` 表结构（对应 P0-3）

```sql
CREATE TABLE memory_embeddings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id      UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  model          VARCHAR NOT NULL,
  dim            INTEGER NOT NULL,

  embedded_text  TEXT    NOT NULL,   -- 被向量化的确切文本快照
  content_hash   VARCHAR NOT NULL,   -- hash(embedded_text)，用于陈旧检测

  embedding      VECTOR(N) NOT NULL, -- N 在 Migration 时冻结
  status         VARCHAR NOT NULL DEFAULT 'ready',  -- ready | stale | failed | deleted

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_embedding_per_model UNIQUE (memory_id, model),
  CONSTRAINT chk_emb_status CHECK (status IN ('ready','stale','failed','deleted'))
);

CREATE INDEX idx_embeddings_status ON memory_embeddings (status);

-- 向量索引（规模增大后再建，或从一开始就建）
CREATE INDEX idx_embeddings_hnsw
  ON memory_embeddings USING hnsw (embedding vector_cosine_ops);
```

### 附录 C　建议的 `extraction_runs` 表结构（对应 P0-6）

> ⚠️ **本节是评审当时的建议稿，已被《数据库设计 V1.1》§11 取代**，差异有三处：
>
> ```text
> ① 幂等键：end_sequence → start_sequence（V1.1 §11.3.1，变更 C19）
> ② 另加 EXCLUDE 排他约束保证「成功区间不重叠」（§11.3.2，变更 C20，需 btree_gist）
> ③ memories_merged → memories_superseded（§11.2：被取代与去重合并是两件事）
>
> 实现以 03-database-design.md §11 与附录 A 为准，不要照抄本节。
> ```

```sql
CREATE TABLE extraction_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   UUID NOT NULL REFERENCES conversations(id),

  start_sequence    INTEGER NOT NULL,
  end_sequence      INTEGER NOT NULL,
  extractor_version VARCHAR NOT NULL,   -- 抽取器/提示词/模型版本

  status            VARCHAR NOT NULL DEFAULT 'pending',
  memories_created  INTEGER NOT NULL DEFAULT 0,
  memories_updated  INTEGER NOT NULL DEFAULT 0,
  memories_merged   INTEGER NOT NULL DEFAULT 0,
  conflicts_found   INTEGER NOT NULL DEFAULT 0,

  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,

  -- 幂等键：同一次抽取无论触发多少次只执行一次
  CONSTRAINT uq_extraction_idempotency
    UNIQUE (conversation_id, end_sequence, extractor_version),
  CONSTRAINT chk_extraction_status
    CHECK (status IN ('pending','running','succeeded','failed','skipped'))
);

CREATE INDEX idx_extraction_conv ON extraction_runs (conversation_id, created_at DESC);
CREATE INDEX idx_extraction_status ON extraction_runs (status) WHERE status IN ('pending','running','failed');
```

### 附录 D　金标数据集样本格式（对应 P0-9）

```jsonc
{
  "id": "gs-001",
  "category": "conflict_lexically_distant",   // 难例分类
  "conversation": [
    { "role": "user", "content": "我下个月就搬到深圳了，房子已经退了。" }
  ],
  "existing_memories": [
    {
      "id": "mem-100",
      "type": "fact",
      "content": "用户住在广州",
      "predicate_key": "residence.city",
      "object_value": "广州",
      "status": "active"
    }
  ],
  "should_extract": true,
  "expected_type": "fact",
  "expected_content_any_of": [
    "用户已搬到深圳",
    "用户搬到深圳",
    "用户现在住在深圳"
  ],
  "expected_predicate_key": "residence.city",
  "expected_object_value": "深圳",
  "expected_relation_to_existing": "conflict",   // duplicate | conflict | coexist | none
  "expected_resolution": "supersede",            // supersede | ask_user | coexist
  "notes": "检验字面不相似但槽位相同的冲突判定能力"
}
```

**难例分类建议至少覆盖：**

```text
conflict_lexically_distant     字面不像但真冲突
similar_but_coexist            字面像但可共存
duplicate_paraphrase           同义表述，应合并
chitchat_should_not_extract    闲聊，不应抽取
emotion_not_diagnosis          情绪表达，不应形成事实
partial_update                 补充细节，应更新而非新增
temporal_state_expiry          阶段性状态，应有有效期
multi_memory_one_message       一句话含多条记忆
pronoun_reference              代词指代需正确解析主体
negation_polarity              否定表达（"我以后不吃这个了"）
```

### 附录 E　问题索引（编号 ↔ 文档位置速查）

| 编号 | 严重度 | 主题 | 主要涉及文档位置 |
| ---- | ---- | ---- | ---- |
| P0-1 | P0 | 记忆版本化模型自相矛盾 | D3 §13/§15/§18；D4 §23；D1 §3.3/§4.4 |
| P0-2 | P0 | 去重/冲突缺少判定依据 | D2 §15/§16；D1 §8.2–8.4/§15 |
| P0-3 | P0 | Embedding 维度与陈旧检测 | D3 §19/§20/§36/§43 |
| P0-4 | P0 | 检索评分公式缺项且不可相加 | D2 §18/§20；D3 §37；D1 §7.3 |
| P0-5 | P0 | events / timeline_events 双写 | D3 §25/§30/§31/§41/§42；D4 §28–30 |
| P0-6 | P0 | 写入路径双入口、抽取不幂等 | D2 §12/§21；D4 §9.3/§10/§11/§37；D1 §15 |
| P0-7 | P0 | Agent Loop 缺边界与副作用防护 | D2 §8.1/§21/§39；D4 §49 |
| P0-8 | P0 | 无认证方案 | D4 §41；D2 §37/§40；D1 §12.1 |
| P0-9 | P0 | 成功指标不可测量 | D1 §15/§16/§12.4；D2 §38 |
| P1-1 | P1 | 删除级联规则未定义 | D3 §38/§39；D4 §16；D2 §37 |
| P1-2 | P1 | 软删除的检索侧语义 | D3 §37/§38；D2 §18；D4 §25 |
| P1-3 | P1 | messages.sequence 竞态 | D3 §10.4/§35/§42；D4 §11 |
| P1-4 | P1 | users 表无法承载 Profile | D2 §9；D3 §8.2；D1 §11；D4 §34 |
| P1-5 | P1 | 抽取状态的前端可见性 | D4 §9.3/§10/§11 |
| P1-6 | P1 | memory_sources 缺索引与约束 | D3 §23/§35/§48 |
| P1-7 | P1 | 缺关键字检索的库层设计 | D2 §20；D3 §35；D4 §20 |
| P1-8 | P1 | 缺数据库约束设计 | D3 §14/§15/§16/§17/§27 |
| P2-1 | P2 | 路由冲突风险 | D4 §19/§20/§50 |
| P2-2 | P2 | 分页选型 | D4 §8/§14；D3 §10.4 |
| P2-3 | P2 | SSE 事件契约过薄 | D4 §11 |
| P2-4 | P2 | Memory 视图对象不统一 | D4 §18/§19/§20/§22 |
| P2-5 | P2 | 错误码与策略不匹配 | D4 §5/§44/§45 |
| P2-6 | P2 | 幂等只覆盖 Chat | D4 §46/§22/§28 |
| P2-7 | P2 | 缺性能/成本/备份目标 | D1 §12/§15；D2 §38；D3 §46 |
| P2-8 | P2 | 隐私缺出网披露与静态加密 | D1 §12.1；D2 §1.1/§37/§50；D3 §45 |
| P2-9 | P2 | 缺 Context 预算与工具裁剪 | D2 §9/§21.1/§24；D4 §49 |
| P2-10 | P2 | 开发顺序与工期调整 | D4 §53；D1 §16 |
| P2-11 | P2 | 可观测性缺「为何未召回」 | D1 §12.4；D2 §38；D4 §43 |
| P2-12 | P2 | 会话摘要生成与失效 | D3 §12；D2 §9/§22/§24；D1 §7.1 |
| P2-13 | P2 | metadata JSONB 使用规范 | D3 §11/§47 |
| P2-14 | P2 | 文档工程化与可追溯性 | D1 全文/§16；D2–D4 全文 |
| P3-1 | P3 | API 前缀 /v1 不一致 | D2 §36 vs D4 §2 |
| P3-2 | P3 | 「11 张表」数目不符、漏 memory_sources | D3 §48；D2 §31 |
| P3-3 | P3 | PRD 实体清单与表名/粒度不一致 | D1 §11 vs D3 |
| P3-4 | P3 | 技术栈表不完整 | D2 §5.1/§34/§35/§38/§40 |
| P3-5 | P3 | 核心模块清单位置散乱 | D2 §7.1/§43/§50 |
| P3-6 | P3 | agent_run_id 无处存储（需与 extraction_runs 区分） | D4 §42/§43 |
| P3-7 | P3 | 409 / 422 使用边界 | D4 §5/§39 |
| P3-8 | P3 | PRD 文体与元评论清理 | D1 第 1–3 行 / §18 末尾 |

---

**评审结论至此结束。**

下一步建议：先完成第 5 章的 12 项决策，再按第 6 章第 1 步回写四份基线文档，然后即可进入编码。
