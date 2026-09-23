/**
 * 记忆召回服务（docs/03 §18.2、§18.5）
 *
 *   search(query, options) → Memory[]       纯检索，可离线评测
 *   （注入在 ContextBuilder，见 §18.5 的「检索与注入分离」）
 *
 * 【流程】严格按 §18.2：
 *   Query → Embedding(bge-m3) → 向量通道 Top-50
 *         → 关键词通道 Top-50 → RRF 融合 → Top-30 → 归一化重排 → Top-N
 *
 * 【降级策略 —— 这是本模块最需要想清楚的地方】
 *   三条外部依赖都可能挂：embedding 服务、数据库、LLM。
 *   原则是「**召回能力逐级下降，但绝不整体失败**」：
 *     ① embedding 服务不可用 → 跳过向量通道，只用关键词 + 结构化
 *        中文关键词通道能召回字面重合的记忆；语义相近但用词不同的会漏。
 *        这是真实的能力下降，因此必须**显式记录降级原因**而不是静默返回少几条。
 *     ② 某条记忆没有向量 → 它仍可被关键词通道召回，向量项得 0
 *     ③ 查询为空/无意义 → 返回空，不报错
 *
 *   为什么不「embedding 挂了就返回空」：那会让 Agent 在 embedding 服务
 *   重启的几十秒里完全失忆，而它本可以靠关键词召回到一部分。
 */
import { embed, embeddingModelId, toVectorLiteral } from '../llm/embedding.js';
import {
  scoreVectorForMemories,
  searchByKeyword,
  searchBySlot,
  searchByVector,
  type KeywordCandidate,
  type VectorCandidate,
} from '../database/repository/retrieval-queries.js';
import type { Memory } from '../database/schema/memories.js';
import {
  CHANNEL_LIMIT,
  FUSION_LIMIT,
  INJECT_LIMIT,
} from './retrieval-config.js';
import {
  fuseByRrf,
  rerank,
  type RetrievalCandidate,
  type ScoredCandidate,
} from './retrieval-fusion.js';

export interface RetrieveParams {
  userId: string;
  /** 用户当前的消息或检索词 */
  query: string;
  /** 最终返回条数。缺省 INJECT_LIMIT（8） */
  limit?: number;
  /**
   * 结构化通道的槽位提示。
   *
   * 目前由调用方显式传入（尚无 Query Analysis 模块解析自然语言里的槽位）。
   * 留成参数而不是留 TODO：一旦解析器做出来，接上来不用改检索逻辑。
   */
  predicateKeys?: string[];
  subjectKey?: string;
}

/** 逐通道的可观测信息。**不含任何记忆正文**（docs/03 §29.1） */
export interface RetrievalDiagnostics {
  /** 各通道原始命中数 */
  channelHits: { vector: number; keyword: number; slot: number };
  /** 融合后的候选数 */
  fusedCount: number;
  /** 最终返回条数 */
  returned: number;
  /** 生效的降级。空数组表示一切正常 */
  degradations: RetrievalDegradation[];
  /** 各阶段耗时（ms），用于定位性能问题 */
  timings: { embedding: number; channels: number; rerank: number; total: number };
}

export type RetrievalDegradation =
  /** embedding 服务不可用，向量通道被跳过 */
  | 'embedding_unavailable'
  /** 查询为空，未做任何检索 */
  | 'empty_query'
  /** 数据库查询失败 */
  | 'database_error';

export interface RetrievalResult {
  /** 重排后的记忆，已按最终得分降序 */
  memories: Memory[];
  /**
   * 带完整分数的候选，供离线评测分析「为什么这条排在这里」。
   *
   * 与 memories 的关系：candidates 是融合后进入重排的全部（≤ Top-30），
   * memories 是其前 limit 条。评测 Memory Recall 时需要看**未入选**的那些，
   * 因此不能只返回 memories。
   */
  candidates: ScoredCandidate[];
  diagnostics: RetrievalDiagnostics;
}

/**
 * 检索与当前查询相关的记忆。
 *
 * 本函数**不抛错**：任何依赖失败都降级并在 diagnostics.degradations 里体现。
 * 理由见文件头「降级策略」——聊天不能因为检索出问题而失败（接口 §45 的同类原则）。
 */
