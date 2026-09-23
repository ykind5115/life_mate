/**
 * 会话摘要生成（docs/03 §12.3、docs/02 §24）
 *
 * 【为什么需要它】（PRD §7.1）
 *   对话会越来越长。没有摘要就只能两个选择：
 *     ① 无限把历史塞进 Context —— 迟早超预算，且越贵越慢
 *     ② 直接丢弃旧消息 —— 丢掉的可能正是「我三个月前说过什么」
 *   摘要是第三条路：把旧消息压成一段话，信息密度高得多。
 *
 * 【生成策略】严格按 §12.3：
 *   触发：未摘要消息 > SUMMARY_THRESHOLD（默认 30）
 *   动作：对最早的 BATCH_SIZE 条（默认 20）生成一段摘要
 *
 *   ⚠️ 触发阈值与批大小是两个数，不要合并：
 *      阈值决定「什么时候值得动手」，批大小决定「一次处理多少」。
 *      阈值 > 批大小，因此摘要不会每来一条消息就重算一次 ——
 *      那是浪费，且每次都调用 LLM。
 *
 * 【幂等】UNIQUE (conversation_id, sequence_from, sequence_to)
 *   同一区间重复生成本来会被唯一索引拦住，
 *   但本节在**调用前**先查 maxSummarizedSequence 算区间，
 *   因此正常路径不会撞索引。索引是并发下的最终防线。
 */
import type { LLMProvider } from '../llm/provider.js';
import {
  createSummary,
  maxSummarizedSequence,
} from '../database/repository/summary-store.js';
import { findMessagesInRange } from '../database/repository/conversation-queries.js';
import type { ExecutorOption } from '../database/repository/types.js';

/**
 * 摘要器版本。
 *
 * ⚠️ 提示词或模型变更时必须改这个值 —— 与 EXTRACTOR_VERSION 同理，
 *    它是「这段摘要由哪一版摘要器产出」的追溯依据。
 *    改了之后，旧摘要不会自动重算（那需要显式的重建流程），
 *    但至少能看出来库里混着两个版本的产出。
 */
export const SUMMARIZER_VERSION = 'v1';

/** §12.3 的默认阈值：未摘要消息超过这么多条才触发 */
export const SUMMARY_THRESHOLD = 30;

/** §12.3 的默认批大小：一次对最早的这么多条生成摘要 */
export const SUMMARY_BATCH_SIZE = 20;

const SUMMARY_SYSTEM_PROMPT = `你是对话摘要器。把一段对话压缩成一段摘录，供后续对话作为背景使用。

## 要求

1. 只保留**对理解用户与后续对话有用**的信息：
   用户的处境、在做的事、表达过的想法与偏好、已经讨论过的结论。
2. 用**第三人称陈述**，以「用户」为主语。
   不要写「你说」「我建议」这类对话口吻 —— 摘要是背景资料，不是对话记录。
3. 保留**时间顺序与因果**：先发生什么、后发生什么。
   若用户的想法有变化，要体现出变化。
4. 不要罗列寒暄与无关细节。不要评价用户。
5. 不要编造对话里没有的信息。材料里没提到的就不要写。
6. 长度控制在 150~300 字。

## 输出

只输出摘要正文，不要任何前缀、标题或 markdown 标记。`;

export interface SummarizeResult {
  /** 本次是否真的生成了摘要 */
  generated: boolean;
  /** 未生成的原因 */
  skippedReason?: 'below_threshold' | 'no_unsummarized_messages';
  /** 生成的摘要覆盖的区间 */
  covered?: { from: number; to: number };
  summary?: string;
}

/**
 * 按需为会话生成一段摘要。
 *
 * 本函数不抛错（除 LLM 调用失败外）：
 *   「消息还不够多」是正常状态，不是错误。
 */
export async function maybeSummarize(
  params: {
    conversationId: string;
    /** 会话当前的最大消息序号。由调用方提供，避免重复查询 */
    latestSequence: number;
    provider?: LLMProvider;
    threshold?: number;
    batchSize?: number;
  },
  options: ExecutorOption = {}
): Promise<SummarizeResult> {
  const threshold = params.threshold ?? SUMMARY_THRESHOLD;
  const batchSize = params.batchSize ?? SUMMARY_BATCH_SIZE;

  const summarizedUpTo = await maxSummarizedSequence(params.conversationId, options);
  const unsummarized = params.latestSequence - summarizedUpTo;

  if (unsummarized <= 0) {
    return { generated: false, skippedReason: 'no_unsummarized_messages' };
  }
  if (unsummarized <= threshold) {
    return { generated: false, skippedReason: 'below_threshold' };
  }

  /**
   * 区间：从「已摘要到的下一条」开始，取 batchSize 条。
   *
   * ⚠️ 不是取「最新的 batchSize 条」：
   *    摘要是为了把**最早的**旧消息腾出上下文。
   *    取最新的会把刚聊过的内容压成摘要 —— 用户下一句问「刚才说的那个」时
   *    原文已经没了，回答质量直接下降。
   */
  const from = summarizedUpTo + 1;
  const to = Math.min(from + batchSize - 1, params.latestSequence);

  const messages = await findMessagesInRange(
    { conversationId: params.conversationId, from, to },
    options
  );

  if (messages.length === 0) {
    return { generated: false, skippedReason: 'no_unsummarized_messages' };
  }

  const provider = params.provider ?? (await defaultProvider());

  const res = await provider.generate({
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildSummaryMaterials(
          messages.map((m) => ({ role: m.role, content: m.content }))
        ),
      },
    ],
    maxOutputTokens: 2048,
    /**
     * 摘要是有明确要求的压缩任务，不需要思维链。
     * 关掉思考能省一半延迟与费用，且不会明显影响摘要质量
     * （与「抽取」不同：抽取要做语义判断，摘要只是压缩）。
     */
    thinking: { type: 'disabled' },
  });

  const summary = res.content.trim();
  if (summary.length === 0) {
    throw new Error('摘要器返回了空内容');
  }

  await createSummary(
    {
      conversationId: params.conversationId,
      summary,
      sequenceFrom: from,
      sequenceTo: to,
      summarizerVersion: SUMMARIZER_VERSION,
    },
    options
  );

  return { generated: true, covered: { from, to }, summary };
}

/**
 * 组装摘要材料。
 *
 * 只给 role 与 content —— 摘要不需要 message id 与时间戳，
 * 给了反而会让模型倾向于罗列时间。
 */
export function buildSummaryMaterials(
  messages: { role: string; content: string }[]
): string {
  const lines = messages.map((m) => {
    const speaker = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : m.role;
    return `${speaker}：${m.content}`;
  });

  return `以下是需要摘要的对话片段（按时间正序）：\n\n${lines.join('\n\n')}\n\n请输出摘要正文。`;
}

/** 延迟导入以避免在不需要 LLM 的路径上加载 env 校验 */
async function defaultProvider(): Promise<LLMProvider> {
  const mod = await import('../llm/index.js');
  return mod.getLLMProvider();
}
