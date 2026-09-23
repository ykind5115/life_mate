/**
 * Life Review 路由（docs/04 §31–§33）
 *
 *   POST /api/v1/life-review
 *
 * 【为什么是 POST 而不是 GET】
 *   它会**真实调用 LLM**（有成本、有延迟、结果不可缓存），
 *   且请求体是一个结构化的区间描述而非简单查询参数。
 *   docs/04 §31 定的也是 POST。
 */
import type { FastifyInstance } from 'fastify';

import type { LLMProvider } from '../../llm/provider.js';
import { getOrCreateDefaultUser } from '../../database/repository/user-store.js';
import { generateLifeReview } from '../../life-review/life-review-service.js';
import { badRequest, ok } from '../errors.js';
import { lifeReviewRequestSchema } from '../schemas.js';
import { resolvePeriod } from '../../timeline/timeline-service.js';

export interface LifeReviewRouteDeps {
  /**
   * 覆盖 LLM Provider。生产不传（用 env 配置的默认 Provider），
   * 测试必须传 —— 否则用例会真调模型：慢、要花钱、结果还不确定。
   */
  provider?: LLMProvider;
}

export async function registerLifeReviewRoutes(
  app: FastifyInstance,
  deps: LifeReviewRouteDeps = {}
): Promise<void> {
  app.post('/life-review', async (request) => {
    const body = lifeReviewRequestSchema.parse(request.body);
    const user = await getOrCreateDefaultUser();

    const at = body.at !== undefined ? parseTime(body.at, 'at') : new Date();

    /**
     * kind 省略时按 custom 处理（schema 的 refine 已保证此时 start/end 齐全）。
     *
     * ⚠️ resolvePeriod 会抛错（自定义区间缺 from/to、或终点早于起点）。
     *    那是**调用方传错了**，应映射成 400 而不是 500 ——
     *    因此在这里 catch 并转成 badRequest。
     */
    let period;
    try {
      period = resolvePeriod({
        kind: body.kind ?? 'custom',
        at,
        ...(body.start !== undefined ? { from: parseTime(body.start, 'start') } : {}),
        ...(body.end !== undefined ? { to: parseTime(body.end, 'end') } : {}),
      });
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : '时间区间不合法');
    }

    const result = await generateLifeReview({
      userId: user.id,
      from: period.from,
      to: period.to,
      ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
    });

    /**
     * 响应形状按 docs/04 §33：period + review。
     * 另外附上原始材料（events / memories）与来源可用性 ——
     * 那不在 §33 的示例里，但用户需要能核对
     * 「它是不是照着我说的写的」，否则回顾无法验证。
     */
    return ok({
      period: { start: result.period.from, end: result.period.to, kind: period.kind },
      review: result.review,
      materials: {
        events: result.events.map((e) => ({
          id: e.id,
          title: e.title,
          event_time: e.eventTime,
          category: e.category,
        })),
        memories: result.memories.map((m) => ({
          id: m.id,
          type: m.type,
          content: m.content,
        })),
        goals: result.goals.map((g) => ({
          id: g.id,
          title: g.title,
          status: g.status,
          target_at: g.targetAt,
        })),
        summaries: result.summaries,
      },
      sources_available: result.sourcesAvailable,
    });
  });
}

/**
 * 解析时间参数。
 *
 * 与 timeline 的边界处理不同：这里 `at` 是一个**时点**而不是区间端点，
 * 因此不做「补齐到当天末尾」的处理 —— 补了反而会让
 * 「回顾 2026-08-15 所在的这一周」算错基准。
 */
function parseTime(value: string, field: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = dateOnly ? new Date(`${value}T00:00:00Z`) : new Date(value);

  if (Number.isNaN(parsed.getTime())) throw badRequest(`${field} 不是合法时间`);
  return parsed;
}
