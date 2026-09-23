/**
 * Memory 路由（docs/04 §17–§26）
 *
 *   GET    /api/v1/memories                 列表
 *   GET    /api/v1/memories/search          搜索（§20）
 *   GET    /api/v1/memories/:id             详情
 *   GET    /api/v1/memories/:id/sources     来源（§26）
 *   POST   /api/v1/memories                 手工创建（§22）
 *   PATCH  /api/v1/memories/:id             更新（§23，受限，见下）
 *   DELETE /api/v1/memories/:id             软删除（§24）
 *   POST   /api/v1/memories/:id/restore     恢复（§25）
 *
 * 【⚠️ PATCH 的文档冲突 —— 本实现按保守口径处理，需要确认】
 *   docs/04 §23 允许 PATCH 改 content 并「重新生成 Embedding」。
 *   但 Q1 已锁定「记忆正文永不就地修改」，docs/03 §13.1 明确禁止
 *   `UPDATE memories.content`，理由：
 *     · 改内容会让 valid_from 语义二义（记录时间还是事实时间）
 *     · 「用户过去住在广州」本身是需要被记住的历史事实，就地改会让它消失
 *     · 时间线与历史查询依赖旧记录仍然存在
 *
 *   因此本接口**只允许改系统认知类字段**（importance_score），
 *   改 content 返回 422 并提示改用「新建 + 替代」的路径。
 *   这是文档之间的冲突，不是实现遗漏 —— 已在交付说明中回报。
 */
import type { FastifyInstance } from 'fastify';

import {
  createMemory,
  findByIdIncludingInactive,
  findConversationIdsByMessageIds,
  findSourcesByMemoryId,
  getOrCreateDefaultUser,
  listCurrent,
  listForManagement,
  restoreMemory,
  softDeleteMemory,
  updateMemoryScores,
  type Memory,
} from '../../database/repository/index.js';
import { retrieveMemories } from '../../memory/retriever.js';
import { badRequest, conflict, notFound, ok, paginate, toOffset } from '../errors.js';
import {
  createMemorySchema,
  listMemoriesQuerySchema,
  memoryIdParamSchema,
  searchMemoriesQuerySchema,
  updateMemorySchema,
} from '../schemas.js';

