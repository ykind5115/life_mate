# 可观测性补全（进行中）

**日期：** 2026-09-29
**来源：** `docs/11` 的一次幻觉报告 → `docs/12` §5.7 的遗留项
**状态：** ✅ **本轮已完成** —— 9 项全部做完，验证见 §1

---

## 0. 本轮要达成什么

### 0.1 目标（一句话）

**让「下一次出现幻觉时能查得出原因」这件事从不可能变成可能。**

不是「修好幻觉」—— 那件事本轮不做（结论见 §6）。
本轮只解决「事后能不能回溯」：

```text
本轮之前：一轮回答出问题，能拿到的运行时数据只有
            {"model": "deepseek-flash", "iterations": 2}
          也就是说，只知道它调了工具，不知道调了哪个、传了什么、拿到什么。

本轮之后：同一轮回答能回答出七个问题（§0.2 的验收标准）
```

为什么先做这个而不是直接修幻觉：**16 次重放一次都没复现**（§5），
说明这是低概率事件。在没有可观测性的前提下修它，
既不知道改对了没有，也不知道下次是不是同一个原因 —— 那是猜。

### 0.2 验收标准（可机械核对）

一轮对话结束后，查 `messages.metadata` 应能回答：

```text
① 用的哪一版系统提示词？
② 注入了哪几条记忆（id + 类型 + 分数）？
③ 检索三条通道各命中多少、有没有降级、各阶段耗时？
④ 模型调了哪几个工具、参数里有哪些字段、拿回多少字符、耗时多少？
⑤ Agent 总耗时、检索耗时、token 用量？
⑥ 有没有因为上限被截断？
⑦ 这次回答对应哪个 HTTP 请求（request_id）？
```

**并且**（同样重要，是约束不是目标）：

```text
⑧ metadata 里【不含任何正文】——
   拿该轮用户消息的 content 去 metadata 里 LIKE，必须查不到
⑨ 日志里【不含任何参数值】——
   pnpm probe:log-leak 全绿
```

### 0.3 本轮不做（明确排除）

```text
❌ 回答之后的过滤/校验模块        —— §8 已论证不做
❌ 建 agent_runs 表               —— docs/04 §43 明确 V1.0 不建
❌ 结构化日志落文件/落库          —— 当前 stdout 够用，先不加基础设施
❌ 单次 LLM 调用的独立耗时        —— 价值低于成本，等真有需要再说
```

---

## 1. 进度表

```text
① 白名单 + Zod 校验                        ✅ 完成
   src/database/schema/message-metadata.ts
   此前 appendMessage 直接收 Record<string, unknown>，谁都能塞正文进 JSONB

② 工具调用采集                            ✅ 完成
   src/conversation/trace-collector.ts
   只记参数【键名】与结果长度，不记值

③ 轨迹接线（检索计时/诊断/注入/落库）        ✅ 完成
   chat-service.ts、conversation-store.ts、routes/chat.ts、context-builder.ts

④ 错误日志脱敏（顺带修掉一个真泄露）         ✅ 完成
   src/shared/error-info.ts
   实测 log.error({ err }) 会把 SQL 参数值打进日志 —— 通用错误处理器，
   任何一次 5xx 都可能泄露用户正文。已修 + 有探针守着

⑤ 排查工具                                ✅ 完成
   audit/replay-hallucination.ts、audit/probe-log-leak.ts

────────────────────────────────────────────────────────

⑥ 真实跑一轮，验证轨迹真的落库                  ✅ 完成
   两条路都验过：
     · 测试库（可重复、零残留、不花钱）：新增 src/api/trace-routes.test.ts
       3 个用例 —— 轨迹落库 / 不含正文 / 白名单外的键被拒
     · 开发库真实调用：发一条【可观测性自检】消息，psql 查回来核对七项全齐，
       然后用 DELETE /conversations/:id 清掉（含之前探针留下的 7 条垃圾会话）
   实测轨迹（deepseek-flash，真实一轮）：
     retrieval: 向量 38 命中 → 融合 38 → 注入 8，embedding 79ms / 总 115ms
     injectedMemories: 8 条 id + type + score（0.435 ~ 0.499）
     timingsMs: agentTotal 1136 / retrieval 116
     promptVersion v2, usage input 1388 / output 101 / reasoning 60
   并把被注入的记忆 id 与记忆正文对照过：8 条全部与「工作/招聘」话题相关

⑦ 5 处后台任务补 logger                       ✅ 完成
   新增 src/shared/app-logger.ts：启动时绑定一次，后台任务共用。
   这些任务是 fire-and-forget，不在请求上下文里，拿不到 request.log ——
   此前它们的日志**没有任何关联键**。
   已改为字段化结构化日志（可按键筛选，而不是人眼扫中文句子）

⑧ 提示词补一条约束                            ✅ 完成
   「提到以前的事时用问句，不要当陈述句说」+「对方这次没提过的事，
     不要当成已经说好的前提」，并直接写进那次幻觉的具体形状。
   加了 2 条测试守着（prompts.test.ts 现在 19 条）

⑨ 同步设计文档                                ✅ 完成
   docs/03 §10.5 白名单按新结构重写，并指向实现位置；
   §29.1 补上日志脱敏的实现位置与那次实测事故的记录
```

