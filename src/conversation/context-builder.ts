/**
 * Context Builder（架构 §9、docs/03 §18.5）
 *
 * 职责：把「模型该看到什么」组装成一个确定的对象。
 *   System Prompt + User Profile + Recent Conversation + Relevant Memories
 *   + Tool Definitions + Current User Message
 *
 * 【为什么单独成模块，而不是写在 ChatService 里】
 *   ① docs/03 §18.5 明确要求「检索与注入分离」：
 *        MemoryRetrievalService.search() → Memory[]
 *        ContextBuilder.inject(memories, budget) → 上下文片段
 *      前者可离线评测，后者只管呈现。混在一起会让检索无法单独评测。
 *   ② 上下文组装是纯函数式的（给定输入必然得到同一输出），
 *      因此可以单测；一旦掺进数据库与网络调用就不再可测。
 *
 * 【本模块不做的事】
 *   · 不查数据库（近期消息由调用方传入）
 *   · 不做检索（记忆由调用方传入，见 buildChatContext 的 retrieval 参数）
 *   · 不调用 LLM
 */
import type { LLMMessage } from '../llm/types.js';
import { buildKnownFactsSection, CHAT_SYSTEM_PROMPT, type KnownFactInput } from './prompts.js';

/** docs/02 §23 明确「最近 20 条消息」属于短期上下文 */
export const DEFAULT_RECENT_MESSAGE_LIMIT = 20;

/**
 * 时区缺省值。
 *
 * ⚠️ **不是 UTC**。服务器与容器的 TZ 通常是 UTC，而本项目的用户在中国 ——
 *    用 UTC 会把凌晨 0-8 点的对话算到「昨天」，模型说「今天」就错了。
 *    调用方应当传 users.timezone；这个常量只在配置缺失时兜底。
 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/**
 * 历史消息之间插入时间标记的最小间隔（分钟）。
 *
 * 【为什么需要标记间隔】
 *   模型此前完全看不到时间 —— 上下文里只有 role 与 content。
 *   实测（2026-09-26）：用户的会话跨 2 天 11 小时，
 *   模型不知道中间过了多久，于是出现「我隔了两天再讲话，它分不清」。
 *
 * 【为什么用间隔阈值而不是给每条消息打时间戳】
 *   实测数据：21 个发言间隔里 20 个在 1 小时以内（同一段连续对话）。
 *   每条都标时间会明显变吵，且大量「相隔 30 秒」的标记没有信息量。
 *   真正需要时间感的是「隔了半天」「隔了几天」。
 *
 * 阈值 60 分钟的依据：同一份数据里超过 1 小时的有 3 处（1-6 小时 2 处、
 * 超 1 天 1 处）—— 正好是那些「不是同一段连续对话」的边界。
 * 定 6 小时会漏掉两段「隔了半天」的；定 5 分钟会把连续对话切得太碎。
 */
export const TIME_GAP_MARKER_MINUTES = 60;

/**
 * 检索结果注入上文的默认条数（docs/03 §18.5：默认注入 Top-8）。
 *
 * ⚠️ 与「候选条数」不是一回事：§18.2 的流程先各通道取 Top-50，
 *    RRF 融合取 Top-30 重排，最后只注入 Top-8。
 *    条数放大 6 倍是刻意的 —— 重排需要足够多的候选才有意义。
 */
export const DEFAULT_INJECT_LIMIT = 8;

/** 注入的 token 预算（docs/03 §18.5：预算 ≤ 2000 tokens） */
export const DEFAULT_INJECTION_TOKEN_BUDGET = 2000;

export interface ContextMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * 这条消息发生的时间。
   *
   * 【为什么要带上它】
   *   模型此前完全看不到时间。实测（2026-09-26）用户的会话横跨 2 天 11 小时，
   *   模型无法区分「刚说完」与「隔了两天又来说」——
   *   打印出来的历史与实时对话长得一模一样。
   *
   * 【为什么可选】
   *   本模块是纯函数式的自测对象，测试会直接塞 `{ role, content }`。
   *   把时间设成必填会逼所有测试跟着造时间戳，而时间缺失本身
   *   是**合法状态**（旧数据、外部调用方）——
   *   缺了就不标时间，而不是抛错或假装是现在。
   */
  createdAt?: Date;
}

