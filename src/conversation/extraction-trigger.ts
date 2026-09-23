/**
 * 记忆抽取触发器（docs/04 §10 的末段箭头、§45 的错误约定）
 *
 * 【为什么需要它，而不是直接在 ChatService 里调 runExtraction】
 *   ① 抽取必须**不阻塞**聊天响应（§45 的流程图明确把它画在「返回用户」之后）
 *   ② 抽取失败**不得**影响聊天结果
 *   ③ 同一会话的抽取请求会连续到来（一次对话产生多条消息），
 *      必须**合流**：否则每轮对话都会触发一次抽取，
 *      而抽取是「从上次成功的位置往后抽」，短时间内多次触发只会互相
 *      撞幂等键，白烧 LLM 调用
 *
 * 【合并策略：按会话去重 + 串行】
 *   同一会话已有任务在跑 → 只标记「还有新消息」，跑完再跑一次。
 *   这比「每次触发都入队」省调用，又比「直接丢弃」不丢消息。
 *
 * 【已知取舍：进程内状态】
 *   队列在内存里，进程重启即丢失。V1.0 不引入 Redis / MQ（AGENTS.md §2），
 *   因此这是既定取舍。**丢失不会造成数据错误**：
 *   抽取是幂等的，进度只按 succeeded 推进，
 *   下次该会话有新消息时会从上次成功处继续覆盖。
 */
import { eq, sql } from 'drizzle-orm';

import { db } from '../database/client.js';
import { messages } from '../database/schema/messages.js';
import { runExtraction, type ExtractionSummary } from '../memory/extraction-pipeline.js';

export interface ExtractionTriggerOptions {
  /**
   * 触发阈值：本次会话累积消息数达到多少才值得抽一次。
   *
   * 缺省 4（约两轮对话）—— 一次抽取要读一段对话才有语义上下文，
   * 「用户说一句就抽一次」既贵又容易抽出断章取义的记忆。
   *
   * ⚠️ 这是保守起点，不是实测最优值。真实阈值应结合评测确定
   *    （PRD §15 的指标 + Phase 5 的评测集）。
   */
  minMessages?: number;
  /**
   * 两次抽取之间的最小间隔（ms）。
   *
   * 用于削掉「用户连续快速发几条消息」造成的抖动 ——
   * 否则每条消息都会立刻触发一次抽取，而相邻两次的消息范围几乎相同。
   */
  debounceMs?: number;
  /** 抽取结果回调。用于日志与指标，**不得记录记忆正文**（§29.1） */
  onResult?: (e: { conversationId: string; summary: ExtractionSummary }) => void;
  /** 抽取失败回调。默认只记录错误描述，不记录正文 */
  onError?: (e: { conversationId: string; error: unknown }) => void;
  /** 覆盖 runExtraction（测试注入用） */
  run?: typeof runExtraction;
  /** 覆盖「统计会话消息数」（测试注入用） */
  countMessages?: (conversationId: string) => Promise<number>;
}

/** 每个会话的运行状态 */
interface PendingEntry {
  /** 是否有新消息在等待下一次抽取 */
  queued: boolean;
  /** 正在跑 */
  running: boolean;
  /** 上次启动时间，用于 debounce */
  lastStartedAt: number;
  /** debounce 定时器句柄 */
  timer?: NodeJS.Timeout | undefined;
}

export class ExtractionTrigger {
  private readonly entries = new Map<string, PendingEntry>();
  private readonly minMessages: number;
  private readonly debounceMs: number;
  private readonly run: typeof runExtraction;
  private readonly countMessages: (conversationId: string) => Promise<number>;

  constructor(private readonly options: ExtractionTriggerOptions = {}) {
    this.minMessages = options.minMessages ?? 4;
    this.debounceMs = options.debounceMs ?? 0;
    this.run = options.run ?? runExtraction;
    this.countMessages = options.countMessages ?? countConversationMessages;
  }

