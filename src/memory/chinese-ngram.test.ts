/**
 * 中文关键词切分的单元测试
 *
 * 【为什么这些必须测】
 *   这个模块是「pg_trgm 不支持中文」的补救实现。
 *   切分逻辑一旦出错，关键词通道会静默失效 —— 不会报错，
 *   只是召回变少，而召回变少的表现是「Agent 想不起来」，
 *   很难被归因到切分本身。
 *
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bigramHitRatio,
  buildBigrams,
  MAX_BIGRAMS,
  MIN_BIGRAM_HIT_RATIO,
} from './chinese-ngram.js';

// ============================================================
// 切分
// ============================================================

test('buildBigrams：中文按字符切双字组', () => {
  assert.deepEqual(buildBigrams('杭州'), ['杭州']);
  assert.deepEqual(buildBigrams('住在杭州'), ['住在', '在杭', '杭州']);
});

test('buildBigrams：去掉标点与空白，避免产生噪音 bigram', () => {
  // 「，我」这类 bigram 会带来无意义的重合
  const grams = buildBigrams('你好，世界');
  assert.ok(!grams.includes('，世'), '标点不应进入 bigram');
  assert.deepEqual(grams, ['你好', '好世', '世界']);
});

test('buildBigrams：单个汉字退化为它本身（否则无法检索）', () => {
  assert.deepEqual(buildBigrams('猫'), ['猫']);
});

test('buildBigrams：空串与纯标点返回空数组', () => {
  assert.deepEqual(buildBigrams(''), []);
  assert.deepEqual(buildBigrams('   '), []);
  assert.deepEqual(buildBigrams('，。！？'), []);
});

test('buildBigrams：英文转小写后切分（大小写不敏感）', () => {
  assert.deepEqual(buildBigrams('Rust'), ['ru', 'us', 'st']);
  assert.deepEqual(buildBigrams('RUST'), buildBigrams('rust'));
});

test('buildBigrams：去重（重复的 bigram 只算一次）', () => {
  // 「哈哈哈哈哈」的 bigram 只有「哈哈」一种
  assert.deepEqual(buildBigrams('哈哈哈哈哈'), ['哈哈']);
});

test('buildBigrams：超过上限时截断，且结果**确定**（不随机）', () => {
  const long = '一二三四五六七八九十甲乙丙丁戊己庚辛';
  const grams = buildBigrams(long);

  assert.equal(grams.length, MAX_BIGRAMS);
  /**
   * 确定性很重要：随机截断会让同一个查询在两次调用里给出不同结果，
   * 那对离线评测是致命的（指标会抖动，无法归因）。
   */
  assert.deepEqual(buildBigrams(long), grams);
});

// ============================================================
// 命中率
// ============================================================

test('bigramHitRatio：完全字面重合 → 1.0', () => {
  const { hits, ratio } = bigramHitRatio(buildBigrams('杭州'), '用户居住在杭州');
  assert.equal(hits, 1);
  assert.equal(ratio, 1);
});

test('bigramHitRatio：部分重合按比例计分', () => {
  /**
   * 查询「住在杭州」→ ['住在','在杭','杭州']
   * 记忆「用户定居在杭州」含「在杭」「杭州」，但**不含**「住在」
   *   （是「定居在」，不是「住在」）→ 2/3
   *
   * ⚠️ 这条用例的价值在于它体现了 bigram 的**字面性**：
   *    「定居在杭州」与「住在杭州」语义几乎相同，
   *    但 bigram 只认字面，因此只得 2/3 而不是 1。
   *    这是刻意的 —— 语义相近的召回由向量通道负责。
   *    （实测过程中踩过：一开始用「用户居住在杭州」，
   *     它含「住在」也含「在杭」，三个全中，用例反而没测到部分重合。）
   */
  const { hits, ratio } = bigramHitRatio(buildBigrams('住在杭州'), '用户定居在杭州');
  assert.equal(hits, 2);
  assert.ok(Math.abs(ratio - 2 / 3) < 1e-9);
});

test('bigramHitRatio：换了说法的查询拿低分（这是预期行为）', () => {
  /**
   * 「我住在哪里」的 bigram 与「用户住在杭州」只重合「住在」。
   * 1/4 = 0.25 < 阈值 0.3 → 关键词通道不召它。
   *
   * ⚠️ 这不是缺陷，是**分工**：
   *    关键词通道负责「字面重合」，语义相近但换词的情况由向量通道负责。
   *    这也正是混合检索需要 RRF 融合的原因 —— 单看任一路都会漏。
   *    已实测确认：该查询由向量通道正确召回。
   */
  const query = buildBigrams('我住在哪里');
  const { ratio } = bigramHitRatio(query, '用户于2026年9月中旬从北京搬到杭州居住');

  assert.ok(ratio < MIN_BIGRAM_HIT_RATIO, `预期低于阈值，实际 ${ratio}`);
});

test('bigramHitRatio：无重合 → 0', () => {
  const { hits, ratio } = bigramHitRatio(buildBigrams('雅思'), '用户最近在学习钢琴');
  assert.equal(hits, 0);
  assert.equal(ratio, 0);
});

test('bigramHitRatio：空查询返回 0 而不是 NaN', () => {
  const { hits, ratio } = bigramHitRatio([], '任意内容');
  assert.equal(hits, 0);
  assert.equal(ratio, 0);
  assert.ok(!Number.isNaN(ratio));
});

test('bigramHitRatio：大小写不敏感', () => {
  const lower = bigramHitRatio(buildBigrams('rust'), '用户在学 RUST');
  assert.equal(lower.ratio, 1);
});

// ============================================================
// 回归：pg_trgm 的行为（用注释固化结论）
// ============================================================

test('回归说明：pg_trgm 对中文返回空三元组，因此不能用它', () => {
  /**
   * 这条测试没有断言 pg_trgm（那需要数据库连接），
   * 它的作用是**固化结论**，防止将来有人「顺手改回 pg_trgm」。
   *
   * 实测（2026-09-23，PostgreSQL 18 + pg_trgm 1.6）：
   *   SELECT show_trgm('用户住在杭州');  -- → {}      空集
   *   SELECT show_trgm('hello world');   -- → {"  h"," he",...}
   *   SELECT show_trgm('2026年9月');     -- → {"  2"," 20",...}  只切了数字
   *
   * 也就是说 pg_trgm 的解析器只把字母数字当词，CJK 全被忽略。
   * 替代方案也都不可用：tsvector 整句一个词元；
   * pg_bigm / pgroonga / zhparser 不在 pg_available_extensions 里。
   *
   * 结论：关键词通道必须由应用层 bigram 实现。
   * 细节见 chinese-ngram.ts 的文件头与 audit/trgm-probe.sql。
   */
  assert.ok(true);
});
