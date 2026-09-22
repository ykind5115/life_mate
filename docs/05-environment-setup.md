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

> ⚠️ **不要跳过这一步。** 如果容器拿不到 GPU，第 6 步的 bge-m3 会退化成 CPU 推理，虽然能跑但毫无意义（**GPU 约 10～50 ms，CPU 约 100～300 ms**，见 [§7.5](#75-测量推理延迟) 的实测口径）。

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

## 1.7 确认 Docker Compose 是 V2

本手册所有命令都写成 **Compose V2 的子命令形式**（`docker compose`，中间是空格）。先确认版本，避免后面被 V1 的差异误导：

```powershell
docker compose version
```

✅ 期望：输出 `Docker Compose version v2.x.y`。

❌ 若报 `docker: 'compose' is not a docker command`：说明只有旧的独立二进制 `docker-compose`（V1）。升级 Docker Desktop 到最新版即可；**不要把本手册的 `docker compose` 自行改成 `docker-compose`**，两者参数行为不一致（详见 [§10.10.3](#10103-docker-compose-is-not-a-docker-command)）。

---

# 2. 目录与配置文件

## 2.1 确认目录结构

> 📌 **本节列出的文件仓库中均已存在，无需手动创建。**
> 这里只做核对，确认你拉到的是正确版本。
> 唯一例外是 `backups\`：它是备份输出目录，不入库，在 [§11.1](#111-手动备份) 首次备份时创建。

项目根目录 `D:\workspace\LifeMate` 的当前结构：

```text
D:\workspace\LifeMate\
├── docs\                              设计文档（01~07 + archive）
├── devops\                            环境与运维配置
│   └── postgres\
│       └── init\
│           └── 01-extensions.sql      ← 数据库初始化脚本
├── src\                               （预留）TypeScript 源码
├── backups\                           备份输出目录（不入库，首次备份时创建）
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
# 环境变量（含数据库密码，绝不提交）
.env

# 备份文件（含私密数据的明文，绝不提交）
backups/
*.dump
*.7z

# 依赖与构建产物
node_modules/
dist/
build/
*.tsbuildinfo

# 日志
*.log
logs/

# 编辑器与系统
.vscode/
.idea/
.DS_Store
Thumbs.db
```

## 2.3 `docker-compose.yml`

> 📌 **该文件已在仓库根目录，无需创建。** 以下是核对要点与设计理由。

```powershell
# 查看实际内容
Get-Content docker-compose.yml
```

> 💡 **这里先不要跑 `docker compose config`。** 此时 `.env` 尚未创建（见 §2.5），所有 `${POSTGRES_*}` 变量都是空的，compose 只会刷一屏 `variable is not set` 警告，什么也验证不了。语法校验放在 §2.5 末尾 `.env` 就绪之后。

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
Copy-Item .env.example .env -Force
```

> 💡 加 `-Force` 是为了让这条命令**可重复执行**：`.env` 已存在时直接覆盖，不会中途报错。

**然后编辑 `.env`，把密码换成一个强密码。** 生成一个随机密码：

```powershell
# 生成 32 位随机密码
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_})
```

> 🔴 **`.env` 里有两处密码，必须改成同一个值：**
>
> ```text
> POSTGRES_PASSWORD=<新密码>                        ← 容器用它初始化/校验账号
> DATABASE_URL=postgresql://lifemate:<新密码>@127.0.0.1:5432/lifemate
>                                 ↑ .env.example 第 14 行嵌着同一份密码
> ```
>
> 只改 `POSTGRES_PASSWORD` 而漏掉 `DATABASE_URL`，容器能起来，但应用侧仍拿着旧密码连接，表现为 `password authentication failed for user "lifemate"`。两处必须**完全一致**。

> ⚠️ 密码中的特殊字符会破坏 `DATABASE_URL` 的解析。建议只用**字母和数字**，或对特殊字符做 URL 编码。

> ⚠️ **`.env` 必须以 UTF-8（无 BOM）保存，不能是 UTF-16。** Windows PowerShell 5.1 的 `Set-Content` / `>` 重定向默认写出 **UTF-16 LE（带 BOM）**，Compose 解析时会看到字符之间夹着的 NUL 字节，报出难以定位的解析错误。请用编辑器另存为 UTF-8，或显式指定编码：
>
> ```powershell
> Get-Content .env.example | Set-Content -Encoding utf8NoBOM .env
> ```
>
> （`utf8NoBOM` 是 PowerShell 7+ 的写法；5.1 下请改用编辑器保存。）

**验证 `.env` 已被 git 忽略：**

```powershell
git check-ignore -v .env     # 应输出匹配的忽略规则
git status --short           # .env 不应出现在列表中
```

**校验 compose 配置（必须在 `.env` 就绪之后做）：**

```powershell
# 退出码为 0，并输出展开后的完整配置
docker compose config

# 只看解析后的环境变量（Compose V2 可用）
docker compose config --environment
```

✅ 期望：`docker compose config` 退出码为 0，输出中 `POSTGRES_USER`、`POSTGRES_DB` 为真实值 `lifemate`，`POSTGRES_PASSWORD` 为**你刚设置的密码**（既不是空串，也不是模板里的 `change_me_to_a_strong_password`）。

❌ 若输出里出现 `variable is not set. Defaulting to a blank string`，说明 `.env` 没被读到（文件名不对、不在 compose 同目录、或编码是 UTF-16），**不要继续下一步**。

## 2.6 初始化脚本 `devops/postgres/init/01-extensions.sql`

> 📌 **该文件已存在，无需创建。** 内容如下（供核对）：

```sql
-- LifeMate 数据库初始化
-- 仅在数据卷首次创建时执行一次
-- 对应《LifeMate 数据库设计 V1.1》§7、§11.3.2、§17.4 与 §18
--
-- ⚠️ 本脚本只在「数据卷为空」时执行。
--    对已经存在数据的库补扩展，必须写进 Migration —— 改这里不会生效。

-- 向量检索扩展（pgvector）
CREATE EXTENSION IF NOT EXISTS vector;

-- 关键词检索扩展
-- 中文场景下 PostgreSQL 默认全文检索不支持中文分词，
-- 因此混合检索的关键词通道使用 pg_trgm 的字符三元组匹配。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 区间排他约束所需
-- extraction_runs 的 excl_extraction_range 用 EXCLUDE 保证「成功区间不重叠」，
-- 其等值部分（conversation_id）需要 uuid 的 GiST 操作符类，由 btree_gist 提供。
-- 缺少本扩展时该约束无法创建，见《数据库设计 V1.1》§11.3.2。
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 不需要 uuid-ossp：所有主键使用 gen_random_uuid()，PostgreSQL 13+ 内置（见 §7）。

-- 输出确认
DO $$
BEGIN
  RAISE NOTICE 'LifeMate extensions installed: vector=%, pg_trgm=%, btree_gist=%',
    (SELECT extversion FROM pg_extension WHERE extname = 'vector'),
    (SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm'),
    (SELECT extversion FROM pg_extension WHERE extname = 'btree_gist');
END $$;
```

> 📌 `pg_trgm` 是**必须的**，不是可选项。《数据库设计 V1.1》§17.4 决定用 `pg_trgm` 承担混合检索的关键词通道——因为 PostgreSQL 默认全文检索不支持中文分词。

> 📌 `btree_gist` 同样是**必须的**，不是可选项。《数据库设计 V1.1》§11.3.2 的 `excl_extraction_range` 用 `EXCLUDE` 保证「同一会话的成功抽取区间不重叠」，其等值部分 `conversation_id` 是 `uuid`，需要由 `btree_gist` 提供 GiST 操作符类。**缺少该扩展时 `ALTER TABLE ... ADD CONSTRAINT excl_extraction_range` 会直接失败**，而报错文案（见 [§10.2](#102-扩展创建失败)）不会提示你缺的是扩展。

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
NOTICE:  LifeMate extensions installed: vector=0.8.x, pg_trgm=1.x, btree_gist=1.x
...
PostgreSQL init process complete; ready for start up.
...
database system is ready to accept connections
```

> 📌 **`NOTICE` 在 `PostgreSQL init process complete; ready for start up.` 之前**——初始化脚本是在 `/docker-entrypoint-initdb.d` 阶段跑的，早于数据库正式启动。
>
> 📌 **`NOTICE` 只在「首次初始化」出现。** 它由 `devops/postgres/init/01-extensions.sql` 发出，而该脚本仅在**数据卷为空**时执行一次。第二次及以后启动，日志里**没有这行 `NOTICE` 是完全正常的**，不要据此判断失败；要确认扩展是否装好，用 [§4.2](#42-验证扩展已加载) 的 SQL 查询。

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

✅ 期望：至少包含下面四行（`btree_gist` / `pg_trgm` / `plpgsql` / `vector`），且版本号落在下面的模式里：

```text
 extname   | extversion   ← 不要按字面核对，只要匹配前缀即可
-----------+------------
 btree_gist| 1.*
 pg_trgm   | 1.*
 plpgsql   | 1.0
 vector    | 0.8.*
```

> 📌 **判据只看到前缀：`vector` 以 `0.8.` 开头，`btree_gist` / `pg_trgm` 以 `1.` 开头。** 文档里不写死具体小版本号（不同镜像 tag 会有出入），要看本机实际值就直接查：
>
> ```sql
> SELECT extname, extversion FROM pg_extension
>  WHERE extname IN ('vector', 'pg_trgm', 'btree_gist', 'plpgsql')
>  ORDER BY extname;
> ```

> 📌 **`uuid-ossp` 是刻意不安装的。** 初始化脚本用的是 PostgreSQL 13+ 内置的 `gen_random_uuid()`（见《数据库设计 V1.1》§7），所以清单里**不应该**出现 `uuid-ossp`。若出现了，说明用的还是旧版初始化脚本。

## 4.3 验证服务器参数

```sql
SHOW server_version;
SHOW TimeZone;
SHOW server_encoding;
```

✅ 期望：`server_version` **以 `18.` 开头**，`TimeZone` 为 `Asia/Shanghai`，`server_encoding` 为 `UTF8`。

```text
 server_version  | 18.0 (Debian 18.0-1.pgdg120+1)
 TimeZone        | Asia/Shanghai
 server_encoding | UTF8
```

> 📌 `SHOW server_version` 打印的是**完整版本串**（形如 `18.0 (Debian ...)`），不会只输出 `18.x`。所以判据只能写成「以 `18.` 开头」，不要去找字面量 `18.x`。想要纯数字版本用 `SHOW server_version_num;`（应为 `180000` 级别）。

> ⚠️ 如果 `TimeZone` 不是 `Asia/Shanghai`，`TIMESTAMPTZ` 的显示会与你的预期差 8 小时。虽然存储是 UTC 不受影响，但排查问题时容易误判。修正方式见 [§10.6](#106-时区不正确)。

## 4.4 验证中文存储

```sql
-- ① 字面量：只证明客户端能显示中文
SELECT '测试中文与 emoji 😀' AS check_text, length('测试中文与 emoji 😀') AS len;

-- ② 真正的插入 + 回读：证明中文能落盘再取回（§12.2 的检查项指的是这一步）
CREATE TEMP TABLE _cn_check (id SERIAL PRIMARY KEY, t TEXT);
INSERT INTO _cn_check (t) VALUES ('测试中文与 emoji 😀');
SELECT id, t, length(t) AS len FROM _cn_check;
```

✅ 期望：两步都正常。第 ② 步回读出来的 `t` 必须与插入时**逐字相同**（emoji 也不能变成 `?`），`len` 为合理值。

> 💡 `_cn_check` 是临时表，只存在于当前会话，`\q` 退出即自动消失，不会污染数据库。

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
ORDER BY embedding <=> (array_fill(1.0::real, ARRAY[1024]))::vector
LIMIT 1;
```

✅ 期望：**只判读「对 `embedding` 排序」这一步**——它是 `Seq Scan`（必要时配 `Sort` / `Limit`），而不是向量索引扫描。

**这是符合预期的**——《数据库设计 V1.1》§18.1 决定 V1.0 不建向量索引，走精确检索（召回率 100%）。

**判读要点（容易误判，务必看完）：**

```text
• 上面的查询用「字面量向量」作排序键，计划里只应该出现 Seq Scan
• 如果写成子查询 (SELECT embedding FROM _vector_smoke_test WHERE id = 1)，
  计划里出现 Index Scan using _vector_smoke_test_pkey 是完全正常的：
  那是主键在查 id = 1 这一行，与向量排序无关，不是问题
• 真正的问题只有一种：embedding 列上存在 hnsw / ivfflat 向量索引
```

❌ 只有当 `\d _vector_smoke_test` 显示 `embedding` 列上有 hnsw / ivfflat 向量索引时，才需要删掉它：

```sql
\d _vector_smoke_test
-- 仅当 embedding 列上有 hnsw / ivfflat 索引时才执行
-- DROP INDEX <向量索引名>;
-- 注意：_vector_smoke_test_pkey 是主键索引，不要删
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

> ✅ **不需要下载模型。** 当前 `docker-compose.yml` 使用的是**宿主机上已有的
> bge-m3 权重**（bind mount），不走 HuggingFace 下载。见下方说明。

**本次启动使用的关键配置（已在 `docker-compose.yml` 中设定）：**

```text
镜像           ghcr.io/huggingface/text-embeddings-inference:89-1.9
               └─ 89 = Ada Lovelace（你的 4070，sm_89）。用错标签会启动失败
               └─ 镜像约 8.16 GB，ghcr.io 拉取可能较慢
模型           /data/models/bge-m3   ← 容器内路径，由 bind mount 提供
               └─ 宿主机实际路径来自 .env 的 BGE_M3_MODEL_DIR
pooling        cls          → 必须显式指定，见下方说明
DTYPE          float16      → 显存约 3.2 GB
max-client-batch-size  32
端口           127.0.0.1:8080 → 容器内 80
```

### 6.1.1 为什么用本地权重而不是让 TEI 下载

```text
① 省掉 2.3 GB 下载，且不受网络波动影响
   （实测：ghcr.io 镜像拉取多次 TLS 超时，容器内下载模型同样可能失败）
② 模型文件完全不出网，契合「数据默认私有」的隐私要求（docs/03 §29）
③ 权重目录已存在于本机：D:\workspace\RAG_system\rag_qa\models\bge-m3
```

**模型目录的内容要求**（约 2.13 GB）：

```text
config.json              架构 xlm-roberta，hidden_size=1024，max_position_embeddings=8194
model.safetensors        权重，约 2.27 GB
tokenizer.json
tokenizer_config.json
```

### 6.1.2 `--pooling cls` 为什么必须显式指定

上面那份权重**缺少 Sentence-Transformers 的 `1_Pooling/config.json`**（没有 `modules.json`）。
TEI 启动时会警告：

```text
WARN Could not find a Sentence Transformers config
```

没有该文件时 TEI 无法推断池化方式，**不指定会用到错误池化、导致向量质量下降**。
bge-m3 官方使用 CLS pooling，因此在 `command` 中显式加了 `--pooling cls`。

> ⚠️ 若今后换成从 HuggingFace 完整下载的权重（含 `1_Pooling`），
> 该参数可以去掉，但留着也无害（显式指定优先于推断）。

> 💡 `DTYPE: float16` 也是刻意设置的。不指定时 TEI 可能以 FP32 加载
> （该权重的 `config.json` 里 `dtype` 就是 `float32`），显存翻倍到约 6.4 GB，
> 在 8G 卡上会给后续的 reranker 留不下空间。


## 6.2 观察加载日志

```powershell
docker compose logs -f embedding
```

✅ 期望依次看到（本机实测输出，已省略时间戳）：

```text
Args { model_id: "/data/models/bge-m3", ... dtype: Some(Float16), ... pooling: Some(Cls), ... }
WARN Could not find a Sentence Transformers config        ← 预期内，见 §6.1.2
INFO Maximum number of tokens per request: 8192
INFO Starting model backend
INFO Starting FlashBert model on Cuda(CudaDevice(DeviceId(1)))   ← GPU 生效
INFO Warming up model
INFO Starting HTTP server: 0.0.0.0:80
INFO Ready
```

**关键三行，对应三项配置：**

```text
dtype: Some(Float16)                    ← DTYPE 生效
pooling: Some(Cls)                      ← --pooling cls 生效
Starting FlashBert model on Cuda(...)   ← GPU 生效
```

> ⚠️ 那条 `Could not find a Sentence Transformers config` 的 WARN
> **是预期内的**，不是错误 —— 本地权重缺少 `1_Pooling/config.json`，
> 已用 `--pooling cls` 显式补偿。详见 §6.1.2。
>
> 若看到 `Downloading model.safetensors`，说明 bind mount 没生效、
> TEI 回退到了联网下载，检查 `.env` 的 `BGE_M3_MODEL_DIR`。

从启动到 `Ready` 约 **35 秒**（含模型加载与 warmup），比联网下载快得多。

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

✅ 期望：输出 GPU 信息表，且能看到一个名为 `text-embeddings-` 的进程占用显存（约 3.2 GB）。

> 📌 TEI 是 Rust 二进制，进程名不是 `python`。`nvidia-smi` 的 `Processes` 表里显示的进程名会被截断为 `text-embeddings-`（完整名 `text-embeddings-router`）。看到 `python` 反而说明跑的不是 TEI。

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

✅ 期望：返回 JSON，包含 `"model_id":"BAAI/bge-m3"`，且存在 `max_input_length` 字段。

> 📌 `max_input_length` 的具体数值由模型配置决定（本文档不写死），这里**只要求该字段存在**。真正的硬性门槛是 [§7.3](#73-生成一个向量并检查维度关键) 的 **1024 维**检查，不是这个字段的值。

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

> ⚠️ **必须先丢弃第一次（预热）调用。** 首次请求包含模型预热与 CUDA kernel 装载，耗时会明显高于稳态（可能达到数百毫秒），把它算进平均会得出「GPU 没生效」的错误结论。

```powershell
$body = @{ inputs = "测试延迟" } | ConvertTo-Json

# 第 1 次：预热，只发不测
Invoke-RestMethod -Uri "http://127.0.0.1:8080/embed" `
                  -Method Post -ContentType "application/json" -Body $body | Out-Null

# 之后 10 次：取平均
$sw = [System.Diagnostics.Stopwatch]::StartNew()
1..10 | ForEach-Object {
    Invoke-RestMethod -Uri "http://127.0.0.1:8080/embed" `
                      -Method Post -ContentType "application/json" -Body $body | Out-Null
}
$sw.Stop()
"平均单次延迟: {0:N1} ms" -f ($sw.ElapsedMilliseconds / 10)
```

✅ 期望（GPU 正常，已丢弃预热）：**约 10～50 ms**。

```text
平均单次延迟: 25.0 ms
```

❌ 若为 **约 100～300 ms**：GPU 没有生效，正在用 CPU 推理。回到 [§1.5](#15-确认容器内可访问-gpu关键验证)。

> 📌 全文只用这一对数字：**GPU 约 10～50 ms、CPU 约 100～300 ms**。任何位置的期望值都以本节的实测口径为准（首次调用含预热会更慢，不参与统计）。

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

function Insert-Memory([string]$content, [string]$timeHint = (Get-Date -Format "yyyy-MM-dd")) {
    # 与《数据库设计 V1.1》§14.5 的拼接规则一致：
    #   embedded_text = "{type}｜{主体}｜{content}｜{时间提示}"   ← 四段，缺一不可
    $embeddedText = "fact｜用户｜$content｜$timeHint"
    $vec  = Get-Embedding $embeddedText
    $hash = Get-Sha256 $embeddedText
    $vecLiteral = To-PgVector $vec

    $sql = @"
INSERT INTO _e2e_test (content, embedded_text, content_hash, model, embedding)
VALUES ('$content', '$embeddedText', '$hash', 'BAAI/bge-m3', '$vecLiteral'::vector)
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

> 📌 **`model` 列必须写完整的 `BAAI/bge-m3`，不能写短名 `bge-m3`。** 这是《数据库设计 V1.1》§14.5 的 C27 决策：写入与检索两侧必须用同一个字面量，否则 JOIN 会静默失配、检索永远返回空。真实实现里该值应来自单一常量（如 `EMBEDDING_MODEL_ID`），不要手写。

> 📌 **`embedded_text` 必须包含「时间提示」这第四段。** §14.5 定义的构成是 `{type}｜{主体}｜{content}｜{时间提示}`（示例：`fact｜用户｜用户住在广州｜2026-01-01 起有效`）。上面的函数用当天的 `yyyy-MM-dd` 作时间提示，保证与设计一致。

> ⚠️ **`-c $sql` 会把整条 SQL（含约 20 KB 的向量字面量）当作一个命令行参数传给 `psql`。** Windows 单个命令行参数最长约 32767 字符，且 `$vecLiteral` 里全是要转义的引号，稍有不慎就被截断或改写。更稳的做法是**落成临时 `.sql` 文件再执行，或把 SQL 通过 stdin 喂给 `psql`**：
>
> ```powershell
> # 方案 A：临时文件（推荐）
> $sql | Set-Content -Encoding utf8NoBOM "$env:TEMP\insert.sql"
> docker compose cp "$env:TEMP\insert.sql" postgres:/tmp/insert.sql
> docker compose exec -T postgres psql -U lifemate -d lifemate -t -A -f /tmp/insert.sql
>
> # 方案 B：stdin（注意管道只传文本，不要传二进制）
> $sql | docker compose exec -T postgres psql -U lifemate -d lifemate -t -A -f -
> ```
>
> 真正写业务代码时更应把向量作为**参数**绑定（`$1::vector`），而不是拼进 SQL 字符串。

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

## 8.4 验证软件层面的去重（对应 §13.7）

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
\dt              列出所有表（当前环境里只有临时测试表，业务表尚不存在）
\d <表名>        查看表结构
                 ⚠️ memories 等业务表要等 Phase 3 迁移执行后才有；
                    现在执行 \d memories 会报 `Did not find any relation named "memories"`
\d+ <表名>       查看表结构（含约束与索引）
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
Error response from daemon: Ports are not available: exposing port TCP 127.0.0.1:5432 -> ... bind: address already in use
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

### 10.2.1 缺少 `btree_gist`：`EXCLUDE` 约束建不上

**症状：** 执行《数据库设计 V1.1》§11.3.2 的 `excl_extraction_range` 时失败：

```text
ERROR:  data type uuid has no default operator class for access method "gist"
HINT:  You must specify an operator class for the index or define a default operator class for the data type.
```

**原因：** `EXCLUDE USING gist (conversation_id WITH =, ...)` 的等值部分 `conversation_id` 是 `uuid`，它没有内置的 GiST 操作符类，必须由 `btree_gist` 扩展提供。初始化脚本已包含 `CREATE EXTENSION IF NOT EXISTS btree_gist;`，所以出现这个报错说明**当前数据卷是用旧脚本初始化的**（或扩展被手工删掉了）。

**处理：** 在 psql 里直接补扩展：

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
-- 确认
SELECT extname, extversion FROM pg_extension WHERE extname = 'btree_gist';
```

> ⚠️ **改初始化脚本对已存在的数据卷无效。** `devops/postgres/init/*.sql` 只在数据卷为空的首次启动时执行一次；对已有数据的库补扩展，必须在 psql 里补（如上），并把这一步写进 Migration 以便在别的机器上可复现。**不要用 `down -v` 来「让脚本重新跑」——那会删掉全部数据。**

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
| `permission denied` 写 `/data` | 卷权限 / 卷内容坏了 | 停服务 → 确认真实卷名 → 删卷重建，见下方 §10.3.2 |
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
# down 不接受服务名（Compose V2 会报 "no such service" / 用法错误），
# 停单个服务用 stop，再 rm 掉容器
docker compose stop embedding
docker compose rm -f embedding
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

### 10.3.2 修复 `lifemate-hf-cache` 卷（HF 缓存损坏）

> ⚠️ **两个常见错误先澄清：**
>
> ```text
> ❌ 只跑 docker compose down —— down 不会删除具名卷（volume），卷还在，问题依旧
> ❌ 直接写 docker volume rm lifemate-hf-cache —— 卷名是「项目名_卷名」带前缀的，
>    项目名默认取自 compose 文件所在目录名，例如：
>      D:\workspace\LifeMate     → lifemate_lifemate-hf-cache
>      E:\workspace\life_mate    → life_mate_lifemate-hf-cache
>    名字猜错会得到 "No such volume"
> ```

**正确做法：**

```powershell
# 1) 先停掉用卷的服务（down 不接受服务名，停单个服务用 stop）
docker compose stop embedding

# 2) 列出真实卷名，按实际输出取用
docker volume ls
#   形如 lifemate_lifemate-hf-cache / life_mate_lifemate-hf-cache

# 3) 删除该卷（模型权重会在下次启动时重新下载，约 2.3 GB）
docker volume rm <上一步列出的实际卷名>

# 4) 重新起服务
docker compose up -d embedding
```

> 🔴 **`docker compose down -v` 是核选项，不要为了修这一个卷去用它。** 它会一次删掉**全部**具名卷（含 `lifemate-hf-cache`），包括 `lifemate-pgdata`——你的全部记忆数据不可恢复。

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

# 若仍不足，优先调小 --max-batch-tokens（TEI 默认 16384）
#   峰值显存由「一次实际处理多少 token」决定，这才是 OOM 的主旋钮：
#   docker-compose.yml 中 embedding.command 里加/改 --max-batch-tokens 4096（或更小）
#
# 其次才考虑 --max-client-batch-size（默认已是 32，调小收益有限）：
#   它是「客户端一次最多提交多少条」，不是显存峰值的主因
```

> 📌 **旋钮顺序不要弄反：先 `--max-batch-tokens`，再 `--max-client-batch-size`。** 长文本单条就可能撞上 token 上限，此时把客户端批大小降到 8 也救不了；反之把 `--max-batch-tokens` 降到 4096 通常立刻见效（代价是吞吐下降）。

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

若想永久生效，可以写 `~/.psqlrc`（注意：这是**用户主目录**下的文件，即 `C:\Users\<你>`，不是项目根目录），Windows 下 `~` 不总是被展开，直接用连接参数更省事：

```powershell
docker compose exec -e PGCLIENTENCODING=UTF8 postgres psql -U lifemate -d lifemate
```

## 10.8 PowerShell 下 curl 行为异常

**症状：** `curl -X POST ...` 报参数错误，或返回的不是原始响应。

**原因：** PowerShell 中 `curl` 是 `Invoke-WebRequest` 的**别名**，参数语义不同。

**处理：** 始终使用 `curl.exe`，或用 `Invoke-RestMethod`：

```powershell
# PowerShell 的单引号是字面量，JSON 里的双引号不需要反斜杠转义
curl.exe -X POST http://127.0.0.1:8080/embed `
  -H "Content-Type: application/json" `
  -d '{"inputs":"测试"}'
```

> 📌 写成 `-d '{\"inputs\":\"测试\"}'` 是错的：PowerShell 会把反斜杠原样传给 `curl.exe`，服务端收到的是非法 JSON。

更稳的是用 `Invoke-RestMethod`（与 [§7.3](#73-生成一个向量并检查维度关键) 一致），完全绕开引号转义：

```powershell
$body = @{ inputs = "测试" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:8080/embed" `
                  -Method Post -ContentType "application/json" -Body $body
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

## 10.10 `postgres` 容器起不来

**症状：** `docker compose ps` 里 `postgres` 反复 `Restarting` / `Exited`，或 `docker compose up -d postgres` 直接报错退出。按下面三类原因逐条排查。

### 10.10.1 数据卷挂载点写错（PostgreSQL 18 的目录变更）

PostgreSQL 18 官方镜像把数据目录从 `/var/lib/postgresql/data` 改成了 **`/var/lib/postgresql`**。

```text
✅ 正确：命名卷挂到 /var/lib/postgresql
❌ 错误：仍然挂到 /var/lib/postgresql/data
```

**后果有两种，都不好发现：**

```text
① 直接起不来 —— 挂载点与镜像预期的数据目录冲突，日志里出现 mount / initdb 相关报错
② 能起来，但数据「神秘消失」—— 挂载点没用上，数据实际写进了容器内的匿名卷，
   容器一被重建（up -d 后重建、rm 后重建）数据全丢
```

**处理：**

```powershell
# 确认 compose 里 postgres 的挂载点
docker compose config | Select-String "lifemate-pgdata" -Context 2,2
# 期望看到：source: lifemate-pgdata
#           target: /var/lib/postgresql      ← 注意没有 /data
```

改对挂载点后重建（⚠️ 若之前的数据写在了匿名卷里，重建会丢数据，仅在无真实数据时执行）：

```powershell
docker compose stop postgres
docker compose rm -f postgres
docker compose up -d postgres
docker compose logs --tail 50 postgres
```

### 10.10.2 `POSTGRES_PASSWORD` 为空 / 缺 `.env`

镜像在首次初始化时**要求非空密码**，否则拒绝初始化：

```text
Error: Database is uninitialized and superuser password is not specified.
       You must specify POSTGRES_PASSWORD to a non-empty value for the superuser.
```

**排查：**

```powershell
Test-Path .env                                   # 必须为 True，且与 docker-compose.yml 同目录
docker compose config --environment | Select-String "POSTGRES"
# POSTGRES_PASSWORD 必须是非空真实值
```

**处理：** 按 [§2.5](#25-创建-env本步骤需要你动手) 重建 `.env`（含 UTF-8 编码要求），注意 `POSTGRES_PASSWORD` 与 `DATABASE_URL` 里的密码必须一致。

### 10.10.3 `docker: 'compose' is not a docker command`

```text
docker: 'compose' is not a docker command.
```

**原因：** 装的是 Compose V1（独立二进制 `docker-compose`），或 Docker CLI 里没有 Compose V2 插件。

**处理：**

```powershell
# 本手册所有命令都要求 Compose V2（子命令形式 docker compose，中间是空格）
docker compose version
# 期望：Docker Compose version v2.x.y

# 若只有旧的 V1，会看到：
docker-compose version
```

升级 Docker Desktop 到最新版即可获得 V2 插件。**不要**把本手册里的 `docker compose` 替换成 `docker-compose` 来绕过——V1 已停止维护，且行为差异（如 `down` 的参数处理）会让后面的排查结论失真。

## 10.11 改了 `POSTGRES_PASSWORD` 却连不上

**症状：** 按 [§2.5](#25-创建-env本步骤需要你动手) 改了 `.env` 里的密码，重启容器后连接失败：

```text
FATAL:  password authentication failed for user "lifemate"
```

**原因：** `POSTGRES_PASSWORD` **只在数据卷为空、首次初始化时生效**。数据卷一旦存在，Postgres 的账号密码已经写在数据目录里了，后续再改 `.env` 不会再同步——环境变量被忽略，密码还是旧的那个。

同样的道理，**改 `.env` 不会改数据库里的密码，删卷重建才会**（而那是不可接受的，会丢数据）。

**处理：** 用 `ALTER USER` 在库内改密码，然后让 `.env` 跟上：

```powershell
# 用旧密码进入 psql
docker compose exec postgres psql -U lifemate -d lifemate
```

```sql
-- 改成本次设置的新密码（与 .env 中两处保持一致）
ALTER USER lifemate WITH PASSWORD '<新密码>';
-- 确认
\du lifemate
```

> 🔴 **顺序很重要：** 先用**旧密码**进得去，再执行 `ALTER USER`；改完之后才把 `.env` 的 `POSTGRES_PASSWORD` 与 `DATABASE_URL` 一起更新为新密码，然后 `docker compose restart postgres`。
>
> 若旧密码已经忘了，唯一出路是 `docker compose down -v` 重建数据卷（会清空全部数据）——所以密码请务必记牢。

---

# 11. 备份与恢复演练

> 《数据库设计 V1.1》§28 要求备份，并明确「备份的重要性高于普通业务系统」——因为长期积累的人生数据不可重建。

## 11.1 手动备份

> 🔴 **不要用 PowerShell 的重定向（`>`）或管道把 `pg_dump -Fc` 的二进制结果导出容器。**
>
> ```text
> ❌ docker compose exec -T postgres pg_dump ... -Fc > backups\x.dump
>      → Windows PowerShell 5.1 会把管道/重定向内容按文本编码处理，
>        结果是 0 字节或损坏的 dump（且不报错）
> ❌ Get-Content x.dump -AsByteStream -Raw | docker compose exec -T ...
>      → -AsByteStream 是 PowerShell 7 才有的参数；5.1 只有 -Encoding Byte
>      → 能字节保真的原生重定向要 PowerShell ≥ 7.4 才具备
> ✅ 正确做法：让 dump 落在容器内的文件里，再用 docker compose cp 取出来
> ```
>
> 下面这套写法**与 PowerShell 版本无关**（5.1 / 7.x 都一样），是唯一推荐的流程。

```powershell
cd D:\workspace\LifeMate

# 0) 确保备份目录存在（backups\ 不入库，仓库里没有这个目录）
New-Item -ItemType Directory -Force backups | Out-Null

$date = Get-Date -Format "yyyyMMdd-HHmmss"

# 1) 在容器内生成 dump（-T 禁用 TTY）
docker compose exec -T postgres pg_dump -U lifemate -d lifemate -Fc -f /tmp/lifemate.dump

# 2) 从容器拷到宿主机（docker cp 是字节保真的，不走 PowerShell 管道）
docker compose cp postgres:/tmp/lifemate.dump "./backups/lifemate-$date.dump"

# 3) 清理容器内临时文件
docker compose exec -T postgres rm -f /tmp/lifemate.dump

# 4) 确认文件真的写出来了，且不是 0 字节
"已备份: backups/lifemate-$date.dump"
Get-Item "./backups/lifemate-$date.dump" | Select-Object Name, Length
```

✅ 期望：`Length` **明显大于 0**（一个只有扩展、没有业务表的库也有几十 KB）。若 `Length` 为 0 或文件不存在，说明上面某一步失败了，**这份备份等于没有**，不要继续往下做。

`-Fc` 是自定义格式，支持压缩和选择性恢复。

> 💡 **本步骤要真的手动跑通一次**，并把 `Length` 记下来（[§12.6](#126-工程配套) 的检查项之一）。

## 11.2 恢复演练（每季度一次）

> ⚠️ **不要在正式库上演练。** 用独立数据库验证。

```powershell
cd D:\workspace\LifeMate

# 0) 确认 dump 文件在本地，且不是 0 字节
Get-ChildItem backups\*.dump | Select-Object Name, Length

# 1) 建一个演练库
docker compose exec -T postgres psql -U lifemate -d postgres `
  -c "CREATE DATABASE lifemate_restore_test;"

# 2) 把 dump 拷进容器（同样是字节保真，不经 PowerShell 管道）
docker compose cp "./backups/lifemate-<你选的文件>.dump" postgres:/tmp/restore.dump

# 3) 先在容器内列出 dump 内容目录（不写库，最快的完整性自检）
docker compose exec -T postgres pg_restore -l /tmp/restore.dump

# 4) 恢复备份到演练库
docker compose exec -T postgres pg_restore -U lifemate -d lifemate_restore_test `
  --no-owner /tmp/restore.dump

# 5) 验证：看演练库里实际有哪些表（注意：业务表要等 Phase 3 迁移后才有）
docker compose exec -T postgres psql -U lifemate -d lifemate_restore_test `
  -c "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"

# 6) 清理容器内临时文件与演练库
docker compose exec -T postgres rm -f /tmp/restore.dump
docker compose exec -T postgres psql -U lifemate -d postgres `
  -c "DROP DATABASE lifemate_restore_test;"
```

✅ 期望：

```text
• 第 3 步 pg_restore -l 能列出 dump 目录（证明文件完整、格式可读）
• 第 4 步 pg_restore 无 fatal 报错
• 第 5 步返回的表清单与备份时一致
```

> 📌 **暂时不要验证 `SELECT COUNT(*) FROM memories;`——`memories` 表现在还不存在。** 仓库里还没有任何 Migration（见 [§9.3](#93-进入数据库)），此刻库中只有扩展和临时测试表。等 **Phase 3 的 Migration 执行完**之后，这一项才升级为「对 `memories` 做行数比对」：

```sql
-- Phase 3 迁移之后才有意义
SELECT COUNT(*) FROM memories;
```

**记录演练耗时**：__________（这是真实的 RTO 参考值）。

## 11.3 自动备份（Windows 任务计划）

> ⚠️ **本节是可选的，且未经验证。** 它是一份**起点草稿**，不是可以直接挂着无人值守运行的成品。启用前请先确认下列前提，并完成加密改造。
>
> **前提条件：**
>
> ```text
> □ 使用 PowerShell 7 的 pwsh.exe —— 不是系统自带的 powershell.exe（5.1）
> □ 注册任务需要「以管理员身份」运行（-RunLevel Highest 要求已提权）
> □ 需要安装 7-Zip，并把 7z.exe 加进 PATH
> □ 脚本首次运行前先手动跑一次，确认 dump 的 Length > 0
> ```
>
> 🔴 **警告：下面的脚本会写出明文 dump，而本手册与《数据库设计 V1.1》§28 都要求备份必须加密后才能留存。**
> **在把 7z 加密步骤合并进脚本、并确认加密产物可解密之前，不要让它无人值守跑。**

```powershell
# 创建备份脚本 backups\backup.ps1
@'
$ErrorActionPreference = "Stop"
Set-Location "D:\workspace\LifeMate"

# $date 必须在本脚本内定义：任务计划启动的是新进程，
# 不会继承你交互式会话里的变量
$date = Get-Date -Format "yyyyMMdd-HHmmss"

New-Item -ItemType Directory -Force backups | Out-Null

# 与 §11.1 一致：dump 落在容器内，再 cp 出来（不要用 PowerShell 重定向）
docker compose exec -T postgres pg_dump -U lifemate -d lifemate -Fc -f /tmp/lifemate.dump
docker compose cp postgres:/tmp/lifemate.dump "backups/lifemate-$date.dump"
docker compose exec -T postgres rm -f /tmp/lifemate.dump

$out = "backups\lifemate-$date.dump"

# ⚠️ TODO（启用前必须完成）：在这里插入 7z 加密步骤，并删除明文 dump：
#   7z a -p"<密码>" -mhe=on "backups\lifemate-$date.7z" $out
#   Remove-Item $out -Force
# 在此之前，本脚本留存的是明文备份，不允许无人值守运行。

# 删除 30 天前的备份（路径由脚本内的 $date 变量决定，不依赖外部会话）
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

> 📌 这里用 `pwsh.exe`（PowerShell 7）。若机器上只装了 Windows PowerShell 5.1，`New-ScheduledTaskAction` 会因找不到可执行文件而失败；改 `powershell.exe` 之前，先确认脚本里没有用到 7.x 专属语法。

> ⚠️ **备份文件必须加密。** 它包含你全部的记忆内容（明文形式）。Windows 可用 BitLocker 加密整个 `D:\`，或用 7-Zip 加密后再存（下面的 `$date` 沿用本节的同一值；若在新会话里执行，请自行重新定义）：

```powershell
$date = Get-Date -Format "yyyyMMdd-HHmmss"   # 与 §11.1 一致，独立会话里必须重新定义
7z a -p"<密码>" -mhe=on "backups/lifemate-$date.7z" "backups/lifemate-$date.dump"
Remove-Item "backups/lifemate-$date.dump"
```

---

# 12. 完成检查清单

全部通过才算环境就绪：

## 12.1 环境与 GPU

```text
□ docker version 成功
□ docker compose version 显示 v2.x（Compose V2）
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
□ SELECT extname FROM pg_extension 包含 vector、pg_trgm 与 btree_gist
□ SHOW server_version 以 18. 开头
□ SHOW TimeZone 为 Asia/Shanghai
□ 中文能真的 INSERT 并原样回读（§4.4 的第 ② 步，不是只 SELECT 字面量）
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
□ 单次推理延迟 约 10～50 ms（丢弃首次预热后取平均，证明 GPU 生效）  ← 关键
□ nvidia-smi 显示显存占用约 3.2 GB，且占用进程名为 text-embeddings-（不是 python）
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
□ 备份脚本就位，且手动跑通过一次：确认 dump 文件存在且 Length > 0（§11.1）
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
| pgvector 版本 | 0.8.* | | 只核前缀 |
| pg_trgm 版本 | 1.* | | 只核前缀 |
| btree_gist 版本 | 1.* | | 只核前缀，EXCLUDE 约束依赖它 |
| PostgreSQL 版本 | 18.* | | `SHOW server_version` 以 `18.` 开头 |
| 数据库时区 | Asia/Shanghai | | |
| Embedding 模型 | BAAI/bge-m3 | | |
| **向量维度** | **1024** | | 不符则需修订数据库设计 |
| Embedding 延迟 | 约 10～50 ms | | GPU 口径；丢弃首次预热后取平均，明显更慢则 GPU 未生效 |
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
| §2.6 核对 pg_trgm 扩展（初始化脚本已存在，不新建） | Keyword 通道用 pg_trgm 承担 | §17.4 |
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