/** 待注入上下文的一条记忆 */
export interface ContextMemory extends KnownFactInput {
  id: string;
  importanceScore?: number;
  /**
   * 重排后的最终得分。
   *
   * 只用于**观测**（落进 messages.metadata 的轨迹），不参与组装 ——
   * 选谁注入在检索阶段就定了，Context Builder 只按传入顺序裁剪。
   * 留着它的价值：事后能看出「这条回答是不是被一条低分记忆带偏的」。
   */
  score?: number;
}

/**
 * 记忆检索的结果。
 *
 * ⚠️ 检索尚未实现（见文件末尾「实现状态」），
 *    因此这个类型先用于让上下文组装与检索解耦，
 *    接口形状按 docs/03 §18.5 的签名设计。
 */
export interface MemoryRetrieval {
  /** 检索阶段是否真的执行了 */
  performed: boolean;
  /** 未执行的原因，用于可观测性（不记录内容） */
  skippedReason?: 'not_implemented' | 'disabled' | 'failed';
  /** 检索命中的记忆 */
  memories: ContextMemory[];
}

export interface BuildChatContextParams {
  /** 会话历史（应已按时间正序，且是**最近**的 N 条） */
  recentMessages: ContextMessage[];
  /** 当前用户消息。**不需要**调用方预先塞进 recentMessages */
  userMessage: string;
  /**
   * 更早对话的摘要（docs/03 §12.4）。
   *
   * ⚠️ 位置固定：必须插在**最近消息之前**。
   *    §12.4 明确写了「摘要必须位于最近消息之前，否则模型会误判时间顺序」——
   *    摘要说的是较早的事，放在最近消息后面会被当成刚发生的。
   *
   * 空数组表示这段会话还没长到需要摘要 —— 此时**不插入任何段落**，
   * 而不是插一句「（无更早的对话）」：那会浪费 token 且暗示信息缺失。
   */
  summaries?: string[];
  /** 检索到的长期记忆。缺省视为「未检索」 */
  retrieval?: MemoryRetrieval;
  /** 覆盖系统提示词（测试与实验用） */
  systemPrompt?: string;
  /**
   * 组装这一刻的「现在」。
   *
   * 【为什么必须由调用方注入，而不是内部调 new Date()】
   *   ① 本模块是纯函数式的 —— 内部读时钟会让同一份输入产出不同输出，无法单测。
   *   ② 事件时间与消息时间必须来自同一个时钟，否则跨零点会自相矛盾
   *      （消息标 23:59、系统提示写「今天」却是明天）。
   *   ③ 集成测试需要构造「隔了两天」的历史，只能靠注入。
   *
   * 缺省取当前时刻，供真实调用路径省略此参数。
   */
  now?: Date;
  /**
   * 用户所在时区（IANA 名称，如 Asia/Shanghai）。
   *
   * ⚠️ 必须显式传入：容器与 CI 的 TZ 通常是 UTC，
   *    而用户在中国 —— 用 UTC 写「今天」会让模型把凌晨的对话算到前一天。
   *    调用方传 users.timezone（用户在 /settings 里配置的独立列）。
   */
  timezone?: string;
  /** 覆盖时间标记的最小间隔（分钟）。测试用 */
  timeGapMinutes?: number;
  /** 注入条数上限。缺省 DEFAULT_INJECT_LIMIT */
  injectLimit?: number;
  /** 注入 token 预算。缺省 DEFAULT_INJECTION_TOKEN_BUDGET */
  injectTokenBudget?: number;
}

export interface BuiltChatContext {
  /** 可直接交给 runAgent 的 messages */
  messages: LLMMessage[];
  /** 可观测性信息。**不含任何消息或记忆正文**（docs/03 §29.1） */
  meta: {
    messageCount: number;
    historyCount: number;
    /** 纳入的摘要段数 */
    summaryCount: number;
    injectedMemoryCount: number;
    /** 因预算或条数被裁掉的记忆数 */
    droppedMemoryCount: number;
    retrievalPerformed: boolean;
    retrievalSkippedReason?: MemoryRetrieval['skippedReason'];
    /** 组装后上下文的近似 token 数（估算，用于观测注入是否超预算） */
    approxTokens: number;
    /** 实际插入的时间标记条数（观测用：能看出历史是否被切成了多段） */
    timeMarkerCount: number;
  };
}

