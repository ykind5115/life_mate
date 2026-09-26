/**
 * 会话标题生成（解决 docs/11 反馈 4）
 *
 * 【要解决的问题】
 *   用户反馈：「会话总结标题了吗？总结的标题是还没有往前端放吗？」
 *   实测：两个真实会话的 `title` 都是 NULL，前端列表只能显示
 *   「新对话」并靠首条消息猜 —— 用户完全无法从列表里认出哪个是哪个。
 *
 * 【方案 C：先占位，后生成】（docs/12 §方案 2，用户已确认）
 *   ① 会话创建时立刻写一个**占位标题**（首条用户消息截断，纯字符串操作，零成本）
 *      → 列表在任何时刻都有东西可显示
 *   ② 首轮回答落库后，后台用 LLM 生成正式标题覆盖它
 *      → 标题质量好（「公安运维工作咨询」而不是「早上好呀，你知道现在是…」）
 *
 *   为什么两段都要：
 *     只有 ① → 问候语开头的会话标题永远很难看
 *     只有 ② → 从发消息到生成完成之间，列表里是空的/「新对话」
 *
 * 【为什么不用首条消息截断就完事】
 *   实测用户的真实首条消息是「早上好呀，你知道现在是什么时间吗，你知道我是谁吗？」
 *   —— 截断成「早上好呀，你知道现在是什么时间吗」当标题毫无信息量。
 *
 * 【与摘要 / 抽取共用同一套 fire-and-forget 模式】
 *   都放在响应之后、失败不影响聊天、进程内触发（不引入 MQ）。
 */
import type { LLMProvider } from '../llm/provider.js';
import {
  findAliveConversationById,
  findRecentMessages,
  updateConversation,
} from '../database/repository/conversation-store.js';
import type { ExecutorOption } from '../database/repository/types.js';

/**
 * 标题生成器版本。
 *
 * ⚠️ 与 SUMMARIZER_VERSION / EXTRACTOR_VERSION 同理：
 *    提示词或模型变更时必须改这个值。
 *    它是「这个标题由哪一版生成器产出」的唯一追溯依据。
 */
export const TITLE_GENERATOR_VERSION = 'v1';

/** 占位标题的最大字符数 */
export const TITLE_PLACEHOLDER_MAX_CHARS = 20;

/** LLM 正式标题的最大字符数。超过就截断（模型偶尔不听话） */
export const TITLE_MAX_CHARS = 16;

/**
 * 生成标题时喂给模型的对话条数。
 *
 * 取前若干条而不是全部：标题只需要「这段对话在聊什么」，
 * 前几条已经足够，而且早期消息最能代表会话主题
 * （聊到后面往往会漂移到别的话题）。
 *
 * 6 条 = 3 轮，够模型看出主题，又不会让输入无谓变长。
 */
const TITLE_MATERIAL_MESSAGE_LIMIT = 6;

const TITLE_SYSTEM_PROMPT = `你要给一段对话起一个标题。

## 要求

1. 用中文，5～12 个字。
2. 概括**谈话的主题**，让人一眼能从列表里认出这段对话是关于什么的。
3. 不要出现「对话」「聊天」「咨询」「关于」这类空词。
4. 不要是问候语或对话原文的节选。
5. 不要标点符号，不要引号，不要书名号。
6. 只输出标题本身。不要「标题：」这类前缀，不要解释，不要 markdown。

## 例子

对话在聊用户做运维工作同时搞 AI 开发 → 公安运维与 AI 开发
对话在聊用户想学 agent 但一直拖着 → 学习 agent 的进度
对话在聊用户假期睡了两天、情绪低落 → 假期状态与心情
对话在聊用户在考虑换城市工作 → 换城市的考虑`;

export interface GenerateTitleResult {
  /** 是否真的写入了一个新标题 */
  generated: boolean;
  /** 未生成的原因 */
  skippedReason?: 'not_found' | 'already_titled' | 'too_few_messages' | 'empty_output';
  /** 写入的标题（仅 generated 时存在） */
  title?: string;
}

