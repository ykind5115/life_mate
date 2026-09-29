/**
 * ChatService —— 一次聊天的编排（docs/02 §28、docs/04 §10）
 *
 * 流程（严格按文档顺序）：
 *   ① 校验入参（Zod，在 Controller 做）
 *   ② 解析或创建会话
 *   ③ 保存 user message
 *   ④ 组装上下文（Context Builder）
 *   ⑤ 运行 Agent
 *   ⑥ 保存 assistant message
 *   ⑦ 返回结果
 *   ⑧ **响应之后**触发记忆抽取（异步、不阻塞、失败不影响聊天 —— 接口 §45）
 *
 * 【事务边界】
 *   保存 user message 与保存 assistant message 是**两个独立事务**，不是一个。
 *   理由：中间夹着一次可能耗时数十秒的 LLM 调用。
 *   把它们放进同一个事务会让数据库连接在整个推理期间被占用（§25.2 的同类问题），
 *   而且一旦 LLM 失败，用户刚说的话也会被回滚 —— 那句话已经真实发生过，
 *   不应该因为助手没答上来就消失。
 *
 * 【为什么抽取是 fire-and-forget】
 *   接口 §45 明确规定：Memory Extraction 失败不能导致聊天失败。
 *   因此这里不 await 它的结果，只记录日志（不含正文，§29.1）。
 *   ⚠️ 进程内触发意味着进程重启会丢掉排队中的抽取。
 *      未做持久化队列是 V1.0 的既定取舍（不引入 Redis / MQ，AGENTS.md §2），
 *      但抽取本身是幂等的（extraction_runs 的 idempotency key），
 *      因此「补跑」是安全的：下次该会话有新消息时会一并覆盖。
 */
import type { LLMProvider } from '../llm/provider.js';
import type { ToolDefinition } from '../agent/loop.js';
import { runAgent } from '../agent/loop.js';
import { db } from '../database/client.js';
import {
  appendMessage,
  createConversation,
  findAliveConversationById,
  findConversationById,
  findRecentMessages,
  getOrCreateDefaultUser,
  listActiveSummaries,
  touchConversation,
  type Message,
} from '../database/repository/index.js';
import { findFirstUserMessage } from '../database/repository/conversation-queries.js';
import {
  buildChatContext,
  DEFAULT_RECENT_MESSAGE_LIMIT,
  type ContextMemory,
  type MemoryRetrieval,
} from './context-builder.js';
import type { ExtractionTrigger } from './extraction-trigger.js';
import type { SummaryTrigger } from './summary-trigger.js';
import type { TitleTrigger } from './title-trigger.js';
import { buildPlaceholderTitle } from './conversation-title.js';
import { applyToolEvents, createTraceCollector } from './trace-collector.js';
import { isAutoExtractEnabled } from './settings-service.js';
import { createMemoryTools } from '../memory/tools.js';
import { AGENT_PROMPT_VERSION } from './prompts.js';
import {
  buildMessageMetadata,
  type InjectedMemoryRef,
  type RetrievalTrace,
} from '../database/schema/message-metadata.js';
import type { AgentEvent } from '../agent/loop.js';
import { describeError } from '../shared/error-info.js';

/** 从历史消息中排除的角色：system / tool 不属于「短期对话上下文」 */
const CONTEXT_ROLES = new Set(['user', 'assistant']);

/**
 * 日志器缺省值。直接调用 chat() 的脚本（重放、e2e 检查）不该被迫构造 logger，
 * 而观测代码绝不能因为「没传 logger」而抛错。
 */
const consoleLogger = {
  warn: (obj: Record<string, unknown>, msg: string): void => {
    console.warn(msg, obj);
  },
  error: (obj: Record<string, unknown>, msg: string): void => {
    console.error(msg, obj);
  },
};

export interface ChatParams {
  /** 为 null / undefined 时新建会话 */
  conversationId?: string | null;
  message: string;
  /** 请求级取消信号。客户端断开时应中止 LLM 调用，避免继续烧 token */
  signal?: AbortSignal;
}