/**
 * 组装一次对话的完整上下文。
 *
 * 结构（docs/02 §9）：
 *   ┌─ system：角色与规则
 *   ├─ system：已知信息（长期记忆）—— 没有记忆时**整段不出现**
 *   ├─ 历史消息（user / assistant 交替）
 *   └─ user：当前消息
 *
 * ⚠️ 为什么「已知信息」单独放一条 system 消息，而不是拼进第一条：
 *    拼进去会让提示词缓存失效的概率变高，也会让「规则」与「数据」混在一起 ——
 *    模型更容易把记忆内容当成指令（提示注入的经典入口）。
 *    分开后，规则与数据边界清晰，且记忆段落可以独立裁剪而不动规则。
 */
export function buildChatContext(params: BuildChatContextParams): BuiltChatContext {
  const retrieval = params.retrieval ?? { performed: false, skippedReason: 'not_implemented', memories: [] };
  const injectLimit = params.injectLimit ?? DEFAULT_INJECT_LIMIT;
  const tokenBudget = params.injectTokenBudget ?? DEFAULT_INJECTION_TOKEN_BUDGET;

  const systemPrompt = params.systemPrompt ?? CHAT_SYSTEM_PROMPT;

  /*
   * 「现在是几点」必须由系统提示给出一次。
   *
   * ⚠️ 不拼进 CHAT_SYSTEM_PROMPT 常量，也不单独发一条 system 消息：
   *    · 拼进常量 → 它就不再是常量，提示词缓存每次都失效
   *    · 单独发一条 → 白占一条消息，而它本来就是「规则」的一部分
   *    在组装时追加到常量末尾，既保持常量不变，又不动消息结构。
   */
  const now = params.now ?? new Date();
  const timezone = params.timezone ?? DEFAULT_TIMEZONE;
  const gapMinutes = params.timeGapMinutes ?? TIME_GAP_MARKER_MINUTES;

  // ---------- 记忆的条数与预算双裁剪 ----------
  const { kept, dropped } = selectMemoriesWithinBudget(
    retrieval.memories,
    injectLimit,
    tokenBudget
  );

  const messages: LLMMessage[] = [
    { role: 'system', content: `${systemPrompt}\n\n${buildNowLine(now, timezone)}` },
  ];

  const knownFacts = buildKnownFactsSection(kept);
  if (knownFacts !== null) {
    messages.push({ role: 'system', content: knownFacts });
  }

  /**
   * 更早对话的摘要（§12.4）。
   *
   * 位置不可调换：必须在最近消息**之前**。
   * 摘要讲的是较早的事，放到最近消息之后会被模型当成刚发生的 ——
   * §12.4 专门强调了这一点。
   */
  const summaries = params.summaries ?? [];
  if (summaries.length > 0) {
    messages.push({ role: 'system', content: buildSummarySection(summaries) });
  }

  /*
   * 历史消息带上时间标记。
   *
   * ⚠️ 「现在」是各条消息的时间标记的共同参照点：
   *    最后一条历史消息到「现在」的间隔同样要标 ——
   *    那正是用户最需要模型感知的场景（「我隔了两天又来说话」）。
   */
  let previousAt: Date | undefined;
  let timeMarkerCount = 0;

  for (const m of params.recentMessages) {
    const marker = buildTimeMarker(previousAt, m.createdAt, now, timezone, gapMinutes);
    if (marker !== null) {
      messages.push({ role: 'system', content: marker });
      timeMarkerCount += 1;
      /**
       * ⚠️ 只在**真的打了标记**时推进锚点，不能每条都推。
       *
       * 实测踩到：先写成「有 createdAt 就推进」，于是
       *   08:51(标记) → 09:21(未标，但锚点被推到 09:21)
       *   → 11:30 与锚点同一天 → 标记写成「（11:30）」
       * 模型看到的是孤零零一个「11:30」，既不知道是哪天、
       * 也看不出与上一段隔了 2 小时。锚点必须是**上一个标记点**。
       */
      previousAt = m.createdAt;
    }

    messages.push({ role: m.role, content: m.content });
  }

  messages.push({ role: 'user', content: params.userMessage });

  return {
    messages,
    meta: {
      messageCount: messages.length,
      historyCount: params.recentMessages.length,
      summaryCount: summaries.length,
      injectedMemoryCount: kept.length,
      droppedMemoryCount: dropped,
      retrievalPerformed: retrieval.performed,
      ...(retrieval.skippedReason !== undefined
        ? { retrievalSkippedReason: retrieval.skippedReason }
        : {}),
      approxTokens: messages.reduce((n, m) => n + estimateTokens(m.content), 0),
      timeMarkerCount,
    },
  };
}

