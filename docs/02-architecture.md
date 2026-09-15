# LifeMate 系统架构设计说明书 V1.0

**项目名称：** LifeMate
**文档类型：** 系统架构设计说明书
**版本：** V1.0
**文档状态：** 基线版本
**适用阶段：** MVP / V1.0
**系统形态：** 单用户个人 AI Agent
**架构风格：** 模块化单体（Modular Monolith）

------

# 1. 文档概述

## 1.1 编写目的

本文档用于定义 LifeMate V1.0 的系统技术架构、模块边界、核心数据流、Agent 执行机制、长期记忆机制、数据存储方案以及部署方式。

本文档作为后续以下工作的技术依据：

- 数据库设计
- API 接口设计
- TypeScript 项目结构设计
- Agent Core 开发
- Memory Engine 开发
- Web 前端开发
- 单元测试与集成测试
- Docker 部署
- 后续版本迭代

------

# 2. 系统设计目标

LifeMate 并不是一个简单的聊天机器人。

其核心目标是：

> **构建一个能够长期理解、记录、检索和维护用户个人信息与人生经历的 AI Agent。**

因此系统设计必须重点解决以下问题：

### 2.1 长期记忆

系统不能只保存聊天记录，而应该从聊天中提取具有长期价值的信息。

例如：

> “我最近开始学 TypeScript。”

系统不应该只把这句话作为历史消息保存。

而应该形成类似：

```text
Memory
├── type: Goal
├── content: 用户正在学习 TypeScript
├── importance: 0.7
├── created_at: 2026-09-10
├── updated_at: 2026-09-10
└── status: active
```

------

### 2.2 记忆检索

用户未来可能不会直接提到“TypeScript”。

例如：

> “最近想做个 Agent 项目。”

Agent 应该能够从长期记忆中发现：

```text
用户正在学习 TypeScript
用户希望通过项目学习 Agent
用户正在开发 LifeMate
```

然后将相关信息提供给 LLM。

------

### 2.3 记忆演化

用户的信息不是永久不变的。

例如：

```text
2026-01
用户正在学习 Python

2026-06
用户开始使用 Node.js

2026-09
用户开始学习 TypeScript
```

系统不能简单地认为：

```text
用户永远只使用 Python
```

而应该允许旧记忆被：

- 更新
- 替代
- 弱化
- 标记为历史状态

------

### 2.4 用户拥有最终控制权

用户能够：

- 查看记忆
- 修改记忆
- 删除记忆
- 查看记忆来源
- 导出个人数据

系统不能把模型的推测永久当作用户事实。

------

# 3. 总体架构

LifeMate V1.0 采用：

> **前后端分离 + 模块化单体 + PostgreSQL + pgvector + LLM API**

总体结构如下：

```text
┌──────────────────────────────────────────────┐
│                  Client                      │
│                                              │
│          Next.js + React + Tailwind          │
└──────────────────────┬───────────────────────┘
                       │ HTTP / REST
                       ▼
┌──────────────────────────────────────────────┐
│                  API Layer                   │
│                                              │
│              Fastify / Node.js               │
│                                              │
│  Auth / Conversation / Memory / Timeline API │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│                 Agent Core                   │
│                                              │
│  Agent Loop                                  │
│  Context Builder                             │
│  Tool Manager                                │
│  Prompt Manager                              │
│  Model Provider                              │
└───────────────┬───────────────────┬──────────┘
                │                   │
                ▼                   ▼
┌───────────────────────┐   ┌──────────────────┐
│    Memory Engine      │   │ Conversation     │
│                       │   │ Service          │
│ Extraction            │   │                  │
│ Classification        │   │ Messages         │
│ Deduplication         │   │ Sessions         │
│ Conflict Detection    │   │ History          │
│ Retrieval             │   │                  │
│ Ranking               │   │                  │
└───────────┬───────────┘   └─────────┬────────┘
            │                         │
            └────────────┬────────────┘
                         ▼
┌──────────────────────────────────────────────┐
│                 Data Layer                   │
│                                              │
│             PostgreSQL + pgvector             │
│                                              │
│ Conversation / Message / Memory / Event      │
│ Goal / Relationship / Timeline / Summary     │
└──────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────┐
│               External Services              │
│                                              │
│              LLM / Embedding API             │
└──────────────────────────────────────────────┘
```

