/**
 * 记忆抽取流水线编排
 *
 * 把整条链路串起来：
 *   幂等认领 → 读消息 → LLM 抽取 → 解析契约 → 逐条判定落库 → 生成并写入向量
 *
 * 【事务边界（关键，§25.2）】
 *   向量生成是外部调用（GPU 推理），**不能放在数据库事务内**：
 *     在事务里做会把连接一直持有到推理结束，且失败时会把记忆本体一起回滚 ——
 *     而记忆本体是该保留的。
 *
 *   因此顺序是：
 *     ① 事务 A：判定 + 记忆落库（含来源指针）
 *     ② 事务外：逐条生成向量
 *     ③ 事务 B：写入向量
 *
 *   ②失败时的降级：记忆保留，向量缺失或标记 failed。
 *   该记忆仍可被关键词通道（pg_trgm）召回 —— 功能降级但不丢失。
 *
 * 【幂等（C19/C21）】
 *   以 (conversation_id, start_sequence, extractor_version) 为幂等键。
 *   进度只按 succeeded 的 MAX(end_sequence) 推进，
 *   因此失败区间会被下次触发自然覆盖，无需特殊重试逻辑。
 */
import { createHash } from 'node:crypto';

import { db } from '../database/client.js';
import { upsertMemoryEmbedding, setEmbeddingStatus } from '../database/repository/memory-store.js';
import type { ExecutorOption, StoreExecutor } from '../database/repository/types.js';
import {
  claimExtractionRun,
  completeExtractionRun,
  failExtractionRun,
  nextStartSequence,
} from '../database/repository/extraction-runs.js';
import {
  findMessagesInRange,
  maxMessageSequence,
} from '../database/repository/conversation-queries.js';
import {
  embed,
  buildEmbeddedText,
  embeddingModelId,
  embeddingDimensions,
  toVectorLiteral,
} from '../llm/embedding.js';
import type { LLMProvider } from '../llm/provider.js';
import { buildExtractionMessages } from './extraction-prompt.js';
import { LlmSlotAdjudicator } from './slot-adjudicator.js';
import {
  normalizeCandidate,
  parseExtractionResultWithDiagnostics,
  type ExtractionDiagnostics,
} from './extraction-schema.js';
import {
  processCandidate,
  type CandidateOutcome,
  type SlotAdjudicator,
} from './candidate-processor.js';

/**
 * 抽取器版本。
 *
 * ⚠️ 提示词或模型变更时**必须改这个值** —— 它是幂等键的一部分。
 *    不改的话，历史对话会因「已成功抽取」而不会被新版本重新处理；
 *    改了则可以对新范围重跑，且不会与旧版本的记录冲突。
 */
export const EXTRACTOR_VERSION = 'v1';

export interface RunExtractionParams {
  conversationId: string;
  /** 覆盖默认抽取器版本（提示词/模型变更时使用） */
  extractorVersion?: string;
  /** 单次抽取最多覆盖多少条消息。防止一次拉入过长对话 */
  maxMessages?: number;
  /** 覆盖 LLM Provider（测试注入用） */
  provider?: LLMProvider;
  /** 覆盖判定器（测试注入用） */
  adjudicator?: SlotAdjudicator;
  /** 是否生成向量。默认 true；测试中可关掉以避免依赖 embedding 服务 */
  generateEmbeddings?: boolean;
  /**
   * 思考模式覆盖。缺省保留思考（推理模型默认开启）。
   *
   * 用途：实测思考对抽取质量的影响 —— 同一段对话跑两遍对比。
   * 简单/格式类任务关掉可省 3~4 倍延迟，但抽取是语义判断，通常该开。
   */
  thinking?: { type: 'enabled' | 'disabled' };
  /**
   * 执行器。传入外层事务以把整次抽取纳入同一原子操作，
   * 或供测试整体回滚。
   *
   * ⚠️ 传了它并不改变「向量生成必须在事务外」的约束 ——
   *    那只约束**数据库事务**的持有时间；此处传的是外层事务句柄，
   *    向量的 HTTP 调用仍然发生在数据库写入与写入之间，
   *    不会延长任何单个事务。生产环境应传 undefined。
   */
  executor?: StoreExecutor;
}