export async function registerMemoryRoutes(app: FastifyInstance): Promise<void> {
  // ==========================================================
  // GET /api/v1/memories
  // ==========================================================
  app.get('/memories', async (request) => {
    const query = listMemoriesQuerySchema.parse(request.query);
    const user = await getOrCreateDefaultUser();

    const filter = {
      userId: user.id,
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      limit: query.page_size,
      offset: toOffset(query.page, query.page_size),
    };

    /**
     * 两种视图口径不同，这不是重复实现：
     *   current    —— 只返回「当前有效」的记忆（§13.6 谓词），即 Agent 能看到的那批
     *   management —— 包含 conflict / superseded / archived，但排除已删除的
     *
     * 前端「我的记忆」页用 current，「记忆管理 / 待裁决」页用 management。
     * 用一个接口加参数而不是两个端点：两者是同一资源的两种视图，
     * 分成两个端点会让分页、过滤这些参数各写一遍。
     */
    const page =
      query.view === 'management'
        ? await listForManagement(filter)
        : await listCurrent(filter);

    return ok({
      items: page.items.map((m) => toMemoryDto(m, { includeScores: true })),
      pagination: paginate({
        page: query.page,
        pageSize: query.page_size,
        total: page.total,
      }),
    });
  });

  // ==========================================================
  // GET /api/v1/memories/search   （docs/04 §20）
  // ==========================================================
  /**
   * ⚠️ 必须注册在 /memories/:id **之前**。
   *    Fastify 的静态路由优先于参数路由，因此顺序其实不影响匹配，
   *    但放在前面能让「这条路不是 :id」这件事一眼可见。
   */
  app.get('/memories/search', async (request) => {
    const query = searchMemoriesQuerySchema.parse(request.query);
    const user = await getOrCreateDefaultUser();

    /**
     * 走完整检索链路（向量 + 关键词 + 结构化 → RRF → 重排），
     * 而不是只做 LIKE：这个端点存在的主要用途就是「检验检索质量」，
     * 若它走的路径与 Agent 实际用的不同，调试价值就没了（docs/04 §21）。
     */
    const result = await retrieveMemories({
      userId: user.id,
      query: query.q,
      limit: query.limit,
    });

    // 从 candidates 取分数：memories 只有正文，没有排名信息
    const scoreById = new Map(result.candidates.map((c) => [c.memory.id, c]));

    return ok({
      items: result.memories.map((m) => {
        const scored = scoreById.get(m.id);
        return {
          ...toMemoryDto(m),
          /** 最终重排得分。前端据此判断「这条有多相关」 */
          score: scored?.finalScore ?? 0,
          /** 各通道名次，用于排查「为什么这条没被召回」 */
          ranks: scored?.ranks ?? {},
        };
      }),
      /** 检索诊断。**不含正文** */
      diagnostics: result.diagnostics,
    });
  });

  // ==========================================================
  // GET /api/v1/memories/:id
  // ==========================================================
  app.get('/memories/:id', async (request) => {
    const { id } = memoryIdParamSchema.parse(request.params);

    /**
     * 用 findByIdIncludingInactive（含 conflict / archived / superseded，
     * 但排除已删除的）而不是 findCurrentById：
     *   用户在管理页点到一条待裁决的冲突记忆时，不该得到 404。
     *   已删除的仍然看不到 —— 那要尊重删除意图（§29.1）。
     */
    const memory = await findByIdIncludingInactive(id);
    if (!memory) {
      // 区分「不存在」与「已删除但存在」：前者 404，后者同 404 但不误导
      const deleted = await findByIdIncludingInactive(id, { includeDeletedForRestore: true });
      throw notFound(deleted ? '记忆已删除' : '记忆不存在');
    }

    return ok({
      ...toMemoryDto(memory, { includeScores: true }),
      /** 无槽位表示不参与冲突判定（§13.7） */
      participates_in_conflict: memory.predicateKey !== null && memory.subjectKey !== null,
    });
  });

  // ==========================================================
  // GET /api/v1/memories/:id/sources   （docs/04 §26）
  // ==========================================================
  app.get('/memories/:id/sources', async (request) => {
    const { id } = memoryIdParamSchema.parse(request.params);

    const memory = await findByIdIncludingInactive(id, { includeDeletedForRestore: true });
    if (!memory) throw notFound('记忆不存在');

    const sources = await findSourcesByMemoryId(id);

    /**
     * ⚠️ C22：memory_sources 没有 conversation_id，
     *    「来自哪个会话」必须 JOIN messages 反查（§15.4）。
     *    一次批量查完再映射，避免前端为每条来源各发一个请求。
     */
    const messageIds = sources.map((s) => s.messageId).filter((x): x is string => x !== null);
    const conversationByMessage = await findConversationIdsByMessageIds(messageIds);

    return ok({
      items: sources.map((s) => ({
        id: s.id,
        source_type: s.sourceType,
        message_id: s.messageId,
        /**
         * 消息已被物理删除时会是 null（JOIN 不到）。
         * 前端据此显示「原始对话已删除」（§24.2 末尾的要求）。
         */
        conversation_id: s.messageId ? (conversationByMessage.get(s.messageId) ?? null) : null,
        event_id: s.eventId,
        goal_id: s.goalId,
        created_at: s.createdAt,
      })),
    });
  });

  // ==========================================================
  // POST /api/v1/memories   （docs/04 §22）
  // ==========================================================
  app.post('/memories', async (request, reply) => {
    const body = createMemorySchema.parse(request.body);
    const user = await getOrCreateDefaultUser();

    /**
     * 手工创建的记忆来源类型是 'manual'（§15 的 SOURCE_TYPES）。
     * 不伪造一个 message_id：那会让「这条记忆从哪来」的追溯变成假信息。
     */
    const memory = await createMemory({
      userId: user.id,
      type: body.type,
      content: body.content,
      ...(body.subject_key !== undefined ? { subjectKey: body.subject_key } : {}),
      ...(body.predicate_key !== undefined ? { predicateKey: body.predicate_key } : {}),
      ...(body.object_value !== undefined ? { objectValue: body.object_value } : {}),
      ...(body.polarity !== undefined ? { polarity: body.polarity } : {}),
      /**
       * 手工创建的记忆置信度给 1.0：用户自己说的，没有推断成分。
       * 重要度交给用户后续调整，缺省 0.5（不擅自替用户判断重要性）。
       */
      confidenceScore: 1.0,
      sources: [{ sourceType: 'manual' }],
    });

    /**
     * ⚠️ 这里**不生成 embedding**。
     *
     * 原因：生成向量是外部调用，而 createMemory 内部已经用了事务（§25.2）。
     * 更重要的是——不生成向量不会让这条记忆查不到，
     * 它仍可被关键词通道与列表接口召回，只是少了语义召回。
     * 按 extraction-pipeline 的做法补一次异步向量化是对的，
     * 但那属于「补齐缺失向量的任务」，与本节端点无关。
     *
     * 未做标记：本端点的返回里没有 embedding 状态，前端无法知道
     * 这条记忆暂时搜不到。已记入交付说明。
     */
    reply.code(201);
    return ok(toMemoryDto(memory, { includeScores: true }));
  });

  // ==========================================================
  // PATCH /api/v1/memories/:id   （受限，见文件头说明）
  // ==========================================================
  app.patch('/memories/:id', async (request) => {
    const { id } = memoryIdParamSchema.parse(request.params);
    const body = updateMemorySchema.parse(request.body);

    /**
     * ⚠️ 必须用 includeDeletedForRestore 才看得到已删除的记忆。
     *
     * 默认口径下（findByIdIncludingInactive）已删除的记录直接不可见，
     * 于是「已删除」会走到 404 分支 —— 但 404 的语义是「没有这条记忆」，
     * 而实际情况是「有，但状态不允许改」。这个区别对前端有实际意义
     * （一个提示「记录不存在」，一个提示「请先恢复」）。
     */
    const existing = await findByIdIncludingInactive(id, { includeDeletedForRestore: true });
    if (!existing) throw notFound('记忆不存在');

    if (existing.status === 'deleted') {
      throw conflict('记忆已删除，请先恢复再修改');
    }

    if (body.importance_score === undefined) {
      throw badRequest('没有需要更新的字段');
    }

    /**
     * 只走 updateMemoryScores —— C25 允许更新的字段之一。
     * 它改变的是「系统对这条记忆的判断」，不是「用户说的是什么事实」，
     * 因此不违反 Q1 的不可变原则。
     */
    const updated = await updateMemoryScores({
      memoryId: id,
      importanceScore: body.importance_score,
    });

    return ok(toMemoryDto(updated, { includeScores: true }));
  });

  // ==========================================================
  // DELETE /api/v1/memories/:id   （docs/04 §24，软删除）
  // ==========================================================
  app.delete('/memories/:id', async (request) => {
    const { id } = memoryIdParamSchema.parse(request.params);

    const existing = await findByIdIncludingInactive(id);
    if (!existing) throw notFound('记忆不存在或已删除');

    await softDeleteMemory(id);

    return ok({
      id,
      status: 'deleted',
      /**
       * 提醒调用方：软删除不影响已派生出去的内容。
       * 这是事实陈述，不是免责声明 —— 检索谓词会在下一次召回时立即排除它。
       */
      note: '已从所有召回路径排除，可用 POST /:id/restore 恢复',
    });
  });

  // ==========================================================
  // POST /api/v1/memories/:id/restore   （docs/04 §25）
  // ==========================================================
  app.post('/memories/:id/restore', async (request) => {
    const { id } = memoryIdParamSchema.parse(request.params);

    /**
     * 必须用 includeDeletedForRestore 才看得到已删除的记忆，
     * 否则这条路径永远 404（这正是那个选项存在的唯一理由）。
     */
    const deleted = await findByIdIncludingInactive(id, { includeDeletedForRestore: true });
    if (!deleted) throw notFound('记忆不存在');

    if (deleted.status !== 'deleted') {
      throw conflict(`记忆当前状态是 ${deleted.status}，只有已删除的可以恢复`);
    }

    const { memory, becameConflict } = await restoreMemory(id);

    return ok({
      ...toMemoryDto(memory, { includeScores: true }),
      /**
       * 恢复时若槽位已被别的记忆占用，会转为 conflict 而不是 active ——
       * 直接置 active 会撞上 uq_memories_current_slot。
       * 前端必须据此提示用户去裁决，否则这条记忆会「恢复了但搜不到」。
       */
      became_conflict: becameConflict,
    });
  });
}