------

# 4. 架构风格

## 4.1 为什么采用模块化单体

V1.0 不采用微服务。

原因：

LifeMate 当前是：

- 单用户
- 单项目
- 初期开发
- 服务数量少
- 数据规模有限
- 主要目的是建立完整工程能力

如果现在拆成：

```text
Agent Service
Memory Service
Conversation Service
Timeline Service
Embedding Service
API Gateway
Message Queue
```

会产生大量与产品价值无关的工程复杂度。

因此采用：

```text
一个 Node.js 应用
        │
        ├── Agent
        ├── Memory
        ├── Conversation
        ├── Timeline
        └── Life Review
```

但在代码层面保持清晰的模块边界。

未来如果某个模块真的需要独立扩展，再进行服务拆分。

------

# 5. 技术栈

## 5.1 后端

| 技术        | 用途           |
| ----------- | -------------- |
| TypeScript  | 主要开发语言   |
| Node.js     | Runtime        |
| Fastify     | HTTP Server    |
| Zod         | 参数与数据校验 |
| Drizzle ORM | 数据库访问     |
| pnpm        | 包管理         |

选择 TypeScript 的核心原因：

LifeMate 本身就是一个 Agent 工程。

后续可能涉及：

- Tool Calling
- MCP
- Agent Loop
- Structured Output
- JSON Schema
- Streaming
- WebSocket
- AI SDK
- Agent Harness

TypeScript/Node.js 对这一生态具有较好的适配性。

------

# 6. 前端架构

前端采用：

```text
Next.js
   │
   ├── React
   ├── Tailwind CSS
   └── TypeScript
```

主要页面：

```text
/
├── Chat
├── Memory
├── Timeline
├── Life Review
└── Settings
```

------

# 7. Agent Core

Agent Core 是 LifeMate 的核心执行系统。

其职责不是“聊天”，而是：

> **决定当前应该如何理解用户输入、获取什么上下文、调用什么工具以及最终如何生成响应。**

------

## 7.1 Agent Core 模块

```text
Agent Core
│
├── Agent Loop
│
├── Context Builder
│
├── Tool Manager
│
├── Prompt Manager
│
├── Model Provider
│
└── Response Processor
```

------

# 8. Agent Loop

Agent Loop 是整个 Agent 的运行核心。

基本流程：

```text
User Message
      │
      ▼
理解用户输入
      │
      ▼
构建 Context
      │
      ▼
调用 LLM
      │
      ▼
LLM 是否需要 Tool？
   ┌──┴──┐
   │     │
  Yes    No
   │     │
   ▼     ▼
执行 Tool 生成回答
   │
   ▼
Tool Result
   │
   ▼
再次调用 LLM
   │
   ▼
最终回答
```

------

## 8.1 V1.0 Agent Loop

伪代码：

```typescript
async function runAgent(input: AgentInput) {
    const context = await contextBuilder.build(input);

    let response = await model.generate(context);

    while (response.toolCalls?.length) {
        const results = await toolManager.execute(
            response.toolCalls
        );

        response = await model.generate({
            ...context,
            toolResults: results
        });
    }

    return response;
}
```

V1.0 不追求复杂 Agent Framework。

优先自己实现核心 Loop。

原因是：

> **这个项目本身就是学习 Agent 架构最好的实践项目。**

------

# 9. Context Builder

Context Builder 负责构建 LLM 最终看到的上下文。

输入：

```text
当前用户消息
+
近期对话
+
长期记忆
+
当前任务信息
+
系统规则
```

输出：

```text
LLM Context
```

整体结构：

```text
System Prompt
       +
User Profile
       +
Recent Conversation
       +
Relevant Memories
       +
Tool Definitions
       +
Current User Message
       │
       ▼
     LLM
```

------

