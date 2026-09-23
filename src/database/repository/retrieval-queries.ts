/**
 * 记忆召回通道（docs/03 §18.2）
 *
 * 三个通道各自独立取 Top-N，由上层（memory/retriever.ts）用 RRF 融合：
 *   ① 向量通道   —— pgvector 精确检索（按 §18.3 的过滤条件）
 *   ② 关键词通道 —— pg_trgm，中文场景不能用 tsvector（C16）
 *   ③ 结构化通道 —— 已知 subject_key 时的精确槽位查询
 *
 * 【本文件的两条纪律】
 *
 * ① 所有通道**必须**包含 currentMemoryCondition() 的过滤条件（§18.3 C14）
 *    这不是风格要求而是隐私要求：漏掉任一条件，
 *    用户已删除 / 已替代 / 待裁决的记忆就可能重新出现在回答里。
 *    因此这里一律引用 conditions.ts 的谓词，绝不手写 status / deleted_at 条件。
 *
 * ② V1.0 不建向量索引（§18.1 C6），走精确检索
 *    召回率 100%，代价是全表扫描。数据量 < 5 万条时几十毫秒。
 *    因此**不要**在这里加 ORDER BY ... LIMIT 之外的优化暗示，
 *    引入 HNSW 的条件写在 §18.6。
 */