/** 单次抽取的结果摘要 */
export interface ExtractionSummary {
  /** 本次是否真的执行了（false 表示被幂等键拦截） */
  executed: boolean;
  /** 未执行的原因 */
  skippedReason?: 'already_succeeded' | 'in_progress' | 'duplicate' | 'no_new_messages';
  runId?: string;
  coveredRange?: { from: number; to: number };
  /** 模型声称抽出的条数（未经校验） */
  candidatesFound: number;
  /**
   * 抽取诊断：哪些条目被丢弃、哪些字段被降级、槽位命中率。
   *
   * ⚠️ 这不是调试信息，而是质量指标：
   *    槽位命中率下降意味着结构化抽取在退化（提示词或词表需调整），
   *    被丢弃条目增多意味着模型输出偏离契约。两者都该被监控。
   */
  diagnostics: ExtractionDiagnostics;
  outcomes: {
    created: number;
    merged: number;
    superseded: number;
    conflict: number;
  };
  /** 判定阶段额外调用了几次 LLM（每次取值变化一次） */
  adjudicationCalls: number;
  /** 向量生成成功/失败的条数 */
  embeddings: { succeeded: number; failed: number };
  /** 未生成向量的记忆（供后续补齐） */
  memoriesWithoutEmbedding: string[];
}

/**
 * 执行一次抽取。
 *
 * 幂等：同一 (conversation, startSequence, version) 重复调用只会执行一次。
 */
