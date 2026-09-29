/**
 * messages.metadata 的白名单与校验（docs/03 §10.5、§16.2、§16.3）
 *
 * 【为什么必须有这个文件】
 *   §16.3 写得很明确：
 *     「① 写入前用 Zod schema 校验 JSONB 结构
 *       ② 白名单模式（只允许已知键），不是黑名单过滤
 *       ③ JSONB 同样受 §21 的日志脱敏约束」
 *
 *   而在此之前，`appendMessage` 直接接收一个 `Record<string, unknown>`，
 *   没有任何校验 —— 任何人都能往 messages.metadata 里塞任意结构，
 *   包括**整段对话正文**。§16.2 明确禁止「任何级别的敏感正文副本
 *   （message content、memory content）」进入 JSONB。
 *
 *   这不是假想的风险：2026-09-29 出了一次幻觉，我要回溯「当时注入了哪
 *   8 条记忆、模型调了什么工具」，结果发现 metadata 里只有
 *   `{model, iterations}` 两个键 —— **什么都查不出来**。
 *   与此同时，如果当初为了调试而随手把上下文整个塞进去，
 *   现在就违反了 §16.2。所以「能查案」与「不越界」必须同时被 schema 约束住。
 *
 * 【设计取向：只存指针，不存正文】
 *   凡是能指向内容的东西一律存标识（memory id、message id、工具名），
 *   正文一律不存 —— 正文本来就在它自己的表里，要看到时 JOIN 过去即可。
 *   这样即使 metadata 被整体导出，也不含新的内容泄露面。
 */
import { z } from 'zod';

/**
 * 工具调用的一条记录。
 *
 * ⚠️ **不含参数值、不含返回值**。理由：
 *   · 参数值往往直接是用户的话（`search_memory({query: "…"})`），
 *     存下来就是 §16.2 禁止的「正文副本」
 *   · 只看参数**键名**已经足够回答「它当时查了什么」
 *     （`keys:["query"]` 就说明它做了一次检索，`keys:[]` 说明没传参）
 *   · 返回内容同理，只留长度
 *
 * 这是刻意的取舍：**牺牲一点排查精度，换取不扩大内容留存面**。
 */
export const toolCallTraceSchema = z.object({
  /** 工具名，如 search_memory / get_timeline */
  name: z.string().max(64),
  /** 第几轮迭代里调用的（从 1 开始） */
  turn: z.number().int().min(1).max(100),
  /** 参数字段的**键名**，不含值。已排序去重 */
  argumentKeys: z.array(z.string().max(64)).max(40),
  /** 结果字符数。用于判断「模型有没有拿到东西」 */
  resultChars: z.number().int().min(0),
  /** 结果是否被截断 */
  truncated: z.boolean(),
  /** 耗时（毫秒） */
  ms: z.number().int().min(0),
  /** 失败原因（工具名与错误类型，不含用户数据） */
  error: z.string().max(200).optional(),
});

export type ToolCallTrace = z.infer<typeof toolCallTraceSchema>;

/** 检索通道命中数与落选情况。全部是计数，不含内容 */
export const retrievalTraceSchema = z.object({
  performed: z.boolean(),
  /** 'not_implemented' | 'disabled' | 'failed' —— 为何没检索 */
  skippedReason: z.string().max(40).optional(),
  channelHits: z
    .object({
      vector: z.number().int().min(0),
      keyword: z.number().int().min(0),
      slot: z.number().int().min(0),
    })
    .optional(),
  fusedCount: z.number().int().min(0).optional(),
  returned: z.number().int().min(0).optional(),
  /** 生效的降级项（枚举名，不含内容） */
  degradations: z.array(z.string().max(64)).max(20).optional(),
  /** 各阶段耗时 */
  timingsMs: z.record(z.string().max(32), z.number()).optional(),
});

export type RetrievalTrace = z.infer<typeof retrievalTraceSchema>;