import { and, desc, eq, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';

import { db } from '../client.js';
import { memories, type Memory } from '../schema/memories.js';
import { memoryEmbeddings } from '../schema/memory-embeddings.js';
import { currentMemoryCondition } from './conditions.js';
import type { ExecutorOption } from './types.js';
import { buildBigrams, idf, idfWeightedScore, MIN_IDF_SCORE } from '../../memory/chinese-ngram.js';

/** 单通道候选数。§18.2 规定各通道取 Top-50 再融合 */
export const DEFAULT_CHANNEL_LIMIT = 50;

/**
 * 向量通道的候选。
 *
 * 用 `1 - (embedding <=> $1)` 得到余弦相似度：pgvector 的 `<=>` 返回余弦距离，
 * 取值范围 [0, 2]（1 - 相似度），因此相似度落在 [-1, 1]。
 */
export interface VectorCandidate {
  memory: Memory;
  /** 余弦相似度，[-1, 1]。越大越相似 */
  similarity: number;
}

/**
 * 向量通道：按余弦相似度取 Top-N。
 *
 * @param embeddingLiteral 查询向量，形如 `[0.1,0.2,...]`（见 toVectorLiteral）
 */
export async function searchByVector(
  params: {
    userId: string;
    embeddingLiteral: string;
    model: string;
    limit?: number;
    /** 附加过滤（结构化通道的条件） */
    extra?: SQL | undefined;
  },
  options: ExecutorOption = {}
): Promise<VectorCandidate[]> {
  const exec = options.executor ?? db;
  const limit = params.limit ?? DEFAULT_CHANNEL_LIMIT;

  const rows = await exec
    .select({
      memory: memories,
      similarity: sql<number>`(1 - (${memoryEmbeddings.embedding} <=> ${params.embeddingLiteral}::vector))::float8`,
    })
    .from(memories)
    .innerJoin(memoryEmbeddings, eq(memoryEmbeddings.memoryId, memories.id))
    .where(
      and(
        eq(memories.userId, params.userId),
        currentMemoryCondition(),
        /**
         * 只认 ready 的向量：
         *   failed  = 生成失败，向量不可信（记忆本体仍可由关键词通道召回）
         *   stale   = 内容已变，向量过期
         *   deleted = 记忆已删（虽然会被上面的谓词挡掉，这里再明确一次）
         */
        eq(memoryEmbeddings.status, 'ready'),
        /**
         * ⚠️ model 必须显式过滤（§14.5 C27）。
         *    同一记忆可能在不同模型下各有一行向量；
         *    不过滤会让换模型期间两个向量空间的距离被混在一起比较 ——
         *    数值上不报错，结果完全无意义。
         */
        eq(memoryEmbeddings.model, params.model),
        ...(params.extra ? [params.extra] : [])
      )
    )
    // 精确检索：直接按距离升序排（= 相似度降序），无索引可用也不需要
    .orderBy(sql`${memoryEmbeddings.embedding} <=> ${params.embeddingLiteral}::vector`)
    .limit(limit);

  return rows.map((r) => ({ memory: r.memory, similarity: Number(r.similarity) }));
}

/** 关键词通道的候选 */
export interface KeywordCandidate {
  memory: Memory;
  /** pg_trgm 相似度，[0, 1]。越大越相似 */
  similarity: number;
}

/**
 * 关键词通道：应用层字符 bigram + IDF 加权（**不是 pg_trgm**）
 *
 * 🔴 【为什么不用 pg_trgm —— 实测确认它不支持中文】
 *   docs/03 §17.4 的 C16 决定用 pg_trgm，理由写的是「按字符三元组匹配，
 *   无需分词器，适合中文」。**实测（PostgreSQL 18 + pg_trgm 1.6）**：
 *
 *     SELECT show_trgm('用户住在杭州');   -- → {}    空集
 *     SELECT show_trgm('hello world');    -- → {"  h"," he",...}
 *
 *   解析器只把字母与数字当词，CJK 全被忽略 → similarity() 恒为 0 →
 *   关键词通道对中文完全失效。替代方案（tsvector / pg_bigm / pgroonga）
 *   也都不可用，详见 memory/chinese-ngram.ts 的文件头。
 *
 * 🔴 【为什么用 IDF 加权而不是纯命中率 —— 实测数据】
 *   纯命中率（命中数/查询 bigram 总数）在中文上不可用：
 *     查询「我现在住在哪个城市？」→ 8 个 bigram，
 *       我现 现在 在住 住在 在哪 哪个 个城 城市
 *     记忆「用户居住在杭州」只命中「住在」→ 1/8 = 0.13。
 *   但「住在」恰恰是内容词，分母里七个虚词本就不该命中。
 *   实测 16 个查询只有 2 个能过 0.3 阈值 —— 通道基本没在工作。
 *
 *   改为 IDF 加权后：
 *     · 「什么」「我有」这类几乎人人皆有的 bigram 权重趋近 0
 *     · 「城市」「雅思」这类少见的 bigram 权重高，单命中即可入选
 *
 * 【成本】每条查询多一次 df 统计（一次全表聚合）。
 *   与 §18.1 不建向量索引同理：数据量 < 5 万条短文本，可接受。
 *   bigram 数量受 MAX_BIGRAMS 限制，因此是「一次聚合 + 一个带 N 个 CASE 的扫描」。
 */
export async function searchByKeyword(
  params: {
    userId: string;
    query: string;
    limit?: number;
    /** IDF 分数下限。缺省 MIN_IDF_SCORE */
    minScore?: number;
    extra?: SQL | undefined;
  },
  options: ExecutorOption = {}
): Promise<KeywordCandidate[]> {
  const exec = options.executor ?? db;
  const limit = params.limit ?? DEFAULT_CHANNEL_LIMIT;

  const bigrams = buildBigrams(params.query);
  if (bigrams.length === 0) return [];

  const minScore = params.minScore ?? MIN_IDF_SCORE;

  /**
   * 文档频率统计。
   *
   * 与候选查询分开两次查询而不是一次 CTE：
   * df 是**全语料**统计（不含候选过滤），候选是带条件的扫描。
   * 合成一条会让 SQL 难读，且优化器未必更优。
   */
  const { docCount, docFreq } = await computeDocFreq(params.userId, bigrams, options);

  /**
   * ⚠️ 语料很小时的退化处理。
   *
   * idf 是相对值：只有 1 条记忆时，「钢琴」的 idf 也只有 0.1，
   * 达不到 MIN_IDF_SCORE=1.0 —— 于是关键词通道在极小语料上完全不出结果。
   * 那不是「没有字面命中」，而是「统计量算不出来」，两者不该混为一谈。
   *
   * 因此：语料少于 10 条时改用「是否命中」做判据（分数用命中数），
   * 统计意义要等语料够大才成立。
   */
  const useRawCount = docCount < 10;

  const maxPossible = bigrams.reduce((s, g) => s + idf(docCount, docFreq.get(g) ?? 0), 0);
  if (!useRawCount && maxPossible < minScore) return [];

  const hitExpr = sql.join(
    bigrams.map((g) => sql`(CASE WHEN ${memories.content} LIKE ${'%' + g + '%'} THEN 1 ELSE 0 END)`),
    sql` + `
  );

  // 候选筛选：至少命中一个 bigram，避免全表返回
  const rows = await exec
    .select({ memory: memories })
    .from(memories)
    .where(
      and(
        eq(memories.userId, params.userId),
        currentMemoryCondition(),
        sql`(${hitExpr}) > 0`,
        ...(params.extra ? [params.extra] : [])
      )
    )
    // 命中数只用于**粗排**（真正排序在 Node 侧按 IDF 算），
    // 因此这里取一个宽松的上限：IDF 重排需要看到足够多的候选
    .orderBy(desc(sql`(${hitExpr})`), sql`length(${memories.content})`)
    .limit(limit * 3);

  /**
   * IDF 加权打分在 Node 侧做。
   *
   * 为什么不在 SQL 里算：idf 需要每个 bigram 的 df，
   * 那会变成一长串内联常量表达式，SQL 会变得无法阅读与调试。
   * 候选已被粗排限制在 limit*3，Node 侧算的成本可忽略。
   */
  const scored = rows
    .map((r) => {
      const { score, matched } = idfWeightedScore(bigrams, docFreq, docCount, r.memory.content);
      /**
       * 小语料下用命中数当分数（见上面的 useRawCount 说明）。
       * matched.length 是「命中了几个不同 bigram」，足以排序。
       */
      return { memory: r.memory, score: useRawCount ? matched.length : score, matched };
    })
    .filter((c) => (useRawCount ? c.score > 0 : c.score >= minScore))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length === 0) return [];

  /**
   * 归一化到 [0,1] 供 RRF 与重排使用。
   *
   * 除以**本批最高分**而不是理论最大值：
   *   IDF 分数的理论上限依赖查询长度，用它做分母会让长查询被系统性压低，
   *   而 RRF 只看排名、重排的向量项也另有归一化 ——
   *   这里只需要一个单调的 [0,1] 分数。
   */
  const top = scored[0]!.score;

  return scored.map((c) => ({
    memory: c.memory,
    similarity: top > 0 ? c.score / top : 0,
  }));
}