/**
 * 为会话生成一个正式标题并覆盖占位标题。
 *
 * 【幂等性怎么保证】
 *   判断依据是「当前标题是否等于我算出来的占位标题」——
 *   而不是「是不是第一次调用」。
 *   这样：
 *     · 用户手动改过名 → 当前标题 ≠ 占位 → 不覆盖（尊重用户）
 *     · 上次生成失败    → 当前标题仍 = 占位 → 下次会重试
 *     · 并发两次调用    → 第二次发现标题已变 → 跳过
 *   不需要额外的状态表，也不怕进程重启。
 *
 * 【失败处理】
 *   LLM 返回空、超长、带标点 —— 一律清洗；清洗后仍不可用就返回
 *   empty_output 并**保留占位标题**，而不是写一个空标题或半截标题。
 */
export async function generateConversationTitle(
  params: {
    conversationId: string;
    /** 该会话首条用户消息的占位标题，用于判断「是否还需要生成」 */
    placeholderTitle: string;
    provider?: LLMProvider;
  },
  options: ExecutorOption = {}
): Promise<GenerateTitleResult> {
  const conversation = await findAliveConversationById(params.conversationId, options);
  if (!conversation) return { generated: false, skippedReason: 'not_found' };

  /**
   * 判断「是否还需要生成标题」。
   *
   * 三种情况，**顺序不能反**：
   *   ① 标题为空（NULL 或空串）→ 需要生成
   *   ② 标题等于占位标题       → 需要生成（还没有正式名字）
   *   ③ 其余                   → 已有正式标题，或用户手动改过名 → 跳过
   *
   * ⚠️ ① 不能省。`createConversation` 允许 `title` 为 NULL，
   *    而**本功能上线之前的会话全是 NULL** ——
   *    少了这一条，`null !== placeholder` 会被判成「已有标题」，
   *    那些历史会话永远起不了名字（实测踩到：回填脚本对两个真实会话
   *    全部输出 already_titled，一个都没生成）。
   *
   * ⚠️ 比较的是「当前标题 === 占位标题」而不是「标题是否为空」：
   *    会话创建时一定会写占位标题，所以单看「为空」会漏掉
   *    最常见的「还是占位标题」这一种，退化成「每次对话都重新生成」。
   */
  const hasTitle = conversation.title !== null && conversation.title.length > 0;
  if (hasTitle && conversation.title !== params.placeholderTitle) {
    return { generated: false, skippedReason: 'already_titled' };
  }

  const messages = await findRecentMessages(
    { conversationId: params.conversationId, limit: TITLE_MATERIAL_MESSAGE_LIMIT },
    options
  );

  /**
   * 材料不足时跳过。
   *
   * 正常路径下这一步至少能看到 2 条（用户问 + 助手答，两者在同一个事务里落库，
   * 触发在事务之后）。只有 1 条说明助手回答还没写进去 ——
   * 此时给出的标题会偏向「用户问了什么」，等下一轮再生成更准。
   */
  if (messages.length < 2) {
    return { generated: false, skippedReason: 'too_few_messages' };
  }

  const provider = params.provider ?? (await defaultProvider());

  const res = await provider.generate({
    messages: [
      { role: 'system', content: TITLE_SYSTEM_PROMPT },
      { role: 'user', content: buildTitleMaterials(messages) },
    ],
    /**
     * 标题很短，但**不能把 max_tokens 定得太小**。
     *
     * ⚠️ 实测教训（docs/10 §3.2 记过同一件事）：
     *    deepseek 是推理模型，思考 token 与答案 token **共用** max_tokens。
     *    定 32 会让它思考完就没有余量输出标题。
     *    这里给 512 —— 相对一次完整对话可以忽略，但足够思考 + 输出。
     */
    maxOutputTokens: 512,
    /** 起标题是压缩任务，不需要思维链（与摘要同理） */
    thinking: { type: 'disabled' },
  });

  const cleaned = cleanTitle(res.content);
  if (cleaned === null) return { generated: false, skippedReason: 'empty_output' };

  /**
   * ⚠️ withUpdatedAt: false —— 标题是后台补写的元数据，不是「有新消息」。
   *    推进 updated_at 会把旧会话顶到列表最前面（见 updateConversation 的说明）。
   */
  const updated = await updateConversation(
    params.conversationId,
    { title: cleaned },
    { ...options, withUpdatedAt: false }
  );

  if (!updated) return { generated: false, skippedReason: 'not_found' };

  return { generated: true, title: cleaned };
}

