/**
 * 会话标题触发器（docs/12 §方案 2 的③）
 *
 * 【为什么需要触发层，而不是在 ChatService 里直接 await】
 *   与摘要触发器完全同理：生成标题要调 LLM（慢且花钱），
 *   而用户此刻在等回答。放在响应路径上会平白多等一次调用，
 *   而标题只是列表可读性，失败不该影响聊天。
 *
 * 【与 ExtractionTrigger / SummaryTrigger 的合流策略一致】
 *   同一会话串行。这里的合流比摘要更必要：
 *   摘要有 30 条的高阈值，绝大多数 schedule 直接返回；
 *   而标题在**每一轮**都可能真的调一次 LLM（判断逻辑在
 *   generateConversationTitle 里），连续快速发消息时最坏会排队多次。
 *   合流把它们压成一次。
 *
 * 【已知取舍：进程内状态】
 *   与另两个触发器相同：重启即丢。但标题是**幂等**的
 *   （判据是「当前标题是否还是占位标题」），
 *   下次对话触发时会自然补上，不会漏也不会重复覆盖。
 */
import { generateConversationTitle, type GenerateTitleResult } from './conversation-title.js';
import type { LLMProvider } from '../llm/provider.js';

export interface TitleTriggerOptions {
  /**
   * LLM Provider。生产不传（用 env 配置的默认 Provider），
   * 测试必须传一个假实现 —— 否则每轮对话都会真调模型。
   */
  provider?: LLMProvider;
  /** 生成结果回调。用于日志，**不得记录标题正文**（docs/03 §29.1） */
  onResult?: (e: {
    conversationId: string;
    result: GenerateTitleResult;
  }) => void;
  onError?: (e: { conversationId: string; error: unknown }) => void;
  /** 覆盖 generateConversationTitle（测试注入用） */
  run?: typeof generateConversationTitle;
}

interface Entry {
  /** 占位标题。新建会话时算出来的那个 */
  placeholderTitle: string;
  running: boolean;
  queued: boolean;
}

export class TitleTrigger {
  private readonly entries = new Map<string, Entry>();
  private readonly run: typeof generateConversationTitle;

  constructor(private readonly options: TitleTriggerOptions = {}) {
    this.run = options.run ?? generateConversationTitle;
  }

  /**
   * 请求一次标题生成。**立即返回**。
   *
   * @param placeholderTitle 会话当前的占位标题。生成器靠它判断
   *        「是否还需要生成」（不等于它就说明已经有正式标题或用户改过名）。
   */
  schedule(conversationId: string, placeholderTitle: string): void {
    const entry = this.entries.get(conversationId) ?? {
      placeholderTitle,
      running: false,
      queued: false,
    };

    // 后到的请求覆盖先到的：占位标题在同一会话里是稳定的，
    // 这里赋值只是为了让新建时的值也能进入 entry。
    entry.placeholderTitle = placeholderTitle;
    this.entries.set(conversationId, entry);

    if (entry.running) {
      entry.queued = true;
      return;
    }

    void this.drain(conversationId);
  }

  /** 等待在跑的生成结束。**仅供测试与优雅退出** */
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

  private async drain(conversationId: string): Promise<void> {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.running) return;

    entry.running = true;
    entry.queued = false;

    try {
      const result = await this.run({
        conversationId,
        placeholderTitle: entry.placeholderTitle,
        ...(this.options.provider !== undefined ? { provider: this.options.provider } : {}),
      });

      if (result.generated) {
        this.options.onResult?.({ conversationId, result });
      }
    } catch (err) {
      // 标题生成失败不影响任何已返回给用户的响应
      if (this.options.onError) {
        this.options.onError({ conversationId, error: err });
      } else {
        console.error(`[title] 会话 ${conversationId} 标题生成失败：${describeError(err)}`);
      }
    } finally {
      entry.running = false;
      /**
       * 执行期间又有新消息（queued）→ 再跑一次。
       * 第二次多半会得到 already_titled 并立即返回，成本可忽略；
       * 但若第一次因材料不足跳过，这一次就能真的生成。
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
 * 与另两个触发器一样：合流状态必须在进程内共享，
 * 因此测试应自己 new 而不是用这个。
 */
let defaultTrigger: TitleTrigger | undefined;

/**
 * @param options.provider 生产不传（用 env 配置的默认 Provider）。
 *        注意：单例只会按**首次调用**的参数构造，后续调用传的 options 会被忽略。
 *        因此测试不要用这个函数 —— 自己 new TitleTrigger。
 */
export function getDefaultTitleTrigger(
  options: Omit<TitleTriggerOptions, 'onResult'> = {}
): TitleTrigger {
  defaultTrigger ??= new TitleTrigger({
    ...options,
    onResult: ({ conversationId }) => {
      // 只记「生成了」，不记标题正文（§29.1）
      console.info(`[title] 会话 ${conversationId} 已生成标题`);
    },
  });

  return defaultTrigger;
}