/**
 * 统计每个 bigram 的文档频率。
 *
 * 一条聚合查询搞定，而不是每个 bigram 查一次 —— 那样 N 个 bigram
 * 就是 N 次全表扫描。
 */
async function computeDocFreq(
  userId: string,
  bigrams: string[],
  options: ExecutorOption
): Promise<{ docCount: number; docFreq: Map<string, number> }> {
  const exec = options.executor ?? db;

  const rows = await exec
    .select({
      total: sql<number>`count(*)::int`,
      // 每个 bigram 一个 SUM(CASE...)，一次扫描拿到全部 df
      ...Object.fromEntries(
        bigrams.map((g, i) => [
          `df${i}`,
          sql<number>`sum(CASE WHEN ${memories.content} LIKE ${'%' + g + '%'} THEN 1 ELSE 0 END)::int`,
        ])
      ),
    })
    .from(memories)
    .where(and(eq(memories.userId, userId), currentMemoryCondition()));

  const row = rows[0] as Record<string, number> | undefined;
  const docFreq = new Map<string, number>();
  bigrams.forEach((g, i) => {
    docFreq.set(g, Number(row?.[`df${i}`] ?? 0));
  });

  return { docCount: Number(row?.['total'] ?? 0), docFreq };
}

/**
 * 结构化通道：按已知槽位精确取。
 *
 * 用途：当查询能解析出明确槽位时（如用户问「我现在住哪」→ residence.city），
 * 直接按槽位取比任何相似度都准 —— 这是「已知槽位就该用槽位」的体现。
 *
 * ⚠️ 返回的是**候选**，仍然要过 currentMemoryCondition()：
 *    槽位相同不代表这条记忆当前有效（可能已被替代）。
 */
export async function searchBySlot(
  params: {
    userId: string;
    predicateKeys: string[];
    subjectKey?: string;
    limit?: number;
  },
  options: ExecutorOption = {}
): Promise<Memory[]> {
  const exec = options.executor ?? db;
  const limit = params.limit ?? DEFAULT_CHANNEL_LIMIT;

  if (params.predicateKeys.length === 0) return [];

  return exec
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.userId, params.userId),
        currentMemoryCondition(),
        isNotNull(memories.predicateKey),
        inArray(memories.predicateKey, params.predicateKeys),
        ...(params.subjectKey !== undefined ? [eq(memories.subjectKey, params.subjectKey)] : [])
      )
    )
    .orderBy(desc(memories.updatedAt))
    .limit(limit);
}

/**
 * 回填一组记忆的向量相似度。
 *
 * 为什么需要：RRF 融合只用排名，但**重排阶段**要按 §18.4 的
 * `0.55 × norm(vector_score)` 参与计算。只被关键词通道召回的候选
 * 在融合阶段没有向量分，必须回填一次，否则它们的向量项会被当成 0，
 * 系统性低于被向量通道召回的候选 —— 那是排序偏差，不是相关性判断。
 *
 * @returns memoryId → 相似度。只包含有 ready 向量的记忆
 */
export async function scoreVectorForMemories(
  params: {
    userId: string;
    memoryIds: string[];
    embeddingLiteral: string;
    model: string;
  },
  options: ExecutorOption = {}
): Promise<Map<string, number>> {
  const exec = options.executor ?? db;

  if (params.memoryIds.length === 0) return new Map();

  const rows = await exec
    .select({
      memoryId: memoryEmbeddings.memoryId,
      similarity: sql<number>`(1 - (${memoryEmbeddings.embedding} <=> ${params.embeddingLiteral}::vector))::float8`,
    })
    .from(memoryEmbeddings)
    .innerJoin(memories, eq(memories.id, memoryEmbeddings.memoryId))
    .where(
      and(
        inArray(memoryEmbeddings.memoryId, params.memoryIds),
        eq(memoryEmbeddings.status, 'ready'),
        eq(memoryEmbeddings.model, params.model),
        eq(memories.userId, params.userId),
        currentMemoryCondition()
      )
    );

  return new Map(rows.map((r) => [r.memoryId, Number(r.similarity)]));
}
