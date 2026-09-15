# LifeMate API 接口设计说明书 V1.0

**项目名称：** LifeMate
**文档类型：** API 接口设计说明书
**版本：** V1.0
**文档状态：** 基线版本
**API 风格：** RESTful HTTP API
**协议：** HTTP / HTTPS
**数据格式：** JSON
**后端：** Node.js + TypeScript + Fastify

------

# 1. 文档概述

## 1.1 编写目的

本文档定义 LifeMate V1.0 对外提供的 HTTP API，包括：

- 请求方法
- URL
- 请求参数
- 请求体
- 返回结构
- 错误码
- 分页规则
- 数据校验
- Agent 调用接口
- Memory 管理接口
- Conversation 管理接口
- Timeline 接口
- Life Review 接口

本文档是后续后端开发和前端开发的接口契约。

------

# 2. API 总体设计

所有 API 统一使用：

```text
/api/v1
```

作为前缀。

例如：

```text
POST /api/v1/chat
GET  /api/v1/conversations
GET  /api/v1/memories
```

------

# 3. API 模块

V1.0 API 分为六个模块：

```text
/api/v1
│
├── /chat
│
├── /conversations
│
├── /memories
│
├── /timeline
│
├── /life-review
│
└── /settings
```

------

# 4. 通用响应结构

API 返回 JSON。

成功：

```json
{
  "success": true,
  "data": {}
}
```

失败：

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求参数错误"
  }
}
```

------

# 5. 通用错误码

| HTTP | Code                | 含义         |
| ---- | ------------------- | ------------ |
| 400  | BAD_REQUEST         | 请求格式错误 |
| 401  | UNAUTHORIZED        | 未授权       |
| 403  | FORBIDDEN           | 无权限       |
| 404  | NOT_FOUND           | 资源不存在   |
| 409  | CONFLICT            | 数据冲突     |
| 422  | VALIDATION_ERROR    | 参数校验失败 |
| 429  | RATE_LIMITED        | 请求过于频繁 |
| 500  | INTERNAL_ERROR      | 服务内部错误 |
| 502  | LLM_ERROR           | LLM 服务错误 |
| 503  | SERVICE_UNAVAILABLE | 服务暂不可用 |

------

# 6. ID 规范

所有实体 ID 使用 UUID。

例如：

```text
550e8400-e29b-41d4-a716-446655440000
```

API 中：

```text
GET /api/v1/memories/550e8400-e29b-41d4-a716-446655440000
```

------

# 7. 时间格式

所有时间统一使用 ISO 8601。

例如：

```text
2026-09-10T16:30:00+08:00
```

数据库内部统一使用：

```text
TIMESTAMPTZ
```

API 返回时携带时区信息。

------

# 8. 分页规范

列表接口统一使用：

```text
?page=1&page_size=20
```

例如：

```text
GET /api/v1/memories?page=1&page_size=20
```

返回：

```json
{
  "success": true,
  "data": {
    "items": [],
    "pagination": {
      "page": 1,
      "page_size": 20,
      "total": 100,
      "total_pages": 5
    }
  }
}
```

------

# 9. Chat API

这是整个系统最核心的接口。

------

## 9.1 创建聊天

```http
POST /api/v1/chat
```

用途：

> 向 LifeMate 发送消息，并获得 Agent 响应。

------

## 9.2 Request

```json
{
  "conversation_id": "uuid",
  "message": "我最近想认真学一下 TypeScript"
}
```

其中：

```text
conversation_id
```

可以为空。

为空时：

> 创建新的 Conversation。

------

## 9.3 Response

```json
{
  "success": true,
  "data": {
    "conversation_id": "uuid",
    "user_message": {
      "id": "uuid",
      "content": "我最近想认真学一下 TypeScript",
      "created_at": "2026-09-10T16:30:00+08:00"
    },
    "assistant_message": {
      "id": "uuid",
      "content": "可以，我们可以通过 LifeMate 这个项目来系统学习 TypeScript。",
      "created_at": "2026-09-10T16:30:02+08:00"
    }
  }
}
```

------

# 10. Chat 执行流程

调用：

```text
POST /chat
```

后：

```text
HTTP Request
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
     ├── Recent Messages
     ├── Memory Retrieval
     └── System Context
     │
     ▼