/**
 * 注入到上下文里的一条记忆 —— **只存 id 与类型，不存正文**。
 *
 * 存 id 的价值：事后能 JOIN 回 memories 看到当时那条记忆的**当前**内容，
 * 以及它是否已被否定/替代（这次幻觉之后加「这条不对」正好用得上）。
 * 不存正文的价值：不制造第二份内容副本。
 */
export const injectedMemoryRefSchema = z.object({
  id: z.string().max(64),
  type: z.string().max(20),
  /** 重排后的最终得分。用于判断「它是不是被一条低分记忆带偏的」 */
  score: z.number().optional(),
});

export type InjectedMemoryRef = z.infer<typeof injectedMemoryRefSchema>;

/**
 * 一次 Agent 执行的完整轨迹。
 *
 * 【它要回答的问题】（按 2026-09-29 那次排查的实际顺序）
 *   ① 当时用的是哪一版提示词？        → promptVersion
 *   ② 注入了哪几条记忆？              → injectedMemories
 *   ③ 检索各通道命中多少、有没有降级？ → retrieval
 *   ④ 模型调了哪些工具、拿回多少东西？ → toolCalls
 *   ⑤ 耗了多久、花了多少 token？      → timingsMs / usage
 *   ⑥ 有没有因为上限被截断？          → truncatedBy
 *   ⑦ 怎么把这一切与某次 HTTP 请求对上？ → requestId
 *
 * 【为什么是嵌套对象而不是平铺】
 *   平铺的键会越来越多（§10.5 原来的白名单已经出现 user_profile、
 *   各种计数字段混在一起）。分组之后每组可以独立演进，
 *   而且「这一组该不该存在」的判断变得清楚。
 */
export const agentTraceSchema = z.object({
  /** HTTP 请求 id，与访问日志、X-Request-Id 响应头一致（docs/04 §42） */
  requestId: z.string().max(64).optional(),
  /** Agent 执行 id（docs/04 §43 的概念，V1.0 只进日志与这里） */
  agentRunId: z.string().max(64).optional(),

  /** 用的哪一版系统提示词。排查「它怎么突然变这样」时第一个要看的 */
  promptVersion: z.string().max(20).optional(),
  provider: z.string().max(40).optional(),
  model: z.string().max(80).optional(),
  finishReason: z.string().max(40).optional(),
  truncatedBy: z.enum(['max_iterations', 'max_tool_calls', 'timeout']).optional(),

  iterations: z.number().int().min(0).max(1000).optional(),
  toolCallsExecuted: z.number().int().min(0).max(1000).optional(),
  usage: z
    .object({
      inputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
      reasoningTokens: z.number().int().min(0),
    })
    .optional(),

  /** 各阶段耗时。key 为阶段名（agentTotal / llm / retrieval），值为毫秒 */
  timingsMs: z.record(z.string().max(32), z.number().min(0)).optional(),

  /** 上下文规模（全是计数） */
  context: z
    .object({
      historyCount: z.number().int().min(0),
      injectedMemoryCount: z.number().int().min(0),
      /** 因条数或预算被裁掉的记忆数 */
      droppedMemoryCount: z.number().int().min(0).optional(),
      approxTokens: z.number().int().min(0),
      /** 注入的时间标记条数 */
      timeMarkerCount: z.number().int().min(0).optional(),
      timezone: z.string().max(64).optional(),
      summaryCount: z.number().int().min(0).optional(),
    })
    .optional(),

  retrieval: retrievalTraceSchema.optional(),
  /** 注入的记忆指针。上限与注入上限一致（Top-8），留些余量 */
  injectedMemories: z.array(injectedMemoryRefSchema).max(32).optional(),
  toolCalls: z.array(toolCallTraceSchema).max(32).optional(),

  /** 助手消息的字符数。用于事后核对「这条回答有多长」而不必读正文 */
  answerChars: z.number().int().min(0).optional(),
});

export type AgentTrace = z.infer<typeof agentTraceSchema>;