export interface ChatResult {
  conversation: {
    id: string;
    /** 本次是否新建了会话 */
    created: boolean;
    title: string | null;
  };
  userMessage: {
    id: string;
    content: string;
    sequence: number;
    createdAt: Date;
  };
  assistantMessage: {
    id: string;
    content: string;
    sequence: number;
    createdAt: Date;
  };
  /** Agent 执行的可观测信息。不含正文 */
  meta: {
    iterations: number;
    toolCallsExecuted: number;
    model: string;
    finishReason: string;
    truncatedBy?: 'max_iterations' | 'max_tool_calls' | 'timeout';
    usage: { inputTokens: number; outputTokens: number; reasoningTokens: number };
    context: {
      historyCount: number;
      injectedMemoryCount: number;
      approxTokens: number;
      /**
       * 注入的「时间标记」条数（docs/12 §方案 1）。
       *
       * 观测价值：0 表示整段历史都在 1 小时内（或历史为空），
       * 大于 0 说明模型看到了「中间断开过」——
       * 排查「它怎么又分不清隔了多久」时，第一个要看的数就是它。
       */
      timeMarkerCount: number;
    };
  };
}

export interface ChatServiceDeps {
  /** 覆盖 LLM Provider（测试注入用） */
  provider?: LLMProvider;
  /**
   * 记忆检索。
   *
   * ⚠️ 检索模块尚未实现，因此缺省不检索（retrieval.performed=false）。
   *    这里保留注入点而不是留 TODO 注释：
   *    没有这个参数，Context Builder 的记忆注入分支就无法被测试覆盖，
   *    等检索实现后接上来也只是换个实现，不用改 ChatService。
   */
  retrieveMemories?: (params: {
    userId: string;
    query: string;
  }) => Promise<ContextMemory[]>;
  /** Agent 可用的工具。V1.0 应为只读工具（Q3） */
  tools?: ToolDefinition[];
  /**
   * 是否注册记忆工具（docs/02 §21）。
   *
   * 缺省 true —— 生产就该有，否则 Agent 只能被动依赖注入的 8 条记忆。
   * 测试常传 false：记忆工具会真调检索（连 embedding 服务），
   * 让「聊天协议」这类用例依赖外部服务。
   */
  enableMemoryTools?: boolean;
  /** 抽取触发器。不传则不触发抽取（测试用） */
  extractionTrigger?: ExtractionTrigger;
  /**
   * 摘要触发器（docs/03 §12.3）。
   *
   * 与抽取分开而不是合成一个触发器：两者的触发条件与成本都不同 ——
   * 抽取按「有没有新消息」触发，摘要按「未摘要消息是否超过阈值」触发，
   * 而阈值很高（默认 30），绝大多数请求不会真的生成摘要。
   * 合成一个会让「这次到底做了什么」变得难查。
   */
  summaryTrigger?: SummaryTrigger;
  /**
   * 标题触发器（docs/12 §方案 2）。
   *
   * 与摘要触发器同样三态：不传 = 不生成（测试与离线场景）、
   * 传实例 = 用注入的（测试用假 LLM）、生产由路由层注入进程单例。
   */
  titleTrigger?: TitleTrigger;
  /**
   * 逐 token 回调，透传给 Agent Loop。
   * 传了它就走流式（provider.stream）。
   */
  onToken?: (token: string, turn: number) => void;
  /** 注入的记忆条数上限，透传 Context Builder */
  injectLimit?: number;
  /** 近期消息条数上限。缺省 20（docs/02 §23） */
  recentMessageLimit?: number;
  /**
   * 组装上下文时的「现在」，透传 Context Builder。
   *
   * 仅测试与实验用：真实路径不传，由 Context Builder 取当前时刻。
   * 生产代码传固定值会让上下文里的「今天」永远停在那一刻。
   */
  now?: Date;
  /**
   * 请求级日志器。
   *
   * 【为什么必须注入，而不是让服务层用 console】
   *   routes/chat.ts 里用的是 `request.log`（带 request_id），
   *   而服务层此前用 `console.error` —— 后者**没有 request_id**。
   *   于是「这一次回答为什么怪」要去日志里捞，却没有任何关联键。
   *
   *   接口类型只要求 warn/error 两个方法：这样测试传一个记录数组即可，
   *   不必引入 pino。Fastify 的 request.log 天然满足这个形状。
   *
   * 缺省回退到 console —— 直接调用 chat() 的脚本（重放、e2e 检查）
   * 不该被迫构造一个 logger。
   */
  logger?: {
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
  /**
   * HTTP 请求 id（docs/04 §42）。落进轨迹，用于把一次回答与访问日志对上。
   */
  requestId?: string;
  /**
   * 取上一次检索的诊断信息。
   *
   * 为什么是「取」而不是「传」：诊断数据产生在 retrieveMemories 内部
   * （routes/chat.ts 的 defaultRetrieve 拿到了它），
   * 而 ChatService 只看到返回的 memories 数组。
   * 让 retrieveMemories 多返回一个诊断对象会改变它的签名、
   * 影响所有调用方；加一个「取上一次结果」的读取器代价最小。
   *
   * ⚠️ 约定：必须在 retrieveMemories 之后调用才有效。
   */
  retrieveDiagnostics?: () => RetrievalTrace | undefined;
}

/**
 * 执行一次聊天。
 *
 * 步骤与 docs/02 §28、docs/04 §10 的流程图一一对应：
 *   ② 解析会话      （① 校验在 Controller，本函数只接受已校验的入参）
 *   ③ 组装上下文    （近期消息 + 记忆 + 系统规则）
 *   ④ 运行 Agent
 *   ⑤ 落库          （会话 + 用户消息 + 助手消息，同一事务；
 *                     对应流程图的「保存 User Message」与「保存 Assistant Message」，
 *                      但都推迟到 LLM 成功之后 —— 见步骤⑤的说明）
 *   ⑥ 触发后台抽取
 *   ⑦ 返回
 *
 * ⚠️ 步骤⑤不在③之前，与流程图字面顺序不同。这是刻意的，
 *    理由写在该步骤的注释里（失败的请求不该留下痕迹）。
 *
 * @throws LLMError                       LLM 调用失败（错误码 LLM_ERROR / SERVICE_UNAVAILABLE）
 * @throws ConversationNotFoundError      会话不存在（错误码 NOT_FOUND）
 * @throws ConversationDeletedError       会话已删除（错误码 CONFLICT）
 */
export async function chat(
  params: ChatParams,
  deps: ChatServiceDeps = {}
): Promise<ChatResult> {
  const provider = deps.provider ?? (await defaultProvider());
  const log = deps.logger ?? consoleLogger;

  // ---------- ② 解析会话 ----------
  const user = await getOrCreateDefaultUser();

  /**
   * ⚠️ 新会话在这里**只是确定「要新建」，并不落库**。
   *
   * 为什么：本次对话可能因为 LLM 失败而根本没有结果。
   * 若先落库，一次失败的请求就会在会话列表里留下一个空会话
   * （实测复现：LLM 失败后列表里多出点进去什么都没有的会话）。
   * 「先建后删」的写法还要处理删除失败，不如根本不建。
   *
   * 会话在步骤⑤（确定要写入内容时）才真正 INSERT。
   */
  const existingConversationId = params.conversationId ?? null;
  const created = existingConversationId === null;

  /**
   * 新会话的**占位标题**（docs/12 §方案 2 的①）。
   *
   * 立刻用首条用户消息截断出来，纯字符串操作、零成本、无 LLM 调用 ——
   * 目的是让会话列表在**任何时刻**都有东西可显示。
   * 正式标题由后台的 TitleTrigger 稍后覆盖（见步骤⑥）。
   *
   * 只在新建时算：往已有会话追加消息不该改它的标题。
   */
  const placeholderTitle = created ? buildPlaceholderTitle(params.message) : null;
  let title: string | null = placeholderTitle;

  if (existingConversationId) {
    /**
     * 必须用 findAliveConversationById 而不是 findConversationById：
     * 往已删除的会话里追加消息会违背用户的删除意图（§24.1）。
     * 区分「不存在」与「已删除」两种错误，前端才能给出有意义的提示。
     */
    const existing = await findAliveConversationById(existingConversationId);
    if (!existing) {
      throw (await findConversationById(existingConversationId))
        ? new ConversationDeletedError(existingConversationId)
        : new ConversationNotFoundError(existingConversationId);
    }
    title = existing.title;
  }

  // ---------- ③ 组装上下文 ----------
  /**
   * 历史消息里**不能包含当前这条消息** —— 它此刻还没落库（见步骤⑤），
   * 因此直接读库拿到的就是「当前消息之前」的历史，天然不会重复。
   *
   * （早先的写法是先存用户消息再读历史，结果当前消息在上下文里出现两次：
   *   一次来自历史、一次来自 Context Builder 的追加。模型会反复追问同一件事。）
   */
  const history = existingConversationId
    ? (await findRecentMessages({
        conversationId: existingConversationId,
        limit: deps.recentMessageLimit ?? DEFAULT_RECENT_MESSAGE_LIMIT,
      }))
        .filter((m: Message) => CONTEXT_ROLES.has(m.role))
        .map((m: Message) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          /*
           * ⚠️ createdAt 必须带上，不能像早先那样只取 role/content。
           *
           * 早先的写法把时间丢在这里，模型看到的历史与刚刚发生的对话
           * 长得一模一样 —— 于是用户隔了两天回来说话，模型仍当成接着聊。
           * 实测（2026-09-26）：一个会话横跨 2 天 11 小时，模型毫无察觉。
           */
          createdAt: m.createdAt,
        }))
    : [];

  /**
   * 更早对话的摘要（docs/03 §12.4）。
   *
   * 只读已生成的摘要，**不在这里生成** —— 生成要调 LLM（慢且花钱），
   * 而用户此刻在等回答。生成放在响应之后（见步骤⑥）。
   */
  const summaries = existingConversationId
    ? (await listActiveSummaries(existingConversationId)).map((s) => s.summary)
    : [];

  /**
   * 记忆检索（docs/03 §18.5：检索与注入分离）。
   *
   * ⚠️ 缺省行为分两种，不要混淆：
   *    · retrieveMemories 未注入 → 「未实现」，performed=false
   *      （测试与离线场景刻意不联网）
   *    · 注入了但检索失败 → 「执行过但降级」，performed=true + skippedReason='failed'
   *    两者的区别对排查很重要：前者是功能没开，后者是服务出问题。
   */
  let retrieval: MemoryRetrieval;
  /**
   * 检索阶段的可观测数据，随消息落库。
   *
   * ⚠️ 此前这些数据**只有日志里有过一行**（routes/chat.ts 打的降级日志），
   *    而且只在有降级时才打。排查 09-29 那次幻觉时我要问
   *    「当时注入了哪几条记忆」，翻遍库和日志都答不上来。
   */
  let retrievalTrace: RetrievalTrace | undefined;
  /** 注入用的记忆指针（id + type + 分数），不含正文 */
  let injectedRefs: InjectedMemoryRef[] = [];
  let retrievalMs: number | undefined;

  if (deps.retrieveMemories) {
    const retrievalStartedAt = Date.now();
    try {
      const memories = await deps.retrieveMemories({ userId: user.id, query: params.message });
      retrievalMs = Date.now() - retrievalStartedAt;
      retrieval = { performed: true, memories };
      injectedRefs = memories.map((m) => ({
        id: m.id,
        type: m.type,
        ...(m.score !== undefined ? { score: m.score } : {}),
      }));
      retrievalTrace = deps.retrieveDiagnostics?.() ?? { performed: true };
    } catch (err) {
      retrievalMs = Date.now() - retrievalStartedAt;
      /**
       * 检索失败降级为「没有记忆」而不是让聊天失败。
       *
       * 判断依据：检索是**增强**，不是完成对话的必要条件；
       * 而用户此刻在等一次回答。失败原因记录下来（不含正文）。
       *
       * 用注入的 logger 而不是 console：见 ChatServiceDeps.logger 的说明。
       */
      log.error(
        { requestId: deps.requestId, reason: describeError(err) },
        '记忆检索失败，降级为无记忆上下文'
      );
      retrieval = { performed: true, skippedReason: 'failed', memories: [] };
      retrievalTrace = { performed: true, skippedReason: 'failed' };
    }
  } else {
    retrieval = { performed: false, skippedReason: 'not_implemented', memories: [] };
    retrievalTrace = { performed: false, skippedReason: 'not_implemented' };
  }

  const context = buildChatContext({
    recentMessages: history,
    userMessage: params.message,
    retrieval,
    summaries,
    // 时间与「现在」都取自同一处：users.timezone 是用户配置的独立列
    timezone: user.timezone,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.injectLimit !== undefined ? { injectLimit: deps.injectLimit } : {}),
  });

  // ---------- ④ 运行 Agent ----------
  /**
   * 记忆工具（docs/02 §21）。
   *
   * ⚠️ 只注册**只读**的 search_memory / get_memory / get_timeline（Q3）。
   *    save / update / delete 刻意不提供 —— 理由见 memory/tools.ts 的文件头。
   *
   * 为什么要给工具，而不是只靠上下文里自动注入的记忆：
   *   注入的是「本次查询最相关的 8 条」，而用户可能问到 8 条之外的东西。
   *   工具让 Agent 能主动再查一次，而不是只能回答「我这边没有」。
   */
  const tools =
    deps.tools ??
    (deps.enableMemoryTools === false
      ? []
      : /**
         * 传时区给工具：它们返回的日期会被模型直接用来回答
         * 「你什么时候面试的」，用 UTC 日期会答错一天（见 tools.ts 的说明）。
         */
        createMemoryTools({ userId: user.id, timezone: user.timezone }));

  /**
   * 包一层采集器，记录模型这次到底调了什么工具。
   *
   * 为什么必须记：2026-09-29 那次幻觉里，出问题的那一轮 `iterations=2`
   * （说明它调了工具），而工具调用的名字、参数、返回**一个都没留下**——
   * 故障恰好发生在唯一没有记录的那一步。这是最糟的排查处境。
   *
   * 采集器只记键名与长度，不记内容（§16.2 禁止正文副本进入 JSONB）。
   */
  const collector = createTraceCollector(tools);
  /** 采集 Loop 的事件，用于回填「截断」与「执行前失败」两类信息 */
  const agentEvents: AgentEvent[] = [];

  const agentStartedAt = Date.now();
  const agentResult = await runAgent({
    provider,
    messages: context.messages,
    tools: collector.tools,
    onEvent: (e) => agentEvents.push(e),
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
    ...(deps.onToken !== undefined ? { onToken: deps.onToken } : {}),
  });
  const agentTotalMs = Date.now() - agentStartedAt;

  const toolCalls = collector.summary();
  applyToolEvents(toolCalls, agentEvents);

  // ---------- ⑤ 落库：会话（首次）→ 用户消息 → 助手消息 ----------
  /**
   * 组装要落库的轨迹（白名单校验在 buildMessageMetadata 里做）。
   *
   * ⚠️ 校验失败**不让对话失败** —— 只放弃这次轨迹，并记一行日志。
   *    理由：一轮对话已经花掉真实 token 与几十秒，
   *    不能因为「记录观测数据时多了个字段」而丢掉用户的对话。
   *    三种损失里，少记一次轨迹是最轻的那种。
   */
  const { metadata: assistantMetadata, problem: metadataProblem } = buildMessageMetadata({
    ...(deps.requestId !== undefined ? { requestId: deps.requestId } : {}),
    promptVersion: AGENT_PROMPT_VERSION,
    provider: provider.providerName,
    model: agentResult.model,
    finishReason: agentResult.finishReason,
    ...(agentResult.truncatedBy !== undefined ? { truncatedBy: agentResult.truncatedBy } : {}),
    iterations: agentResult.iterations,
    toolCallsExecuted: agentResult.toolCallsExecuted,
    usage: agentResult.usage,
    timingsMs: {
      agentTotal: agentTotalMs,
      ...(retrievalMs !== undefined ? { retrieval: retrievalMs } : {}),
    },
    context: {
      historyCount: context.meta.historyCount,
      injectedMemoryCount: context.meta.injectedMemoryCount,
      droppedMemoryCount: context.meta.droppedMemoryCount,
      approxTokens: context.meta.approxTokens,
      timeMarkerCount: context.meta.timeMarkerCount,
      timezone: user.timezone,
      summaryCount: context.meta.summaryCount,
    },
    ...(retrievalTrace !== undefined ? { retrieval: retrievalTrace } : {}),
    /** 只存 id 与类型：正文留在 memories 表里，要看时 JOIN 过去 */
    injectedMemories: context.messages
      .length === 0
      ? []
      : injectedRefs.map((m) => ({
          id: m.id,
          type: m.type,
          ...(m.score !== undefined ? { score: m.score } : {}),
        })),
    toolCalls,
    answerChars: agentResult.content.length,
  });

  if (metadataProblem !== undefined) {
    /**
     * 用注入的 logger 而不是 console：服务层的 console.* 会丢掉 request_id，
     * 那正是排查时最先要的东西（见 ChatServiceDeps.logger 的说明）。
     */
    log.warn(
      { requestId: deps.requestId, problem: metadataProblem },
      '消息轨迹未通过白名单校验，已放弃记录（不影响对话）'
    );
  }

  /**
   * ⚠️ 三条写入放在**同一个事务**里。
   *
   * 理由：它们要么一起生效，要么一起不生效。
   *   · 会话建了却没有消息 → 列表里出现点进去空白的会话
   *   · 用户消息写了但没有助手消息 → 下次重试会看到一条孤立的提问
   * 前两种都不该出现在用户面前。
   *
   * 事务里**不含** LLM 调用（那在步骤⑤，早已完成）——
   * 这正是「先算完再落库」的意义：事务只覆盖纯数据库写入，毫秒级，
   * 不会因为一次几十秒的推理而长期占用连接（§25.2 的同类要求）。
   */
  const saved = await db.transaction(async (tx) => {
    const conversationId =
      existingConversationId ??
      (
        await createConversation(
          {
            userId: user.id,
            /**
             * 占位标题在这里落库（不是等后台生成）——
             * 用户发完就切到列表页也该看得到它。
             * placeholderTitle 非 null 时必然是新建的会话（见上面的赋值）。
             */
            title: placeholderTitle,
          },
          { executor: tx }
        )
      ).id;

    const userMessage = await appendMessage(
      { conversationId, role: 'user', content: params.message },
      { executor: tx }
    );

    const assistantMessage = await appendMessage(
      {
        conversationId,
        role: 'assistant',
        content: agentResult.content,
        /**
         * 只放**可观测指标**，不放正文（§29.1）。
         *
         * 结构见 database/schema/message-metadata.ts —— 那里是白名单的
         * 唯一出处，且由 Zod 强制（§16.3）。这里只负责把数据凑齐。
         *
         * 排查 2026-09-29 那次幻觉需要回答的七件事，逐一对应下面的字段：
         *   ① 当时是哪版提示词？   → promptVersion
         *   ② 注入了哪几条记忆？   → injectedMemories（只存 id，正文 JOIN 回表）
         *   ③ 检索各通道命中多少？ → retrieval
         *   ④ 调了什么工具、拿到多少？ → toolCalls
         *   ⑤ 耗时与 token？        → timingsMs / usage
         *   ⑥ 有没有被截断？        → truncatedBy
         *   ⑦ 与哪次 HTTP 请求对应？ → requestId
         */
        metadata: assistantMetadata,
      },
      { executor: tx }
    );

    // 会话的 updated_at 必须一起推进，否则列表排序看不到这次对话。
    // clock_timestamp 而非 now()：同事务内 now() 是常量（见 conversation-store）
    await touchConversation(conversationId, { executor: tx });

    return { conversationId, userMessage, assistantMessage };
  });

  const { conversationId, userMessage, assistantMessage } = saved;

  // ---------- ⑥ 触发后台抽取（不 await 结果）----------
  /**
   * auto_extract 关掉时**不触发**抽取（docs/04 §36 的开关语义）。
   *
   * ⚠️ 这里是这个开关唯一有实际效果的地方。若只在设置页显示、
   *    不在这里判断，用户会以为关了但它照抽不误 ——
   *    那是彻头彻尾的假开关。
   *
   * 注意语义：关掉只是「不再自动抽」，**已经记住的内容不受影响**，
   * 也不会删除。用户想清理得走记忆管理接口。
   */
  if (isAutoExtractEnabled(user)) {
    deps.extractionTrigger?.schedule(conversationId);
  }

  /**
   * 摘要生成（docs/03 §12.3）。
   *
   * 同样放在响应之后：它要调 LLM（慢且花钱），而用户此刻在等回答。
   * 失败不影响聊天 —— 摘要只是上下文优化，不是完成对话的必要条件。
   *
   * ⚠️ 与抽取一样是 fire-and-forget，进程重启会丢掉待生成的摘要。
   *    代价可接受：没生成就下次消息再触发（幂等由区间唯一索引保证）。
   */
  deps.summaryTrigger?.schedule(conversationId, assistantMessage.sequence);

  /**
   * 会话标题生成（docs/12 §方案 2 的②，解决反馈 4）。
   *
   * ⚠️ **每一轮都 schedule，而不是只在首轮**。
   *    生成器自己判断「当前标题是否还是占位标题」：
   *      · 已是正式标题 → 直接返回，不调 LLM（只多两条走索引的查询）
   *      · 上次失败或材料不足 → 这一次会真的重试
   *    只在首轮触发的话，第一次失败就再也没机会补了 ——
   *    列表里会永远留着「早上好呀，你知道现在是什么时间吗…」这种标题。
   *
   * 用 placeholderTitle 而不是数据库里的 title 作为判据：
   *   新建时两者相同；用户手动改名后 title 变了而 placeholderTitle 不变，
   *   于是生成器会正确地跳过，不会覆盖用户起的名字。
   *
   * ⚠️ 触发器不存在时整个跳过 —— 连那次查询都不做。
   *    否则关掉标题生成的场景（测试、离线跑）每轮白多两条查询。
   */
  if (deps.titleTrigger) {
    const titleIfFresh = await resolvePlaceholderTitle(placeholderTitle, conversationId);
    if (titleIfFresh !== null) {
      deps.titleTrigger.schedule(conversationId, titleIfFresh);
    }
  }

  return {
    conversation: { id: conversationId, created, title },
    userMessage: {
      id: userMessage.id,
      content: userMessage.content,
      sequence: userMessage.sequence,
      createdAt: userMessage.createdAt,
    },
    assistantMessage: {
      id: assistantMessage.id,
      content: assistantMessage.content,
      sequence: assistantMessage.sequence,
      createdAt: assistantMessage.createdAt,
    },
    meta: {
      iterations: agentResult.iterations,
      toolCallsExecuted: agentResult.toolCallsExecuted,
      model: agentResult.model,
      finishReason: agentResult.finishReason,
      ...(agentResult.truncatedBy !== undefined ? { truncatedBy: agentResult.truncatedBy } : {}),
      usage: agentResult.usage,
      context: {
        historyCount: context.meta.historyCount,
        injectedMemoryCount: context.meta.injectedMemoryCount,
        approxTokens: context.meta.approxTokens,
        /**
         * 时间标记条数：能看出这次历史被切成了几段。
         * 0 表示整段历史都在 1 小时内（或历史为空）。
         */
        timeMarkerCount: context.meta.timeMarkerCount,
      },
    },
  };
}