LLM
     │
     ▼
Agent Response
     │
     ▼
保存 Assistant Message
     │
     ▼
返回 API
     │
     └──────────────┐
                    ▼
             Memory Extraction
```

------

# 11. Streaming Chat

V1.0 推荐支持 Streaming。

接口：

```http
POST /api/v1/chat/stream
```

返回：

```text
text/event-stream
```

例如：

```text
data: {"type":"token","content":"可以"}

data: {"type":"token","content":"，我们"}

data: {"type":"token","content":"先"}

data: {"type":"done"}
```

这样前端可以实现类似 ChatGPT 的逐字输出。

------

# 12. Conversations API

## 12.1 获取会话列表

```http
GET /api/v1/conversations
```

参数：

```text
?page=1
&page_size=20
&archived=false
```

返回：

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "uuid",
        "title": "LifeMate 系统设计",
        "summary": "讨论了 LifeMate 的系统架构和数据库设计",
        "created_at": "2026-09-10T10:00:00+08:00",
        "updated_at": "2026-09-10T16:00:00+08:00"
      }
    ],
    "pagination": {}
  }
}
```

------

# 13. 获取单个 Conversation

```http
GET /api/v1/conversations/:id
```

返回：

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "title": "LifeMate 系统设计",
    "summary": "讨论了系统架构",
    "messages": [
      {
        "id": "uuid",
        "role": "user",
        "content": "我们接下来设计数据库吧",
        "sequence": 1,
        "created_at": "..."
      },
      {
        "id": "uuid",
        "role": "assistant",
        "content": "可以。",
        "sequence": 2,
        "created_at": "..."
      }
    ]
  }
}
```

------

# 14. 获取 Conversation Messages

当消息很多时，不直接返回全部消息。

```http
GET /api/v1/conversations/:id/messages
```

参数：

```text
?page=1
&page_size=50
```

返回：

```json
{
  "success": true,
  "data": {
    "items": [],
    "pagination": {}
  }
}
```

------

# 15. 更新 Conversation

```http
PATCH /api/v1/conversations/:id
```

Request：

```json
{
  "title": "LifeMate 项目设计"
}
```

Response：

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "title": "LifeMate 项目设计",
    "updated_at": "..."
  }
}
```

------

# 16. 删除 Conversation

```http
DELETE /api/v1/conversations/:id
```

默认执行软删除。

Response：

```json
{
  "success": true,
  "data": null
}
```

------

# 17. Memories API

Memory 是 LifeMate 的核心 API。

------

# 18. 获取 Memory 列表

```http
GET /api/v1/memories
```

参数：

```text
?page=1
&page_size=20
&type=fact
&status=active
```

返回：

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "uuid",
        "type": "goal",
        "content": "用户正在学习 TypeScript",
        "importance_score": 0.8,
        "confidence_score": 0.95,
        "status": "active",
        "valid_from": "2026-09-10T00:00:00+08:00",
        "valid_until": null,
        "created_at": "...",
        "updated_at": "..."
      }
    ],
    "pagination": {}
  }
}
```

------

# 19. 获取单条 Memory

```http
GET /api/v1/memories/:id
```

返回：

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "type": "goal",
    "content": "用户正在学习 TypeScript",
    "importance_score": 0.8,
    "confidence_score": 0.95,
    "status": "active",
    "sources": [
      {
        "message_id": "uuid",
        "created_at": "..."
      }
    ]
  }
}
```

------

# 20. 搜索 Memory

```http
GET /api/v1/memories/search
```

参数：

```text
?q=TypeScript
&limit=10
```

Response：

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "uuid",
        "content": "用户正在学习 TypeScript",
        "type": "goal",
        "score": 0.91
      }
    ]
  }
}
```

------

# 21. Memory 语义搜索

内部 Agent 使用的 Memory Retrieval 不完全等同于这个 HTTP API。

Agent 内部：

```text
Query
 ↓
Embedding
 ↓
Vector Search
 ↓
Metadata Filter
 ↓
