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
}

/** 待注入上下文的一条记忆 */
export interface ContextMemory extends KnownFactInput {
  id: string;
  importanceScore?: number;
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
  /** 检索到的长期记忆。缺省视为「未检索」 */
  retrieval?: MemoryRetrieval;
  /** 覆盖系统提示词（测试与实验用） */
  systemPrompt?: string;
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
    injectedMemoryCount: number;
    /** 因预算或条数被裁掉的记忆数 */
    droppedMemoryCount: number;
    retrievalPerformed: boolean;
    retrievalSkippedReason?: MemoryRetrieval['skippedReason'];
    /** 组装后上下文的近似 token 数（估算，用于观测注入是否超预算） */
    approxTokens: number;
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

  // ---------- 记忆的条数与预算双裁剪 ----------
  const { kept, dropped } = selectMemoriesWithinBudget(
    retrieval.memories,
    injectLimit,
    tokenBudget
  );

  const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt }];

  const knownFacts = buildKnownFactsSection(kept);
  if (knownFacts !== null) {
    messages.push({ role: 'system', content: knownFacts });
  }

  for (const m of params.recentMessages) {
    messages.push({ role: m.role, content: m.content });
  }

  messages.push({ role: 'user', content: params.userMessage });

  return {
    messages,
    meta: {
      messageCount: messages.length,
      historyCount: params.recentMessages.length,
      injectedMemoryCount: kept.length,
      droppedMemoryCount: dropped,
      retrievalPerformed: retrieval.performed,
      ...(retrieval.skippedReason !== undefined
        ? { retrievalSkippedReason: retrieval.skippedReason }
        : {}),
      approxTokens: messages.reduce((n, m) => n + estimateTokens(m.content), 0),
    },
  };
}

// ============================================================
// 内部
// ============================================================

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