/**
 * 占位标题：截取首条用户消息。
 *
 * 规则：
 *   · 换行压成空格（标题是一行）
 *   · 连续空白压成一个空格
 *   · 超过上限则截断并加省略号
 *
 * ⚠️ 不做「去掉问候语」这类智能处理 —— 那是 LLM 的活（见方案 ②）。
 *    占位标题的定位就是「立刻有东西可显示」，越简单越可靠。
 */
export function buildPlaceholderTitle(firstUserMessage: string): string {
  const flat = firstUserMessage.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '新对话';
  if (flat.length <= TITLE_PLACEHOLDER_MAX_CHARS) return flat;
  return `${flat.slice(0, TITLE_PLACEHOLDER_MAX_CHARS)}…`;
}

/**
 * 清洗模型给出的标题。
 *
 * 模型经常不听话，实测常见的有这些：
 *   「标题：公安运维与 AI 开发」    ← 带前缀
 *   「"公安运维与 AI 开发"」        ← 带引号（中英文都有）
 *   「公安运维与 AI 开发。」        ← 带句末标点
 *   「公安运维与 AI 开发\n\n解释…」 ← 后面跟了解释
 *   「**公安运维与 AI 开发**」      ← markdown 加粗
 *
 * 返回 null 表示清洗后不可用（调用方保留占位标题）。
 */
export function cleanTitle(raw: string): string | null {
  let t = raw.trim();

  // 只取第一行非空内容：模型常在标题后追加解释
  const firstLine = t
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return null;
  t = firstLine;

  // 「标题：xxx」「标题: xxx」「title: xxx」
  t = t.replace(/^(标题|题目|title)\s*[:：]\s*/i, '');

  // markdown 强调标记
  t = t.replace(/^[*_`#>\s]+/, '').replace(/[*_`\s]+$/, '');

  // 成对的引号与书名号（中英文）
  t = t.replace(/^["'“”‘’「」『』《》【】]+/, '').replace(/["'“”‘’「」『』《》【】]+$/, '');

  // 句末标点
  t = t.replace(/[。．.，,；;：:！!？?~～\-\s]+$/, '');

  t = t.trim();

  if (t.length === 0) return null;

  /**
   * 剩下的内容里还有引号 → 模型输出的不是标题，而是一句话。
   *
   * 实测形态：`"标题一" 和 "标题二" 都可以，你选一个`
   * 简单地去首尾引号会得到 `标题一" 和 "标题二" 都可以` —— 明显是垃圾。
   * 与其把这种字符串写进会话列表，不如返回 null 保留占位标题等下一轮重试。
   */
  if (/["'“”‘’「」『』]/.test(t)) return null;

  if (t.length > TITLE_MAX_CHARS) {
    t = `${t.slice(0, TITLE_MAX_CHARS)}…`;
  }

  return t;
}

/**
 * 组装标题材料。
 *
 * ⚠️ **不含时间戳**：标题要的是「聊了什么」，不是「什么时候聊的」。
 *    给了时间模型会倾向于起「9 月 24 日的对话」这种标题。
 */
export function buildTitleMaterials(messages: { role: string; content: string }[]): string {
  const lines = messages.map((m) => {
    const speaker = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : m.role;
    return `${speaker}：${m.content}`;
  });

  return `以下是一段对话的开头（按时间正序）：\n\n${lines.join('\n\n')}\n\n请输出这段对话的标题。`;
}

/** 延迟导入以避免在不需要 LLM 的路径上加载 env 校验 */
async function defaultProvider(): Promise<LLMProvider> {
  const mod = await import('../llm/index.js');
  return mod.getLLMProvider();
}
