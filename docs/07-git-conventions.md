# LifeMate Git 提交规范 V1.0

**项目名称：** LifeMate
**文档类型：** 工程规范
**版本：** V1.0
**适用范围：** 本仓库全部提交
**参考标准：** [Conventional Commits v1.0.0](https://www.conventionalcommits.org/zh-hans/)

---

# 0. 先说清楚：为什么值得规范

你是单人开发，没有同事，没有 CI。所以最容易产生的想法是："提交信息写给自己看，随便写写就行。"

这个想法有两个漏洞。

## 0.1 你不是在写给人看，是在写给 `git log` 看

半年后你调试一个记忆冲突的 bug，需要回答：

```text
「这个 super persede 逻辑是什么时候变的？为什么变？」
```

这时你会用：

```bash
git log --oneline -- src/memory/
git log -S "superseded_by" --oneline
git log --grep "冲突" --oneline
```

**这三个命令的效果完全取决于你的提交信息。** 如果日志长这样：

```text
修复bug
更新
再改一下
提交
wip
终于好了
```

那 `git log` 对你就毫无价值，你只能一行行读 diff——而这正是你写提交信息想省掉的时间。

## 0.2 更重要的：提交粒度逼你想清楚架构

这一条对**你这个项目**尤其重要。

LifeMate 有一个明确的模块划分（`agent` / `memory` / `conversation` / `timeline`）。**如果你一次提交里改了 `memory` 和 `agent` 两个模块，说明你的模块边界正在被破坏。**

反过来，当你养成"每次提交只做一件事"的习惯时，你会被迫回答：

```text
这次改动到底属于哪个模块？
如果跨了两个模块，是不是其中一个该调用另一个？
这个改动是不是应该拆成两次？
```

**提交纪律是架构纪律的体检。** 这是规范对你最大的价值，比"日志好看"重要得多。

## 0.3 还有一个实际收益：回滚会变得精准

```bash
# 提交粒度细的时候，回滚是精确手术
git revert <sha>     # 只撤销那一个逻辑改动

# 提交粒度粗的时候，回滚是砸核桃
# 你只能手动去 diff 里挑，很容易多删或少删
```

你马上要开始写 `memories` 表和相关逻辑。**在动 schema 之前先提交一次干净的基线**，出错了 `git reset --hard` 就能回来——这个安全感是免费送的。

---

# 1. 核心心法（先记这三条，比记格式重要）

## 心法一：一条提交 = 一个逻辑改动

**不是"一次操作"，是"一个逻辑改动"。**

```text
❌ 一次操作：  我今天下午改的东西
✅ 一个逻辑：  为 memories 表增加 superseded_by 字段及其状态转移约束

判断标准：能不能用「应用这个提交，就……了」一句话说清？
  能  → 粒度合适
  不能 → 拆
```

## 心法二：主语是「仓库/代码」，不是「我」

提交信息描述的是**这次变化本身**，不是你的工作汇报。

```text
❌ 我今天写了记忆去重逻辑
❌ 修复了我发现的bug
❌ 我根据评审意见修改了文档

✅ 新增记忆槽位判定逻辑，支持确定性去重
✅ 修复 Embedding 维度校验缺失导致的静默错误
✅ 按评审意见修订约束设计章节
```

一个简单的自检：**把"我"字去掉，句子还成立吗？** 成立就是好信息。

## 心法三：`type` 回答"这是什么改动"，不是"我做了什么动作"

很多人把 `type` 当成动词用，错了。它是**分类**。

```text
❌ feat: 修改了登录逻辑        ← 修改为什么是 feat？
❌ fix:  新增了错误处理        ← 新增为什么是 fix？

✅ fix:  修正登录 token 过期时间计算错误     ← 修的是 bug
✅ feat: 新增登录失败次数限制                ← 加的是能力
```

**判断 `feat` 还是 `fix` 的黄金问题：**

> **这个改动会让用户/调用方觉得"多了个能力"，还是"原先不对的地方对上了"？**

- 多了个能力 → `feat`
- 原先不对 → `fix`
- 都不是（重构、格式化、加注释）→ 其他类型

---

# 2. 提交信息结构

## 2.1 完整结构

```text
<type>(<scope>): <subject>
│        │          │
│        │          └── 必填。一句话说清改了什么
│        └───────────── 可选。改动落在哪个模块
└────────────────────── 必填。改动类型

<空行>

<body>  可选。为什么改、怎么改、有什么取舍

<空行>

<footer>  可选。BREAKING CHANGE、关联 Issue、Co-authored-by
```

只有第一行是硬性要求，其余按需要用。

## 2.2 第一行（Header）的格式规则

```text
type(scope): subject
```

| 部分 | 规则 |
| ---- | ---- |
| `type` | 小写，来自第 3 节的封闭列表 |
| `scope` | 小写，来自第 4 节的模块列表，可省略 |
| `:` 后 | **必须有且仅有一个空格** |
| `subject` | 不加句号结尾；用祈使/陈述语气；中文不加"了" |
| 整行长度 | **≤ 50 字符**（中文按 2 字符算，即约 25 个汉字） |

## 2.3 为什么是 50 字符（理解原理，不用背）

这不是随便定的，来自**终端宽度和 Git 生态的默认值**：

```text
git log --oneline        在 80 列终端里显示 SHA + subject
                          40(SHA) + 空格 + subject ≈ 80
                          → subject 大约 50 字符时刚好不折行

GitHub / GitLab 提交列表  同样按这个宽度截断加"..."
```

**超了会怎样？** 不会报错，但你在 `git log --oneline` 里会看到被截断的信息，必须点进去才能看全——那 `--oneline` 就白用了。

```text
❌ docs(db): 新增数据库设计 V1.1，落地 Q1/Q2/Q4 三项决策并补充约束设计、删除级联策略
   → 43 个汉字 ≈ 86 字符，超了一倍

✅ docs(db): 新增数据库设计 V1.1
   → 短，且信息量没丢（细节放 body）
```

## 2.4 正文（Body）的写法

**正文回答"为什么"，diff 已经回答了"是什么"。**

这是最容易写错的地方——很多人把 diff 里能看出来的东西又抄一遍。

```text
❌ 差的正文（复述 diff，零信息量）
   修改了 memories 表
   增加了 superseded_by 字段
   增加了 status 的 CHECK 约束

✅ 好的正文（解释动机与取舍）
   原设计允许就地更新 content，导致两个问题：
   ① valid_from 语义二义（记录时间还是事实时间）
   ② 信息变化后历史丢失，时间线无法回溯

   改为不可变事实模型：正文永不原地修改，
   变化时新建记忆并将旧记忆标记为 superseded。
   这样 valid_from/valid_until 与 created_at 各司其职。
```

**自检方法：** 如果删掉正文，读代码的人会**困惑于"为什么这么做"**吗？
会 → 必须写。不会（比如改个错别字）→ 不用写。

## 2.5 页脚（Footer）

```text
BREAKING CHANGE: <描述>          # 破坏性变更，见第 6 节
Closes #12                       # 关联并关闭 Issue
Refs #8, #9                      # 仅关联
Co-authored-by: 名字 <邮箱>       # 协作
```

---

# 3. `type` 完整清单

只允许以下类型。**这个列表是封闭的**——需要新类型时改本规范，别临时发明。

| type | 用途 | 对应语义化版本 |
| ---- | ---- | ---- |
| `feat` | 新增功能 | MINOR |
| `fix` | 修复缺陷 | PATCH |
| `docs` | 仅文档改动 | — |
| `refactor` | 重构：既不修 bug 也不加功能 | — |
| `perf` | 性能优化 | — |
| `test` | 新增或修改测试 | — |
| `build` | 构建系统、依赖、Docker | — |
| `chore` | 杂项：配置、脚本、不影响源码 | — |
| `style` | 格式：空格、分号、排版（不改语义） | — |
| `revert` | 回滚某次提交 | — |

## 3.1 最容易混淆的三组

**`fix` vs `refactor`**

```text
bug：接口返回的 confidence 没做 0~1 范围校验
     → fix: 修复 confidence 缺少范围校验

   代码能跑、行为正确，但三个 Service 里重复了同一段查询
     → refactor: 抽取「当前有效记忆」谓词为共享常量
```

**`chore` vs `build`**

```text
build  → 影响"怎么构建/运行"：package.json、Dockerfile、CI
chore  → 其他杂项：.gitignore、编辑器配置、发布脚本
```

**`docs` vs `style`**

```text
docs  → 改的是文档内容（.md 文件）
style → 改的是代码格式（缩进、分号），代码逻辑一字未动
```

## 3.2 `type` 是给机器读的（这是它存在的真正理由）

你现在觉得 `type` 是形式主义，是因为还没有工具消费它。一旦加上下面这段，它会自动变成 CHANGELOG：

```bash
# 从提交历史自动生成变更日志
git log --oneline --grep "^feat" v1.0.0..HEAD   # 新功能清单
git log --oneline --grep "^fix"  v1.0.0..HEAD   # 修复清单
```

而 `type` 还直接决定版本号（语义化版本）：

```text
有 feat            → 0.1.0 → 0.2.0   (MINOR)
只有 fix           → 0.2.0 → 0.2.1   (PATCH)
有 BREAKING CHANGE → 0.2.1 → 1.0.0   (MAJOR)
```

**对你这个项目：** 记忆数据一旦开始积累，`memories` 表结构的破坏性变更会直接影响已有数据。有 `BREAKING CHANGE` 标记，你才能在升级前一眼看到"这次要迁移数据"。

---

# 4. `scope` 清单（与项目架构对齐）

**关键设计：`scope` 直接采用《系统架构设计说明书》的模块名。** 这样当你想不出该填什么 scope 时，往往说明这次改动不该是一个提交。

| scope | 对应模块 | 典型改动 |
| ---- | ---- | ---- |
| `db` | 数据库 Schema / Migration | 表结构、索引、约束 |
| `memory` | Memory Engine | 抽取、去重、冲突、演化 |
| `retrieval` | 检索 | 向量/关键词/RRF/重排 |
| `agent` | Agent Core | Loop、Context Builder、Tool |
| `conversation` | 会话 | 消息、摘要、分页 |
| `timeline` | Timeline | 事件、时间线视图 |
| `review` | Life Review | 日/周/月回顾 |
| `llm` | 模型接入 | Provider 抽象、提示词 |
| `embedding` | 向量化 | bge-m3 接入、陈旧检测 |
| `api` | HTTP 层 | 路由、Zod 校验、错误码 |
| `web` | 前端 | 页面、组件 |
| `config` | 配置 | 环境变量、设置项 |
| `deps` | 依赖 | 升级/新增包 |
| `docs` | 文档 | 设计文档、注释 |
| `repo` | 仓库工程 | .gitignore、脚本 |

**跨模块怎么办：**

```text
情况 A：改了两个模块，但属于同一逻辑
   → 选主要那个做 scope
   feat(memory): 新增冲突检测并接入检索过滤

情况 B：改了两个模块，属于两件事
   → 拆成两个提交（这才是绝大多数情况）
```

---

# 5. 对比例子（尽量用你项目里的真实场景）

## 5.1 反例 → 正例

### 例 1：数据库改动

```text
❌ 改了表结构
❌ 数据库更新
❌ 加了一些字段

✅ feat(db): 新增 extraction_runs 表作为抽取幂等键

   抽取是异步且可重试的，原先没有幂等键，
   同一次对话被重复抽取会产生重复记忆，
   直接导致 Memory Noise 指标失控。

   以 (conversation_id, end_sequence, extractor_version)
   作为唯一约束：重复触发时插入冲突即跳过执行。
```

### 例 2：修 bug

```text
❌ 修复了bug
❌ 修复一个奇怪的问题
❌ 终于好了

✅ fix(embedding): 修复内容变更后向量未重算导致的静默错误

   memory.content 更新时未比较 content_hash，
   导致旧向量继续参与召回，检索返回与正文不符的结果。

   现在写入路径统一比较 hash，不一致则标记 stale 并投递重算。
```

**注意正例里保留了"现象"，但没有保留"你的辛苦"。**
"终于好了"记录的是你的情绪，不是代码的事实——三个月后它一文不值。

### 例 3：重构

```text
❌ 优化代码
❌ 重构了一下
❌ 清理

✅ refactor(memory): 抽取「当前有效记忆」谓词为单一常量

   原先在 4 处手写过滤条件，其中 1 处遗漏了 status，
   导致已删除记忆仍被列表接口返回。

   统一为 CURRENT_MEMORY_CONDITION 常量，
   检索、列表、统计、离线评测共同引用。
```

**为什么这条是 `refactor` 而不是 `fix`？**
因为主要目的是消除重复，顺手修掉的那处遗漏是副产品。如果那次提交**只**修那一处，就该是 `fix`。

### 例 4：文档

```text
❌ 更新文档
❌ 文档修改

✅ docs(db): 新增数据库设计 V1.1

   落地三项决策：
   - Q1 记忆改为不可变事实 + superseded_by + 双时间轴
   - Q2 新增结构化槽位字段与受控词表
   - Q4 冻结 VECTOR(1024)

   同时删除 timeline_events（改为 events 查询视图），
   新增约束设计、检索过滤条件、删除级联策略三节。

   Refs: 设计评审与改进建议 V1.0 §4.1 P0-1/P0-2/P0-3
```

### 例 5：配置

```text
❌ 加了配置文件
❌ docker

✅ build(embedding): 固定 TEI 镜像为 89-1.9 并启用 FP16

   RTX 4070 计算能力为 sm_89，纯版本号标签（1.9）
   面向 Ampere sm_80，在 Ada 显卡上会启动失败并报
   「no kernel image is available」。

   同时设置 DTYPE=float16，将显存占用从约 6.4G 降至 3.2G，
   为后续 reranker 预留空间。
```

## 5.2 一个真实案例：拆解我那次提交

我当时写的是：

```text
docs(db): 新增数据库设计 V1.1，落地 Q1/Q2/Q4 三项决策
```

**问题诊断：**

| 问题 | 说明 |
| ---- | ---- |
| ❌ 混合提交 | 一个 commit 干了三件事（见下） |
| ❌ subject 过长 | 约 30 个汉字 / 60 字符，超出 50 |
| ❌ type 与内容不符 | 里面包含 Docker 配置，不属于 `docs` |
| ✅ body 结构 | 用列表分条，这点是对的 |
| ✅ 记录了背景 | 写了"说明：TEI 镜像标签按 GPU 计算能力选择" |

**应该拆成三个提交：**

```text
提交 1 ─────────────────────────────────────────
docs(db): 新增数据库设计 V1.1

  落地三项决策：
  - Q1 记忆改为不可变事实 + superseded_by + 双时间轴
  - Q2 新增结构化槽位字段与受控词表
  - Q4 冻结 VECTOR(1024)

  删除 timeline_events（改为 events 查询视图），
  新增约束设计、检索过滤条件、删除级联策略三节。

  Refs: 设计评审与改进建议 V1.0 §4.1

提交 2 ─────────────────────────────────────────
docs(db): 标记 V1.0 数据库设计为已弃用

  V1.1 已取代其表结构，保留 V1.0 仅作历史留档。

提交 3 ─────────────────────────────────────────
build: 新增本地容器环境（Postgres + pgvector + TEI）

  - docker-compose.yml：postgres 与 embedding 两个服务，
    端口只绑 127.0.0.1
  - devops/postgres/init/01-extensions.sql：安装
    vector / pg_trgm / uuid-ossp
  - .env.example：环境变量模板
  - .gitignore：排除 .env 与备份文件
  - .gitattributes：统一 LF，避免 SQL 在容器内报错

  TEI 镜像按 GPU 计算能力选为 89-1.9（RTX 4070, sm_89）。
```

**为什么不嫌麻烦？**
因为如果后来发现 `docker-compose.yml` 的端口配置有问题，用提交 1 和 2 是撤销不掉的——它们把正确和错误的东西焊在了一起。

---

# 6. 破坏性变更（`BREAKING CHANGE`）

**对 LifeMate 特别重要**，因为记忆数据会持续积累，表结构不能随便改。

## 6.1 什么时候算破坏性

```text
✅ 算：
   - 删除或重命名数据库字段/表
   - 修改 API 请求/响应结构（不向后兼容）
   - 改变已有语义（如 valid_from 从"记录时间"改为"事实时间"）
   - 修改 Embedding 维度

❌ 不算：
   - 新增可选字段
   - 新增 API 端点
   - 内部重构（对外无感知）
```

## 6.2 写法

```text
feat(db): 记忆改为不可变事实模型

  原模型允许就地更新 content，导致历史丢失。

  BREAKING CHANGE: memories 表移除就地更新语义。
  已有的 active 记忆需要回填 valid_from，
  并重建 superseded_by 链路。迁移脚本见
  migrations/2026xxxx-backfill-memory-timeline.sql

  升级前必须备份。
```

`BREAKING CHANGE` 必须在 footer 且**全大写**，自动化工具靠它识别。

---

# 7. 实用技巧

## 7.1 怎么把一个混乱的工作区拆成多个提交

最常见的情况：你写了一下午，`git status` 里十几个文件。

**别 `git add -A`。** 用交互式暂存：

```bash
git add -p
```

它会逐块问你：

```text
@@ -10,6 +10,8 @@ CREATE TABLE memories (
   status VARCHAR(20) NOT NULL,
+  superseded_by UUID REFERENCES memories(id),
+  source_count INTEGER NOT NULL DEFAULT 1,
Stage this hunk [y,n,q,a,d,s,e,?]?
```

按键含义：

```text
y  暂存这一块
n  跳过这一块
s  把这一块拆得更细（同一文件里有两处不相关改动时用）
q  退出
?  帮助
```

**流程：**

```text
① git add -p          → 只暂存属于「第一件事」的块
② git commit          → 提交第一件事
③ git add -p          → 暂存「第二件事」
④ git commit
```

## 7.2 提交前必看的两个命令

```bash
# 我到底改了哪些文件？
git status --short

# 我到底改了什么内容？（这个最重要，避免误提交调试代码）
git diff --cached
```

**养成习惯：`git commit` 之前一定跑 `git diff --cached`。**

它能拦住的典型事故：

```text
❌ 误提交 console.log / print 调试语句
❌ 误提交 .env（含密码）
❌ 误提交本地临时文件
❌ 误提交半成品代码（改了但没写完）
```

## 7.3 提交信息写错了怎么办

**还没 push：**

```bash
# 改最近一次提交的信息
git commit --amend

# 只改信息不改内容（不会产生新提交）
git commit --amend -m "docs(db): 新增数据库设计 V1.1"
```

**已经 push 了（单人项目可以改）：**

```bash
git commit --amend
git push --force-with-lease
```

> ⚠️ `--force-with-lease` 比 `--force` 安全：如果远端有别人的新提交，它会拒绝推送而不是覆盖掉。单人项目用这个。
>
> **有协作者时不要 amend 已推送的提交**——会打乱别人的历史。

## 7.4 `fixup`：把零碎修改并回原提交

场景：你提交了 `feat(memory)`，两分钟后又发现忘了个文件，不想留一堆 "补充" / "漏了" 提交。

```bash
# 1) 先正常提交这个补充
git add src/memory/conflict.ts
git commit -m "fixup! feat(memory): 新增冲突检测"

# 2) 自动合并回目标提交
git rebase -i --autosquash HEAD~2
```

关键点：**信息以 `fixup! ` 开头**（注意有个空格），Git 会自动把它排到目标提交后面并标记为 `fixup`。

## 7.5 回滚

```bash
# 安全回滚：生成一个反向提交（保留历史，推荐）
git revert <sha>

# 本地丢弃：危险，会丢改动
git reset --hard <sha>

# 只想撤销某个文件到上次提交
git restore src/memory/conflict.ts
```

**在有真实记忆数据之后，永远优先用 `revert` 而不是 `reset --hard`。**

## 7.6 提交前跑检查（pre-commit hook）

即使还没有测试，也该挡住"明显不该提交的东西"：

```bash
# .git/hooks/pre-commit  （不需要额外依赖）
#!/bin/sh
if git diff --cached --name-only | grep -qE '^\.env$'; then
  echo "❌ 检测到尝试提交 .env，已阻止"
  exit 1
fi
```

记得给执行权限：

```bash
chmod +x .git/hooks/pre-commit
```

> 注意：`.git/hooks/` 不随仓库分发。要团队共享得用 `husky` 或 `core.hooksPath`。

---

# 8. 工具配置（可选，但建议）

## 8.1 提交信息模板（零成本，先上这个）

在仓库根目录建 `.gitmessage`：

```text
# <type>(<scope>): <subject>
# ────────────────────────────────────────────
# 第一行 ≤ 50 字符，不加句号
#
# type:  feat | fix | docs | refactor | perf
#        test | build | chore | style | revert
#
# scope: db | memory | retrieval | agent | conversation
#        timeline | review | llm | embedding | api
#        web | config | deps | docs | repo
#
# 空一行后写正文：为什么改？有什么取舍？
# diff 里能看到的内容不用重复写
#
# ────────────────────────────────────────────
# BREAKING CHANGE: <破坏性变更说明>
# Closes #
```

启用（仅需一次）：

```bash
git config commit.template .gitmessage
```

之后每次 `git commit`（不带 `-m`）都会打开编辑器并带上这个模板。

## 8.2 commitlint + husky（自动校验格式）

`husky` 是 Git hooks 管理器，`commitlint` 校验提交信息是否符合规范。

**安装：**

```bash
pnpm add -D husky @commitlint/cli @commitlint/config-conventional
```

**初始化 husky：**

```bash
pnpm exec husky init
```

**`commitlint.config.js`：**

```js
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 允许中文，放宽 subject 长度（中文按字符数不好换算）
    'subject-max-length': [2, 'always', 72],
    'header-max-length': [2, 'always', 100],
    'subject-case': [0],          // 中文无大小写，关闭
    'subject-full-stop': [2, 'never', '.'],
    'body-max-line-length': [0],  // 中文正文不强制换行
    'scope-enum': [2, 'always', [
      'db', 'memory', 'retrieval', 'agent', 'conversation',
      'timeline', 'review', 'llm', 'embedding', 'api',
      'web', 'config', 'deps', 'docs', 'repo',
    ]],
  },
};
```

> ⚠️ **关于字符长度**：`@commitlint/config-conventional` 默认按**字符数**算，中文一个汉字算 1。所以默认的 72 对中文其实偏松。我在上面把 `subject-max-length` 设为 72 字符（约 36 个汉字），既能容纳中文表达，又不至于失控。

**`.husky/commit-msg`：**

```bash
pnpm exec commitlint --edit "$1"
```

**效果：**

```bash
$ git commit -m "更新一下"
⧗   input: 更新一下
✖   subject may not be empty [subject-empty]
✖   type may not be empty [type-empty]
✖   found 2 problems, 0 warnings

# 提交被拒绝
```

```bash
$ git commit -m "feat(memory): 新增槽位判定与去重逻辑"
✅ 提交成功
```

**要不要现在就装？**

```text
建议：等你写出第一行 TypeScript 代码时再装。

现在仓库里只有文档，装上 commitlint 会拦住你改文档时的临时提交，
反而增加摩擦。先养成手写习惯（用 §8.1 的模板），
等代码量上来、提交变频繁了再上工具。
```

## 8.3 查看历史的常用命令

```bash
# 一行一条，最常用
git log --oneline

# 带图，看分支合并
git log --oneline --graph --all

# 只看某个模块的改动
git log --oneline -- src/memory/

# 搜提交信息
git log --oneline --grep "去重"

# 搜代码变化（哪个提交增删了这个字符串）
git log -S "superseded_by" --oneline

# 看某次提交的完整内容
git show <sha>

# 看某个文件的历史
git log -p -- src/memory/conflict.ts
```

---

# 9. 本项目的约定速查

## 9.1 提交前检查清单

```text
□ 这次提交只做了一件事吗？跨模块了吗？
□ git diff --cached 看过了吗？没有调试代码和 .env 吧？
□ type 选对了吗？（feat=新能力 / fix=修缺陷 / refactor=不改行为）
□ scope 是模块名吗？
□ 第一行 ≤ 50 字符、没加句号吗？
□ 正文解释了「为什么」而不是复述 diff 吗？
□ 有破坏性变更的话，写了 BREAKING CHANGE 吗？
```

## 9.2 各场景该用什么 type

| 你要做的事 | type | 示例 |
| ---- | ---- | ---- |
| 加一个记忆提取能力 | `feat` | `feat(memory): 新增记忆抽取结构化输出` |
| 修一个召回漏掉的 bug | `fix` | `fix(retrieval): 修正软删除记忆仍被召回` |
| 改数据库表结构 | `feat(db)` / `fix(db)` | `feat(db): 新增 memory_sources 反向索引` |
| 写/改设计文档 | `docs` | `docs(db): 新增数据库设计 V1.1` |
| 抽公共逻辑、不改行为 | `refactor` | `refactor(api): 统一错误码映射` |
| 让检索更快 | `perf` | `perf(retrieval): 复用查询计划缓存` |
| 加测试 | `test` | `test(memory): 补充槽位冲突用例` |
| 改 Docker / 依赖 | `build` | `build: 升级 pgvector 镜像到 0.8.6` |
| 改 .gitignore / 脚本 | `chore` | `chore(repo): 排除本地备份目录` |
| 只调格式 | `style` | `style: 统一缩进为 2 空格` |
| 撤销某提交 | `revert` | `revert: feat(memory): 新增槽位判定` |

## 9.3 从今天起的三个具体行动

```text
① 装模板（1 分钟）
     git config commit.template .gitmessage

② 养成两个习惯
     写提交前：git diff --cached
     写提交时：先问「这是一件事还是三件事」

③ 下次动 schema 之前
     先提交一次干净基线，给自己留个「后悔药」点
```

---

# 10. 常见疑问

**Q：单人项目有必要这么讲究吗？**
A：格式可以简化，但**粒度不能省**。粒度是给你自己留后路的，和有没有同事无关。格式的价值是半年后你还能 grep 到。

**Q：中文还是英文？**
A：本仓库用中文。理由：项目文档是中文，术语（记忆演化、槽位、冲突判定）在中文语境下更准确，翻译成英文反而失真。
唯一例外是 `BREAKING CHANGE` 和 `type` —— 这两个必须英文，因为工具要解析。

**Q：提交信息要写多长？**
A：遵守"最小必要"。
- 改错别字：只写第一行
- 常规改动：第一行 + 两三行正文
- 有取舍/有坑/有背景：完整写

**Q：`wip` 提交能用吗？**
A：本地分支可以用，但**代价是你会忘记清理**。
建议：真要临时存一下，用 `git stash` 而不是 `wip` 提交。非得提交就用 `chore: wip 临时保存`，并在合并前 `rebase -i` 压掉。

**Q：一次提交改了 20 个文件正常吗？**
A：看情况。
- 正常：重命名一个模块（文件多但一件事）
- 不正常：20 个文件分属 5 个模块——该拆

判断标准始终是**"一个逻辑改动"**，不是文件数量。

**Q：`git add -A` 到底能不能用？**
A：能用，但要**先看 `git status`**。
危险在于它会连未跟踪的临时文件、日志、`.env` 一起加进去。安全用法：

```bash
git status              # 确认没有不该提交的
git add -A
git diff --cached       # 再确认一次
git commit
```

---

# 附录 A　提交信息速查卡

```text
格式：  <type>(<scope>): <subject>
第一行：≤ 50 字符，祈使语气，不加句号
正文：  解释「为什么」，不是复述 diff
footer：BREAKING CHANGE / Closes #N

type   feat fix docs refactor perf test build chore style revert
scope  db memory retrieval agent conversation timeline review
       llm embedding api web config deps docs repo
```

**三句话自检：**

```text
1. 这条提交只做了一件事吗？
2. type 说的是「改动类型」还是「我的动作」？
3. 正文解释了为什么吗，还是把 diff 抄了一遍？
```

---

# 附录 B　正例集（本项目语境）

```text
feat(db): 新增 extraction_runs 表作为抽取幂等键
fix(embedding): 修复内容变更后向量未重算导致的静默错误
fix(retrieval): 修正软删除记忆仍被召回的问题
refactor(memory): 抽取「当前有效记忆」谓词为单一常量
perf(retrieval): 向量检索改为精确扫描并移除冗余索引
feat(memory): 新增受控词表与槽位判定流程
feat(agent): Agent Loop 补充分配迭代上限与超时
feat(api): 新增抽取状态查询接口
test(memory): 补充字面不相似但冲突的难例用例
docs(db): 新增数据库设计 V1.1
docs(api): 补全 SSE 事件契约
build: 新增本地容器环境（Postgres + pgvector + TEI）
build(embedding): 固定 TEI 镜像为 89-1.9 并启用 FP16
chore(repo): 新增 .gitignore 与 .gitattributes
style: 统一 TypeScript 缩进为 2 空格
```

---

# 附录 C　反例集（对照着别这么写）

```text
❌ 提交
❌ 更新
❌ 修改
❌ 修复bug
❌ 优化代码
❌ 完善功能
❌ 一些改动
❌ 终于好了
❌ 明天继续
❌ wip
❌ 111
❌ asdf
❌ 测试
❌ 再提交一次
❌ 修复了整个记忆系统的所有问题
❌ docs: 更新文档
❌ feat: 修改了登录逻辑          ← type 当动词用
❌ fix: 新增了错误处理           ← 新增不是 fix
```

**共同特征：** 删掉这条信息，你对这次改动的了解**没有任何损失**。那就等于没写。

---

**规范结束。**

本规范与《LifeMate 设计评审与改进建议 V1.0》配套使用：
评审报告约束「改什么」，本规范约束「怎么把这个改动记录下来」。