/**
 * 组装摘要段落。
 *
 * 显式标注「以下是更早对话的摘要」并说明**后面的才是原文** ——
 * 否则模型会把摘要与原文一视同仁，在细节问题上引用摘要里被压缩掉的信息
 * （摘要是有损的，用它回答细节会出错）。
 */
function buildSummarySection(summaries: string[]): string {
  return [
    '以下是本次会话更早部分的摘要（按时间正序，内容经过压缩）：',
    ...summaries.map((s, i) => `【第 ${i + 1} 段】${s}`),
    '',
    '注意：摘要是有损压缩，细节可能不准确。',
    '若用户追问具体细节而摘要里没有，请说明你不确定，不要凭摘要推断。',
    '摘要之后的消息是原文，以原文为准。',
  ].join('\n');
}

// ============================================================
// 内部
// ============================================================

/**
 * 系统提示末尾的「现在」。
 *
 * 【为什么还要明说「不要说自己看不到时间」】
 *   实测（docs/11 反馈 1）：用户问「你知道现在是什么时间吗」，
 *   模型回答「我没有时钟，看不到当前是几点几分」——
 *   它在字面上没有撒谎（当时的上下文里确实没有时间），但体验很差：
 *   这是产品能力的缺失，而不是诚实的表现。
 *   光补上时间还不够 —— 它会按旧习惯继续声称看不到，因此必须显式纠正。
 *
 * 【为什么用括注】
 *   放在规则里的祈使句容易被模型当成「用户说过的话」来引用；
 *   括注的形式更像环境说明，被复述出去的概率低。
 */
function buildNowLine(now: Date, timezone: string): string {
  const clock = formatClock(now, timezone);
  const stamp = formatDateStamp(now, timezone);
  return `当前时间：${stamp} ${clock}。\n（这是你所在环境提供的真实时间，可以直接回答时间相关的问题。不要说自己看不到时间。）`;
}

/** 渲染成 HH:MM（24 小时制，按给定时区） */
function formatClock(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    // ⚠️ 必须显式指定 h23。zh-CN 下 hour12:false 不保证是 0-23 ——
    //    实测过 00:51 被渲染成「24:51」，模型会以为是深夜。
    hourCycle: 'h23',
  }).format(d);
}

/**
 * 把时刻拆成时区内的日期部件。
 *
 * 用 formatToParts 逐个取，而不是拼两次 Intl 调用 ——
 * 年份是最容易被搞错的一项（见下），集中在一处处理才不会两处不一致。
 */
function dateParts(d: Date, timezone: string): { year: string; month: string; day: string; weekday: string } {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  }).formatToParts(d);

  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    weekday: pick('weekday'),
  };
}

/**
 * 渲染成「2026年09月26日 星期六」。
 *
 * ⚠️ 年份**每个标记都写**，不做「同年省略」的优化。实测踩到：
 *    跨年会话里标记写成「12月31日 星期三 23:00」、
 *    紧随其后一句「现在是 01月01日 星期四 10:00」——
 *    两句都没有年份，读起来像同一天的一小时之后，而实际隔了一年。
 *    这条路径的错误代价（模型把一年前的事当成昨天）远高于省下 5 个字符。
 *
 * ⚠️ 星期用「星期六」而不是「周六」：模型把两者都认成周六，
 *    但「星期六」与 Intl 在 zh-CN 下的输出一致，少一层格式猜测。
 */