// ============================================================
// DTO 转换
// ============================================================

/**
 * 记忆 DTO（docs/04 §18 的形状）。
 *
 * ⚠️ 刻意不返回 userId：单用户系统里它是内部实现细节。
 *    也不返回 supersededBy —— 那需要前端再发请求解析，
 *    且 C23 明确它可能指向已被物理删除的记录（悬空指针）。
 *    要展示替代历史请用专门的接口。
 */
function toMemoryDto(m: Memory, options: { includeScores?: boolean } = {}) {
  return {
    id: m.id,
    type: m.type,
    content: m.content,
    status: m.status,

    // ---------- 结构化槽位（Q2）----------
    subject_key: m.subjectKey,
    predicate_key: m.predicateKey,
    object_value: m.objectValue,
    polarity: m.polarity,

    // ---------- 双时间轴 ----------
    valid_from: m.validFrom,
    valid_until: m.validUntil,

    // ---------- 评分 ----------
    /** 仅在需要时返回：列表接口默认不返回，避免把内部评分当业务数据用 */
    ...(options.includeScores === true
      ? {
          importance_score: m.importanceScore,
          confidence_score: m.confidenceScore,
          source_count: m.sourceCount,
        }
      : {}),

    created_at: m.createdAt,
    updated_at: m.updatedAt,
  };
}
