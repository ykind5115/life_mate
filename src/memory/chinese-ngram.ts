/**
 * 中文关键词切分（应用层）
 *
 * 【为什么需要这个文件 —— 一个实测确认的设计缺陷】
 *   docs/03 §17.4 的 C16 决定「关键词通道用 pg_trgm」，
 *   理由是「pg_trgm 按字符三元组匹配，无需分词器，适合中文」。
 *
 *   🔴 **这个理由是错的。实测（2026-09-23，PostgreSQL 18 + pg_trgm 1.6）**：
 *
 *     SELECT show_trgm('用户住在杭州');   -- → {}        （空集！）
 *     SELECT show_trgm('hello world');    -- → {"  h"," he",...}
 *     SELECT show_trgm('2026年9月');      -- → {"  2"," 20",...}
 *
 *   pg_trgm 的默认解析器只把**字母与数字**当词，
 *   CJK 字符全部被忽略 → 中文完全不产生三元组 → similarity() 恒为 0。
 *   也就是说**关键词通道对中文完全失效**，混合检索退化成单路向量检索。
 *
 *   替代方案也都被排除：
 *     · tsvector：to_tsvector('simple','用户住在杭州') → `'用户住在杭州':1`
 *       整句一个词元，同样不可用
 *     · pg_bigm / pgroonga / zhparser：pg_available_extensions 里没有
 *       （容器是 pgvector/pgvector:pg18，只带 pg_trgm）
 *     · 新增扩展 = 换镜像 + 加依赖，成本与风险都超过收益（AGENTS.md §2
 *       要求新增依赖前说明理由）
 *
 * 【因此采用应用层字符 bigram】
 *   在 Node 侧把查询切成字符 bigram，用 LIKE '%xx%' 在库里筛，
 *   按「命中的不同 bigram 数 / 查询的 bigram 总数」打分。
 *
 *   为什么是 bigram 而不是别的长度：
 *     · unigram（单字）太宽：「用」「的」这类字几乎命中所有记忆，没有区分度
 *     · trigram 太严：中文常以双字词为单位（「住在」「杭州」），
 *       三字窗口会横跨词边界，命中率显著下降
 *     · bigram 正好对应中文最自然的双字词粒度
 *
 * 【性能】V1.0 不建向量索引同理，这里也接受顺序扫描：
 *   数据量 < 5 万条短文本，LIKE 全表扫在几十毫秒级。
 *   bigram 数量上限见 MAX_BIGRAMS。
 *
 * 【这是对 C16 的偏离，不是遗忘】
 *   已记入交付说明。修法建议：把 C16 的「用 pg_trgm」改为
 *   「关键词通道由应用层 bigram 实现（pg_trgm 不支持 CJK）」，
 *   并删掉 memories 上那个无用的 gin_trgm_ops 索引。
 */

/**
 * bigram 数量上限。
 *
 * 每个 bigram 会变成一个 LIKE 条件，太多会让 SQL 变得臃肿。
 * 12 个足够覆盖一句话里的实义部分（超出部分是「我想问一下」这类虚词）。
 */
export const MAX_BIGRAMS = 12;

/**
 * 命中率下限。
 *
 * 0.3 的含义：查询里至少三成的 bigram 出现在记忆正文里才算候选。
 * 太低会让单字重合的记忆混进来，太高会漏掉换了说法的表述。
 * ⚠️ 这个值与检索权重一样属于**待评测校准**的参数。
 */
export const MIN_BIGRAM_HIT_RATIO = 0.3;

/**
 * 切出字符 bigram。
 *
 * 只保留 CJK 与字母数字，丢掉标点与空白 ——
 * 标点产生的 bigram（如「，我」）会带来噪音命中。
 *
 * @returns 去重后的 bigram 列表，超过 MAX_BIGRAMS 时截断
 */
export function buildBigrams(text: string): string[] {
  const cleaned = text
    .replace(/[\s，。！？、；：""''（）,.!?;:()[\]{}~—-]/g, '')
    .toLowerCase();

  if (cleaned.length === 0) return [];
  // 单字查询无法构成 bigram，退化为它本身
  if (cleaned.length === 1) return [cleaned];

  const grams = new Set<string>();
  for (let i = 0; i < cleaned.length - 1; i++) {
    grams.add(cleaned.slice(i, i + 2));
  }

  /**
   * 截断时保留**靠前**的 bigram。
   *
   * 中文疑问句的重点通常在靠后（「我明年有什么打算」的重点是「打算」），
   * 但按位置截断只能选一边。选前面而不是随机：
   * 随机会让同一个查询在两次调用里给出不同结果 —— 那对评测是致命的。
   */
  return [...grams].slice(0, MAX_BIGRAMS);
}

/**
 * 按「命中的不同 bigram 数」算关键词相似度。
 *
 * 分母是查询的 bigram 总数，因此：
 *   查询「杭州」→ bigram ['杭州']，记忆含「杭州」→ 1/1 = 1.0
 *   查询「我住在哪里」→ ['我住','住在','在哪','哪里']，
 *     记忆「用户住在杭州」只含「住在」→ 1/4 = 0.25（低于阈值，不入选）
 *
 * ⚠️ 这个例子里 0.25 被过滤掉了，而它其实是**语义相关**的
 *    （用户确实在问居住地）。这类「换了说法」的召回由**向量通道**负责 ——
 *    关键词通道的定位本就是「字面重合」，两者互补而不是互相替代。
 *    这也解释了为什么混合检索需要 RRF 融合：单看任一路都会漏。
 */
export function bigramHitRatio(
  queryBigrams: string[],
  content: string
): { hits: number; ratio: number } {
  if (queryBigrams.length === 0) return { hits: 0, ratio: 0 };

  const haystack = content.toLowerCase();
  const hits = queryBigrams.filter((g) => haystack.includes(g)).length;

  return { hits, ratio: hits / queryBigrams.length };
}
