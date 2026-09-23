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
 * 关键词通道：pg_trgm 三元组相似度。
 *
 * 【为什么不用 tsvector / plainto_tsquery】
 *   PostgreSQL 默认全文检索不支持中文分词，`plainto_tsquery('中文句子')`
 *   会把整句当一个词元，关键词通道形同虚设（C16）。
 *   pg_trgm 按字符三元组匹配，无需分词器，适合记忆这种短文本。
 *
 * 【阈值的作用】
 *   `%` 操作符使用 pg_trgm.similarity_threshold（默认 0.3）。
 *   中文短句的三元组重叠通常很稀疏，0.3 会漏掉不少真实匹配，
 *   因此这里显式用 similarity() 排序并用一个更低的阈值过滤，
 *   避免「查询词换个说法就一条都召回不到」。
 */
export async function searchByKeyword(
  params: {
    userId: string;
    query: string;
    limit?: number;
    /** 相似度下限，低于它的候选直接丢弃 */
    minSimilarity?: number;
    extra?: SQL | undefined;
  },
  options: ExecutorOption = {}
): Promise<KeywordCandidate[]> {
  const exec = options.executor ?? db;
  const limit = params.limit ?? DEFAULT_CHANNEL_LIMIT;
  const minSimilarity = params.minSimilarity ?? 0.05;

  const sim = sql<number>`similarity(${memories.content}, ${params.query})::float8`;

  const rows = await exec
    .select({ memory: memories, similarity: sim })
    .from(memories)
    .where(
      and(
        eq(memories.userId, params.userId),
        currentMemoryCondition(),
        sql`similarity(${memories.content}, ${params.query}) >= ${minSimilarity}`,
        ...(params.extra ? [params.extra] : [])
      )
    )
    .orderBy(desc(sim))
    .limit(limit);

  return rows.map((r) => ({ memory: r.memory, similarity: Number(r.similarity) }));
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