# 10. Memory Engine

Memory Engine 是 LifeMate 最核心的业务模块。

它负责：

```text
发现记忆
   ↓
提取记忆
   ↓
分类
   ↓
评估重要性
   ↓
去重
   ↓
冲突检测
   ↓
保存
   ↓
后续演化
```

------

# 11. Memory 数据模型

V1.0 定义六类核心记忆。

## 11.1 Fact

事实。

例如：

```text
用户正在广州工作。
```

------

## 11.2 Preference

偏好。

例如：

```text
用户喜欢直接、具体的技术解释。
```

------

## 11.3 Event

事件。

例如：

```text
用户完成了第一次正式项目部署。
```

------

## 11.4 Goal

目标。

例如：

```text
用户希望系统学习 TypeScript。
```

------

## 11.5 Relationship

关系。

例如：

```text
某人与用户存在朋友关系。
```

------

## 11.6 State

阶段性状态。

例如：

```text
用户目前处于项目开发初期。
```

State 特别重要，因为它允许系统表达：

> “这是用户现在的状态。”

而不是：

> “这是用户永久不变的属性。”

------

# 12. Memory Extraction

每次对话结束后，系统可以启动 Memory Extraction。

流程：

```text
Conversation
     │
     ▼
Memory Extractor
     │
     ▼
Candidate Memories
     │
     ▼
Classification
     │
     ▼
Importance Scoring
     │
     ▼
Deduplication
     │
     ▼
Conflict Detection
     │
     ▼
Memory Store
```

------

# 13. 记忆提取原则

并不是每一句话都应该成为 Memory。

例如：

> “今天中午吃了个鸡腿。”

默认不需要形成长期记忆。

而：

> “我以后不想再吃这么油腻的东西了。”

可能形成 Preference。

因此 Memory Extraction 应判断：

```text
是否具有长期价值？
是否会影响未来对话？
是否能够帮助理解用户？
是否属于稳定偏好？
是否属于重要事件？
是否属于长期目标？
```

------

# 14. Memory Importance

每条 Memory 保存一个重要性评分：

```text
importance: 0.0 ~ 1.0
```

例如：

```text
“喜欢喝咖啡”
importance = 0.3

“正在学习 TypeScript”
importance = 0.7

“准备完成一个长期项目”
importance = 0.9
```

重要性将影响：

- 是否长期保存
- 检索优先级
- Context 注入优先级

------

# 15. Memory Deduplication

系统必须避免重复记忆。

例如：

```text
Memory A:
用户正在学习 TypeScript。

Memory B:
用户最近开始学 TypeScript。

Memory C:
用户目前在学习 TS。
```

不能简单保存三个 Memory。

系统应该识别它们语义高度相似，并合并。

最终：

```text
用户正在学习 TypeScript。
```

并更新：

```text
updated_at
source_count
confidence
```

------

# 16. Conflict Detection

用户的信息可能发生变化。

例如：

```text
Memory A:
用户计划学习 Python。

Memory B:
用户现在主要使用 TypeScript。
```

这不一定是冲突。

因为：

```text
学习 Python
```

和：

```text
使用 TypeScript
```

可以同时成立。

但：

```text
用户住在广州

vs

用户已经搬到深圳
```

则可能发生事实变化。

系统需要区分：

```text
真正冲突
        vs
状态变化
        vs
可以共存的信息
```

------

# 17. Memory Evolution

Memory 不应该只有：

```text
create
delete
```

还应该支持：

```text
create
update
supersede
archive
delete
```

例如：

```text
Memory #001
用户正在学习 Python
        │
        ▼
Memory #023
用户开始学习 TypeScript
        │
        ▼
Memory #041
用户目前主要使用 TypeScript 开发 Agent
```

旧记忆可以保留为历史，而不是直接删除。

这样才能形成真正的“人生时间线”。

------

# 18. Memory Retrieval

当用户发送新消息时，系统需要判断：

> 哪些历史记忆与当前问题有关？

检索流程：