export async function runExtraction(
  params: RunExtractionParams
): Promise<ExtractionSummary> {
  const extractorVersion = params.extractorVersion ?? EXTRACTOR_VERSION;
  const maxMessages = params.maxMessages ?? 50;

  /**
   * 执行器选项。传了就用外层事务，没传则各仓库方法各自开事务。
   *
   * ⚠️ 这**不放松**「向量生成必须在事务外」的约束（§25.2）：
   *    那条约束针对的是单个数据库事务的持有时间。
   *    调用方传入的外层事务句柄下，各写操作会生成 SAVEPOINT，
   *    而向量的 HTTP 调用仍发生在两次写之间，不延长任何事务。
   *    生产环境应保持 undefined。
   */
  const ex: ExecutorOption = params.executor ? { executor: params.executor } : {};

  // ---------- ① 计算本次应覆盖的范围（C21：只统计 succeeded）----------
  const startSequence = await nextStartSequence(params.conversationId, ex);
  const latest = await maxMessageSequence(params.conversationId, ex);

  if (latest < startSequence) {
    // 没有新消息可抽 —— 不是错误，正常返回
    return emptySummary(false, 'no_new_messages');
  }

  const endSequence = Math.min(latest, startSequence + maxMessages - 1);

  // ---------- ② 幂等认领 ----------
  const claim = await claimExtractionRun(
    {
      conversationId: params.conversationId,
      startSequence,
      endSequence,
      extractorVersion,
    },
    ex
  );

  if (!claim.claimed) {
    return emptySummary(false, claim.reason);
  }

  const runId = claim.run.id;

  try {
    // ---------- ③ 读消息 ----------
    const msgs = await findMessagesInRange(
      {
        conversationId: params.conversationId,
        from: startSequence,
        to: endSequence,
      },
      ex
    );

    if (msgs.length === 0) {
      // 范围算出来了但没有消息：可能是消息被删除。
      // 标记失败，让下次触发重新覆盖这个区间（而不是带着空洞继续推进）
      await failExtractionRun(runId, `范围 [${startSequence}, ${endSequence}] 内没有消息`);
      return emptySummary(false, 'no_new_messages');
    }

    // ---------- ④ LLM 抽取 ----------
    const provider = params.provider ?? (await defaultProvider());

    /**
     * 判定器缺省用 LLM 实现。
     *
     * ⚠️ 此前必须显式传入，缺省是「一律按 conflict 处理」——
     *    那会让每次取值变化都变成待裁决冲突，用户被大量无谓的裁决请求淹没。
     *    保守降级是对的**兜底**，但不该是**常态**。
     *
     * 保留注入点：测试可传固定判定器，确定性地覆盖三个分支。
     */
    const baseAdjudicator =
      params.adjudicator ?? new LlmSlotAdjudicator(provider, params.thinking);

    // 统计判定调用了几次 LLM —— 抽取本身的开销在 res.usage 里，
    // 判定是额外的 N 次调用。不分开记账会让「一次抽取花了多少」无法解释。
    let adjudicationCalls = 0;
    const adjudicator: SlotAdjudicator = {
      adjudicate: async (input) => {
        adjudicationCalls++;
        return baseAdjudicator.adjudicate(input);
      },
    };

    const res = await provider.generate({
      messages: buildExtractionMessages(
        msgs.map((m) => ({ role: m.role, content: m.content }))
      ),
      // 抽取要输出结构化 JSON（10~20 条记忆），需要足够的回答空间。
      // 且推理模型思考与回答共享预算，必须留余量（见 env.ts 的说明）。
      maxOutputTokens: 4096,
      // 抽取是语义判断任务，缺省保留思考模式。
      // 传 params.thinking 可覆盖 —— 用于实测思考对抽取质量的影响。
      ...(params.thinking !== undefined ? { thinking: params.thinking } : {}),
    });

    // 用带诊断的解析：丢弃与降级的事实必须被记录，
    // 否则槽位命中率下降这类质量退化会静默发生（见 extraction-schema 的分级策略）
    const parsed = parseExtractionResultWithDiagnostics(res.content);
    const extraction = parsed.result;
    const candidates = extraction.memories.map(normalizeCandidate);

    // ---------- ⑤ 逐条判定并落库（事务 A：每条一个事务）----------
    const messageIds = msgs.map((m) => m.id);
    const userId = await userIdOfConversation(params.conversationId, ex);
    const outcomes: CandidateOutcome[] = [];

    for (const candidate of candidates) {
      const outcome = await processCandidate({
        userId,
        candidate,
        // 来源由编排层提供 —— 抽取覆盖了哪些消息，只有这里知道
        source: { messageIds },
        adjudicator,
        ...ex,
      });
      outcomes.push(outcome);
    }

    // ---------- ⑥ 生成并写入向量（事务外 → 事务 B）----------
    const shouldEmbed = params.generateEmbeddings ?? true;
    const embedStats = shouldEmbed
      ? await embedOutcomes(outcomes, ex)
      : { succeeded: 0, failed: 0, pending: [] as string[] };

    // ---------- ⑦ 记录本次抽取的产出 ----------
    const summary: ExtractionSummary = {
      executed: true,
      runId,
      coveredRange: { from: startSequence, to: endSequence },
      candidatesFound: parsed.diagnostics.rawCount,
      diagnostics: parsed.diagnostics,
      outcomes: {
        created: outcomes.filter((o) => o.kind === 'created').length,
        merged: outcomes.filter((o) => o.kind === 'merged').length,
        superseded: outcomes.filter((o) => o.kind === 'superseded').length,
        conflict: outcomes.filter((o) => o.kind === 'conflict').length,
      },
      adjudicationCalls,
      embeddings: { succeeded: embedStats.succeeded, failed: embedStats.failed },
      memoriesWithoutEmbedding: embedStats.pending,
    };

    await completeExtractionRun(runId, {
      memoriesCreated: summary.outcomes.created,
      // 「更新」对应去重合并
      memoriesUpdated: summary.outcomes.merged,
      memoriesSuperseded: summary.outcomes.superseded,
      conflictsFound: summary.outcomes.conflict,
    }, ex);

    return summary;
  } catch (err) {
    // 抽取失败不能影响主链路（接口 §45），但要留下可查的记录
    const message = err instanceof Error ? err.message : String(err);
    await failExtractionRun(runId, message.slice(0, 2000), ex);
    throw err;
  }
}

