/**
 * 事件时间解析的精度与时区（docs/14 的实施验证）
 *
 * 【为什么这些用例重要】
 *   2026-09-29 用户报告时间线上两条记录「冲突」，排查后发现其中一个成因是
 *   **所有事件的时间都显示成 08:00** —— 日期级事件被落库成 UTC 零点，
 *   在北京显示就是当天 08:00。于是时间线看起来像「这些事都发生在早上八点」。
 *
 *   而事件时间**事实上是有精度的**，只是以前无处表达：
 *     「上周三搬到杭州」       → 只知道日期
 *     「今天上午面试了两个人」 → 知道大概时段
 *   把两者写成同一个时刻，等于编造了一个时刻。
 *
 *   这些用例把「解析出的时刻」与「解析出的精度」一起钉住 ——
 *   只钉时刻不够，因为 08:00 与 00:00 都是「看起来合理的时刻」。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveEventTime } from './extraction-schema.js';

const CN = 'Asia/Shanghai';

// ============================================================
// 精度判定
// ============================================================

test('只有日期 → day 精度，落在当地零点', () => {
  const r = resolveEventTime('2026-09-29', undefined, CN);

  assert.ok(r);
  assert.equal(r.precision, 'day');
  // 北京 09-29 00:00 = UTC 09-28 16:00
  assert.equal(r.at.toISOString(), '2026-09-28T16:00:00.000Z');
});

test('🔴 回归：模型照旧示例写的 T00:00:00Z 也算 day 精度', () => {
  /**
   * 这是本次问题的最直接来源：提示词里的示例是
   * `"eventTime": "2026-09-10T00:00:00Z"`，模型就照着写。
   * 若把它当成 minute 精度，时间线上会出现一片 08:00（北京时间）。
   *
   * 判据：落在**某个时区的 UTC 零点**上的输入，按 day 处理。
   */
  const r = resolveEventTime('2026-09-29T00:00:00Z', undefined, CN);

  assert.ok(r);
  assert.equal(r.precision, 'day', 'UTC 零点是「只知道日期」的写法，不是真的在零点发生');
  assert.equal(r.at.toISOString(), '2026-09-28T16:00:00.000Z');
});

test('带真实时刻的 ISO → minute 精度，时刻原样保留', () => {
  const r = resolveEventTime('2026-09-29T10:30:00+08:00', undefined, CN);

  assert.ok(r);
  assert.equal(r.precision, 'minute');
  assert.equal(r.at.toISOString(), '2026-09-29T02:30:00.000Z');
});

test('无偏移但带时刻的 ISO → minute 精度', () => {
  const r = resolveEventTime('2026-09-29T10:30:00', undefined, CN);

  assert.ok(r);
  assert.equal(r.precision, 'minute');
});

test('中文日期 → day 精度', () => {
  const r = resolveEventTime('2026年9月29日', undefined, CN);

  assert.ok(r);
  assert.equal(r.precision, 'day');
  assert.equal(r.at.toISOString(), '2026-09-28T16:00:00.000Z');
});

test('中文日期带时刻 → minute 精度，且按用户当地时刻解释', () => {
  /**
   * 用户说「下午三点」指的是他自己的三点。
   * 不带偏移地解析会按服务器时区（通常 UTC）解释 ——
   * 于是北京的下午三点变成当地晚上十一点。
   */
  const r = resolveEventTime('2026年9月29日 15:00', undefined, CN);

  assert.ok(r);
  assert.equal(r.precision, 'minute');
  assert.equal(r.at.toISOString(), '2026-09-29T07:00:00.000Z', '北京 15:00 = UTC 07:00');
});

test('只有年月 → day 精度，取该月 1 号', () => {
  const r = resolveEventTime('2026年9月', undefined, CN);

  assert.ok(r);
  assert.equal(r.precision, 'day');
  assert.equal(r.at.toISOString(), '2026-08-31T16:00:00.000Z', '北京 09-01 00:00');
});

// ============================================================
// 时区
// ============================================================

test('同一日期在不同时区给出不同的 UTC 时刻（但当地都是零点）', () => {
  const cn = resolveEventTime('2026-09-29', undefined, 'Asia/Shanghai');
  const utc = resolveEventTime('2026-09-29', undefined, 'UTC');
  const ny = resolveEventTime('2026-09-29', undefined, 'America/New_York');

  assert.equal(cn?.at.toISOString(), '2026-09-28T16:00:00.000Z');
  assert.equal(utc?.at.toISOString(), '2026-09-29T00:00:00.000Z');
  assert.equal(ny?.at.toISOString(), '2026-09-29T04:00:00.000Z', '纽约夏令时 -4');
});

test('缺省时区是 Asia/Shanghai，不是 UTC', () => {
  const r = resolveEventTime('2026-09-29');
  assert.equal(r?.at.toISOString(), '2026-09-28T16:00:00.000Z');
});

// ============================================================
// 拒收
// ============================================================

test('解析不了的时间返回 null（调用方丢弃该事件）', () => {
  assert.equal(resolveEventTime('上周三', undefined, CN), null);
  assert.equal(resolveEventTime('', undefined, CN), null);
  assert.equal(resolveEventTime('   ', undefined, CN), null);
  assert.equal(resolveEventTime('不是时间', undefined, CN), null);
});

test('不存在的日历日期返回 null，不自动进位', () => {
  // 2026 不是闰年；放过去会变成 3 月 1 日，凭空在时间线上多一个节点
  assert.equal(resolveEventTime('2026-02-29', undefined, CN), null);
  assert.equal(resolveEventTime('2026年2月30日', undefined, CN), null);
});

test('明显不合理的年份被拒', () => {
  /**
   * ⚠️ 判据是「早于 1900 或晚于未来 1 年」（见 isPlausibleTime）。
   *
   *    这里第一版写的是 `1970-01-01T00:00:01Z` 并expecting null ——
   *    **断言写错了**：1970 远在 1900 之后，判据本来就该放行它。
   *    实测发现后改为下面这些真的越界的值。
   *    （这也说明「测试失败」时先怀疑断言，别急着改代码。）
   */
  assert.equal(resolveEventTime('1850-01-01', undefined, CN), null, '早于 1900');
  assert.equal(resolveEventTime('1899-12-31', undefined, CN), null, '1900 之前一天');
  assert.equal(resolveEventTime('1850-01-01T00:00:01Z', undefined, CN), null, '带时刻也一样');

  // 未来超过 1 年
  assert.equal(resolveEventTime('2099-01-01', undefined, CN), null, '太远的未来');

  // 边界内的应当放行（避免把判据写得太紧而误杀真实事件）
  assert.notEqual(resolveEventTime('1900-01-01', undefined, CN), null, '1900 本身合法');
  assert.notEqual(resolveEventTime('1970-01-01', undefined, CN), null, '1970 合法');
});
