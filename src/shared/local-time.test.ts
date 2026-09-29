/**
 * 时区工具的测试（shared/local-time.ts）
 *
 * 【为什么这些用例值得写】
 *   这里每个函数的错误都是「差一天 / 差几小时」这种静默错误 ——
 *   不报错、不崩，只是把用户的凌晨两点记成前一天。
 *   而它此前在仓库里以 9 份 `toISOString().slice(0, 10)` 的形式存在，
 *   每一份都独立地错。集中到一处之后，用测试钉住它。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatLocalDate,
  formatLocalDateTime,
  formatLocalMonth,
  localDayStartUtc,
  zonedOffsetMs,
} from './local-time.js';

const CN = 'Asia/Shanghai';
const UTC = 'UTC';
const NY = 'America/New_York';

// ============================================================
// formatLocalDate：UTC 日期 vs 本地日期
// ============================================================

test('formatLocalDate 取的是指定时区的日期，不是 UTC 日期', () => {
  /**
   * 🔴 这就是那个 bug 的核心用例。
   *    北京时间 2026-09-29 凌晨 02:00 = UTC 2026-09-28 18:00。
   *    `toISOString().slice(0,10)` 会给出 09-28（错一天）。
   */
  const at = new Date('2026-09-28T18:00:00Z');

  assert.equal(formatLocalDate(at, CN), '2026-09-29', '北京已是 29 日凌晨');
  assert.equal(formatLocalDate(at, UTC), '2026-09-28', 'UTC 还是 28 日');
  assert.equal(
    at.toISOString().slice(0, 10),
    '2026-09-28',
    '对照：被替换掉的那种写法确实给出错误的一天'
  );
});

test('formatLocalDate 对同一时刻在不同时区给出各自正确的日期', () => {
  // 北京 09-29 08:00 = UTC 09-29 00:00 = 纽约 09-28 20:00
  const at = new Date('2026-09-29T00:00:00Z');

  assert.equal(formatLocalDate(at, CN), '2026-09-29');
  assert.equal(formatLocalDate(at, UTC), '2026-09-29');
  assert.equal(formatLocalDate(at, NY), '2026-09-28');
});

test('formatLocalDate 缺省时区是 Asia/Shanghai 而不是 UTC', () => {
  // 容器 TZ 是 UTC，缺省若跟着环境走就会算错
  const at = new Date('2026-09-28T18:00:00Z');
  assert.equal(formatLocalDate(at), '2026-09-29');
});

test('formatLocalDateTime 渲染 0 点而不是 24 点', () => {
  // hourCycle 不显式指定 h23 时，00:10 会渲染成 24:10（同类问题已踩过两次）
  const at = new Date('2026-09-28T16:10:00Z'); // 北京 09-29 00:10
  assert.equal(formatLocalDateTime(at, CN), '2026-09-29 00:10');
});

test('formatLocalMonth 按本地月份分组，不是 UTC 月份', () => {
  /**
   * 月末的 UTC 偏移会把事件分到上一个月 ——
   * 时间线按月分组，那会让「10月1日凌晨做的事」出现在 9 月。
   * 北京 2026-10-01 01:00 = UTC 2026-09-30 17:00。
   */
  const at = new Date('2026-09-30T17:00:00Z');

  assert.equal(formatLocalMonth(at, CN), '2026-10', '北京已是 10 月');
  assert.equal(
    at.toISOString().slice(0, 7),
    '2026-09',
    '对照：UTC 切片会分到 9 月'
  );
});

// ============================================================
// localDayStartUtc：当地零点
// ============================================================

test('localDayStartUtc 返回当地那一天的零点（存成 UTC）', () => {
  /**
   * 这是「日期级事件该怎么落库」的答案。
   * 存 UTC 零点（T00:00:00Z）在北京是当天 08:00 ——
   * 于是时间线上所有日期级事件都显示成 08:00，一个不存在的规律。
   */
  const start = localDayStartUtc('2026-09-29', CN);

  assert.ok(start);
  assert.equal(start.toISOString(), '2026-09-28T16:00:00.000Z', '北京零点 = UTC 前一天 16:00');
  // 关键性质：按北京显示回来必须还是 29 日零点
  assert.equal(formatLocalDateTime(start, CN), '2026-09-29 00:00');
});

test('localDayStartUtc 在 UTC 时区下就是 UTC 零点', () => {
  const start = localDayStartUtc('2026-09-29', UTC);
  assert.equal(start?.toISOString(), '2026-09-29T00:00:00.000Z');
});

test('localDayStartUtc 正确处理夏令时切换（偏移量不是常数）', () => {
  /**
   * 纽约夏令时：3 月第二个周日切换。
   * 切换前 EST = UTC-5，切换后 EDT = UTC-4。
   * 硬编码偏移量的实现在这里必然错一小时。
   */
  const winter = localDayStartUtc('2026-01-15', NY);
  const summer = localDayStartUtc('2026-07-15', NY);

  assert.ok(winter && summer);
  assert.equal(winter.toISOString(), '2026-01-15T05:00:00.000Z', 'EST = UTC-5');
  assert.equal(summer.toISOString(), '2026-07-15T04:00:00.000Z', 'EDT = UTC-4');
});

test('localDayStartUtc 对非法输入返回 null，不抛错也不猜', () => {
  assert.equal(localDayStartUtc('不是日期', CN), null);
  assert.equal(localDayStartUtc('2026-9-29', CN), null, '必须是补零的两位');
  assert.equal(localDayStartUtc('', CN), null);
});

test('localDayStartUtc 拒绝不存在的日历日期，不自动进位', () => {
  /**
   * ⚠️ `Date.UTC(2026, 1, 29)` 不报错，它会**静默变成 3 月 1 日**。
   *    如果放过去，模型给出「2月30日」这类不存在的日期时，
   *    时间线上会凭空出现一个 3 月的事件 —— 而用户从没说过那天有事。
   *    宁可丢弃该事件，也不要往用户的时间线上塞他没经历过的节点。
   */
  assert.equal(localDayStartUtc('2026-02-29', CN), null, '2026 不是闰年');
  assert.equal(localDayStartUtc('2026-04-31', CN), null, '4 月只有 30 天');
  assert.equal(localDayStartUtc('2026-13-01', CN), null, '没有 13 月');
  assert.equal(localDayStartUtc('2026-00-10', CN), null, '没有 0 月');

  // 闰年的 2 月 29 日是合法的
  assert.notEqual(localDayStartUtc('2028-02-29', CN), null, '2028 是闰年');
});

test('localDayStartUtc 的结果能被 formatLocalDate 还原（往返一致）', () => {
  for (const day of ['2026-01-01', '2026-06-15', '2026-12-31', '2028-02-29']) {
    const start = localDayStartUtc(day, CN);
    assert.ok(start, `${day} 应能解析`);
    assert.equal(formatLocalDate(start, CN), day, `${day} 往返应一致`);
  }
});

// ============================================================
// zonedOffsetMs
// ============================================================

test('zonedOffsetMs 给出各时区的偏移量', () => {
  const at = new Date('2026-09-29T00:00:00Z');

  assert.equal(zonedOffsetMs(at, UTC), 0);
  assert.equal(zonedOffsetMs(at, CN), 8 * 3600 * 1000, '北京 +8');
  assert.equal(zonedOffsetMs(at, NY), -4 * 3600 * 1000, '纽约夏令时 -4');
});
