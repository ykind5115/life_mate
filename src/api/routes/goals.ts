/**
 * Goals 路由（docs/03 §21、§13.10）
 *
 *   GET    /api/v1/goals
 *   GET    /api/v1/goals/:id
 *   POST   /api/v1/goals
 *   PATCH  /api/v1/goals/:id
 *   DELETE /api/v1/goals/:id          默认软删除，?hard=true 物理删除
 *   POST   /api/v1/goals/:id/restore
 *
 * 【⚠️ 这组端点不在 docs/04 §50 的清单里 —— 是补齐文档遗漏】
 *   §13.10 明确要求：「用户不可直接新建 type='goal' 的记忆
 *   （必须通过 Goal 实体）」。而 docs/04 里没有任何 Goal 端点 ——
 *   两条规矩合在一起的结果是：用户**完全没有**创建目标的途径。
 *   而 PRD §7.4 的「我的记忆」明确把「目标」列为一类。
 *
 *   因此这组端点是必需的补齐，不是新功能。
 *   设计取舍已按 V1.0「做简单些」的要求收敛：
 *     · **不做抽取**（不让模型自动建目标）—— 生命周期变化是低频高价值操作，
 *       让用户显式管理比让模型猜可靠。日常对话里的目标信息
 *       已由 goal.long_term 槽位的 fact 承载。
 *     · **不做子目标 / 里程碑 / 依赖关系** —— docs/03 §21 的字段里就没有。
 */
import type { FastifyInstance } from 'fastify';

import { getOrCreateDefaultUser } from '../../database/repository/user-store.js';
import {
  createGoalWithProjection,
  findGoalById,
  hardDeleteGoalWithProjection,
  listGoals,
  restoreGoalWithProjection,
  softDeleteGoalWithProjection,
  updateGoalWithProjection,
} from '../../goals/goal-service.js';
import {
  createGoalSchema,
  deleteGoalQuerySchema,
  goalIdParamSchema,
  listGoalsQuerySchema,
  updateGoalSchema,
} from '../schemas.js';
import { badRequest, conflict, notFound, ok, paginate, toOffset } from '../errors.js';

