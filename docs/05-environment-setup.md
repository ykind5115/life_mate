# LifeMate 本地环境搭建操作手册 V1.0

**项目名称：** LifeMate
**文档类型：** 环境搭建操作手册（Manual Runbook）
**版本：** V1.0
**适用对象：** 项目负责人自行操作
**目标环境：** Windows 11 + RTX 4070 Laptop 8G + Docker Desktop
**预计耗时：** 首次约 60～90 分钟（含镜像与模型下载）

---

# 0. 本手册要达成什么

跑完本手册后，你的机器上会有：

```text
① PostgreSQL 18 + pgvector 0.8.x + pg_trgm       → localhost:5432
② bge-m3 Embedding 服务（GPU 加速，1024 维）      → localhost:8080
③ 两者可互相打通，能完成「写入记忆 → 生成向量 → 相似度检索」全链路
```

**本手册不包含：**

```text
❌ 写 Drizzle Schema（属于代码工作，另起任务）
❌ 部署 Fastify 应用
❌ 部署 LLM（本手册只做 Embedding）
```

**执行原则：** 每一步都有「验证」小节。**验证不通过就不要进入下一步**——环境问题越早暴露越省时间。

---

# 目录

- [1. 前置检查](#1-前置检查)
- [2. 目录与配置文件](#2-目录与配置文件)
- [3. 步骤一：启动 PostgreSQL + pgvector](#3-步骤一启动-postgresql--pgvector)
- [4. 步骤二：验证数据库与扩展](#4-步骤二验证数据库与扩展)
- [5. 步骤三：验证 VECTOR(1024) 与相似度检索](#5-步骤三验证-vector1024-与相似度检索)
- [6. 步骤四：启动 bge-m3 Embedding 服务](#6-步骤四启动-bge-m3-embedding-服务)
- [7. 步骤五：验证 Embedding 输出 1024 维](#7-步骤五验证-embedding-输出-1024-维)
- [8. 步骤六：端到端打通（生成向量 → 入库 → 检索）](#8-步骤六端到端打通生成向量--入库--检索)
- [9. 日常操作速查](#9-日常操作速查)
- [10. 故障排查](#10-故障排查)
- [11. 备份与恢复演练](#11-备份与恢复演练)
- [12. 完成检查清单](#12-完成检查清单)

---

# 1. 前置检查

## 1.1 确认 Docker Desktop 正在运行

```powershell
docker version
docker info --format '{{.ServerVersion}}'
```

✅ 期望：两条命令都成功返回版本号。

❌ 若报 `error during connect` / `Is the docker daemon running?` / `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`：

**启动 Docker Desktop**（开始菜单搜索 "Docker Desktop"），等托盘图标停止转动、变为稳定状态（通常 30～60 秒），再重试。

> ⚠️ **本项目当前状态下 Docker 引擎未运行。** 你执行本手册时第一件事就是启动它。
>
> 只装 CLI 而没有启动 Docker Desktop，会得到「命令存在但连不上守护进程」的现象——这是最容易误判为「环境坏了」的情况。
>
> 快速判断：

```powershell
# 引擎在跑时，会列出容器
docker ps

# 若报 npipe 连接失败 → 引擎没起，去启动 Docker Desktop
```


## 1.2 确认使用 WSL2 后端（关键）

Docker Desktop → 右上角齿轮 **Settings** → **General** → 确认：

```text
☑ Use the WSL 2 based engine
```

❌ 如果是 Hyper-V 后端，GPU 穿透会失败，本手册第 6 步无法完成。

## 1.3 确认 WSL2 已安装

```powershell
wsl --version
wsl --list --verbose
```

✅ 期望：返回 WSL 版本信息，且至少有一个发行版（`docker-desktop` 通常存在）。

❌ 若提示 `wsl` 不是命令或未安装：

```powershell
wsl --install
# 按提示重启机器，然后重新执行
```

## 1.4 确认宿主机 GPU 正常

```powershell
nvidia-smi
```

✅ 期望：显示 `NVIDIA GeForce RTX 4070 Laptop GPU`，`8188MiB`，且 Driver 版本存在。

**记录下你的驱动版本**，后面排查 GPU 问题会用到。

### 1.4.1 记录 GPU 计算能力（关键）

```powershell
nvidia-smi --query-gpu=name,compute_cap,driver_version,memory.total --format=csv
```

✅ 本机实测结果：

```text
name, compute_cap, driver_version, memory.total [MiB]
NVIDIA GeForce RTX 4070 Laptop GPU, 8.9, 581.42, 8188 MiB
```

> 🔴 **`compute_cap = 8.9` 这个数字必须记住。**
>
> 它决定了第 6 步要用哪个 Embedding 推理镜像。用错镜像标签会导致容器启动即失败，而报错信息通常不会直接告诉你「镜像架构不匹配」。

**为什么重要：** GPU 推理镜像在构建时会把 CUDA kernel 编译成特定计算能力的机器码。8.9（Ada Lovelace）的 kernel 不能跑在为 8.0（Ampere）编译的镜像上。

## 1.5 确认容器内可访问 GPU（关键验证）

这一步是**整个手册最容易出问题的地方**，务必先单独验证：

```powershell
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

✅ 期望：容器内输出与宿主机一致的 GPU 信息表。

❌ **如果失败**，按下表处理：

| 报错 | 原因 | 处理 |
| ---- | ---- | ---- |
| `could not select device driver "" with capabilities: [[gpu]]` | Docker Desktop 未启用 GPU 支持 | Settings → Resources → 确认有 GPU 选项；或更新 Docker Desktop 到最新版 |
| `--gpus` 参数未被识别 | Docker 版本过旧 | 升级 Docker Desktop |
| 容器启动但 `nvidia-smi` 不存在 / 报错 | WSL2 内核或驱动不匹配 | 更新 Windows 版 NVIDIA 驱动（**必须装 Windows 驱动，不要装 WSL 内驱动**），然后 `wsl --shutdown` 重启 |

> ⚠️ **不要跳过这一步。** 如果容器拿不到 GPU，第 6 步的 bge-m3 会退化成 CPU 推理，虽然能跑但毫无意义（CPU 上 bge-m3 单条推理约 100～300ms，GPU 约 5～15ms）。

## 1.6 确认 Embedding 镜像标签与 GPU 匹配

> 🔴 **这一步是为了避免「下载 2GB+ 镜像后才发现跑不起来」。**

Text Embeddings Inference (TEI) 为不同 GPU 架构提供**不同镜像标签**。官方对应关系：

| GPU 架构 | 计算能力 | 镜像标签 | 典型显卡 |
| ---- | ---- | ---- | ---- |
| **Ada Lovelace** | **sm_89** | **`89-1.9`** | **RTX 4000 系 ← 你的显卡** |
| Ampere | sm_86 | `86-1.9` | RTX 3000 系、A10、A40 |
| Ampere | sm_80 | `1.9` | A100、A30 |
| Hopper | sm_90 | `hopper-1.9` | H100 |
| Turing | sm_75 | `turing-1.9`（实验性） | T4、RTX 2000 系 |
| Blackwell | sm_120 | `120-1.9`（实验性） | RTX 5000 系 |
| 无独显 / 排查用 | — | `cpu-1.9` | — |

来源：[TEI 官方 README「Docker Images」](https://github.com/huggingface/text-embeddings-inference)

**其他硬性要求：**

```text
① NVIDIA 驱动需兼容 CUDA ≥ 12.2
② 计算能力 < 7.5 不被支持（V100、GTX 1000 系不支持）
③ 本机驱动 581.42，满足要求
```

**本项目已在 `docker-compose.yml` 中使用正确的标签：**

```yaml
image: ghcr.io/huggingface/text-embeddings-inference:89-1.9
```

你可以先验证标签可拉取（不需要下载完整镜像）：

```powershell
docker manifest inspect ghcr.io/huggingface/text-embeddings-inference:89-1.9 > $null
if ($LASTEXITCODE -eq 0) { "镜像标签可用" } else { "镜像标签不可用，检查网络或代理" }
```

✅ 期望：输出「镜像标签可用」。

> 💡 如果你的机器换成别的显卡（例如换了 RTX 30 系），**必须同步修改这个标签**，否则第 6 步会失败。修改位置见 `docker-compose.yml` 中 `embedding.image`。


---

# 2. 目录与配置文件

## 2.1 确认目录结构

> 📌 **本节列出的文件仓库中均已存在，无需手动创建。**
> 这里只做核对，确认你拉到的是正确版本。

项目根目录 `D:\workspace\LifeMate` 的当前结构：

```text
D:\workspace\LifeMate\
├── docs\                              设计文档（01~07 + archive）
├── devops\                            环境与运维配置
│   └── postgres\
│       └── init\
│           └── 01-extensions.sql      ← 数据库初始化脚本
├── src\                               （预留）TypeScript 源码
├── docker-compose.yml                 postgres + embedding 两个服务
├── .env                               环境变量（含密码，不提交）
├── .env.example                       环境变量模板（提交）
├── .gitignore
├── .gitattributes
└── .gitmessage                        提交信息模板
```

**分层原则：**

```text
devops\   环境与运维配置 —— 与 src\ 平级，不是应用代码
src\      应用代码 —— 按业务模块组织
docs\     设计文档
根目录     只放「必须在这一层」的配置
```

> 💡 **为什么 `docker-compose.yml` 在根目录而不在 `devops\`？**
> Docker Compose 自动读取的 `.env` 位置**只跟 compose 文件所在目录有关**。
> 留在根目录，`docker compose up -d` 在任何目录下都能读到环境变量；
> 移入子目录就会变成「必须先 cd 进去才能执行」的坑。

**核对命令：**

```powershell
cd D:\workspace\LifeMate
Test-Path devops\postgres\init\01-extensions.sql
Test-Path docker-compose.yml
Test-Path .env.example
```

✅ 期望：三行都输出 `True`。

## 2.2 `.gitignore`

> ⚠️ **`.env` 必须在 .gitignore 中**，它含有数据库密码。这个项目保存的是私密生活数据，密码泄露的代价很高。

仓库中已有 `.gitignore`，内容如下（供核对）：

```gitignore
# 环境变量（含密码，绝不提交）
.env

# 备份文件
backups/
*.dump

# 依赖与构建产物
node_modules/
dist/
build/

# 编辑器
.vscode/
.idea/
*.log
```

## 2.3 `docker-compose.yml`

> 📌 **该文件已在仓库根目录，无需创建。** 以下是核对要点与设计理由。

```powershell
# 查看实际内容
Get-Content docker-compose.yml

# 校验语法（会自动展开变量，能发现大部分配置错误）
docker compose config
```

✅ 期望：`docker compose config` 退出码为 0，并输出展开后的完整配置。

**核对清单：**

```text
□ 两个服务：postgres、embedding
□ 端口均为 127.0.0.1 前缀（不对局域网暴露）
□ postgres.image 为 pgvector/pgvector:pg18
□ postgres 挂载 ./devops/postgres/init 到 /docker-entrypoint-initdb.d
□ embedding.image 为 ghcr.io/huggingface/text-embeddings-inference:89-1.9
□ embedding.environment 含 DTYPE: float16
□ embedding.deploy 含 nvidia gpu 预留
```

**关键决策说明：**

| 决策 | 理由 |
| ---- | ---- |
| `127.0.0.1:5432:5432` 而非 `5432:5432` | 只绑回环，不对局域网暴露。你的记忆库是本机私密数据 |
| 固定 `TZ: Asia/Shanghai` | 避免容器与宿主时区不一致导致 `TIMESTAMPTZ` 语义混乱 |
| `--locale=C` | 让排序规则确定，避免不同机器上 `ORDER BY` 结果不一致 |
| 独立 `lifemate-hf-cache` 卷 | 模型权重约 2.3 GB，不能每次重启重下 |
| `DTYPE: float16` | 显存占用约 3.2 GB；不设置时 TEI 可能用 FP32 而显存翻倍 |
| `89-1.9` 镜像标签 | 匹配 RTX 4070 的计算能力 sm_89，见 §1.6 |
| 不用 `version:` 字段 | Compose V2 已废弃该字段，写了只会产生 warning |
| compose 文件放根目录 | 保证 `.env` 能被自动读取，见 §2.1 |

## 2.4 `.env.example`

> 📌 **该文件已在仓库根目录，无需创建。** 内容如下（供核对）：

```bash
# ============================================
# LifeMate 本地开发环境变量
# 使用方式：复制为 .env 后修改密码
#   Copy-Item .env.example .env
# ============================================

# ---------- PostgreSQL ----------
POSTGRES_USER=lifemate
POSTGRES_PASSWORD=change_me_to_a_strong_password
POSTGRES_DB=lifemate

# 应用连接串（Node.js 使用）
# 注意：密码中的特殊字符会破坏 URL 解析，建议只用字母和数字
DATABASE_URL=postgresql://lifemate:change_me_to_a_strong_password@127.0.0.1:5432/lifemate

# ---------- Embedding 服务 ----------
EMBEDDING_BASE_URL=http://127.0.0.1:8080
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIM=1024
```

> 💡 `EMBEDDING_DIM=1024` 是《数据库设计 V1.1》中 `VECTOR(1024)` 的配套声明。
> 若 §7.3 实测维度不是 1024，**这个值和表结构都要一起改**。

## 2.5 创建 `.env`（本步骤需要你动手）

这是配置阶段唯一必须手动执行的步骤：

```powershell
cd D:\workspace\LifeMate
Copy-Item .env.example .env
```

然后编辑 `.env`，**把密码换成一个强密码**。生成一个随机密码：

```powershell
# 生成 32 位随机密码
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})
```

> ⚠️ 密码中的特殊字符会破坏 `DATABASE_URL` 的解析。建议只用**字母和数字**，或对特殊字符做 URL 编码。

**验证 `.env` 已被 git 忽略：**

```powershell
git check-ignore -v .env     # 应输出匹配的忽略规则
git status --short           # .env 不应出现在列表中
```

## 2.6 初始化脚本 `devops/postgres/init/01-extensions.sql`

> 📌 **该文件已存在，无需创建。** 内容如下（供核对）：

```sql
-- LifeMate 数据库初始化
-- 仅在数据卷首次创建时执行一次

-- 向量检索扩展（pgvector）
CREATE EXTENSION IF NOT EXISTS vector;

-- 关键词检索扩展（中文场景使用三元组匹配，见《数据库设计 V1.1》§17.4）
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 通用工具
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 输出确认
DO $$
BEGIN
  RAISE NOTICE 'LifeMate extensions installed: vector=%, pg_trgm=%',
    (SELECT extversion FROM pg_extension WHERE extname = 'vector'),
    (SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm');
END $$;
```

> 📌 `pg_trgm` 是**必须的**，不是可选项。《数据库设计 V1.1》§17.4 决定用 `pg_trgm` 承担混合检索的关键词通道——因为 PostgreSQL 默认全文检索不支持中文分词。

---

# 3. 步骤一：启动 PostgreSQL + pgvector

## 3.1 先只启动数据库

```powershell
cd D:\workspace\LifeMate
docker compose up -d postgres
```

## 3.2 观察启动日志

```powershell
docker compose logs -f postgres
```

✅ 期望看到（顺序大致如下）：

```text
PostgreSQL init process complete; ready for start up.
...
database system is ready to accept connections
```

以及初始化脚本的输出：

```text
NOTICE:  LifeMate extensions installed: vector=0.8.x, pg_trgm=1.6
```

看到 `ready to accept connections` 后按 **Ctrl+C** 退出日志跟踪（**不会停止容器**）。

## 3.3 确认容器健康

```powershell
docker compose ps
```

✅ 期望 `postgres` 的 `STATUS` 为 `Up ... (healthy)`。

❌ 若为 `Up ... (health: starting)`，等 20 秒再查一次。

❌ 若为 `Restarting` 或 `Exited`：

```powershell
docker compose logs postgres
```

常见原因是 `.env` 中密码为空或含未转义字符。

---

# 4. 步骤二：验证数据库与扩展

## 4.1 进入 psql

```powershell
docker compose exec postgres psql -U lifemate -d lifemate
```

✅ 期望：出现 `lifemate=#` 提示符。

> 💡 退出 psql 用 `\q`。

## 4.2 验证扩展已加载

在 psql 中执行：

```sql
SELECT extname, extversion FROM pg_extension ORDER BY extname;
```

✅ 期望至少包含：

```text
 extname  | extversion
----------+------------
 pg_trgm  | 1.6
 plpgsql  | 1.0
 uuid-ossp| 1.1
 vector   | 0.8.x
```

## 4.3 验证服务器参数

```sql
SHOW server_version;
SHOW TimeZone;
SHOW server_encoding;
```

✅ 期望：

```text
 server_version  | 18.x
 TimeZone        | Asia/Shanghai
 server_encoding | UTF8
```

> ⚠️ 如果 `TimeZone` 不是 `Asia/Shanghai`，`TIMESTAMPTZ` 的显示会与你的预期差 8 小时。虽然存储是 UTC 不受影响，但排查问题时容易误判。修正方式见 [§10.6](#106-时区不正确)。

## 4.4 验证中文存储

```sql
SELECT '测试中文与 emoji 😀' AS check_text, length('测试中文与 emoji 😀') AS len;
```

✅ 期望：中文正常显示，`len` 为合理值（不是乱码或问号）。

❌ 如果显示为乱码，是**客户端编码**问题而非数据库问题，执行：

```sql
SET client_encoding = 'UTF8';
```

PowerShell 终端本身也需要 UTF-8：

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

---

# 5. 步骤三：验证 VECTOR(1024) 与相似度检索

> 这一步**在真正建表之前**先把 pgvector 用起来，确认维度语义和距离算子符合预期。这是模板里最容易踩坑的部分。

## 5.1 建一张临时表

在 psql 中：

```sql
CREATE TABLE _vector_smoke_test (
  id        SERIAL PRIMARY KEY,
  content   TEXT,
  embedding VECTOR(1024)          -- 与《数据库设计 V1.1》§4.2 冻结的维度一致
);
```

## 5.2 插入测试向量

手工构造向量太麻烦，用一个技巧：**用 `array_fill` 生成规则向量**，先验证维度与算子是否工作。

```sql
-- 插入三条 1024 维向量
-- A: 全 1
INSERT INTO _vector_smoke_test (content, embedding)
VALUES ('全1向量', array_fill(1.0::real, ARRAY[1024])::vector);

-- B: 全 0.9（与 A 非常接近）
INSERT INTO _vector_smoke_test (content, embedding)
VALUES ('全0.9向量', array_fill(0.9::real, ARRAY[1024])::vector);

-- C: 前 512 个为 1，后 512 个为 -1（与 A 正交）
INSERT INTO _vector_smoke_test (content, embedding)
VALUES (
  '前后相反的向量',
  (array_fill(1.0::real, ARRAY[512]) || array_fill(-1.0::real, ARRAY[512]))::vector
);
```

✅ 期望：三条都插入成功，无报错。

❌ 若报 `expected 1024 dimensions, not 512`，说明维度拼接有问题，检查 SQL。

## 5.3 验证维度约束生效

故意插入错误维度：

```sql
INSERT INTO _vector_smoke_test (content, embedding)
VALUES ('错误维度', array_fill(1.0::real, ARRAY[512])::vector);
```

✅ **期望报错**：

```text
ERROR:  expected 1024 dimensions, not 512
```

这个报错是好事——它证明维度约束真的生效了。**如果这条插入成功了，说明你的表用的不是 `VECTOR(1024)`，必须回去检查。**

## 5.4 验证余弦相似度检索

```sql
SELECT
  content,
  1 - (embedding <=> (SELECT embedding FROM _vector_smoke_test WHERE content = '全1向量')) AS cosine_similarity
FROM _vector_smoke_test
ORDER BY embedding <=> (SELECT embedding FROM _vector_smoke_test WHERE content = '全1向量')
LIMIT 5;
```

✅ 期望结果（语义上）：

```text
     content      | cosine_similarity
------------------+-------------------
 全1向量          |                 1
 全0.9向量        |                 1
 前后相反的向量    |                 0
```

**解读：**

- `<=>` 是**余弦距离**（pgvector 的算子），`1 - 距离 = 相似度`。
- 全 1 与全 0.9 方向完全相同 → 相似度 1（余弦只看方向，不看长度）。
- 前后相反的向量与全 1 正交 → 相似度 0。

> 💡 这个结果也顺带说明了一件事：**余弦相似度只看方向**。这就是为什么《数据库设计 V1.1》§14.5 要把 `type` 和时间提示拼进 `embedded_text`——否则语义不同但词面相近的文本在向量空间里会靠得很近。

## 5.5 验证精确检索的召回率

```sql
EXPLAIN ANALYZE
SELECT id FROM _vector_smoke_test
ORDER BY embedding <=> (SELECT embedding FROM _vector_smoke_test WHERE id = 1)
LIMIT 1;
```

✅ 期望：执行计划是 **`Seq Scan`**（顺序扫描），而非 `Index Scan`。

**这是符合预期的**——《数据库设计 V1.1》§18.1 决定 V1.0 不建向量索引，走精确检索（召回率 100%）。

❌ 如果出现了 `Index Scan`，说明有遗留索引：

```sql
\d _vector_smoke_test
-- 若有 hnsw / ivfflat 索引
DROP INDEX <索引名>;
```

## 5.6 清理

```sql
DROP TABLE _vector_smoke_test;
```

✅ 期望：删除成功。

---

# 6. 步骤四：启动 bge-m3 Embedding 服务

## 6.1 启动服务

```powershell
cd D:\workspace\LifeMate
docker compose up -d embedding
```

> ⚠️ **首次启动会下载约 2.3 GB 模型权重**，取决于网速需要几分钟到几十分钟。

**本次启动使用的关键配置（已在 `docker-compose.yml` 中设定）：**

```text
镜像           ghcr.io/huggingface/text-embeddings-inference:89-1.9
               └─ 89 = Ada Lovelace（你的 4070，sm_89）。用错标签会启动失败
模型           BAAI/bge-m3
DTYPE          float16      → 显存约 3.2 GB
max-client-batch-size  32
端口           127.0.0.1:8080 → 容器内 80
```

> 💡 `DTYPE: float16` 是刻意设置的。不指定时 TEI 可能以 FP32 加载，显存翻倍到约 6.4 GB，在 8G 卡上会给后续的 reranker 留不下空间。


## 6.2 观察下载与加载日志

```powershell
docker compose logs -f embedding
```

✅ 期望依次看到：

```text
Downloading model.safetensors ...
...
Starting model server at 0.0.0.0:80
```

以及类似：

```text
Ready
```

看到 `Ready` 后 Ctrl+C 退出日志跟踪。

## 6.3 确认容器状态

```powershell
docker compose ps
```

✅ 期望 `embedding` 为 `Up`。

❌ 若不断重启：

```powershell
docker compose logs --tail 50 embedding
```

常见原因见 [§10.3](#103-embedding-容器反复重启)。

## 6.4 验证容器内 GPU 可用

```powershell
docker compose exec embedding nvidia-smi
```

✅ 期望：输出 GPU 信息表，且能看到一个 python 进程占用显存（约 3.2 GB）。

❌ 若报 `nvidia-smi: command not found`：TEI 镜像可能未包含该工具，改用下面的方式间接验证（看响应延迟）。

❌ 若报 CUDA 相关错误：回到 [§1.5](#15-确认容器内可访问-gpu关键验证) 重新验证 GPU 穿透。

---

# 7. 步骤五：验证 Embedding 输出 1024 维

## 7.1 健康检查

```powershell
curl.exe http://127.0.0.1:8080/health
```

✅ 期望：返回 `OK` 或 HTTP 200。

> 💡 Windows 上**必须用 `curl.exe`**，不能只用 `curl`——PowerShell 会把 `curl` 解析为 `Invoke-WebRequest` 的别名，参数行为不同。

## 7.2 获取模型信息

```powershell
curl.exe http://127.0.0.1:8080/info
```

✅ 期望：返回 JSON，包含 `"model_id":"BAAI/bge-m3"` 与 `"max_input_length":8192` 之类的字段。

## 7.3 生成一个向量并检查维度（关键）

PowerShell 中调用：

```powershell
$body = @{ inputs = "用户正在学习 TypeScript" } | ConvertTo-Json
$resp = Invoke-RestMethod -Uri "http://127.0.0.1:8080/embed" `
                          -Method Post `
                          -ContentType "application/json" `
                          -Body $body

"向量维度: " + $resp[0].Count
"前 5 个分量: " + ($resp[0][0..4] -join ", ")
```

✅ **期望：`向量维度: 1024`**

❌ 如果维度不是 1024：

```powershell
# 先确认服务实际加载的模型
curl.exe http://127.0.0.1:8080/info
```

- 若 `model_id` 不是 `BAAI/bge-m3` → 检查 `docker-compose.yml` 的 `--model-id` 参数
- 若 `model_id` 正确但维度不对 → 说明**我们 Q4 的决策需要重新评估**，暂停后续步骤，回到《数据库设计 V1.1》§4.2 修订

> 🔴 **这个数字必须确认。** 它是《数据库设计 V1.1》中 `VECTOR(1024)` 的唯一依据。如果实际不是 1024，整份 Schema 都要改。

## 7.4 验证语义相似度（确认模型真的在工作）

```powershell
function Get-Embedding([string]$text) {
    $body = @{ inputs = $text } | ConvertTo-Json
    (Invoke-RestMethod -Uri "http://127.0.0.1:8080/embed" `
                       -Method Post -ContentType "application/json" -Body $body)[0]
}

function Get-CosineSimilarity($a, $b) {
    $dot = 0.0; $na = 0.0; $nb = 0.0
    for ($i = 0; $i -lt $a.Count; $i++) {
        $dot += $a[$i] * $b[$i]
        $na  += $a[$i] * $a[$i]
        $nb  += $b[$i] * $b[$i]
    }
    $dot / ([Math]::Sqrt($na) * [Math]::Sqrt($nb))
}

$query = Get-Embedding "我最近那个 TS 项目怎么样了"
$doc1  = Get-Embedding "用户正在学习 TypeScript"
$doc2  = Get-Embedding "今天中午吃了个鸡腿"

"相关记忆 相似度: {0:N4}" -f (Get-CosineSimilarity $query $doc1)
"无关记忆 相似度: {0:N4}" -f (Get-CosineSimilarity $query $doc2)
```

✅ 期望：**相关记忆的相似度明显高于无关记忆**（通常差距在 0.2 以上）。

例如：

```text
相关记忆 相似度: 0.6812
无关记忆 相似度: 0.2351
```

❌ 如果两者接近（比如都在 0.5 附近），说明模型或调用有问题，不要继续。

> 💡 这个测试也验证了产品最关键的能力：用户说「TS 项目」而不是「TypeScript 项目」，系统依然能找到相关记忆（对应 PRD §7.3 的召回目标）。

## 7.5 测量推理延迟

```powershell
$body = @{ inputs = "测试延迟" } | ConvertTo-Json
$sw = [System.Diagnostics.Stopwatch]::StartNew()
1..10 | ForEach-Object {
    Invoke-RestMethod -Uri "http://127.0.0.1:8080/embed" `
                      -Method Post -ContentType "application/json" -Body $body | Out-Null
}
$sw.Stop()
"平均单次延迟: {0:N1} ms" -f ($sw.ElapsedMilliseconds / 10)
```

✅ 期望（GPU 正常）：

```text
平均单次延迟: 10 ~ 50 ms
```

❌ 若为 **100～500 ms**：GPU 没有生效，正在用 CPU 推理。回到 [§1.5](#15-确认容器内可访问-gpu关键验证)。

---

# 8. 步骤六：端到端打通（生成向量 → 入库 → 检索）

> 这一步是**真正的验收**。前面每一步都通过、但这一步失败，说明各组件之间的契约没对上。

## 8.1 建一张贴近真实结构的测试表

回到 psql：

```powershell
docker compose exec postgres psql -U lifemate -d lifemate
```

执行：

```sql
CREATE TABLE _e2e_test (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content       TEXT NOT NULL,
  embedded_text TEXT NOT NULL,
  content_hash  VARCHAR(64) NOT NULL,
  model         VARCHAR(100) NOT NULL,
  embedding     VECTOR(1024) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'ready',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

> 注意字段命名与《数据库设计 V1.1》§14.3 的 `memory_embeddings` 保持一致，这样这次测试的结论可以直接迁移。

## 8.2 用 PowerShell 写入真实向量

**新开一个 PowerShell 窗口**（保持 psql 窗口开着）：

```powershell
cd D:\workspace\LifeMate

function Get-Embedding([string]$text) {
    $body = @{ inputs = $text } | ConvertTo-Json
    (Invoke-RestMethod -Uri "http://127.0.0.1:8080/embed" `
                       -Method Post -ContentType "application/json" -Body $body)[0]
}

function To-PgVector($arr) {
    "[" + (($arr | ForEach-Object { $_.ToString([System.Globalization.CultureInfo]::InvariantCulture) }) -join ",") + "]"
}

function Get-Sha256([string]$text) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $hash  = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    ($hash | ForEach-Object { $_.ToString("x2") }) -join ""
}

function Insert-Memory([string]$content) {
    # 与《数据库设计 V1.1》§14.5 的拼接规则一致
    $embeddedText = "fact｜用户｜$content"
    $vec  = Get-Embedding $embeddedText
    $hash = Get-Sha256 $embeddedText
    $vecLiteral = To-PgVector $vec

    $sql = @"
INSERT INTO _e2e_test (content, embedded_text, content_hash, model, embedding)
VALUES ('$content', '$embeddedText', '$hash', 'bge-m3', '$vecLiteral'::vector)
RETURNING id;
"@
    docker compose exec -T postgres psql -U lifemate -d lifemate -t -A -c $sql
}

# 写入三条记忆
Insert-Memory "用户正在学习 TypeScript"
Insert-Memory "用户住在广州"
Insert-Memory "用户喜欢直接、具体的技术解释"
```

✅ 期望：三条都返回一个 UUID。

❌ 若报 `invalid input syntax for type vector`，是向量字符串格式化问题，检查 `To-PgVector` 是否用了 InvariantCulture（某些区域设置会用逗号作小数点，导致向量解析失败）。

## 8.3 执行语义检索

```powershell
function Search-Memory([string]$query) {
    $qvec = To-PgVector (Get-Embedding $query)
    $sql = @"
SELECT content,
       ROUND((1 - (embedding <=> '$qvec'::vector))::numeric, 4) AS similarity
  FROM _e2e_test
 WHERE status = 'ready'
 ORDER BY embedding <=> '$qvec'::vector
 LIMIT 3;
"@
    docker compose exec -T postgres psql -U lifemate -d lifemate -c $sql
}

Search-Memory "我最近那个 TS 项目怎么样了"
```

✅ **期望结果**：

```text
            content             | similarity
--------------------------------+------------
 用户正在学习 TypeScript        |     0.6xxx
 用户喜欢直接、具体的技术解释    |     0.4xxx
 用户住在广州                   |     0.2xxx
```

**关键判定：** 查询里**没有出现「TypeScript」这个词**（只说了「TS 项目」），但排在第一位的是 TypeScript 记忆。这证明语义检索链路完整可用。

❌ 如果 TypeScript 记忆没有排第一，检查：

1. `embedded_text` 是否真的包含了内容（§8.2 的拼接）
2. 是否用了同一个模型生成查询向量与文档向量（**必须同一个模型**，否则向量空间不通用）

## 8.4 验证软件层面的去重（对应 §14.4）

再插入一次相同内容：

```powershell
Insert-Memory "用户正在学习 TypeScript"
```

```sql
SELECT content, COUNT(*) FROM _e2e_test GROUP BY content;
```

✅ 期望：TypeScript 记忆出现 **2 行**。

**这是正确的**——因为这张测试表没有 `(memory_id, model)` 唯一约束（真实表里 `memory_embeddings` 有此约束，但那是按 `memory_id` 去重，不是按内容去重）。

> 💡 这里刻意暴露了一个重要区别，值得记住：
>
> ```text
> memory_embeddings 的 UNIQUE (memory_id, model)  → 防止「同一条记忆存了多个向量」
> 记忆内容的去重                                  → 靠 §13.7 的槽位判定，不是靠数据库约束
> ```
>
> 后者**无法用数据库约束表达**，必须由抽取流水线负责。这正是《数据库设计 V1.1》§13.7 存在的原因。

## 8.5 验证软删除从检索中排除（对应 §18.3）

```sql
UPDATE _e2e_test SET status = 'deleted' WHERE content = '用户住在广州';
```

```powershell
Search-Memory "我最近那个 TS 项目怎么样了"
```

✅ 期望：结果中**不再出现**「用户住在广州」。

```sql
-- 但记录仍在（软删除）
SELECT content, status FROM _e2e_test WHERE content = '用户住在广州';
```

✅ 期望：仍能查到，`status = 'deleted'`。

> 💡 这条验证对应评审 P1-2。生产代码里，这个 `status='ready'` 过滤条件**必须在 Repository 层定义一次并被全局复用**，禁止在业务代码里手写。

## 8.6 清理测试数据

```sql
DROP TABLE _e2e_test;
```

## 8.7 记录本次验证结果

把以下数字记下来，它们是后续基线：

```text
pgvector 版本            : __________
Embedding 模型           : BAAI/bge-m3
向量维度                 : 1024
单次 embedding 延迟      : __________ ms
相关/无关相似度差距       : __________ / __________
```

---

# 9. 日常操作速查

## 9.1 启停

```powershell
cd D:\workspace\LifeMate

# 启动全部
docker compose up -d

# 启动指定服务
docker compose up -d postgres
docker compose up -d embedding

# 停止（保留数据）
docker compose stop

# 停止并删除容器（数据卷保留）
docker compose down

# ⚠️ 危险：停止并删除数据卷（会丢失全部数据）
docker compose down -v
```

> 🔴 **`down -v` 会删除 `lifemate-pgdata`，你的全部记忆数据将不可恢复。** 永远不要在有真实数据后执行它。

## 9.2 查看日志

```powershell
docker compose logs -f              # 全部服务
docker compose logs -f postgres
docker compose logs --tail 100 embedding
```

## 9.3 进入数据库

```powershell
docker compose exec postgres psql -U lifemate -d lifemate
```

常用 psql 命令：

```text
\dt              列出所有表
\d memories      查看表结构
\d+ memories     查看表结构（含约束与索引）
\di              列出索引
\df              列出函数
\x               切换展开显示（宽表阅读友好）
\timing          显示查询耗时
\q               退出
```

## 9.4 资源监控

```powershell
# 容器资源占用
docker stats --no-stream

# GPU 占用
nvidia-smi

# 数据库大小
docker compose exec postgres psql -U lifemate -d lifemate -c `
  "SELECT pg_size_pretty(pg_database_size('lifemate'));"
```

## 9.5 常用连接串

```text
PostgreSQL   postgresql://lifemate:<password>@127.0.0.1:5432/lifemate
Embedding    http://127.0.0.1:8080
TEI 健康检查 http://127.0.0.1:8080/health
TEI 模型信息 http://127.0.0.1:8080/info
```

---

# 10. 故障排查

## 10.1 端口被占用

**症状：**

```text
Error response from daemon: Ports are not available: exposing port TCP 0.0.0.0:5432 -> ... bind: address already in use
```

**排查：**

```powershell
# 查谁占了 5432
Get-NetTCPConnection -LocalPort 5432 -State Listen |
  Select-Object LocalAddress, LocalPort, OwningProcess,
    @{n='Process';e={(Get-Process -Id $_.OwningProcess).ProcessName}}

# 同理查 8080
Get-NetTCPConnection -LocalPort 8080 -State Listen
```

**处理（三选一）：**

```text
① 停掉占用端口的程序
② 改宿主机映射端口（推荐，改动最小）
     docker-compose.yml 中改为 "127.0.0.1:5433:5432"
     同步更新 .env 的 DATABASE_URL 端口
③ 若占用者是本机已装的 PostgreSQL 服务：
     Stop-Service postgresql-x64-18
     Set-Service  postgresql-x64-18 -StartupType Manual
```

## 10.2 扩展创建失败

**症状：** 日志中出现

```text
ERROR:  could not open extension control file ".../vector.control": No such file or directory
```

**原因：** 用错了镜像。普通 `postgres:18` 镜像**不含 pgvector**。

**处理：**

```powershell
# 确认镜像是 pgvector 官方镜像
docker compose config | Select-String "image:"
# 应为：image: pgvector/pgvector:pg18
```

修改后需要重建数据卷（初始化脚本只在首次创建时执行）：

```powershell
docker compose down -v      # ⚠️ 会清空数据，仅在无真实数据时执行
docker compose up -d postgres
```

## 10.3 Embedding 容器反复重启

**排查顺序：**

```powershell
docker compose logs --tail 100 embedding
```

| 日志关键词 | 原因 | 处理 |
| ---- | ---- | ---- |
| `CUDA error` / `no CUDA-capable device` | GPU 未穿透 | 回到 [§1.5](#15-确认容器内可访问-gpu关键验证) |
| `no kernel image is available for execution on the device` | **镜像计算能力与显卡不匹配** | 见下方 §10.3.1，这是 8.9 显卡最容易踩的坑 |
| `OutOfMemoryError` / `CUDA out of memory` | 显存不足 | 见 §10.4 |
| `Connection error` / `timeout` 下载模型 | 网络无法访问 HuggingFace | 见 §10.5 |
| `permission denied` 写 `/data` | 卷权限 | `docker compose down` 后删除 `lifemate-hf-cache` 卷重建 |
| `Address already in use` | 8080 被占 | 见 §10.1 |

### 10.3.1 镜像计算能力不匹配（RTX 40 系最易踩）

**症状：** 容器反复重启，日志出现以下之一：

```text
no kernel image is available for execution on the device
CUDA error: no kernel image is available for execution
Error: Failed to initialize CUDA
```

**原因：** 镜像标签与显卡计算能力不匹配。用 `1.9`（Ampere sm_80）跑 Ada sm_89 就会这样。

**诊断：**

```powershell
# 1) 确认显卡计算能力
nvidia-smi --query-gpu=name,compute_cap --format=csv
# → 期望：NVIDIA GeForce RTX 4070 Laptop GPU, 8.9

# 2) 确认 compose 里用的标签
docker compose config | Select-String "image:.*text-embeddings"
# → 期望：image: ghcr.io/huggingface/text-embeddings-inference:89-1.9
```

**处理：**

编辑 `docker-compose.yml`，把 `embedding.image` 改为与计算能力匹配的标签（对应关系见 [§1.6](#16-确认-embedding-镜像标签与-gpu-匹配)）：

```yaml
# sm_89（RTX 40 系）
image: ghcr.io/huggingface/text-embeddings-inference:89-1.9
```

然后重建：

```powershell
docker compose down embedding
docker compose up -d embedding
docker compose logs -f embedding
```

**临时绕过（仅用于确认问题是否出在镜像标签上）：** 改用 CPU 镜像，如果 CPU 镜像能正常起服务，基本可以断定是 GPU 镜像架构问题。

```powershell
# 临时验证用，确认后应改回 GPU 镜像
docker run --rm -p 8080:80 `
  ghcr.io/huggingface/text-embeddings-inference:cpu-1.9 `
  --model-id BAAI/bge-m3
```

> ⚠️ CPU 模式下单条推理约 100～300 ms，**不要用它做正式环境**，仅用于隔离问题。

## 10.4 显存不足

**症状：** `CUDA out of memory`

bge-m3 在 FP16 下约占 3.2 GB，8G 显存本该宽裕。若报 OOM，通常是**别的程序占用了显存**。

```powershell
nvidia-smi
```

看 `Processes` 表格，确认没有其他进程（浏览器硬件加速、游戏、其他容器）占用。

**处理：**

```powershell
# 释放被 Docker 占用的显存
docker compose restart embedding

# 若仍不足，限制 TEI 的批大小
# docker-compose.yml 中把 --max-client-batch-size 从 32 调小到 8
```

可选：把 Windows 桌面上的 GPU 加速关掉（浏览器 → 设置 → 系统 → 关闭硬件加速）。

## 10.5 模型下载失败

**症状：** 日志停在 `Downloading ...` 或反复 `Connection error`。

**排查：**

```powershell
# 测试能否访问 HuggingFace
curl.exe -I https://huggingface.co
```

**处理（三选一）：**

```text
① 配置国内镜像（推荐）
     在 docker-compose.yml 的 embedding 服务 environment 中加：
       HF_ENDPOINT: https://hf-mirror.com

② 使用代理
     在 Docker Desktop → Settings → Resources → Proxies 中配置

③ 手动下载后挂载
     在宿主机下载 BAAI/bge-m3 全部文件到某个目录，
     然后把该目录挂载到容器内对应位置
```

## 10.6 时区不正确

**症状：** `SHOW TimeZone;` 返回 `UTC`。

**处理：**

```sql
-- 会话级（临时）
SET TIME ZONE 'Asia/Shanghai';

-- 数据库级（持久）
ALTER DATABASE lifemate SET timezone TO 'Asia/Shanghai';

-- 验证
SHOW TimeZone;
```

## 10.7 中文显示乱码

**症状：** psql 里中文显示为 `???` 或乱码。

**处理：**

```powershell
# 设置 PowerShell 为 UTF-8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001
```

在 psql 中：

```sql
SET client_encoding = 'UTF8';
SHOW client_encoding;
```

若想永久生效，在项目根目录建 `~/.psqlrc` 不便（Windows），可改用连接参数：

```powershell
docker compose exec -e PGCLIENTENCODING=UTF8 postgres psql -U lifemate -d lifemate
```

## 10.8 PowerShell 下 curl 行为异常

**症状：** `curl -X POST ...` 报参数错误，或返回的不是原始响应。

**原因：** PowerShell 中 `curl` 是 `Invoke-WebRequest` 的**别名**，参数语义不同。

**处理：** 始终使用 `curl.exe`，或用 `Invoke-RestMethod`：

```powershell
curl.exe -X POST http://127.0.0.1:8080/embed `
  -H "Content-Type: application/json" `
  -d '{\"inputs\":\"测试\"}'
```

## 10.9 Docker 磁盘占用过大

```powershell
docker system df
```

**清理：**

```powershell
# 清理未使用的镜像、容器、网络（不删卷）
docker system prune -a

# 查看卷占用
docker volume ls
docker system df -v
```

> ⚠️ `docker system prune --volumes` **会删除数据卷**，包含你的数据库。不要用它。

---

# 11. 备份与恢复演练

> 《数据库设计 V1.1》§28 要求备份，并明确「备份的重要性高于普通业务系统」——因为长期积累的人生数据不可重建。

## 11.1 手动备份

```powershell
cd D:\workspace\LifeMate
$date = Get-Date -Format "yyyyMMdd-HHmmss"

docker compose exec -T postgres pg_dump -U lifemate -d lifemate -Fc `
  > "backups/lifemate-$date.dump"

"已备份: backups/lifemate-$date.dump"
Get-Item "backups/lifemate-$date.dump" | Select-Object Name, Length
```

`-Fc` 是自定义格式，支持压缩和选择性恢复。

## 11.2 恢复演练（每季度一次）

> ⚠️ **不要在正式库上演练。** 用独立数据库验证。

```powershell
cd D:\workspace\LifeMate

# 1) 建一个演练库
docker compose exec -T postgres psql -U lifemate -d postgres `
  -c "CREATE DATABASE lifemate_restore_test;"

# 2) 恢复备份到演练库
Get-Content "backups/lifemate-<你选的文件>.dump" -AsByteStream -Raw |
  docker compose exec -T postgres pg_restore -U lifemate -d lifemate_restore_test --no-owner

# 3) 验证数据
docker compose exec -T postgres psql -U lifemate -d lifemate_restore_test `
  -c "SELECT COUNT(*) FROM memories;"

# 4) 清理演练库
docker compose exec -T postgres psql -U lifemate -d postgres `
  -c "DROP DATABASE lifemate_restore_test;"
```

✅ 期望：第 3 步返回正确的记忆条数。

**记录演练耗时**：__________（这是真实的 RTO 参考值）。

## 11.3 自动备份（Windows 任务计划）

```powershell
# 创建备份脚本 backups\backup.ps1
@'
$ErrorActionPreference = "Stop"
Set-Location "D:\workspace\LifeMate"
$date = Get-Date -Format "yyyyMMdd-HHmmss"
$out  = "backups\lifemate-$date.dump"

docker compose exec -T postgres pg_dump -U lifemate -d lifemate -Fc > $out

# 删除 30 天前的备份
Get-ChildItem backups\*.dump |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
  Remove-Item -Force

Write-Host "Backup done: $out"
'@ | Set-Content -Encoding UTF8 backups\backup.ps1
```

注册为每日任务：

```powershell
$action  = New-ScheduledTaskAction -Execute "pwsh.exe" `
             -Argument "-NoProfile -File D:\workspace\LifeMate\backups\backup.ps1"
$trigger = New-ScheduledTaskTrigger -Daily -At 03:00
Register-ScheduledTask -TaskName "LifeMate-Backup" `
  -Action $action -Trigger $trigger -RunLevel Highest
```

> ⚠️ **备份文件必须加密。** 它包含你全部的记忆内容（明文形式）。Windows 可用 BitLocker 加密整个 `D:\`，或用 7-Zip 加密后再存：

```powershell
7z a -p"<密码>" -mhe=on "backups/lifemate-$date.7z" "backups/lifemate-$date.dump"
Remove-Item "backups/lifemate-$date.dump"
```

---

# 12. 完成检查清单

全部通过才算环境就绪：

## 12.1 环境与 GPU

```text
□ docker version 成功
□ Docker Desktop 使用 WSL2 后端
□ wsl --version 成功
□ nvidia-smi 在宿主机正常
□ 记录了 GPU 计算能力为 8.9（sm_89）
□ docker-compose.yml 的 embedding 镜像标签为 89-1.9              ← 关键
□ docker run --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi 成功  ← 关键
```

## 12.2 PostgreSQL

```text
□ docker compose up -d postgres 成功
□ docker compose ps 显示 healthy
□ SELECT extname FROM pg_extension 包含 vector 与 pg_trgm
□ SHOW server_version 为 18.x
□ SHOW TimeZone 为 Asia/Shanghai
□ 中文插入与查询正常
```

## 12.3 pgvector

```text
□ VECTOR(1024) 建表成功
□ 插入 512 维时正确报错（证明维度约束生效）
□ 余弦相似度检索结果符合语义预期
□ EXPLAIN 显示 Seq Scan（证明未建索引，符合设计）
```

## 12.4 Embedding 服务

```text
□ docker compose up -d embedding 成功
□ /health 返回 OK
□ /info 返回 model_id = BAAI/bge-m3
□ 向量维度为 1024                                              ← 关键
□ 相关文本相似度明显高于无关文本（差距 > 0.2）
□ 单次推理延迟 < 50 ms（证明 GPU 生效）                        ← 关键
□ nvidia-smi 显示显存占用约 3.2 GB
```

## 12.5 端到端

```text
□ 「我最近那个 TS 项目怎么样了」能召回 TypeScript 记忆          ← 关键
□ 软删除后该记忆不再出现在检索结果
□ 但数据仍可查到（软删除语义正确）
□ 测试表已清理
```

## 12.6 工程配套

```text
□ .gitignore 已创建且包含 .env
□ .env 未被 git 跟踪（git status 中不出现）
□ .env.example 已创建并提交
□ docker-compose.yml 端口绑定为 127.0.0.1
□ 备份脚本就位，且手动跑通过一次
□ 记录下 pgvector 版本、单次 embedding 延迟作为基线
```

确认 `git status` 中 `.env` 不会出现：

```powershell
cd D:\workspace\LifeMate
git status --short
git check-ignore -v .env
```

✅ 期望：`git check-ignore` 输出匹配的忽略规则，且 `.env` **不在** `git status` 列表中。

---

# 附录 A　验证结果记录表

跑完后把实测值填在这里，作为后续开发的基线：

| 项目 | 期望 | 实测 | 备注 |
| ---- | ---- | ---- | ---- |
| Docker 版本 | — | | |
| GPU 计算能力 | 8.9 (sm_89) | | 决定镜像标签 |
| TEI 镜像标签 | 89-1.9 | | 与计算能力匹配 |
| NVIDIA 驱动版本 | ≥ CUDA 12.2 兼容 | | |
| pgvector 版本 | 0.8.x | | |
| pg_trgm 版本 | 1.6 | | |
| PostgreSQL 版本 | 18.x | | |
| 数据库时区 | Asia/Shanghai | | |
| Embedding 模型 | BAAI/bge-m3 | | |
| **向量维度** | **1024** | | 不符则需修订数据库设计 |
| Embedding 延迟 | < 50 ms | | 超过则 GPU 未生效 |
| GPU 显存占用 | ~3.2 GB | | |
| 相关文本相似度 | 明显更高 | | |
| 无关文本相似度 | 明显更低 | | |
| 备份文件大小 | — | | |
| 恢复演练耗时 | — | | RTO 参考值 |

---

# 附录 B　与《数据库设计 V1.1》的对应关系

本手册验证的每一项，都对应数据库设计中的一条决策：

| 本手册步骤 | 对应设计决策 | 章节 |
| ---- | ---- | ---- |
| §2.6 创建 pg_trgm 扩展 | Keyword 通道用 pg_trgm 承担 | §17.4 |
| §5 验证 `VECTOR(1024)` | Q4：bge-m3，维度冻结 | §4.2 |
| §5.5 验证 Seq Scan | V1.0 不建向量索引，精确检索 | §18.1 |
| §7.3 验证 1024 维 | `memory_embeddings.embedding` 的维度 | §14.3 |
| §8.1 测试表字段命名 | `embedded_text` / `content_hash` / `model` / `status` | §14.3 |
| §8.2 拼接 `embedded_text` | 嵌入文本的拼接规则 | §14.5 |
| §8.4 去重讨论 | 内容去重靠槽位判定，非数据库约束 | §13.7 |
| §8.5 软删除过滤 | 「当前有效」谓词与检索过滤 | §13.6 / §18.3 |
| §10.1 端口只绑回环 | 隐私要求（数据默认私有） | §29 |
| §11 备份与恢复 | 备份策略与恢复演练 | §28 |

---

# 附录 C　下一步

环境就绪后，接下来的顺序（见《数据库设计 V1.1》§34）：

```text
① 初始化项目骨架（pnpm + TypeScript + Fastify + Drizzle）
        ↓
② 编写 Drizzle Schema（以《数据库设计 V1.1》§13–§22 为准）
        ↓
③ drizzle-kit generate → 生成 Migration SQL
        ↓
④ 执行 Migration（复用本手册的数据库容器）
        ↓
⑤ 用本手册 §8 的方式验证记忆写入与检索
        ↓
⑥ Repository 层
        ↓
⑦ 抽取流水线（extraction_runs 幂等 + 槽位判定）
        ↓
⑧ 检索流水线（RRF + 重排）
```

---

**操作手册结束。**

遇到本手册未覆盖的问题，先执行以下命令收集信息，再排查：

```powershell
docker compose ps
docker compose logs --tail 100
docker info
nvidia-smi
```
