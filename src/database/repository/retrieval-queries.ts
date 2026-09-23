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
import { buildBigrams, MIN_BIGRAM_HIT_RATIO } from '../../memory/chinese-ngram.js';

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
 * 关键词通道：应用层字符 bigram（**不是 pg_trgm**）
 *
 * 🔴 【为什么不用 pg_trgm —— 实测确认它不支持中文】
 *   docs/03 §17.4 的 C16 决定用 pg_trgm，理由写的是「按字符三元组匹配，
 *   无需分词器，适合中文」。**实测（PostgreSQL 18 + pg_trgm 1.6）**：
 *
 *     SELECT show_trgm('用户住在杭州');   -- → {}    空集
 *     SELECT show_trgm('hello world');    -- → {"  h"," he",...}
 *
 *   pg_trgm 的默认解析器只把字母与数字当词，CJK 全被忽略
 *   → 中文不产生任何三元组 → similarity() 恒为 0 →
 *   **关键词通道对中文完全失效**，混合检索退化成单路向量检索。
 *
 *   替代方案也排除了：tsvector 把整句当一个词元；
 *   pg_bigm / pgroonga / zhparser 不在 pg_available_extensions 里
 *   （镜像 pgvector/pgvector:pg18 只带 pg_trgm）。
 *
 * 【本实现】
 *   在应用层把查询切成字符 bigram，用 LIKE 在库里筛，
 *   按「命中的不同 bigram 数 / 总数」打分。细节见 memory/chinese-ngram.ts。
 *
 * 【性能】与 §18.1 不建向量索引同理：接受顺序扫描。
 *   数据量 < 5 万条短文本，LIKE 全表扫在几十毫秒级。
 *   真要优化应换镜像装 pg_bigm，而不是回到 pg_trgm。
 *
 * ⚠️ memories 上那个 gin_trgm_ops 索引（idx_memories_content_trgm）
 *    对中文无用（索引里没有任何中文三元组）。它现在只是写入开销，
 *    应随 C16 的修订一起删除 —— 那需要改 docs/03 走 Schema 变更流程，
 *    因此本次**保留不动**，已记入交付说明。
 */
export async function searchByKeyword(
  params: {
    userId: string;
    query: string;
    limit?: number;
    /** 命中率下限。缺省 MIN_BIGRAM_HIT_RATIO（见 chinese-ngram.ts） */
    minRatio?: number;
    extra?: SQL | undefined;
  },
  options: ExecutorOption = {}
): Promise<KeywordCandidate[]> {
  const exec = options.executor ?? db;
  const limit = params.limit ?? DEFAULT_CHANNEL_LIMIT;

  const bigrams = buildBigrams(params.query);
  if (bigrams.length === 0) return [];

  const minRatio = params.minRatio ?? MIN_BIGRAM_HIT_RATIO;

  /**
   * 命中率在 SQL 里算，而不是把所有候选拉回 Node 再筛。
   *
   * 为什么不「先 LIKE 任一 bigram 拉回来再算」：
   * 单字重合的记忆可能很多（「的」「用」这类），
   * 全量拉回会浪费带宽与内存。让库先按命中数过滤一轮更省。
   */
  const hitExpr = sql.join(
    bigrams.map((g) => sql`(CASE WHEN ${memories.content} LIKE ${'%' + g + '%'} THEN 1 ELSE 0 END)`),
    sql` + `
  );

  const hits = sql<number>`(${hitExpr})`;

  const rows = await exec
    .select({ memory: memories, hits })
    .from(memories)
    .where(
      and(
        eq(memories.userId, params.userId),
        currentMemoryCondition(),
        // 至少命中一个 bigram（避免全表返回）
        sql`(${hitExpr}) > 0`,
        ...(params.extra ? [params.extra] : [])
      )
    )
    // 按命中数降序；命中数相同时按长度短的优先（短正文里的命中更有信息量）
    .orderBy(desc(hits), sql`length(${memories.content})`)
    .limit(limit);

  const total = bigrams.length;

  return rows
    .map((r) => ({
      memory: r.memory,
      // 归一化到 [0,1]，与原先 pg_trgm 的 similarity 语义一致，
      // 这样上层（RRF 融合）不需要知道通道实现换了
      similarity: Number(r.hits) / total,
    }))
    .filter((c) => c.similarity >= minRatio);
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