**当前验证状态（已跑过、可复现）：**

```text
pnpm typecheck      → 0 错误
pnpm test           → 413 通过 / 0 失败（新增 3 条轨迹用例 + 2 条提示词用例）
pnpm probe:log-leak → 6 项检查全绿
```

**本轮完成后仍未覆盖的**（转成下一轮候选，不留在本文件当尾巴）：

```text
· 用一段时间收集幻觉的真实频率 —— 这是决定「要不要做过滤模块」的唯一依据
· agentRunId 没进轨迹（runAgent 内部生成，没往上传）
· 单次 LLM 调用耗时没单独记录（只有 agentTotal 与 retrieval）
```

---

## 2. 为什么要做这个

2026-09-29 09:23 用户报告一次幻觉：助手回答里出现了「吃饭聊」「这个人你本来就认识」，
而用户既没说过、库里 47 条记忆也没有一条提到吃饭或熟人。

排查过程中发现，**真正的问题不是那次幻觉本身，而是它查不了案**：

```text
我唯一能拿到的运行时数据是 messages.metadata，而它只有两个键：
  {"model": "deepseek-flash", "iterations": 2}
```

`iterations=2` 说明那一轮**调了工具** —— 而工具调用的名字、参数、返回
一个都没留下。也就是说：**故障恰好发生在唯一没有记录的那一步上。**

于是我写重放脚本跑了 16 次（见 §1 的 ⑥ 与 §7 的工具），一次都没复现，
只能得出「这是一次低概率采样事故」的结论 —— 而**无法回答**
「它当时查了什么、拿到什么、是哪一版提示词」。

结论：在讨论任何「加过滤模块」之前，先把可观测性补上。
没有它，任何修复都是在猜，也无法验证修好了没有。

---

## 3. 设计约束（不是可选的）

这几条来自设计文档，实现时必须遵守：

| 出处 | 约束 |
| --- | --- |
| `docs/03` §16.2 | JSONB 里**禁止**存「任何级别的敏感正文副本」（message content、memory content） |
| `docs/03` §16.3 | 写入 JSONB 前必须用 **Zod 校验** + **白名单**（不是黑名单过滤） |
| `docs/03` §29.1 | 日志永不记录 `message.content` / `memory.content` / `relationship.name`；用结构化日志 + 白名单 |
| `docs/03` §10.5 | `messages.metadata` 白名单已给出（model / provider / token_usage / latency_ms / finish_reason / tool_calls / loop_truncated / extractor_version） |
| `docs/04` §42/§43 | `request_id` 与 `agent_run_id` 的概念；V1.0 不建 `agent_runs` 表，只进日志与轨迹 |