// ============================================================
// 内部
// ============================================================

function emptySummary(
  executed: boolean,
  skippedReason: ExtractionSummary['skippedReason']
): ExtractionSummary {
  return {
    executed,
    ...(skippedReason !== undefined ? { skippedReason } : {}),
    candidatesFound: 0,
    diagnostics: {
      rawCount: 0,
      validCount: 0,
      dropped: [],
      degradations: [],
      slotCoverage: { withSlot: 0, total: 0 },
    },
    outcomes: { created: 0, merged: 0, superseded: 0, conflict: 0 },
    adjudicationCalls: 0,
    embeddings: { succeeded: 0, failed: 0 },
    memoriesWithoutEmbedding: [],
  };
}

/** 延迟导入以避免在不需要 LLM 的路径上加载 env 校验 */
async function defaultProvider(): Promise<LLMProvider> {
  const mod = await import('../llm/index.js');
  return mod.getLLMProvider();
}

/** 取会话所属用户。V1.0 单用户，但仍按数据查而不是写死 */
async function userIdOfConversation(conversationId: string, options: ExecutorOption): Promise<string> {
  const { conversations } = await import('../database/schema/conversations.js');
  const { eq } = await import('drizzle-orm');

  const exec = options.executor ?? db;
  const rows = await exec
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  const userId = rows[0]?.userId;
  if (!userId) throw new Error(`会话不存在：${conversationId}`);
  return userId;
}

/**
 * 为判定产出的记忆生成并写入向量。
 *
 * ⚠️ 每条记忆的向量生成与写入都在**独立事务**中，且在所有记忆落库之后 ——
 *    这是 §25.2 的要求：外部调用不占数据库连接，失败也不影响记忆本体。
 *
 * 逐条而非批量：审计 F-12 记录了「TEI 批量返回顺序未经验证」的风险。
 * 一次抽取通常只有 1~5 条，逐条的吞吐损失可忽略。
 */
async function embedOutcomes(outcomes: CandidateOutcome[], options: ExecutorOption): Promise<{
  succeeded: number;
  failed: number;
  pending: string[];
}> {
  let succeeded = 0;
  let failed = 0;
  const pending: string[] = [];

  for (const outcome of outcomes) {
    const memory = outcome.memory;

    // 只给「当前有效」的记忆生成向量：
    // conflict 不参与召回（§13.6），superseded 已失效，为它们生成向量是浪费
    if (memory.status !== 'active') continue;

    const embeddedText = buildEmbeddedText({
      type: memory.type,
      subject: memory.subjectKey ?? 'user',
      content: memory.content,
      timeHint: memory.validFrom
        ? `${memory.validFrom.toISOString().slice(0, 10)} 起有效`
        : null,
    });

    try {
      const vec = await embed(embeddedText);
      await upsertMemoryEmbedding(
        {
          memoryId: memory.id,
          model: embeddingModelId,
          dim: embeddingDimensions,
          embeddedText,
          contentHash: sha256Hex(embeddedText),
          embeddingLiteral: toVectorLiteral(vec),
        },
        options
      );
      succeeded++;
    } catch {
      // 向量失败不抛错：记忆本体已保存，靠关键词通道降级可召回。
      // 标记 failed 以便后续补齐（降级但可观测）
      await setEmbeddingStatus(memory.id, 'failed', options).catch(() => undefined);
      failed++;
      pending.push(memory.id);
    }
  }

  return { succeeded, failed, pending };
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