```text
User Query
    │
    ▼
Query Analysis
    │
    ├── Semantic Query
    ├── Keywords
    ├── Time
    └── Memory Type
    │
    ▼
Candidate Retrieval
    │
    ├── Vector Search
    └── Metadata Search
    │
    ▼
Reranking
    │
    ▼
Relevant Memories
    │
    ▼
Context Builder
```

------

# 19. 向量检索

数据库采用 PostgreSQL + pgvector。

Memory 保存：

```text
content
embedding
```

例如：

```text
用户正在学习 TypeScript
```

生成：

```text
[0.021, -0.314, 0.128, ...]
```

用户说：

> “最近那个 TS 学得怎么样了？”

即使没有出现：

```text
“正在学习 TypeScript”
```

这样的完全相同字符串，也可以通过向量相似度找到相关 Memory。

------

# 20. 混合检索

V1.0 不采用单一 Vector Search。

采用：

```text
Vector Search
       +
Keyword Search
       +
Metadata Filtering
       +
Importance
       +
Recency
```

最终进行综合排序。

概念公式：

```text
Final Score =
    Semantic Similarity
    × weight1
    +
    Importance
    × weight2
    +
    Recency
    × weight3
    +
    Relevance
    × weight4
```

具体权重在实际测试阶段确定。

------

# 21. Memory Tools

Agent 可以使用以下工具。

```text
search_memory()
get_memory()
save_memory()
update_memory()
delete_memory()
get_timeline()
```

------

## 21.1 search_memory

用途：

> 搜索与当前问题相关的长期记忆。

------

## 21.2 get_memory

用途：

> 获取某一条具体 Memory。

------

## 21.3 save_memory

用途：

> 创建新的长期记忆。

------

## 21.4 update_memory

用途：

> 更新已有记忆。

------

## 21.5 delete_memory

用途：

> 删除记忆。

------

## 21.6 get_timeline

用途：

> 查询用户人生事件时间线。

------

# 22. Conversation Service

Conversation Service 负责管理短期上下文。

主要数据：

```text
Conversation
    │
    └── Message
            ├── role
            ├── content
            ├── timestamp
            └── metadata
```

Conversation 负责：

- 创建会话
- 保存消息
- 查询历史
- 分页
- 会话标题
- 会话摘要

------

# 23. 短期记忆与长期记忆

系统必须明确区分：

```text
Conversation History
        ↓
短期上下文
```

与：

```text
Memory
        ↓
长期记忆
```

二者不能混为一谈。

例如：

最近 20 条消息：

```text
短期上下文
```

而：

```text
用户正在学习 TypeScript
```

属于：

```text
长期记忆
```

------

# 24. Conversation Summary

随着对话越来越长，不能无限把历史消息塞进 Context。

因此需要：

```text
Messages
    │
    ▼
Summary
```

例如：

```text
本次对话主要讨论了 LifeMate 的系统架构，
确定采用 TypeScript + Node.js + PostgreSQL，
并决定先实现 Memory Engine。
```

这样可以降低 Token 消耗。

------

# 25. Timeline Service

Timeline 用于表达：

> 用户人生中发生过什么。

它与 Memory 不完全相同。

Memory：

```text
用户喜欢……
用户正在……
用户计划……
```

Timeline：

```text
2026-08
开始工作

2026-09
开始开发 LifeMate

2026-09
开始学习 TypeScript
```

------

# 26. Timeline 数据流

```text
Conversation
      │
      ▼
Event Extraction
      │
      ▼
Timeline Event
      │
      ▼
Timeline Store
```

Timeline 可以从 Memory Engine 中获得事件数据。

------

# 27. Life Review Service

Life Review 用于回答：

> “我过去一段时间发生了什么？”

例如：

```text
最近一个月我都在干什么？
```

系统可以：

```text
查询 Timeline
       +
查询重要 Memory
       +
查询 Goals
       +
查询 Conversation Summary
       │
       ▼
生成 Life Review
```

最终形成：

```text
工作
学习
项目
生活
目标
重要事件
```

等维度的阶段性总结。

------

# 28. 数据流：一次普通聊天

完整流程：