Reranking
```

HTTP API：

```text
GET /memories/search
```

主要用于：

- 前端 Memory 搜索
- 用户主动查询
- Debug
- 管理 Memory

------

# 22. 创建 Memory

```http
POST /api/v1/memories
```

Request：

```json
{
  "type": "preference",
  "content": "用户喜欢直接、具体的技术解释"
}
```

系统自动生成：

```text
importance_score
confidence_score
embedding
created_at
```

Response：

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "type": "preference",
    "content": "用户喜欢直接、具体的技术解释",
    "importance_score": 0.7,
    "confidence_score": 1.0,
    "status": "active"
  }
}
```

------

# 23. 更新 Memory

```http
PATCH /api/v1/memories/:id
```

Request：

```json
{
  "content": "用户喜欢通过实际项目学习技术"
}
```

系统执行：

```text
更新 Content
      ↓
重新生成 Embedding
      ↓
更新 updated_at
```

------

# 24. 删除 Memory

```http
DELETE /api/v1/memories/:id
```

默认：

```text
soft delete
```

返回：

```json
{
  "success": true,
  "data": null
}
```

------

# 25. 恢复 Memory

如果 Memory 被软删除：

```http
POST /api/v1/memories/:id/restore
```

恢复：

```text
status = active
deleted_at = NULL
```

------

# 26. Memory 来源

获取 Memory 来源：

```http
GET /api/v1/memories/:id/sources
```

返回：

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "message_id": "uuid",
        "conversation_id": "uuid",
        "created_at": "..."
      }
    ]
  }
}
```

------

# 27. Timeline API

## 27.1 获取 Timeline

```http
GET /api/v1/timeline
```

参数：

```text
?start=2026-01-01
&end=2026-12-31
&category=work
```

返回：

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "uuid",
        "title": "开始开发 LifeMate",
        "description": "开始正式设计 LifeMate 项目",
        "event_time": "2026-09-10T00:00:00+08:00",
        "category": "project",
        "importance_score": 0.9
      }
    ]
  }
}
```

------

# 28. 创建 Timeline Event

```http
POST /api/v1/timeline
```

Request：

```json
{
  "title": "开始开发 LifeMate",
  "description": "正式开始设计长期记忆 AI Agent",
  "event_time": "2026-09-10T00:00:00+08:00",
  "category": "project"
}
```

------

# 29. 更新 Timeline Event

```http
PATCH /api/v1/timeline/:id
```

------

# 30. 删除 Timeline Event

```http
DELETE /api/v1/timeline/:id
```

默认软删除或归档。

------

# 31. Life Review API

Life Review 用于：

> 对某个时间段进行人生回顾。

------

## 31.1 创建 Life Review

```http
POST /api/v1/life-review
```

Request：

```json
{
  "start": "2026-08-01T00:00:00+08:00",
  "end": "2026-09-10T23:59:59+08:00"
}
```

------

# 32. Life Review 处理流程

```text
Request
   │
   ▼
Timeline
   │
   +
Memories
   │
   +
Goals
   │
   +
Conversation Summaries
   │
   ▼
Context Builder
   │
   ▼
LLM
   │
   ▼
Life Review
```

------

# 33. Life Review Response

```json
{
  "success": true,
  "data": {
    "period": {
      "start": "2026-08-01T00:00:00+08:00",
      "end": "2026-09-10T23:59:59+08:00"
    },
    "review": {
      "summary": "这段时间主要围绕工作、技术学习和个人项目展开。",
      "events": [],
      "goals": [],
      "highlights": []
    }
  }
}
```

------

# 34. Settings API

用于读取系统配置。

```http
GET /api/v1/settings
```

返回：

```json
{
  "success": true,
  "data": {
    "model": {
      "provider": "openai-compatible",
      "model": "xxx"
    },
    "memory": {
      "auto_extract": true
    },
    "timezone": "Asia/Shanghai"
  }
}
```

------

# 35. 更新 Settings

```http
PATCH /api/v1/settings
```

Request：

```json
{
  "memory": {
    "auto_extract": true
  }
}
```

------

# 36. Memory 自动提取配置

系统提供：

```text
auto_extract
```

控制：

```text
Conversation
     ↓
是否自动提取 Memory？
```

默认：

```text
true
```

