/**
 * RRF 融合与归一化重排（docs/03 §18.4）
 *
 * 【为什么本文件里没有一个数据库调用、没有一个 await】
 *   §18.4 的两阶段算法是纯函数：给定候选与分数，输出排序。
 *   把它与查询分开，才能用构造数据把每条分支都测到 ——
 *   否则「时效项对 fact 不衰减」「goal 非 active 得 0」这些规则
 *   只能靠连数据库造场景来验证，成本高到不会有人去测。
 *
 * 【两阶段的分工】
 *   阶段一 RRF：只依赖**排名**，不依赖分数分布 → 绕开量纲问题
 *   阶段二重排：把不同来源的量纲统一到 [0,1] 后加权 → 可解释、可调
 *
 *   为什么不能一步到位（直接用「语义×w1 + 重要性×w2 + ...」）：
 *   余弦相似度落在 [-1,1]、importance 落在 [0,1]，
 *   直接相加是评审 P0-4 点名的典型 RAG 反模式 —— 权重不可解释。
 */
import type { Memory } from '../database/schema/memories.js';
import {
  DECAY_HALF_LIFE_DAYS,
  NORM_VECTOR_MAX,
  NORM_VECTOR_MIN,
  RERANK_WEIGHTS,
  RRF_K,
  SOURCE_COUNT_SATURATION,
} from './retrieval-config.js';

// ============================================================
// 类型
// ============================================================

/** 进入融合的一个候选 */
export interface RetrievalCandidate {
  memory: Memory;
  /** 向量相似度 [-1,1]。未经过向量通道或没有向量时为 undefined */
  vectorScore?: number | undefined;
  /** 关键词相似度 [0,1]。未经关键词通道时为 undefined */
  keywordScore?: number | undefined;
}

/** 融合结果：候选 + 各项分数，供离线评测逐项分析 */
export interface ScoredCandidate {
  memory: Memory;
  /** RRF 融合分（未归一化，仅用于排序与比较） */
  rrfScore: number;
  /** 各通道排名（1 起）。未命中该通道则无此键 */
  ranks: { vector?: number; keyword?: number; slot?: number };
  /** 归一化后的各项，和 RERANK_WEIGHTS 一一对应 */
  normalized: {
    vector: number;
    importance: number;
    recency: number;
    sourceCount: number;
  };
  /** 最终得分（各项加权和） */
  finalScore: number;
}

// ============================================================
// 阶段一：RRF 融合
// ============================================================

/**
 * reciprocal rank fusion。
 *
 *   score = Σ 1 / (k + rank_i)
 *
 * 只用排名不用分数，因此向量通道与关键词通道的分数尺度差异
 * 不会影响融合结果（§18.4 选择 RRF 的全部理由）。
 *
 * @param channelRanks 每个通道的 memoryId 有序列表（排名从 0 起）
 */
export function fuseByRrf(
  channelRanks: { channel: 'vector' | 'keyword' | 'slot'; ids: string[] }[]
): Map<string, { rrfScore: number; ranks: ScoredCandidate['ranks'] }> {
  const fused = new Map<string, { rrfScore: number; ranks: ScoredCandidate['ranks'] }>();

  for (const { channel, ids } of channelRanks) {
    ids.forEach((id, index) => {
      const rank = index + 1; // RRF 的 rank 从 1 起
      const entry = fused.get(id) ?? { rrfScore: 0, ranks: {} };

      entry.rrfScore += 1 / (RRF_K + rank);
      entry.ranks[channel] = rank;

      fused.set(id, entry);
    });
  }

  return fused;
}

// ============================================================
// 阶段二：归一化重排
// ============================================================

/**
 * 对候选做重排。
 *
 * @param candidates 已按 RRF 分排序的候选（顺序不重要，函数内部只读分数）
 * @param fused      每个 memoryId 的 RRF 分与各通道排名
 * @param now        当前时间。**必须显式传入** —— 用 Date.now() 会让
 *                   「时效项」在测试里不可复现（同一份数据隔一天跑出不同结果）
 */
