/**
 * Timeline 路由（docs/04 §27–§30）
 *
 *   GET    /api/v1/timeline        时间线（按年月分组）
 *   POST   /api/v1/timeline        手工创建事件
 *   PATCH  /api/v1/timeline/:id    更新事件
 *   DELETE /api/v1/timeline/:id    软删除事件
 *
 * 【为什么事件的调用方可以写，而记忆不行】
 *   Q3 规定记忆**只能**由后台抽取写入（Agent 不持有写工具），
 *   因为记忆要参与冲突判定与历史查询，"谁写的"必须单一。
 *   事件没有这些约束：它是用户人生经历的记录，
 *   docs/04 §28–§30 明确给了 POST/PATCH/DELETE 三个写端点。
 *   用户在时间线上补一条「去年换了工作」是完全合理的。
 */
import type { FastifyInstance } from 'fastify';

import {
  createEvent,
  findEventById,
  getOrCreateDefaultUser,
  restoreEvent,
  softDeleteEvent,
  updateEvent,
} from '../../database/repository/index.js';
import type { Event } from '../../database/schema/events.js';
import { TIMELINE_CATEGORIES } from '../schemas.js';
import { badRequest, conflict, notFound, ok, paginate, toOffset } from '../errors.js';
import {
  createTimelineEventSchema,
  timelineEventIdParamSchema,
  timelineQuerySchema,
  updateTimelineEventSchema,
} from '../schemas.js';
import { getTimeline } from '../../timeline/timeline-service.js';