用户可以关闭。

------

# 37. Agent 内部 Tool API

Agent Tool 不直接等同于 HTTP API。

Agent 内部定义：

```text
search_memory
get_memory
save_memory
update_memory
delete_memory
get_timeline
```

这些 Tool 最终调用 Application Service。

例如：

```text
Agent
 │
 ▼
search_memory()
 │
 ▼
MemoryService.search()
 │
 ▼
Repository
 │
 ▼
PostgreSQL
```

而不是：

```text
Agent
 │
 ▼
HTTP Request
 │
 ▼
自己的 API
```

V1.0 不建议这样做。

------

# 38. Service 与 API 的关系

架构：

```text
HTTP API
   │
   ▼
Controller
   │
   ▼
Application Service
   │
   ▼
Domain
   │
   ▼
Repository
   │
   ▼
Database
```

Agent：

```text
Agent Tool
   │
   ▼
Application Service
   │
   ▼
Domain
   │
   ▼
Repository
   │
   ▼
Database
```

两者共享业务逻辑。

------

# 39. API 参数校验

所有 API 使用 Zod。

例如：

```typescript
const createMemorySchema = z.object({
  type: z.enum([
    "fact",
    "preference",
    "event",
    "goal",
    "relationship",
    "state"
  ]),
  content: z.string().min(1).max(5000)
});
```

Fastify Controller：

```text
Request
 ↓
Zod
 ↓
Validation
 ↓
Service
```

------

# 40. 参数校验原则

任何来自客户端的数据都不能直接进入数据库。

错误：

```text
Request
 ↓
Database
```

正确：

```text
Request
 ↓
Validation
 ↓
Business Logic
 ↓
Database
```

------

# 41. API 鉴权

虽然 V1.0 是单用户系统，但仍然保留基础鉴权层。

结构：

```text
Request
   │
   ▼
Auth Middleware
   │
   ▼
API
```

具体鉴权方案在部署阶段确定。

本地开发环境可以暂时关闭。

生产环境不得关闭。

------

# 42. Request ID

每个请求生成：

```text
request_id
```

例如：

```text
req_01J...
```

用于：

- 日志追踪
- 错误定位
- Agent 调试
- LLM 请求关联

------

# 43. Agent Execution ID

一次 Agent 执行也应该拥有：

```text
agent_run_id
```

例如：

```text
HTTP Request
    │
    └── request_id
            │
            ▼
        agent_run_id
            │
       ┌────┼────┐
       ▼    ▼    ▼
      LLM  Tool  Memory
```

虽然 V1.0 暂时不建立 `agent_runs` 表，但日志层需要保留这个概念。

------

# 44. LLM 错误

当 LLM Provider 失败：

```text
LLM Request
    │
    ▼
Error
    │
    ▼
Retry
    │
    ├── Success → Continue
    │
    └── Fail → Graceful Error
```

API 返回：

```json
{
  "success": false,
  "error": {
    "code": "LLM_ERROR",
    "message": "AI 服务暂时不可用"
  }
}
```

不向用户暴露：

- API Key
- Provider 内部错误
- Stack Trace
- 内部服务器地址

------

# 45. Memory Extraction 错误

Memory Extraction 失败不能导致聊天失败。

例如：

```text
User
 ↓
Agent
 ↓
LLM
 ↓
Response
 ↓
Memory Extraction
 ↓
失败
```

应该：

```text
正常返回聊天结果
+
记录 Memory Extraction Error
```

而不是：

```text
Memory Extraction Failed
 ↓
整个 Chat Failed
```

------

# 46. API 幂等性

对于可能重复提交的操作，需要考虑幂等。

例如 Chat 请求如果网络超时：

```text
Client
 ↓
POST /chat
 ↓
Server 已经处理
 ↓
Client 没收到 Response
 ↓
Client 重试
```

可能产生两条相同消息。

因此后续实现 Chat API 时应增加：

```text
Idempotency-Key
```

例如：

```http
Idempotency-Key: xxx
```

V1.0 实现时纳入。

------

# 47. API 版本控制

当前：

```text
/api/v1
```

未来：

```text
/api/v2
```

例如：

```text
/api/v1/memories
/api/v2/memories
```