**这些约束此前没有一条被真正执行**：`appendMessage` 直接接收
`Record<string, unknown>`，没有任何校验，谁都能往里塞正文。

---

## 4. 设计取向：只存指针，不存正文

这是整个方案的立足点。

```text
凡是能【指向】内容的东西，一律存标识：
  memory id、message id、工具名、参数字段的【键名】
凡是【就是】内容的东西，一律不存：
  消息正文、记忆正文、工具参数的值、工具返回值

要看正文时 JOIN 回它自己的表 —— 正文本来就在那儿，
存第二份只会扩大泄露面，不会增加信息量。
```

具体到最容易踩的地方 —— 工具参数：

```text
模型最常调的是 search_memory({ query: "用户的原话" })
                                        ↑ 值就是用户正文

我们只记：argumentKeys: ["query"]
          结果字符数、是否截断、耗时

牺牲的：事后不知道它查的具体词
换来的：JSONB 里不出现用户原话
```

这个取舍是刻意的，而且**代价可接受**：知道「它做了一次检索、拿回 3000 字符」
已经足以定位「是不是误用了工具结果」，而具体查询词属于可选项。

---

## 5. 已实现（已通过 typecheck + 408 测试 + 泄漏探针）

### 5.1 白名单与校验（新增）

```text
src/database/schema/message-metadata.ts
  · agentTraceSchema          一次 Agent 执行的完整轨迹（Zod）
  · messageMetadataSchema     顶层白名单，.strict() —— 多一个键就报错
  · parseMessageMetadata()    严格解析，用于写入路径
  · safeParseMessageMetadata()宽松解析，用于读历史行（旧结构不该报错）
  · buildMessageMetadata()    组装 + 校验，失败时【放弃轨迹但不让对话失败】
  · summarizeToolArguments()  把参数裁剪成「只有键名」
```

轨迹里能回答的问题（按排查时的实际顺序）：

```text
① 当时是哪版提示词？        → promptVersion
② 注入了哪几条记忆？        → injectedMemories [{id, type, score}]
③ 检索各通道命中多少？       → retrieval { channelHits, fusedCount, degraded… }
④ 调了什么工具、拿到多少？   → toolCalls [{name, argumentKeys, resultChars, ms, error}]
⑤ 耗时与 token？            → timingsMs / usage
⑥ 有没有被截断？            → truncatedBy
⑦ 与哪次 HTTP 请求对应？     → requestId
```

**降级策略**（刻意的取舍）：轨迹校验失败时**不写轨迹**，只记一行 warn。
一轮对话已经花掉真实 token 与几十秒，不能因为「记录观测数据时多了个字段」
而丢掉用户的对话。三种损失里，少记一次轨迹是最轻的。

### 5.2 工具调用采集（新增）

```text
src/conversation/trace-collector.ts
  · createTraceCollector(tools)   包一层 tool.execute，采集调用过程
  · applyToolEvents(records, evs) 从 Agent Loop 的 onEvent 回填截断/失败
```

两个设计点：

```text
① 为什么在工具边界采集，而不是改 Agent Loop
   Loop 已经发 tool_call / tool_result 事件，但那两个事件里【没有参数】。
   要拿参数只有包 tool.execute 一个位置。
   好处：不动 Loop 一行代码 —— 它的事件契约还兼作 SSE 的 progress 来源，
   为观测去改它、进而影响流式输出，代价不对等。

② 为什么要回填两次
   · truncated 只有 Loop 知道（截断发生在它拿到结果【之后】）
   · tool_error（超时、参数不是合法 JSON）发生在 tool.execute 【之前】，
     包装器看不到这一种
   对齐方式：每个调用恰好产生一个事件，按「同名事件的第 n 次出现」对齐。
```

### 5.3 接线（改动）