```text
用户发送消息
       │
       ▼
API
       │
       ▼
Conversation Service
       │
       ▼
保存 User Message
       │
       ▼
Agent Core
       │
       ▼
Context Builder
       │
       ├── Recent Conversation
       │
       ├── Memory Retrieval
       │
       └── System Prompt
       │
       ▼
LLM
       │
       ▼
生成 Response
       │
       ▼
保存 Assistant Message
       │
       ▼
返回用户
       │
       ▼
Memory Extraction
       │
       ▼
更新长期记忆
```

------

# 29. 数据流：长期记忆检索

```text
用户：
“我之前是不是说过想学 TS？”

        │
        ▼

Query Analysis

        │
        ▼

Memory Retrieval

        │
        ├── Vector Search
        ├── Keyword Search
        └── Metadata Filter

        │
        ▼

Reranker

        │
        ▼

Relevant Memories

        │
        ▼

Context Builder

        │
        ▼

LLM

        │
        ▼

回答用户
```

------

# 30. 数据流：新记忆写入

```text
Conversation
      │
      ▼
Memory Extractor
      │
      ▼
Candidate
      │
      ▼
Classification
      │
      ▼
Importance
      │
      ▼
Existing Memory Search
      │
      ▼
┌───────────────┐
│ 是否重复？     │
└───────┬───────┘
        │
   ┌────┴─────┐
   │          │
   Yes        No
   │          │
   ▼          ▼
Update     New Memory
   │          │
   └────┬─────┘
        ▼
Conflict Detection
        │
        ▼
Memory Store
```

------

# 31. 数据库架构

数据库：

```text
PostgreSQL
    +
pgvector
```

核心表：

```text
users
conversations
messages

memories
memory_embeddings

events
goals
relationships

timeline_events
conversation_summaries
```

------

# 32. 核心实体关系

概念关系：

```text
User
 │
 ├──────── Conversation
 │                │
 │                └── Message
 │
 ├──────── Memory
 │                │
 │                └── Embedding
 │
 ├──────── Event
 │
 ├──────── Goal
 │
 ├──────── Relationship
 │
 └──────── Timeline Event
```

------

# 33. 数据来源追踪

每条重要 Memory 必须能够追溯来源。

例如：

```text
Memory
“用户正在学习 TypeScript”

source:
Conversation #102
Message #1847
```

这样用户查看 Memory 时可以知道：

> “你为什么认为我有这个记忆？”

这对于系统可信度非常重要。

------

# 34. LLM Provider 抽象层

系统不直接把业务代码绑定到某一家模型。

采用：

```text
Agent Core
     │
     ▼
Model Provider Interface
     │
     ├── OpenAI Compatible
     ├── DeepSeek
     ├── Qwen
     └── Other Provider
```

概念接口：

```typescript
interface LLMProvider {
    generate(input: GenerateInput): Promise<GenerateOutput>;
    stream(input: GenerateInput): AsyncIterable<string>;
}
```

这样未来更换模型时，不需要修改 Agent Core。

------

# 35. Embedding Provider 抽象

Embedding 同样采用 Provider 模式：

```text
EmbeddingProvider
        │
        ├── API Embedding
        └── Local Embedding
```

这样可以支持：

- 云端 API
- 国内模型
- 本地部署模型

------

# 36. API Layer

V1.0 API 大致划分为：

```text
/api/chat
/api/conversations
/api/memories
/api/timeline
/api/life-review
/api/settings
```

例如：

```text
POST /api/chat
GET  /api/conversations
GET  /api/conversations/:id
GET  /api/memories
GET  /api/memories/:id
PATCH /api/memories/:id
DELETE /api/memories/:id
GET  /api/timeline
GET  /api/life-review
```

具体 API 契约将在后续《API 接口设计说明书》中确定。

------

# 37. 安全与隐私架构

LifeMate 保存的数据具有高度私密性。

因此 V1.0 必须遵循：

### 数据最小化

只保存真正需要的信息。

### Provider 可替换

避免绑定单一云端模型。

### 数据可导出