function formatDateStamp(d: Date, timezone: string): string {
  const p = dateParts(d, timezone);
  return `${p.year}年${p.month}月${p.day}日 ${p.weekday}`;
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} 天` : `${days} 天 ${restHours} 小时`;
}

/**
 * 生成一条时间标记；不需要标时返回 null。
 *
 * 规则（间隔阈值见 TIME_GAP_MARKER_MINUTES）：
 *   · 首条历史消息永远标 —— 必须有个起点，否则后面所有标记都失去参照
 *   · 与上一条**标记点**的间隔 < 阈值 → 不标（同一段连续对话）
 *   · 标记一律带完整日期，不做「同年省略」
 *   · 与上一条消息（不一定是标记点）间隔 ≥ 阈值时，补一句「距上一条 X」
 *   · 距「现在」超过阈值时，再补一句「现在是 …，已过去 Y」
 *
 * 【为什么日期一律写全，而不是「同一天就只写 11:30」】
 *   实测踩到：先写成「与上一条消息同一天 → 只写时刻」，
 *   结果标记退化成光秃秃一个「（11:30）」—— 模型既不知道是哪一天，
 *   也看不出与上一段隔了 2 小时。时间标记的全部价值就是**锚定时间**，
 *   为省几个字符把它变得有歧义是亏的。
 *
 * 【为什么后两句要分开判断】
 *   「距上一条 X」解决的是历史内部的断裂，
 *   「距现在 Y」解决的是历史与当下的断裂（反馈 5 的核心：
 *   用户隔了两天再说话，模型必须知道这段沉默有多长）。
 *   两者可能同时成立，也可能只成立一个。
 */
function buildTimeMarker(
  previousAt: Date | undefined,
  currentAt: Date | undefined,
  now: Date,
  timezone: string,
  gapMinutes: number
): string | null {
  if (currentAt === undefined || Number.isNaN(currentAt.getTime())) return null;

  let gapFromPrevious: number | undefined;
  if (previousAt !== undefined) {
    const elapsed = Math.round((currentAt.getTime() - previousAt.getTime()) / 60_000);
    if (elapsed < gapMinutes) return null;
    gapFromPrevious = elapsed;
  }

  const lines = [`（${formatDateStamp(currentAt, timezone)} ${formatClock(currentAt, timezone)}）`];

  if (gapFromPrevious !== undefined) {
    lines.push(`—— 距离上面这条消息已经过去 ${formatDuration(gapFromPrevious)}。`);
  }

  const sinceNow = Math.round((now.getTime() - currentAt.getTime()) / 60_000);
  if (sinceNow >= gapMinutes) {
    const nowStamp = `${formatDateStamp(now, timezone)} ${formatClock(now, timezone)}`;
    lines.push(`—— 现在是 ${nowStamp}，距离这条消息已经过去 ${formatDuration(sinceNow)}。`);
  }

  return lines.join('\n');
}

/**
 * 按条数与 token 预算裁剪记忆。
 *
 * 保留顺序：调用方传入时已按最终得分排好序，因此从前往后取即可。
 * 一条都放不下时返回空 —— 比超预算塞进去更安全（超预算会挤掉历史消息，
 * 让模型失去当前对话的上下文，反而更容易答错）。
 */
function selectMemoriesWithinBudget(
  memories: ContextMemory[],
  limit: number,
  tokenBudget: number
): { kept: ContextMemory[]; dropped: number } {
  const kept: ContextMemory[] = [];
  let used = 0;

  for (const m of memories) {
    if (kept.length >= limit) break;

    const cost = estimateTokens(m.content) + 8; // +8：类型标签与日期等固定开销
    if (used + cost > tokenBudget) break;

    kept.push(m);
    used += cost;
  }

  return { kept, dropped: memories.length - kept.length };
}

/**
 * 粗略估算 token 数。
 *
 * ⚠️ 这是**估算**，不是分词结果：中文约 1 字 1 token，
 *    英文约 4 字符 1 token。这里按「字符数」统一处理，
 *    对中日韩文本偏高一点、对纯英文偏低一点，用于预算裁剪足够。
 *
 *    不引入 tiktoken 一类分词器的理由：那是 OpenAI 的编码，
 *    DeepSeek 的编码不同，用错的分词器只会给出更精确的错误。
 *    真要精确计算，应在 provider 层用服务端返回的 usage 反算。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length);
}