```text
chat-service.ts      检索计时、诊断捕获、轨迹组装、注入 logger
conversation-store   appendMessage 在【写库处】校验 metadata（§16.3）
routes/chat.ts       传 request.log 与 request.id；捕获检索诊断
context-builder      ContextMemory 增加 score（只用于观测，不参与组装）
```

### 5.4 顺带修掉一个**真的在泄露**的问题

审日志模块时用真实 logger 打了一次数据库错误，产出：

```json
{"err":{"message":"Failed query: insert into \"messages\" … 
                  params: 用户的私密对话内容-应绝不出现在日志里,user,x,1",
        "stack":"…params: 用户的私密对话内容…",
        "params":["用户的私密对话内容-应绝不出现在日志里","user","x",1]}}
```

**三处同时泄露**：错误消息里、stack 里、以及 `params` 数组本身。

而泄露点 `server.ts` 的 `setErrorHandler` 是**通用**错误处理器 ——
任何一次 5xx（写消息失败、写记忆失败…）都可能把用户正文写进日志文件。
`messages.content` 就是用户原话，所以这不是理论风险。

修法（新增 `src/shared/error-info.ts`）：

```text
toLogError(err)   只输出 5 个安全字段：
                    errType / message / code / constraint / stack
                  并把命中在文本里的参数值替换成 [已脱敏]

保留：错误类名、postgres 错误码、约束名、堆栈、SQL 语句文本
      （语句里只有表名列名与 $1 占位符，没有值 —— 排查最有用）
丢弃：params / parameters / values / detail / where（就是值）
```

同时把散落在 **5 个文件**里的 `describeError` 副本统一成共享实现。
那 5 份副本的注释都写着「只取错误描述，不打印整个 error 对象」——
**意图是对的，但实现只取 `err.message`**，而 Drizzle 恰恰把参数值拼进了 message，
所以它们并没有真正挡住正文。统一成一份就不会有人漏改。

两个实测踩到的细节（都已写进注释）：

```text
· 错误的类名要用 constructor.name，不能用 err.name
    → Drizzle 的 DrizzleQueryError 把 name 设成了 'Error'
· 日志键名不能用 type 或 name
    → pino 的 err 序列化器总是把自己算出的构造函数名写进 type，
      覆盖掉我们传的值（实测渲染成 "Object"）
    → 改用 errType
```

---

## 6. 过程中的发现与教训（留档）

### 6.1 🔴 顺带发现：日志**正在**泄露用户正文

见 §5.4。这里只记「怎么发现的」，因为方法比结论更有复用价值：

```text
做法：不靠读代码猜，而是**用真实 logger 打一次真实的数据库错误**，
      把 stdout 抓下来看里面有什么。
      造错误的方式：往 uuid 列塞一个非 uuid 的字符串 ——
      这样错误对象上必然带 parameters，而 parameters 里就是被写入的值。

结果：三处同时泄露（错误消息里、stack 里、params 数组本身）。
```

教训：**「我以为已经防住了」和「实际防住了」是两件事。**
代码里 5 处 `describeError` 的注释都写着「不打印整个 error 对象」——
意图明确，但实现只取 `err.message`，而 Drizzle 恰恰把参数值拼进了 message。
所以那 5 份副本都没有真正挡住正文。

### 6.2 测试断言的假失败与假成功

两处都踩到了，值得记下来：

```text
假失败：probe-log-leak 里断言 SQL 文本存在，写成 /insert into "messages"/，
        但日志是 JSON，引号被转义成 \" —— 文本明明在，断言错了。
        教训：断言日志内容时要考虑序列化后的形态。

假成功（更危险）：写 DOM 回归测试时，「不抛错」的断言在故意写坏顺序后
        依然全绿 —— 因为我加了防御性 return，错误变成了静默失败。
        教训：断言要落在**期望的结果**上，不能落在「没有异常」上。
        验证方法是**故意把 bug 放回去，看测试是否变红**。
```

### 6.3 工具层面的坑

