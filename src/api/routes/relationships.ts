/**
 * Relationships 路由（docs/03 §22）
 *
 *   GET    /api/v1/relationships
 *   GET    /api/v1/relationships/:id
 *   POST   /api/v1/relationships
 *   PATCH  /api/v1/relationships/:id
 *   DELETE /api/v1/relationships/:id
 *   POST   /api/v1/relationships/:id/restore
 *
 * 【⚠️ 这组端点此前完全不存在】
 *   表从 Phase 3 就建好了，但一直没有 Repository / Service / API ——
 *   AGENTS.md 把它列为未完成项。docs/16 的前端改版要展示人际关系，
 *   因此补齐「表 → 仓储 → 接口 → 界面」这条链路。
 *
 * 【日志纪律】§29.1 禁止记录 relationship.name（人名是私密信息）。
 *   本文件的错误信息里**不含人名**。
 */
import type { FastifyInstance } from 'fastify';

import { getOrCreateDefaultUser } from '../../database/repository/user-store.js';
import {
  createRelationship,
  findRelationshipById,
  listRelationships,
  restoreRelationship,
  softDeleteRelationship,
  updateRelationship,
} from '../../database/repository/index.js';
import type { Relationship } from '../../database/schema/relationships.js';
import {
  createRelationshipSchema,
  listRelationshipsQuerySchema,
  relationshipIdParamSchema,
  updateRelationshipSchema,
} from '../schemas.js';
import { conflict, notFound, ok, paginate, toOffset } from '../errors.js';

export async function registerRelationshipRoutes(app: FastifyInstance): Promise<void> {
  // ==========================================================
  // GET /api/v1/relationships
  // ==========================================================
  app.get('/relationships', async (request) => {
    const query = listRelationshipsQuerySchema.parse(request.query);
    const user = await getOrCreateDefaultUser();

    const page = await listRelationships({
      userId: user.id,
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.q !== undefined ? { nameQuery: query.q } : {}),
      limit: query.page_size,
      offset: toOffset(query.page, query.page_size),
    });

    return ok({
      items: page.items.map(toRelationshipDto),
      pagination: paginate({
        page: query.page,
        pageSize: query.page_size,
        total: page.total,
      }),
    });
  });

  // ==========================================================
  // GET /api/v1/relationships/:id
  // ==========================================================
  app.get('/relationships/:id', async (request) => {
    const { id } = relationshipIdParamSchema.parse(request.params);

    const relationship = await findRelationshipById(id);
    // 与记忆/目标一致：已删除的对详情不可见（尊重删除意图）
    if (!relationship || relationship.deletedAt !== null) {
      throw notFound('这条关系不存在或已删除');
    }

    return ok(toRelationshipDto(relationship));
  });

  // ==========================================================
  // POST /api/v1/relationships
  // ==========================================================
  app.post('/relationships', async (request, reply) => {
    const body = createRelationshipSchema.parse(request.body);
    const user = await getOrCreateDefaultUser();

    try {
      const created = await createRelationship({
        userId: user.id,
        name: body.name,
        relationType: body.relation_type ?? null,
        description: body.description ?? null,
        ...(body.status !== undefined ? { status: body.status } : {}),
      });

      reply.code(201);
      return ok(toRelationshipDto(created));
    } catch (err) {
      /**
       * 撞 uq_relationships_user_name（同一用户下未删除的关系名唯一）。
       *
       * ⚠️ 靠**唯一索引**而不是「先查再插」——
       *    后者是竞态写法（AGENTS.md §4 记过同类教训）。
       *    这里只负责把库层错误翻译成人话。
       */
      if (isUniqueViolation(err)) {
        throw conflict('这个名字已经记过了。若想改信息，请编辑那一条。');
      }
      throw err;
    }
  });

  // ==========================================================
  // PATCH /api/v1/relationships/:id
  // ==========================================================
  app.patch('/relationships/:id', async (request) => {
    const { id } = relationshipIdParamSchema.parse(request.params);
    const body = updateRelationshipSchema.parse(request.body);

    try {
      const updated = await updateRelationship(id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.relation_type !== undefined ? { relationType: body.relation_type } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      });

      if (!updated) throw notFound('这条关系不存在或已删除');
      return ok(toRelationshipDto(updated));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict('已经有一个同名的关系了。');
      }
      throw err;
    }
  });

  // ==========================================================
  // DELETE /api/v1/relationships/:id
  // ==========================================================
  app.delete('/relationships/:id', async (request) => {
    const { id } = relationshipIdParamSchema.parse(request.params);

    const deleted = await softDeleteRelationship(id);
    if (!deleted) throw notFound('这条关系不存在或已删除');

    return ok({ id: deleted.id, deleted: true });
  });

  // ==========================================================
  // POST /api/v1/relationships/:id/restore
  // ==========================================================
  app.post('/relationships/:id/restore', async (request) => {
    const { id } = relationshipIdParamSchema.parse(request.params);

    const restored = await restoreRelationship(id);
    if (!restored) throw notFound('这条关系不存在');

    return ok(toRelationshipDto(restored));
  });
}

/** DTO：snake_case（docs/04 的 API 口径） */
function toRelationshipDto(r: Relationship) {
  return {
    id: r.id,
    name: r.name,
    relation_type: r.relationType,
    description: r.description,
    status: r.status,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

/**
 * 判断是否唯一约束冲突。
 *
 * ⚠️ 要**穿过 cause 链**找：Drizzle 把驱动错误包成
 *    `Error: Failed query: ... [cause]: error: duplicate key value ...`，
 *    直接看外层 message 匹配不到，postgres 的 code 也在 cause 上。
 *    （本项目已多次踩到这个包装层，见 shared/error-info.ts。）
 */
function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  let depth = 0;
  while (cur instanceof Error && depth < 6) {
    const code = (cur as { code?: string }).code;
    if (code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
    depth++;
  }
  return false;
}