export async function registerGoalRoutes(app: FastifyInstance): Promise<void> {
  // ==========================================================
  // GET /api/v1/goals
  // ==========================================================
  app.get('/goals', async (request) => {
    const query = listGoalsQuerySchema.parse(request.query);
    const user = await getOrCreateDefaultUser();

    const page = await listGoals({
      userId: user.id,
      ...(query.status !== undefined ? { status: query.status } : {}),
      limit: query.page_size,
      offset: toOffset(query.page, query.page_size),
    });

    return ok({
      items: page.items.map(toGoalDto),
      pagination: paginate({
        page: query.page,
        pageSize: query.page_size,
        total: page.total,
      }),
    });
  });

  // ==========================================================
  // GET /api/v1/goals/:id
  // ==========================================================
  app.get('/goals/:id', async (request) => {
    const { id } = goalIdParamSchema.parse(request.params);

    const goal = await findGoalById(id);
    // 与记忆一致：已删除的对详情不可见（尊重删除意图）
    if (!goal || goal.deletedAt !== null) throw notFound('目标不存在或已删除');

    return ok(toGoalDto(goal));
  });

  // ==========================================================
  // POST /api/v1/goals
  // ==========================================================
  app.post('/goals', async (request, reply) => {
    const body = createGoalSchema.parse(request.body);
    const user = await getOrCreateDefaultUser();

    const startedAt =
      body.started_at !== undefined && body.started_at !== null
        ? parseTime(body.started_at, 'started_at')
        : null;
    const targetAt =
      body.target_at !== undefined && body.target_at !== null
        ? parseTime(body.target_at, 'target_at')
        : null;

    /**
     * 时间顺序预校验。
     *
     * 库层的 chk_goals_time_order 是最终防线（C26），
     * 但它会以 23xxx 完整性错误冒泡，被映射成笼统的 409
     * 「该操作与已有数据冲突」—— 用户看不出是哪个字段的问题。
     * 这里提前校验一次，给出明确的 400 与字段名。
     */
    if (startedAt && targetAt && targetAt.getTime() < startedAt.getTime()) {
      throw badRequest('目标时间不能早于开始时间（chk_goals_time_order）');
    }

    const { goal } = await createGoalWithProjection({
      userId: user.id,
      title: body.title,
      description: body.description ?? null,
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      startedAt,
      targetAt,
    });

    reply.code(201);
    return ok(toGoalDto(goal));
  });

  // ==========================================================
  // PATCH /api/v1/goals/:id
  // ==========================================================
  app.patch('/goals/:id', async (request) => {
    const { id } = goalIdParamSchema.parse(request.params);
    const body = updateGoalSchema.parse(request.body);

    const existing = await findGoalById(id);
    if (!existing) throw notFound('目标不存在');
    if (existing.deletedAt !== null) {
      throw conflict('目标已删除，请先恢复再修改');
    }

    /**
     * 时间顺序预校验。
     *
     * 只校验**合并后**的结果，而不是只看入参：
     * 单独传 target_at 时，要跟库里已有的 started_at 比。
     * 漏了这一步会让「改目标时间改到开始之前」以 409 冒泡，
     * 而不是一个说清楚哪个字段有问题的 400。
     */
    const nextStartedAt =
      body.started_at !== undefined
        ? body.started_at === null
          ? null
          : parseTime(body.started_at, 'started_at')
        : existing.startedAt;
    const nextTargetAt =
      body.target_at !== undefined
        ? body.target_at === null
          ? null
          : parseTime(body.target_at, 'target_at')
        : existing.targetAt;

    if (nextTargetAt && nextStartedAt && nextTargetAt.getTime() < nextStartedAt.getTime()) {
      throw badRequest('目标时间不能早于开始时间（chk_goals_time_order）');
    }

    const result = await updateGoalWithProjection(id, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.started_at !== undefined ? { startedAt: nextStartedAt } : {}),
      ...(body.target_at !== undefined ? { targetAt: nextTargetAt } : {}),
      ...(body.completed_at !== undefined
        ? {
            completedAt:
              body.completed_at === null ? null : parseTime(body.completed_at, 'completed_at'),
          }
        : {}),
    });

    if (!result) throw notFound('目标不存在或已删除');

    return ok({
      ...toGoalDto(result.goal),
      /**
       * 状态转移的**软告警**（见 goal-state-machine.ts 的说明）。
       *
       * 非法转移（如 completed → active）会被执行但给出提示，
       * 而不是硬拒绝 —— 用户「标记完成了又发现没完成」是真实场景，
       * 硬拒会逼他删掉重建（丢失历史）。
       */
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    });
  });

  // ==========================================================
  // DELETE /api/v1/goals/:id
  // ==========================================================
  app.delete('/goals/:id', async (request) => {
    const { id } = goalIdParamSchema.parse(request.params);
    const query = deleteGoalQuerySchema.parse(request.query);

    const existing = await findGoalById(id);
    if (!existing) throw notFound('目标不存在');
    if (existing.deletedAt !== null) throw notFound('目标已删除');

    if (query.hard) {
      const { deletedProjections } = await hardDeleteGoalWithProjection(id);
      return ok({
        id,
        hard_deleted: true,
        /** 连带失效的投影记忆数。让调用方知道「影响了几条记忆」 */
        deleted_projection_memories: deletedProjections,
      });
    }

    const okSoft = await softDeleteGoalWithProjection(id);
    if (!okSoft) throw notFound('目标不存在或已删除');

    return ok({ id, hard_deleted: false, note: '可用 POST /:id/restore 恢复' });
  });

  // ==========================================================
  // POST /api/v1/goals/:id/restore
  // ==========================================================
  app.post('/goals/:id/restore', async (request) => {
    const { id } = goalIdParamSchema.parse(request.params);

    const existing = await findGoalById(id);
    if (!existing) throw notFound('目标不存在');
    if (existing.deletedAt === null) throw conflict('目标未被删除，无需恢复');

    const restored = await restoreGoalWithProjection(id);
    if (!restored) throw notFound('目标不存在');

    return ok(toGoalDto(restored));
  });
}

// ============================================================
// DTO
// ============================================================

/**
 * Goal DTO。
 *
 * `is_ongoing` 是给前端用的派生字段 —— 「还在进行」这个判断
 * 由状态机的 isOngoing 定义（active/paused），
 * 让前端自己判断会让两处定义漂移。
 */
function toGoalDto(g: {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  startedAt: Date | null;
  targetAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: g.id,
    title: g.title,
    description: g.description,
    status: g.status,
    priority: g.priority,
    started_at: g.startedAt,
    target_at: g.targetAt,
    completed_at: g.completedAt,
    is_ongoing: g.status === 'active' || g.status === 'paused',
    created_at: g.createdAt,
    updated_at: g.updatedAt,
  };
}

/** 解析时间参数。接受 YYYY-MM-DD 或完整 ISO 8601 */
function parseTime(value: string, field: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = dateOnly ? new Date(`${value}T00:00:00Z`) : new Date(value);

  if (Number.isNaN(parsed.getTime())) throw badRequest(`${field} 不是合法时间`);
  return parsed;
}