export async function retrieveMemories(
  params: RetrieveParams
): Promise<RetrievalResult> {
  const startedAt = Date.now();
  const limit = params.limit ?? INJECT_LIMIT;

  const diagnostics: RetrievalDiagnostics = {
    channelHits: { vector: 0, keyword: 0, slot: 0 },
    fusedCount: 0,
    returned: 0,
    degradations: [],
    timings: { embedding: 0, channels: 0, rerank: 0, total: 0 },
  };

  const query = params.query.trim();
  if (query.length === 0) {
    diagnostics.degradations.push('empty_query');
    diagnostics.timings.total = Date.now() - startedAt;
    return { memories: [], candidates: [], diagnostics };
  }

  // ---------- ① 查询向量 ----------
  let queryVector: string | null = null;
  const embedStart = Date.now();
  try {
    const vec = await embed(query);
    queryVector = toVectorLiteral(vec);
  } catch (err) {
    /**
     * 降级而不是失败。记录原因，让「为什么这次没想起我」可排查 ——
     * 静默返回少量结果会让这类问题永远查不出来。
     */
    console.warn(
      `[retrieval] embedding 不可用，跳过向量通道：${describeError(err)}`
    );
    diagnostics.degradations.push('embedding_unavailable');
  }
  diagnostics.timings.embedding = Date.now() - embedStart;

  // ---------- ② 三通道取候选 ----------
  const channelStart = Date.now();
  const vectorHits: VectorCandidate[] = [];
  let keywordHits: KeywordCandidate[] = [];
  let slotHits: Memory[] = [];

  try {
    const tasks: Promise<unknown>[] = [
      searchByKeyword({ userId: params.userId, query, limit: CHANNEL_LIMIT }).then((r) => {
        keywordHits = r;
      }),
    ];

    if (queryVector) {
      tasks.push(
        searchByVector({
          userId: params.userId,
          embeddingLiteral: queryVector,
          model: embeddingModelId,
          limit: CHANNEL_LIMIT,
        }).then((r) => {
          vectorHits.push(...r);
        })
      );
    }

    if (params.predicateKeys && params.predicateKeys.length > 0) {
      tasks.push(
        searchBySlot({
          userId: params.userId,
          predicateKeys: params.predicateKeys,
          ...(params.subjectKey !== undefined ? { subjectKey: params.subjectKey } : {}),
          limit: CHANNEL_LIMIT,
        }).then((r) => {
          slotHits = r;
        })
      );
    }

    await Promise.all(tasks);
  } catch (err) {
    // 数据库失败：本次检索无结果，但聊天继续（调用方会降级为无记忆上下文）
    console.error(`[retrieval] 通道查询失败：${describeError(err)}`);
    diagnostics.degradations.push('database_error');
    diagnostics.timings.channels = Date.now() - channelStart;
    diagnostics.timings.total = Date.now() - startedAt;
    return { memories: [], candidates: [], diagnostics };
  }

  diagnostics.channelHits = {
    vector: vectorHits.length,
    keyword: keywordHits.length,
    slot: slotHits.length,
  };
  diagnostics.timings.channels = Date.now() - channelStart;

  // ---------- ③ RRF 融合 ----------
  const rerankStart = Date.now();

  const fused = fuseByRrf([
    { channel: 'vector', ids: vectorHits.map((h) => h.memory.id) },
    { channel: 'keyword', ids: keywordHits.map((h) => h.memory.id) },
    { channel: 'slot', ids: slotHits.map((m) => m.id) },
  ]);

  diagnostics.fusedCount = fused.size;

  if (fused.size === 0) {
    diagnostics.timings.rerank = Date.now() - rerankStart;
    diagnostics.timings.total = Date.now() - startedAt;
    return { memories: [], candidates: [], diagnostics };
  }

  // 按 RRF 分取 Top-30 进入重排
  const topIds = [...fused.entries()]
    .sort((a, b) => b[1].rrfScore - a[1].rrfScore)
    .slice(0, FUSION_LIMIT)
    .map(([id]) => id);

  // ---------- ④ 组装候选（含向量分回填）----------
  const byId = new Map<string, Memory>();
  for (const h of vectorHits) byId.set(h.memory.id, h.memory);
  for (const h of keywordHits) byId.set(h.memory.id, h.memory);
  for (const m of slotHits) byId.set(m.id, m);

  const vectorScores = new Map(vectorHits.map((h) => [h.memory.id, h.similarity]));
  const keywordScores = new Map(keywordHits.map((h) => [h.memory.id, h.similarity]));

  /**
   * 回填：只被关键词/结构化通道召回的候选没有向量分。
   *
   * 不回填的话，它们的向量项恒为 0（占总权重 0.55），
   * 会系统性输给被向量通道召回的候选 —— 那是排序偏差，不是相关性判断。
   */
  const missing = topIds.filter((id) => !vectorScores.has(id));
  if (queryVector && missing.length > 0) {
    try {
      const filled = await scoreVectorForMemories({
        userId: params.userId,
        memoryIds: missing,
        embeddingLiteral: queryVector,
        model: embeddingModelId,
      });
      for (const [id, score] of filled) vectorScores.set(id, score);
    } catch (err) {
      // 回填失败只是让这些候选的向量项为 0，不影响其余候选
      console.warn(`[retrieval] 向量分回填失败：${describeError(err)}`);
    }
  }

  const candidates: RetrievalCandidate[] = topIds
    .map((id) => byId.get(id))
    .filter((m): m is Memory => m !== undefined)
    .map((memory) => ({
      memory,
      vectorScore: vectorScores.get(memory.id),
      keywordScore: keywordScores.get(memory.id),
    }));

  // ---------- ⑤ 归一化重排 ----------
  const scored = rerank(candidates, fused, new Date());

  diagnostics.timings.rerank = Date.now() - rerankStart;
  diagnostics.returned = Math.min(limit, scored.length);
  diagnostics.timings.total = Date.now() - startedAt;

  return {
    memories: scored.slice(0, limit).map((s) => s.memory),
    candidates: scored,
    diagnostics,
  };
}

// ============================================================
// 内部
// ============================================================

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return '未知错误';
}
