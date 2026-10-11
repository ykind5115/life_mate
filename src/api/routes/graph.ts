/**
 * 知识图谱路由（docs/16 §3.3）
 *
 *   GET /api/v1/graph
 *
 * 【为什么单独一个端点，而不是让前端拿几个列表自己在浏览器里拼】
 *   组装图谱要查 5 类数据（关系、事件、目标、记忆统计、人名派生），
 *   其中「从记忆里派生人名」这一步需要 GROUP BY 聚合 ——
 *   那是库该干的活，不是前端把 90 条记忆拉下来自己数。
 *
 * 【返回里没有正文】
 *   节点只带 label（人名/事件标题/目标标题）与计数。
 *   记忆正文只取前 40 字做 hover 提示，且**只在人的记忆分组节点上**。
 */
import type { FastifyInstance } from 'fastify';

import { getOrCreateDefaultUser } from '../../database/repository/user-store.js';
import { buildKnowledgeGraph } from '../../timeline/knowledge-graph.js';
import { graphQuerySchema } from '../schemas.js';
import { ok } from '../errors.js';

export async function registerGraphRoutes(app: FastifyInstance): Promise<void> {
  app.get('/graph', async (request) => {
    const query = graphQuerySchema.parse(request.query);
    const user = await getOrCreateDefaultUser();

    const graph = await buildKnowledgeGraph({
      userId: user.id,
      userName: user.name,
      maxPerKind: query.max_per_kind,
    });

    return ok(graph);
  });
}