// ============================================================
// 内部
// ============================================================

/**
 * 得到该会话的「占位标题」—— 即「这个会话还没起过正式名字时长什么样」。
 *
 * 标题生成器靠它做判据：当前标题 === 它 → 还需要生成；
 * 否则说明已经有正式标题、或用户手动改过名 → 跳过。
 *
 * ⚠️ 已有会话时**不能拿当前标题反推**（对它再截断一次，比较必然相等 →
 *    生成器会误判「还要生成」→ 每次对话都重新生成并覆盖用户改的名字）。
 *    必须回到「首条用户消息」这个唯一事实来源重新算。
 *    代价是一条走 idx_messages_conversation_sequence 的查询。
 *
 * @param placeholderTitle 新建会话时已经算好的占位标题；已有会话传 null
 * @returns 占位标题；取不到首条用户消息时返回 null（调用方跳过生成）
 */
async function resolvePlaceholderTitle(
  placeholderTitle: string | null,
  conversationId: string
): Promise<string | null> {
  if (placeholderTitle !== null) return placeholderTitle;

  const firstUserMessage = await findFirstUserMessage(conversationId);
  return firstUserMessage ? buildPlaceholderTitle(firstUserMessage.content) : null;
}

// ============================================================
// 业务错误
// ============================================================

/**
 * 用专门的错误类型而不是字符串匹配：
 * Controller 需要据此选 HTTP 状态码，靠 message 文本判断会在文案改动时静默失效。
 *
 * 命名沿用 docs/04 §5 的错误码，Controller 只做一层映射。
 */
export class ConversationNotFoundError extends Error {
  readonly conversationId: string;
  constructor(conversationId: string) {
    super(`会话不存在：${conversationId}`);
    this.name = 'ConversationNotFoundError';
    this.conversationId = conversationId;
  }
}

export class ConversationDeletedError extends Error {
  readonly conversationId: string;
  constructor(conversationId: string) {
    super(`会话已删除，无法继续对话：${conversationId}`);
    this.name = 'ConversationDeletedError';
    this.conversationId = conversationId;
  }
}

// ============================================================
// 内部
// ============================================================

/** 延迟导入以避免在不需要 LLM 的路径上加载 env 校验 */
async function defaultProvider(): Promise<LLMProvider> {
  const mod = await import('../llm/index.js');
  return mod.getLLMProvider();
}