用户能够导出：

```text
Conversations
Memories
Timeline
Settings
```

### 数据可删除

支持删除：

```text
单条 Memory
整个 Conversation
全部个人数据
```

------

# 38. 日志与可观测性

V1.0 至少记录：

```text
Request ID
Conversation ID
Message ID
Agent Execution Time
LLM Latency
Token Usage
Tool Calls
Memory Retrieval Count
Memory Extraction Result
Error
```

但日志不能直接无限制记录敏感对话内容。

------

# 39. 错误处理

系统需要区分：

```text
API Error
Database Error
LLM Error
Embedding Error
Tool Error
Memory Error
```

例如：

```text
LLM API 超时
      ↓
Retry
      ↓
仍然失败
      ↓
返回降级响应
```

不能因为一次模型 API 失败导致整个系统崩溃。

------

# 40. 部署架构

V1.0 使用 Docker Compose。

```text
Docker Compose
│
├── lifemate-app
│       │
│       ├── Next.js
│       └── Fastify
│
└── postgres
        │
        └── pgvector
```

未来可以增加：

```text
Redis
Object Storage
Worker
Monitoring
```

但 V1.0 不提前引入。

------

# 41. 为什么暂时不使用 Redis

当前：

- 单用户
- 请求量低
- 数据量小
- 不需要复杂缓存

Redis 不是刚需。

等出现：

```text
任务队列
缓存
Session
异步 Worker
高并发
```

再引入。

------

# 42. 为什么暂时不使用消息队列

Memory Extraction 可以先采用：

```text
聊天完成
    ↓
异步执行 Memory Extraction
```

V1.0 可以使用 Node.js 的后台任务机制。

未来如果出现大量任务：

```text
Message
   ↓
Queue
   ↓
Worker
   ↓
Memory Engine
```

再引入消息队列。

------

# 43. 项目目录设计原则

V1.0 不采用按照技术类型堆放的方式：

```text
controllers/
models/
services/
utils/
```

而优先按照业务模块组织：

```text
src/
├── agent/
├── conversation/
├── memory/
├── timeline/
├── life-review/
├── llm/
├── database/
└── shared/
```

这样更符合模块化单体架构。

------

# 44. 模块依赖原则

依赖方向：

```text
API
 ↓
Application
 ↓
Domain
 ↓
Infrastructure
```

核心业务逻辑不能反向依赖 HTTP。

例如：

错误：

```text
MemoryService
    ↓
Fastify Request
```

正确：

```text
API Controller
    ↓
MemoryService
    ↓
Repository
```

这样未来即使更换 HTTP 框架，也不会影响核心业务。

------

# 45. V1.0 架构边界

V1.0 明确不实现：

```text
多 Agent
Subagent
MCP Marketplace
Browser Agent
Computer Use
语音助手
移动 App
多人 SaaS
社交系统
微服务
Kubernetes
复杂 Workflow Engine
复杂 RAG Pipeline
自主操作现实世界
```

原因不是这些技术不重要。

而是：

> **当前阶段最重要的是把“长期记忆 Agent”这个核心问题真正做出来。**

------

# 46. 后续扩展方向

V2.0 以后可以考虑：

```text
                    LifeMate
                       │
        ┌──────────────┼──────────────┐
        │              │              │
     Memory          Agent          Tools
        │              │              │
   Knowledge       Subagent          MCP
      Graph           │              │
        │          Workflow      Browser
        │              │              │
        └──────────────┼──────────────┘
                       │
                 Personal OS
```

最终可以演化为：

> **个人 AI Operating System / Personal Agent**

但这不是 V1.0 的目标。

------

# 47. V1.0 核心技术闭环

整个系统最终必须形成以下闭环：

```text
             ┌────────────────────┐
             │      用户生活       │
             └─────────┬──────────┘
                       │
                       ▼
                  对话 / 事件
                       │
                       ▼
                Memory Engine
                       │
                       ▼
                  长期记忆库
                       │
                       ▼
                 Memory Retrieval
                       │
                       ▼
                    Agent
                       │
                       ▼
                   理解用户
                       │
                       ▼
                 更好的回答
                       │
                       ▼
                 新的对话
                       │
                       └───────────┐
                                   │
                                   ▼
                              新记忆形成
```