  /**
   * 请求一次抽取。**立即返回**，不等待抽取完成。
   *
   * 这是 ChatService 唯一需要调用的方法。
   */
  schedule(conversationId: string): void {
    const entry = this.entries.get(conversationId) ?? {
      queued: false,
      running: false,
      lastStartedAt: 0,
    };
    this.entries.set(conversationId, entry);

    // 已有任务在跑：只置标记，跑完会自行再跑一轮
    if (entry.running) {
      entry.queued = true;
      return;
    }

    // debounce：延迟到安静下来再跑，期间的新请求只是把标记置位
    if (this.debounceMs > 0) {
      entry.queued = true;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        void this.drain(conversationId);
      }, this.debounceMs);
      // 定时器不应阻止进程退出
      entry.timer.unref?.();
      return;
    }

    entry.queued = true;
    void this.drain(conversationId);
  }

  /** 等待所有在跑的抽取结束。**仅供测试与优雅退出使用** */
  async idle(): Promise<void> {
    // 反复等待直到没有任何会话处于活动状态：
    // 一次抽取结束后可能立刻被 queued 标记再跑一轮
    for (;;) {
      const busy = [...this.entries.values()].some((e) => e.running || e.timer !== undefined);
      if (!busy) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** 当前处于运行中的会话数。用于健康检查与测试断言 */
  get activeCount(): number {
    return [...this.entries.values()].filter((e) => e.running).length;
  }

  // ------------------------------------------------------------

  /**
   * 串行执行某会话的抽取，直到没有待处理的新消息。
   *
   * 用循环而不是递归：递归在「消息持续涌入」时会无限加深调用栈。
   */
  private async drain(conversationId: string): Promise<void> {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.running) return;

    entry.running = true;
    entry.lastStartedAt = Date.now();

    try {
      while (entry.queued) {
        // 先清标记再执行：执行期间新来的 schedule 会重新置位并再跑一轮
        entry.queued = false;

        // 阈值：消息太少时先不抽，等攒够
        if (this.minMessages > 1) {
          const n = await this.countMessages(conversationId);
          if (n < this.minMessages) break;
        }

        try {
          const summary = await this.run({ conversationId, maxMessages: 50 });

          /**
           * 未执行（被幂等键或「没有新消息」拦下）时不报告成功 ——
           * 那会让人以为抽取发生了，掩盖「消息没进来」这类问题。
           */
          if (summary.executed) {
            this.options.onResult?.({ conversationId, summary });
          }
        } catch (err) {
          // 抽取失败不影响任何已返回给用户的响应（§45）
          if (this.options.onError) {
            this.options.onError({ conversationId, error: err });
          } else {
            console.error(
              `[extraction] 会话 ${conversationId} 抽取失败：${describeError(err)}`
            );
          }
        }
      }
    } finally {
      entry.running = false;
      // 没有待处理项时清掉状态，避免 Map 随会话数无限增长
      if (!entry.queued && !entry.timer) this.entries.delete(conversationId);
    }
  }
}

/** 统计某会话的消息条数（阈值判断用，不读内容） */
async function countConversationMessages(conversationId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));

  return rows[0]?.n ?? 0;
}

/** 只取错误描述，不打印整个 error 对象（可能带上用户消息正文） */
function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return '未知错误';
}

/**
 * 默认触发器的单例。
 *
 * ⚠️ 为什么用单例而不是每次请求 new 一个：
 *    合流状态必须在进程内共享，每个请求一个实例等于没有合流。
 *    单例也意味着测试之间会互相影响 ——
 *    因此测试应自己 new ExtractionTrigger 而不是用这个。
 */
let defaultTrigger: ExtractionTrigger | undefined;

export function getDefaultExtractionTrigger(): ExtractionTrigger {
  defaultTrigger ??= new ExtractionTrigger({
    minMessages: 4,
    debounceMs: 1500,
    onResult: ({ conversationId, summary }) => {
      /**
       * 只记录计数与诊断指标，**不记录任何记忆正文或消息内容**（§29.1）。
       * 槽位命中率下降意味着结构化抽取在退化，被丢弃条目增多意味着
       * 模型输出偏离契约 —— 两者都该被看见。
       */
      console.info(
        `[extraction] 会话 ${conversationId} 完成：` +
          `范围 ${summary.coveredRange?.from}-${summary.coveredRange?.to}，` +
          `新增 ${summary.outcomes.created}、合并 ${summary.outcomes.merged}、` +
          `替代 ${summary.outcomes.superseded}、冲突 ${summary.outcomes.conflict}，` +
          `槽位命中 ${summary.diagnostics.slotCoverage.withSlot}/${summary.diagnostics.slotCoverage.total}，` +
          `丢弃 ${summary.diagnostics.dropped.length}、降级 ${summary.diagnostics.degradations.length}，` +
          `向量 成功${summary.embeddings.succeeded}/失败${summary.embeddings.failed}`
      );
    },
  });

  return defaultTrigger;
}
