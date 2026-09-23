/**
 * Timeline 服务（docs/01 §7.5、docs/03 §20.1/§20.3）
 *
 * 【Timeline 不是一张表，是 events 的查询视图】（C7）
 *   §20.1 给的就是一条 SELECT：
 *     WHERE user_id = $1 AND timeline_visible = true AND deleted_at IS NULL
 *       AND event_time BETWEEN $2 AND $3
 *     ORDER BY event_time DESC
 *   因此本模块只做「按时间分组 + 组装呈现」，
 *   不新增任何存储，也就没有一致性风险（审计 P0-5）。
 *
 * 【为什么分组要在这里做，而不是交给前端】
 *   分页会把同一个月拆到两页。前端拿到半页数据时无法知道
 *   「这个月还有没有更多」，只能靠猜 —— 于是分组标题会显示成
 *   「2026-08（3）」而实际有 5 条。
 *   月份计数必须在库层算（见 countEventsByMonth），与分页各自独立。
 */
import {
  countEventsByMonth,
  listEvents,
  type ListEventsFilter,
} from '../database/repository/event-store.js';
import type { Event } from '../database/schema/events.js';
import type { EventCategory } from '../database/schema/enums.js';

/** §20.3 的效果图按月分组。这里是分组的粒度定义 */
export interface TimelineMonth {
  /** YYYY-MM */
  month: string;
  /** 该月总条数（不受分页影响） */
  total: number;
  /** 本次返回的该月条目 */
  events: Event[];
}

export interface TimelineResult {
  months: TimelineMonth[];
  /** 本次返回的条目总数 */
  returned: number;
  /** 时间窗内的总条数 */
  total: number;
  range: { from: Date | null; to: Date | null };
}

/**
 * 取时间线。
 *
 * @param granularity 'month' 是 §20.3 定义的分组粒度。
 *        预留参数是为了将来支持按年折叠（数据量大时），但**现在只实现 month** ——
 *        加一个只接受单值的参数比留 TODO 好：签名稳定，实现可换。
 */
export async function getTimeline(
  params: {
    userId: string;
    from?: Date;
    to?: Date;
    category?: EventCategory;
    limit?: number;
    offset?: number;
    granularity?: 'month';
  },
  options: Parameters<typeof listEvents>[1] = {}
): Promise<TimelineResult> {
  const filter: ListEventsFilter = {
    userId: params.userId,
    timelineOnly: true,
    ...(params.from !== undefined ? { from: params.from } : {}),
    ...(params.to !== undefined ? { to: params.to } : {}),
    ...(params.category !== undefined ? { category: params.category } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.offset !== undefined ? { offset: params.offset } : {}),
  };

  /**
   * 两个查询并行：条目 与 月度计数。
   *
   * ⚠️ 计数**不能**从返回的 entries 里算：分页只带回一页，
   *    算出来的月度计数是"本页里的条数"，不是该月的总条数。
   */
  const [page, monthCounts] = await Promise.all([
    listEvents(filter, options),
    countEventsByMonth(
      {
        userId: params.userId,
        ...(params.from !== undefined ? { from: params.from } : {}),
        ...(params.to !== undefined ? { to: params.to } : {}),
      },
      options
    ),
  ]);

  // 按 month 归并。计数来自 countEventsByMonth，条目来自本页
  const byMonth = new Map<string, TimelineMonth>();
  for (const { month, n } of monthCounts) {
    byMonth.set(month, { month, total: n, events: [] });
  }

  for (const event of page.items) {
    const month = monthKeyOf(event.eventTime);
    const bucket = byMonth.get(month);
    if (bucket) {
      bucket.events.push(event);
    } else {
      /**
       * 兜底：条目所在的月份不在计数结果里。
       * 理论上不该发生（两个查询用同一套过滤条件），
       * 但若发生了（例如并发写入），静默丢条目比显示一个
       * 计数为 0 却有内容的月份更糟 —— 因此补一个 bucket。
       */
      byMonth.set(month, { month, total: bucketFallbackTotal(page.items, month), events: [event] });
    }
  }

  /**
   * 只返回**有内容**的月份。
   *
   * 为什么：分页时 offset 会落在某个月中间，
   * 前面的月份计数非 0 但本页没有它的条目 —— 那些空月份标题
   * 会让用户以为"这个月的事丢了"。
   */
  const months = [...byMonth.values()]
    .filter((m) => m.events.length > 0)
    .sort((a, b) => (a.month < b.month ? 1 : -1)); // 倒序：最近的月份在前

  return {
    months,
    returned: page.items.length,
    total: page.total,
    range: { from: params.from ?? null, to: params.to ?? null },
  };
}

// ============================================================
// 周期解析（Life Review 用）
// ============================================================

/**
 * 把「日 / 周 / 月 / 自定义区间」解析成具体的时间窗。
 *
 * 【为什么周从周一开始】
 *   中文语境里「这周」指周一到周日。用周日作为起点会让
 *   「周末做了什么」被切到下一个周期里 —— 用户会觉得总结漏了东西。
 *
 * 【时间基准是本地时区还是 UTC】
 *   这里按 **UTC** 切分，与 events.event_time 的存储口径一致。
 *   已知局限：用户在 UTC+8，晚上 8 点后发生的事按 UTC 会算到前一天。
 *   要做对需要按 users.timezone 换算 —— 那是个独立改动
 *   （见交付说明里记的待办），不在本次范围内。
 */
export type PeriodKind = 'day' | 'week' | 'month' | 'custom';

export interface ResolvedPeriod {
  from: Date;
  to: Date;
  kind: PeriodKind;
}

export function resolvePeriod(
  input: { kind: PeriodKind; from?: Date; to?: Date; at?: Date }
): ResolvedPeriod {
  const at = input.at ?? new Date();

  switch (input.kind) {
    case 'day': {
      const from = startOfUtcDay(at);
      return { from, to: endOfUtcDay(at), kind: 'day' };
    }
    case 'week': {
      const from = startOfUtcWeek(at);
      return { from, to: new Date(from.getTime() + 7 * 86400_000 - 1), kind: 'week' };
    }
    case 'month': {
      const from = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
      const to = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1) - 1);
      return { from, to, kind: 'month' };
    }
    case 'custom': {
      if (!input.from || !input.to) {
        throw new Error('自定义区间必须同时提供 from 与 to');
      }
      if (input.to.getTime() < input.from.getTime()) {
        throw new Error('区间终点不能早于起点');
      }
      return { from: input.from, to: input.to, kind: 'custom' };
    }
  }
}

// ============================================================
// 内部
// ============================================================

/** YYYY-MM。用 UTC 口径与 event_time 一致 */
function monthKeyOf(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** 兜底 bucket 的 total：数本页里该月的条目 */
function bucketFallbackTotal(items: Event[], month: string): number {
  return items.filter((e) => monthKeyOf(e.eventTime) === month).length;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function endOfUtcDay(d: Date): Date {
  return new Date(startOfUtcDay(d).getTime() + 86400_000 - 1);
}

/**
 * 周一为一周的开始。
 *
 * getUTCDay() 返回 0=周日 … 6=周六。
 * 因此周一的计算是：(day + 6) % 7 天前。
 */
function startOfUtcWeek(d: Date): Date {
  const dayStart = startOfUtcDay(d);
  const dow = dayStart.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  return new Date(dayStart.getTime() - daysSinceMonday * 86400_000);
}