/**
 * messages.metadata 的完整白名单。
 *
 * 顶层键只允许这些。`agent` 之外的键保留自 §10.5 的原设计
 * （extractor_version 由抽取流水线在需要时写入）。
 */
export const messageMetadataSchema = z
  .object({
    /**
     * 用户消息上的标记：这条消息触发了哪些后台任务。
     *
     * ⚠️ .strict() 是刻意的：多一个键就报错，而不是被静默丢弃 ——
     *    静默丢弃会让「我明明写了怎么查不到」变成一个新的谜题。
     *    这也正是 §16.3 说的「白名单模式（只允许已知键）」。
     */
    agent: agentTraceSchema.optional(),
    /** 抽取器版本（§10.5 原有键）。由抽取流水线在关联消息上标注 */
    extractorVersion: z.string().max(20).optional(),
  })
  .strict();

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

/**
 * 校验并归一化即将写入的 metadata。
 *
 * @throws ZodError 出现白名单之外的键，或字段类型不符
 */
export function parseMessageMetadata(input: unknown): MessageMetadata {
  return messageMetadataSchema.parse(input ?? {});
}

/**
 * 组装助手消息的 metadata。
 *
 * 【为什么在组装这一步就校验，而不是等落库】
 *   这个函数是「trace 进入数据库」的唯一闸门。
 *   在闸门处校验，越界的数据**当场**报错，调用栈指向写它的那行代码；
 *   若等 appendMessage 才拒绝，错误对象已经穿过几层，定位成本高得多。
 *
 * 【为什么先 safeParse 再回退】
 *   观测**绝不能**把业务搞挂：一次对话已经花了几十秒和真实 token，
 *   不能因为「记轨迹时多了一个字段」而让整轮对话失败。
 *   因此这里的策略是：
 *     · 合法 → 原样写入，完整轨迹
 *     · 不合法 → **不写轨迹**，并返回一条能指明问题的降级标记
 *
 *   ⚠️ 这个取舍是刻意的：宁可少记一次轨迹（可观测性受损），
 *      也不能丢一轮对话（业务受损），更不能把越界数据写进库（隐私受损）。
 *      三种损失里，少记轨迹是最轻的。
 */
export function buildMessageMetadata(
  trace: AgentTrace | undefined
): { metadata: MessageMetadata; problem?: string } {
  if (!trace) return { metadata: {} };

  const parsed = messageMetadataSchema.safeParse({ agent: trace });
  if (parsed.success) return { metadata: parsed.data };

  return {
    metadata: {},
    problem: parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; '),
  };
}

/**
 * 宽松读取：用于**已存在**的历史数据。
 *
 * 为什么要宽松：schema 是渐进演进的，库里必然有旧结构的行
 * （实测有 `{model, iterations}` 这种早期扁平结构）。
 * 读取时不该因为它们而报错 —— 那不是数据损坏，是版本差异。
 *
 * 解析不出来时**返回空对象而不是 null**：调用方（诊断脚本）需要的是
 * 「尽量拿到能拿的」，而不是处理一层 null。
 */
export function safeParseMessageMetadata(input: unknown): {
  data: MessageMetadata;
  /** 解析失败时的原因，供诊断脚本展示 */
  problem?: string;
} {
  const result = messageMetadataSchema.safeParse(input ?? {});
  if (result.success) return { data: result.data };
  return {
    data: {},
    problem: result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; '),
  };
}

/**
 * 把工具调用的参数裁剪成「只有键名」。
 *
 * ⚠️ 这是 §16.2「不得存正文副本」的落地点。
 *    工具参数里最常见的就是 `{ query: "用户的原话" }` ——
 *    值一律丢弃，只留键名。
 *
 * 键名排序去重：让同一工具在不同轮次的记录可以对比，
 * 且避免「键顺序不同看起来像不同调用」。
 */
export function summarizeToolArguments(args: unknown): string[] {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return [];
  return [...new Set(Object.keys(args as Record<string, unknown>))].sort().slice(0, 40);
}