export function rerank(
  candidates: RetrievalCandidate[],
  fused: Map<string, { rrfScore: number; ranks: ScoredCandidate['ranks'] }>,
  now: Date
): ScoredCandidate[] {
  if (candidates.length === 0) return [];

  const scored: ScoredCandidate[] = candidates.map((c) => {
    const entry = fused.get(c.memory.id) ?? { rrfScore: 0, ranks: {} };

    /**
     * ⚠️ 归一化用**固定下界**（NORM_VECTOR_MIN）而不是候选集合内的 min-max。
     *    后者是常见的错误做法：它把「本批最好的那个」强行拉到 1.0，
     *    于是「三条都不相关」与「三条都相关」得到同样的相对分数。
     *    绝对基准才能让分数在不同查询之间可比 —— 这对离线评测是必需的。
     *    （具体映射写在 normalizeVector 里。）
     */
    const vector = normalizeVector(c.vectorScore);
    const importance = clamp01(c.memory.importanceScore);
    const recency = typeAwareRecency(c.memory, now);
    const sourceCount =
      Math.min(c.memory.sourceCount, SOURCE_COUNT_SATURATION) / SOURCE_COUNT_SATURATION;

    const finalScore =
      RERANK_WEIGHTS.vector * vector +
      RERANK_WEIGHTS.importance * importance +
      RERANK_WEIGHTS.recency * recency +
      RERANK_WEIGHTS.sourceCount * sourceCount;

    return {
      memory: c.memory,
      rrfScore: entry.rrfScore,
      ranks: entry.ranks,
      normalized: { vector, importance, recency, sourceCount },
      finalScore,
    };
  });

  /**
   * 排序键的顺序很重要：finalScore 相同时用 RRF 分兜底。
   *
   * 不加次级键会让同分候选的顺序取决于输入顺序，
   * 表现为「同一份数据两次检索给出不同结果」——
   * 在离线评测里这会变成无法解释的指标抖动。
   */
  scored.sort((a, b) => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
    // 最后用 created_at 保证全序（新记忆优先），彻底消除不确定性
    return b.memory.createdAt.getTime() - a.memory.createdAt.getTime();
  });

  return scored;
}

// ============================================================
// 各项分数
// ============================================================

/**
 * 向量相似度 → [0, 1]。
 *
 * 低于 NORM_VECTOR_MIN 视为不相关（0 分）：
 * 真实短文本的无关相似度常在 0.3~0.6，若按 [-1,1] 线性映射，
 * 一个 0.5 的无关结果会拿到 0.75，把权重最大的那一项变成噪音。
 *
 * 缺少向量分（embedding 生成失败、或只被关键词通道召回）同样得 0 ——
 * 这类记忆靠关键词通道与重要性仍然可以排上来，不会被一票否决。
 */
export function normalizeVector(score: number | undefined): number {
  if (score === undefined) return 0;
  if (score <= NORM_VECTOR_MIN) return 0;
  if (score >= NORM_VECTOR_MAX) return 1;
  return (score - NORM_VECTOR_MIN) / (NORM_VECTOR_MAX - NORM_VECTOR_MIN);
}

/**
 * 按类型区分的时效项（§18.4）。
 *
 *   fact         → 1.0                   不衰减
 *   preference   → 0.5 + 0.5 × decay(t)  缓慢衰减，下限 0.5
 *   goal         → 1.0（active）/ 0      非 active 不参与（本来也召回不到）
 *   event        → 1.0                   不降权，靠时间排序
 *   state        → decay(t, 半衰期 14 天) 快速衰减
 *   relationship → 1.0                   不衰减
 *
 * 【最重要的一条】fact 不衰减。
 *   两年前的「用户是软件工程师」依然有效，不该因为「旧」被系统性降权 ——
 *   这与长期记忆的产品定位直接冲突（§18.4 特意用「重要」标出这一点）。
 */
export function typeAwareRecency(memory: Memory, now: Date): number {
  const reference = referenceTime(memory);
  const days = Math.max(0, (now.getTime() - reference.getTime()) / 86_400_000);

  switch (memory.type) {
    case 'fact':
    case 'event':
    case 'relationship':
      return 1.0;

    case 'goal':
      // goal 记忆是 goals 表的投影，active 才有意义
      return memory.status === 'active' ? 1.0 : 0;

    case 'preference':
      // 下限 0.5：偏好变化慢，再久也不该掉到「无关」那一档
      return 0.5 + 0.5 * decay(days, DECAY_HALF_LIFE_DAYS.preference);

    case 'state': {
      /**
       * 阶段性状态的半衰期固定 14 天（§18.4 明确给定，不要改）。
       * 「用户最近因被追问进度而烦躁」两周后本就该淡化 ——
       * 这是产品意图，不是可以调优的参数。
       */
      return decay(days, 14);
    }

    default:
      // 新增类型时的保守缺省：不衰减优于错误衰减
      return 1.0;
  }
}

/** 指数衰减：0.5 ^ (days / halfLifeDays) */
export function decay(days: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 0;
  return Math.pow(0.5, days / halfLifeDays);
}

/**
 * 时效计算的参照时间。
 *
 * 【为什么事件用 valid_from 而不是 created_at】
 *   用户今天补记「去年三月换了工作」时，这件事的时效性由
 *   **事件发生时间**决定，而不是「用户什么时候告诉我们的」。
 *   用 created_at 会让一年前的事看起来像新事，把 state/event 的
 *   时效排序整体搞反。
 *
 * created_at 作为兜底：valid_from 为空表示「自记录起有效」。
 */
function referenceTime(memory: Memory): Date {
  return memory.validFrom ?? memory.createdAt;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