```text
· Windows PowerShell 5.1 的 `>` 重定向与 Set-Content 会破坏 UTF-8：
    · git diff 的补丁经 `>` 落盘后 git apply 报 "No valid patches in input"
    · Set-Content 往 .md 写会加 BOM
  两次都改用 Node 处理字节流解决。AGENTS.md §4.2.1 早有记录，仍然踩了。

· `git rebase -i` 的 todo 清单**必须覆盖范围内的每一个提交**：
  只列要改的那几个，其余会被**直接丢掉**（本次丢了 4 个提交，
  其中一个含 6 个新文件）。从 reflog 全部找回，但过程本可避免。
```

### 6.4 仍未覆盖的（转下一轮候选）

```text
· 用一段时间收集幻觉的真实频率 —— 这是决定「要不要做过滤模块」的唯一依据
· agentRunId 没进轨迹：runAgent 内部生成，没往上传。
  当前靠 requestId 关联已够用；要看单次 Agent 执行内部的调用链时再补
· 单次 LLM 调用耗时没有单独记录（timingsMs 里只有 agentTotal 与 retrieval）
```

---

## 7. 本轮新增的文件（含一次性排查工具）

```text
生产代码（4 个新文件）
  src/database/schema/message-metadata.ts   白名单 + Zod 校验 + 轨迹结构
  src/conversation/trace-collector.ts       工具调用采集
  src/shared/error-info.ts                  安全错误提取（脱敏）
  （trace 的接线分布在 11 个已有文件里）

排查工具（audit/，不是生产代码）
  audit/replay-hallucination.ts   重放某一轮对话，可跑 N 次统计复现率
  audit/probe-log-leak.ts         验证错误路径不泄露参数值（pnpm probe:log-leak）

  ⚠️ probe-log-leak 值得保留并定期跑：它是「有人为了调试改回 { err }」
     这类回归的唯一防线。
```

新脚本：

```text
pnpm probe:log-leak          验证日志脱敏（会制造一次失败的写入，不写数据）
pnpm replay:hallucination N  重放 09-29 那一轮 ×N（会真调 LLM，只读库）
```

---

## 8. 关于「回答之后加过滤模块」的结论

**决定：不做。**（用户 2026-09-29 同意）

理由记录在案，避免以后重复讨论：

```text
① 要解决的是一个测不出频率的问题
   16 次重放里一次都没复现，说明这是低概率采样事故。
   为它加一次 LLM 调用到每一轮回答的路径上，账算不过来。

② 校验通常不比生成容易
   「这句话有没有依据」本身就是需要推理的判断，判官模型同样会错。

③ 修的位置在提示词，不在输出后
   现在的提示词告诉模型「不确定时怎么说话」，但**没有**告诉它
   「不要把用户没给的前提当成既定事实」。
   而那次幻觉正是：回答了一个用户根本没问的问题。
   补一条「凡是涉及【以前】的事、只要不是对方刚说的，就用问句而不是陈述句」，
   那句「这个人你本来就认识」就会变成「这个人你是本来就认识吗？」——
   错误还在，但它立刻变成可纠正的，而不是误导用户的。
   成本是一条提示词，零延迟、零新调用、可测试。

④ 过滤救不了这个错误
   「吃饭/熟人」是对外部世界的具体断言。判官凭什么断定这是编的？
   「用户没说过」并非不在场证明 —— 模型完全可能从别处合理推断。
```

**下一步的顺序**（本轮已把前三项做完，见 §1 的 ⑥⑦⑧）：

```text
✅ ① 可观测性补上（轨迹 + 日志脱敏）—— 本轮
✅ ② 提示词补上「用问句」那条约束 —— 本轮 §1 的 ⑧
⬜ ③ 用一段时间收集幻觉的真实频率 —— **现在只差这一步**
     这是决定「要不要做过滤模块」的唯一依据。
     有了 §1 的轨迹之后，判断「这次是不是同一个原因」也变便宜了：
     直接查 messages.metadata 里当轮的 injectedMemories 与 toolCalls。
```