避免未来修改接口导致前端全部重构。

------

# 48. OpenAPI

V1.0 推荐最终维护：

```text
OpenAPI 3.x
```

接口文档可以由：

```text
Fastify
+
OpenAPI Schema
```

自动生成。

最终可以访问：

```text
/api/docs
```

查看 API 文档。

------

# 49. API 安全原则

API 必须：

- 校验所有输入
- 限制字符串长度
- 防止非法 UUID
- 防止任意 SQL
- 不返回敏感配置
- 不返回 API Key
- 不返回内部 Stack Trace
- 限制请求频率
- 对 LLM 请求设置超时
- 对文件和 JSON Payload 设置大小限制

------

# 50. V1.0 API 清单

## Chat

```text
POST /api/v1/chat
POST /api/v1/chat/stream
```

## Conversation

```text
GET    /api/v1/conversations
GET    /api/v1/conversations/:id
GET    /api/v1/conversations/:id/messages
PATCH  /api/v1/conversations/:id
DELETE /api/v1/conversations/:id
```

## Memory

```text
GET    /api/v1/memories
GET    /api/v1/memories/:id
GET    /api/v1/memories/search
POST   /api/v1/memories
PATCH  /api/v1/memories/:id
DELETE /api/v1/memories/:id
POST   /api/v1/memories/:id/restore
GET    /api/v1/memories/:id/sources
```

## Timeline

```text
GET    /api/v1/timeline
POST   /api/v1/timeline
PATCH  /api/v1/timeline/:id
DELETE /api/v1/timeline/:id
```

## Life Review

```text
POST /api/v1/life-review
```

## Settings

```text
GET   /api/v1/settings
PATCH /api/v1/settings
```

------

# 51. API 架构最终关系

```text
                    Frontend
                       │
                       ▼
                 HTTP REST API
                       │
             ┌─────────┴─────────┐
             │                   │
             ▼                   ▼
        Controllers         Agent Endpoint
             │                   │
             ▼                   ▼
        Application Services
             │
       ┌─────┼─────────┐
       │     │         │
       ▼     ▼         ▼
   Memory  Conversation Timeline
   Service   Service     Service
       │     │         │
       └─────┼─────────┘
             ▼
        Repository
             │
             ▼
 PostgreSQL + pgvector
```

------

# 52. API 设计基线

LifeMate V1.0 API 正式确定：

```text
Base URL:
 /api/v1

Protocol:
 HTTP / HTTPS

Format:
 JSON

Style:
 RESTful

Validation:
 Zod

Documentation:
 OpenAPI 3.x

Primary Modules:
 Chat
 Conversation
 Memory
 Timeline
 Life Review
 Settings
```

核心原则：

> **API 负责通信，Service 负责业务，Repository 负责数据。**

Agent Tool 不直接操作数据库，而是与 API 共享 Application Service。

------

# 53. 后续实现顺序

API 设计完成后，正式进入工程实现阶段。

推荐顺序：

```text
① 初始化 TypeScript 项目
        ↓
② 配置 pnpm
        ↓
③ 配置 Fastify
        ↓
④ 配置 Drizzle
        ↓
⑤ 配置 PostgreSQL
        ↓
⑥ 编写 Database Schema
        ↓
⑦ Migration
        ↓
⑧ Repository
        ↓
⑨ Application Service
        ↓
⑩ API Controller
        ↓
⑪ Agent Core
        ↓
⑫ Memory Engine
        ↓
⑬ 前端 Chat
        ↓
⑭ Memory UI
```

------

# 54. V1.0 技术闭环

最终系统形成：

```text
                User
                  │
                  ▼
             Next.js UI
                  │
                  ▼
              REST API
                  │
         ┌────────┴────────┐
         │                 │
         ▼                 ▼
 Conversation           Agent Core
 Service                   │
         │          ┌──────┴──────┐
         │          │             │
         │          ▼             ▼
         │       Memory        LLM
         │       Retrieval
         │          │
         └────┬─────┘
              │
              ▼
        Application Service
              │
              ▼
          Repository
              │
              ▼
   PostgreSQL + pgvector
```

**LifeMate API 接口设计 V1.0 至此完成。**