export async function registerTimelineRoutes(app: FastifyInstance): Promise<void> {
  // ==========================================================
  // GET /api/v1/timeline   （docs/04 §27）
  // ==========================================================
  app.get('/timeline', async (request) => {
    const query = timelineQuerySchema.parse(request.query);
    const user = await getOrCreateDefaultUser();

    const result = await getTimeline({
      userId: user.id,
      ...(query.start !== undefined ? { from: parseDateBoundary(query.start, 'start') } : {}),
      ...(query.end !== undefined ? { to: parseDateBoundary(query.end, 'end') } : {}),
      ...(query.category !== undefined ? { category: query.category } : {}),
      limit: query.page_size,
      offset: toOffset(query.page, query.page_size),
    });

    return ok({
      /** 按年月分组（§20.3 的呈现方式） */
      months: result.months.map((m) => ({
        month: m.month,
        total: m.total,
        items: m.events.map(toEventDto),
      })),
      /** 同时给一份平铺列表：前端的日历视图用分组，列表视图用平铺 */
      items: result.months.flatMap((m) => m.events.map(toEventDto)),
      pagination: paginate({
        page: query.page,
        pageSize: query.page_size,
        total: result.total,
      }),
    });
  });

  // ==========================================================
  // POST /api/v1/timeline   （docs/04 §28）
  // ==========================================================
  app.post('/timeline', async (request, reply) => {
    const body = createTimelineEventSchema.parse(request.body);
    const user = await getOrCreateDefaultUser();

    const eventTime = new Date(body.event_time);
    if (Number.isNaN(eventTime.getTime())) {
      throw badRequest('event_time 不是合法时间');
    }

    const event = await createEvent({
      userId: user.id,
      title: body.title,
      description: body.description ?? null,
      eventTime,
      category: body.category ?? null,
      ...(body.importance_score !== undefined
        ? { importanceScore: body.importance_score }
        : {}),
      /**
       * 手工创建的事件来源是 'manual'，且**没有** source_message_id。
       * 不伪造一个消息 id：那会让「这件事从哪来」的追溯变成假信息。
       */
      sourceType: 'manual',
      sourceMessageId: null,
      ...(body.timeline_visible !== undefined ? { timelineVisible: body.timeline_visible } : {}),
    });

    reply.code(201);
    return ok(toEventDto(event));
  });

  // ==========================================================
  // PATCH /api/v1/timeline/:id   （docs/04 §29）
  // ==========================================================
  app.patch('/timeline/:id', async (request) => {
    const { id } = timelineEventIdParamSchema.parse(request.params);
    const body = updateTimelineEventSchema.parse(request.body);

    const existing = await findEventById(id);
    if (!existing) throw notFound('事件不存在');
    if (existing.deletedAt !== null) {
      // 与记忆的 PATCH 一致：已删除的应提示"先恢复"，而不是含糊的 404
      throw conflict('事件已删除，请先恢复再修改');
    }

    const patch: Parameters<typeof updateEvent>[1] = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.description !== undefined) patch.description = body.description;
    if (body.category !== undefined) patch.category = body.category;
    if (body.importance_score !== undefined) patch.importanceScore = body.importance_score;
    if (body.timeline_visible !== undefined) patch.timelineVisible = body.timeline_visible;
    if (body.event_time !== undefined) {
      const t = new Date(body.event_time);
      if (Number.isNaN(t.getTime())) throw badRequest('event_time 不是合法时间');
      patch.eventTime = t;
    }

    if (Object.keys(patch).length === 0) throw badRequest('没有需要更新的字段');

    const updated = await updateEvent(id, patch);
    if (!updated) throw notFound('事件不存在或已删除');

    return ok(toEventDto(updated));
  });

  // ==========================================================
  // DELETE /api/v1/timeline/:id   （docs/04 §30）
  // ==========================================================
  app.delete('/timeline/:id', async (request) => {
    const { id } = timelineEventIdParamSchema.parse(request.params);

    const existing = await findEventById(id);
    if (!existing) throw notFound('事件不存在');
    if (existing.deletedAt !== null) throw notFound('事件已删除');

    await softDeleteEvent(id);

    return ok({
      id,
      deleted: true,
      /**
       * 提示另一种语义：只想从时间线移除、并不想删掉时，
       * 应该用 PATCH timeline_visible=false。两者不可混用：
       *   软删除 = 「删掉这件事」
       *   隐藏   = 「还在，但我不想在时间线上看到它」
       */
      note: '若只是想从时间线隐藏，请用 PATCH {"timeline_visible": false} 而不是删除',
    });
  });

  // ==========================================================
  // POST /api/v1/timeline/:id/restore
  // ==========================================================
  /**
   * ⚠️ 这个端点 docs/04 §50 的清单里**没有**。
   *    加它的理由：DELETE 明确是软删除（有 deleted_at），
   *    而只有软删除却没有恢复路径是不自洽的 ——
   *    记忆那边就有 restore（§25）。属于补齐而非发明。
   */
  app.post('/timeline/:id/restore', async (request) => {
    const { id } = timelineEventIdParamSchema.parse(request.params);

    const existing = await findEventById(id);
    if (!existing) throw notFound('事件不存在');
    if (existing.deletedAt === null) throw conflict('事件未被删除，无需恢复');

    const restored = await restoreEvent(id);
    if (!restored) throw notFound('事件不存在');

    return ok(toEventDto(restored));
  });

  // ==========================================================
  // GET /api/v1/timeline/categories
  // ==========================================================
  /**
   * ⚠️ 同样不在 docs/04 §50 的清单里。
   *    加它的理由：category 是受控枚举（库层有 CHECK），
   *    前端做筛选下拉时必须知道可选值。
   *    硬编码在前端会与库层 CHECK 漂移 —— 加一个类别就要改两个地方。
   *    这也解释了为什么 TIMELINE_CATEGORIES 从 enums.ts 导出而不是另写一份。
   */
  app.get('/timeline/categories', async () =>
    ok({ items: TIMELINE_CATEGORIES.map((value) => ({ value })) })
  );
}

// ============================================================
// DTO
// ============================================================

function toEventDto(e: Event) {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    event_time: e.eventTime,
    category: e.category,
    importance_score: e.importanceScore,
    /** conversation | manual | system，前端据此显示"来自对话"徽标 */
    source_type: e.sourceType,
    source_message_id: e.sourceMessageId,
    timeline_visible: e.timelineVisible,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
  };
}

/**
 * 解析日期参数的边界。
 *
 * ⚠️ start 与 end 的语义必须区分：
 *    start=2026-01-01 应包含**这一整天**（00:00:00.000）
 *    end=2026-12-31   也应包含这一整天（23:59:59.999）
 *
 * 若 end 按 00:00:00 处理，用户查「2026 年整年」时 12 月 31 日
 * 当天的事件会全部消失 —— 这是个很隐蔽、很难被发现的错误。
 */
function parseDateBoundary(value: string, kind: 'start' | 'end'): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (dateOnly) {
    const base = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(base.getTime())) throw badRequest(`${kind} 不是合法日期`);
    return kind === 'start' ? base : new Date(base.getTime() + 86400_000 - 1);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw badRequest(`${kind} 不是合法时间`);
  return parsed;
}
