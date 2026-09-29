/**
 * 时间与日期的时区处理
 *
 * 【为什么必须集中到一个模块】
 *
 *   🔴 2026-09-29 实测发现：全仓库有 **9 处**用 `toISOString().slice(0, 10)`
 *      来取「日期」，而它取的是 **UTC 日期**，不是用户所在时区的日期。
 *
 *      用户在北京（UTC+8）。晚上 20:00 之后发生的事，UTC 已经是第二天：
 *        当地时间 2026-09-29 22:00  →  UTC 2026-09-29T14:00Z  →  日期仍对
 *        当地时间 2026-09-30 02:00  →  UTC 2026-09-29T18:00Z  →  ❌ 变成 09-29
 *      也就是说**凌晨 0–8 点发生的事会被算成前一天**。
 *
 *      这 9 处散落在：事件时间（给 Agent 看的）、事实生效日期、
 *      目标日期、回顾的周期、评测材料……每一处都独立地错。
 *
 *      而它此前一直没暴露，只是因为一个巧合：事件时间目前都是
 *      `00:00:00Z`（= 当地 08:00，同一天），切片后恰好是对的。
 *      一旦事件带上真实时刻，全部立刻现形。
 *
 * 【所以规则是】
 *   凡是要把时刻变成「给用户看的日期」，一律走本模块，并**显式传时区**。
 *   不要在各处写 toISOString().slice(0, 10) —— 那九个副本就是教训。
 *
 * 【为什么显式传时区而不是读全局配置】
 *   ① 纯函数可测：同一个 Date + 同一个时区，永远同一个结果
 *   ② 抽取流水线在后台跑，它拿得到 user.timezone，但不一定在同一请求上下文里
 *   ③ 缺省值可以显式写出来（见 DEFAULT_TIMEZONE），而不是隐式依赖环境
 */

/**
 * 缺省时区。
 *
 * ⚠️ **不是 UTC**。容器与 CI 的 TZ 通常是 UTC，而本项目的用户在中国 ——
 *    用 UTC 会把凌晨 0-8 点的事算到前一天。
 *    这个值与 conversation/context-builder.ts 的 DEFAULT_TIMEZONE 保持一致；
 *    之所以在这里再定义一份而不是互相 import，是为了避免
 *    schema / shared 层反向依赖 conversation 层。
 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/**
 * 取某个时刻在指定时区里的日期，格式 YYYY-MM-DD。
 *
 * en-CA 的 locale 输出天然就是 YYYY-MM-DD，因此不需要手工拼月份补零。
 */
export function formatLocalDate(at: Date, timezone: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** 取某个时刻在指定时区里的日期 + 时刻，格式 YYYY-MM-DD HH:mm */
export function formatLocalDateTime(at: Date, timezone: string = DEFAULT_TIMEZONE): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    // ⚠️ 显式 h23：zh-CN 与 en-GB 下只写 hour12:false 不保证 0-23，
    //    实测过 00:10 被渲染成 24:10（context-builder 里记过同一件事）
    hourCycle: 'h23',
  }).format(at);

  return `${formatLocalDate(at, timezone)} ${time}`;
}

/** 取某个时刻在指定时区里的「月」，格式 YYYY-MM。用于按月分组 */
export function formatLocalMonth(at: Date, timezone: string = DEFAULT_TIMEZONE): string {
  return formatLocalDate(at, timezone).slice(0, 7);
}

/**
 * 探针：验证 Intl 是否真的认识这个时区名。
 *
 * 为什么要验：`Intl.DateTimeFormat` 遇到无法识别的时区会**抛 RangeError**，
 * 而时区来自 `users.timezone`（用户可以填任意字符串）。
 * 一个写错的时区名不该让整条时间线打不开 —— 应当退回缺省值。
 */
export function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * 宽松版：时区名不合法时退回缺省值，而不是抛错。
 *
 * 用于「时区来自用户配置」的路径 —— 那里必须容忍脏数据。
 */
export function formatLocalDateSafe(
  at: Date,
  timezone: string | null | undefined
): string {
  const tz = timezone && isKnownTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
  return formatLocalDate(at, tz);
}

/** 宽松版：时区名不合法时退回缺省值 */
export function formatLocalMonthSafe(
  at: Date,
  timezone: string | null | undefined
): string {
  const tz = timezone && isKnownTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
  return formatLocalMonth(at, tz);
}

/**
 * 把「某时区里的某一天零点」转成 UTC 时刻。
 *
 * 【为什么需要它】
 *   只知日期、不知时刻的事件，落库时要选一个时刻。选 UTC 零点
 *   （`T00:00:00Z`）是错的：那在北京是当天 08:00，
 *   于是时间线上所有日期级事件都显示成 08:00，
 *   看起来像「都在早上八点发生」——一个不存在的规律。
 *
 *   正确做法是选**用户当地那一天的零点**，存成 UTC：
 *     北京 2026-09-29 00:00  →  2026-09-28T16:00:00Z
 *   这样任何按当地时区显示的界面都会还原成 09-29。
 *
 * 【怎么算】
 *   先用 UTC 拼出目标时刻，再用该时区在这一刻的偏移量修正。
 *   偏移量随时区与夏令时变化，因此**用 Intl 实时算**，不硬编码 +08:00。
 *
 * @param date YYYY-MM-DD（已按目标时区表达的日期）
 * @returns 对应的 UTC 时刻；date 非法时返回 null
 */
export function localDayStartUtc(
  date: string,
  timezone: string = DEFAULT_TIMEZONE
): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;

  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);

  /**
   * 校验这个日期真实存在，而不是靠 Date 自动进位。
   *
   * ⚠️ `Date.UTC(2026, 1, 29)`（2026 不是闰年）不会报错，它会
   * **静默变成 3 月 1 日**。若放过去，模型给出「2月30日」这种
   * 不存在的日期时，时间线上会凭空出现一个 3 月的事件 ——
   * 而用户从没说过那天发生任何事。
   *
   * 宁可丢弃这个事件（上层已有「时间解析不了就丢弃」的策略），
   * 也不要往用户的时间线上塞一个他没经历过的节点。
   */
  const naiveMs = Date.UTC(year, month - 1, day, 0, 0, 0);
  if (Number.isNaN(naiveMs)) return null;

  const back = new Date(naiveMs);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }

  /**
   * 求该时区在「那个日期」的偏移量。
   *
   * 做法：把 naive 时刻按目标时区格式化回「当地时间」，
   * 再把它当成 UTC 解析 —— 两者之差就是偏移量。
   * 例：Asia/Shanghai 下 2026-09-29T00:00Z 显示为 2026-09-29 08:00，
   *     08:00Z − 00:00Z = +8h 偏移。
   */
  const offsetMs = zonedOffsetMs(new Date(naiveMs), timezone);

  return new Date(naiveMs - offsetMs);
}

/**
 * 时区在某一时刻的偏移量（毫秒）。
 *
 * 用 formatToParts 取当地年月日时分，再当成 UTC 反解析 ——
 * 差值即偏移。这样夏令时切换也能正确处理（偏移量随时刻变化）。
 */
export function zonedOffsetMs(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);

  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((p) => p.type === type)?.value;
    return value === undefined ? 0 : Number(value);
  };

  const asUtc = Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    pick('hour'),
    pick('minute'),
    pick('second')
  );

  return asUtc - at.getTime();
}