这就是 LifeMate 最核心的技术闭环：

> **对话 → 记忆 → 检索 → 理解 → 回应 → 新记忆**

------

# 48. 系统核心设计原则总结

LifeMate V1.0 遵循以下原则：

### 原则一：记住的是“人”，不是聊天记录

Conversation 是原始数据。

Memory 才是长期认知。

------

### 原则二：记忆必须可演化

用户会改变。

因此系统必须允许：

```text
新增
更新
替代
归档
删除
```

------

### 原则三：Agent 不应该被 Memory 绑架

即使检索到了某条 Memory，也不能强行提及。

只有真正相关时才使用。

------

### 原则四：模型不是数据库

LLM 负责：

```text
理解
推理
生成
决策
```

数据库负责：

```text
事实
历史
状态
关系
事件
```

二者必须分离。

------

### 原则五：记忆不是模型的猜测

系统必须区分：

```text
User Fact
Model Inference
Temporary State
```

不能把：

> “我觉得你可能……”

直接保存成：

> “用户就是……”

------

### 原则六：工程复杂度服从产品价值

V1.0：

```text
模块化单体
+
PostgreSQL
+
pgvector
+
Node.js
+
TypeScript
```

先把核心能力做扎实。

------

# 49. V1.0 最终架构图

```text
┌────────────────────────────────────────────────────┐
│                     Web Client                     │
│                 Next.js / React                    │
└─────────────────────────┬──────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────┐
│                     API Layer                      │
│                    Fastify                         │
└─────────────────────────┬──────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────┐
│                    Agent Core                      │
│                                                    │
│  Agent Loop                                        │
│  Context Builder                                   │
│  Tool Manager                                      │
│  Prompt Manager                                    │
│  Model Provider                                    │
└─────────────┬───────────────────────┬──────────────┘
              │                       │
              ▼                       ▼
┌─────────────────────────┐ ┌────────────────────────┐
│     Memory Engine       │ │  Conversation Service  │
│                         │ │                        │
│ Extraction              │ │ Messages               │
│ Classification          │ │ Sessions               │
│ Importance              │ │ Summaries              │
│ Deduplication            │ │                        │
│ Conflict Detection      │ │                        │
│ Retrieval               │ │                        │
│ Ranking                 │ │                        │
│ Evolution               │ │                        │
└────────────┬────────────┘ └───────────┬────────────┘
             │                          │
             └─────────────┬────────────┘
                           ▼
┌────────────────────────────────────────────────────┐
│                    Data Layer                      │
│                                                    │
│                PostgreSQL + pgvector               │
│                                                    │
│ User / Conversation / Message / Memory             │
│ Event / Goal / Relationship / Timeline             │
└─────────────────────────┬──────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────┐
│                  Model Providers                   │
│                                                    │
│       LLM API / Embedding API / Local Model        │
└────────────────────────────────────────────────────┘
```

------

# 50. 架构基线结论

LifeMate V1.0 的技术架构正式确定为：

```text
语言：
TypeScript

Runtime：
Node.js

Backend：
Fastify

Frontend：
Next.js + React

Validation：
Zod

ORM：
Drizzle

Database：
PostgreSQL

Vector：
pgvector

LLM：
Provider Abstraction

Embedding：
Provider Abstraction

Architecture：
Modular Monolith

Deployment：
Docker Compose
```

核心业务模块：

```text
Agent Core
Memory Engine
Conversation Service
Timeline Service
Life Review Service
```

核心技术闭环：

```text
Conversation
      ↓
Memory Extraction
      ↓
Memory Store
      ↓
Memory Retrieval
      ↓
Context Builder
      ↓
Agent
      ↓
LLM
      ↓
Response
      ↓
Conversation
```

**V1.0 架构基线至此确定。**
后续开发若无明确需求变更，原则上不随意修改上述核心架构。