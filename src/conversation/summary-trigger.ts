/**
 * 会话摘要触发器（docs/03 §12.3）
 *
 * 【为什么需要触发层，而不是在 ChatService 里直接 await】
 *   生成摘要要调 LLM（慢且花钱），而用户此刻在等回答 ——
 *   放在响应路径上会平白多等一次调用。
 *   而且摘要只是上下文优化，失败不该影响聊天。
 *
 * 【与 ExtractionTrigger 的合流策略一致】
 *   同一会话串行、跑完再看有没有新的待处理项。
 *   摘要的阈值很高（默认 30 条未摘要消息），
 *   因此绝大多数 schedule 调用会立刻返回「未达阈值」——
 *   这里的合流主要防的是「一长段对话里连续多次触发」。
 *
 * 【已知取舍：进程内状态】
 *   与抽取触发器相同：重启即丢。但摘要**幂等**
 *   （区间唯一索引 + maxSummarizedSequence 推进），
 *   下次触发会从上次摘要到的位置继续，不会重复也不会漏。
 */
import { maybeSummarize, type SummarizeResult } from './summarizer.js';
import type { LLMProvider } from '../llm/provider.js';

export interface SummaryTriggerOptions {
  /** 覆盖默认阈值（§12.3 规定 30） */
  threshold?: number;
  /** 覆盖默认批大小（§12.3 规定 20） */
  batchSize?: number;
  /**
   * LLM Provider。生产不传（用 env 配置的默认 Provider），
   * 测试必须传一个假实现 —— 否则每条消息都会真调模型。
   */
  provider?: LLMProvider;
  /** 生成结果回调。用于日志，**不得记录正文**（docs/03 §29.1） */
  onResult?: (e: { conversationId: string; result: SummarizeResult }) => void;
  onError?: (e: { conversationId: string; error: unknown }) => void;
  /** 覆盖 maybeSummarize（测试注入用） */
  run?: typeof maybeSummarize;
}

interface Entry {
  /** 最新的消息序号。合流时取最大值 —— 中间那些不必逐个处理 */
  latestSequence: number;
  running: boolean;
  queued: boolean;
}

export class SummaryTrigger {
  private readonly entries = new Map<string, Entry>();
  private readonly run: typeof maybeSummarize;

  constructor(private readonly options: SummaryTriggerOptions = {}) {
    this.run = options.run ?? maybeSummarize;
  }

  /**
   * 请求一次摘要生成。**立即返回**。
   *
   * @param latestSequence 会话当前的最新消息序号
   */
  schedule(conversationId: string, latestSequence: number): void {
    const entry = this.entries.get(conversationId) ?? {
      latestSequence,
      running: false,
      queued: false,
    };

    // 取较大的序号：后到的请求覆盖先到的，中间值不必逐个处理
    entry.latestSequence = Math.max(entry.latestSequence, latestSequence);
    this.entries.set(conversationId, entry);

    if (entry.running) {
      entry.queued = true;
      return;
    }

    void this.drain(conversationId);
  }

  /** 等待在跑的摘要结束。**仅供测试与优雅退出** */
  async idle(): Promise<void> {
    for (;;) {
      const busy = [...this.entries.values()].some((e) => e.running);
      if (!busy) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  get activeCount(): number {
    return [...this.entries.values()].filter((e) => e.running).length;
  }

  // ------------------------------------------------------------

  /**
   * 执行一次摘要尝试。
   *
   * ⚠️ 这里**刻意不循环**重试。
   *    每次调用最多生成**一段**摘要（一条摘要覆盖 batchSize 条消息）。
   *    未达阈值时直接返回；生成成功后如果消息仍然积压，
   *    下一次 chat 请求会再次 schedule 并继续推进。
   *
   *    为什么不在这一次调用里循环把积压清空：
   *    一次只生成一段是 §12.3 的策略（阈值 30 / 批 20），
   *    循环清空意味着一次请求可能触发 N 次 LLM 调用 ——
   *    在用户看不见的地方花掉不可预期的成本。
   */
  private async drain(conversationId: string): Promise<void> {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.running) return;

    entry.running = true;
    entry.queued = false;

    try {
      const result = await this.run({
        conversationId,
        latestSequence: entry.latestSequence,
        ...(this.options.threshold !== undefined ? { threshold: this.options.threshold } : {}),
        ...(this.options.batchSize !== undefined ? { batchSize: this.options.batchSize } : {}),
        ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
      });

      if (result.generated) {
        this.options.onResult?.({ conversationId, result });
      }
    } catch (err) {
      // 摘要失败不影响任何已返回给用户的响应
      if (this.options.onError) {
        this.options.onError({ conversationId, error: err });
      } else {
        console.error(`[summary] 会话 ${conversationId} 摘要失败：${describeError(err)}`);
      }
    } finally {
      entry.running = false;
      /**
       * 执行期间有新消息进来（queued）→ 再跑一次。
       * 用一次尾递归而不是 while：语义上就是「这批没赶上，再补一次」，
       * 且 depth 至多 1（下一轮若又没赶上会继续排，但不会同步堆栈）。
       */
      if (entry.queued) {
        entry.queued = false;
        void this.drain(conversationId);
      } else {
        this.entries.delete(conversationId);
      }
    }
  }
}

/** 只取错误描述，不打印整个 error 对象（可能带上对话正文） */
function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return '未知错误';
}

/**
 * 默认触发器单例。
 *
 * 与抽取触发器一样：合流状态必须在进程内共享，
 * 因此测试应自己 new 而不是用这个。
 */
let defaultTrigger: SummaryTrigger | undefined;

/**
 * 默认触发器单例。
 *
 * @param options.provider 生产不传（用 env 配置的默认 Provider）。
 *        注意：单例只会按**首次调用**的参数构造，后续调用传的 options 会被忽略。
 *        因此测试不要用这个函数 —— 自己 new SummaryTrigger。
 */
export function getDefaultSummaryTrigger(
  options: Omit<SummaryTriggerOptions, 'onResult'> = {}
): SummaryTrigger {
  defaultTrigger ??= new SummaryTrigger({
    ...options,
    onResult: ({ conversationId, result }) => {
      // 只记区间，不记摘要正文（§29.1）
      console.info(
        `[summary] 会话 ${conversationId} 已生成摘要：` +
          `覆盖 ${result.covered?.from}-${result.covered?.to}`
      );
    },
  });

  return defaultTrigger;
}
