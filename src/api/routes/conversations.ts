/**
 * Conversation 路由（docs/04 §12–§16）
 *
 *   GET    /api/v1/conversations
 *   GET    /api/v1/conversations/:id
 *   GET    /api/v1/conversations/:id/messages
 *   PATCH  /api/v1/conversations/:id
 *   DELETE /api/v1/conversations/:id
 *
 * 【分层】Controller 只做「校验 + 调服务 + 转协议」，不写业务判断。
 * 但本模块的多数操作是单表读写，没有超越仓库层的业务规则，
 * 因此直接调用仓库函数 —— 为每个端点造一层只做转发的 Service
 * 是纯样板代码。真正有业务规则的地方（聊天、删除级联）才走 Service。
 */
import type { FastifyInstance } from 'fastify';

import {
  deleteConversation,
  findAliveConversationById,
  findConversationById,
  findMessages,
  getOrCreateDefaultUser,
  listConversations,
  updateConversation,
  type Conversation,
  type Message,
} from '../../database/repository/index.js';
import { notFound, ok, paginate, toOffset } from '../errors.js';
import {
  conversationIdParamSchema,
  conversationMessagesQuerySchema,
  deleteConversationQuerySchema,
  listConversationsQuerySchema,
  updateConversationSchema,
} from '../schemas.js';

export async function registerConversationRoutes(app: FastifyInstance): Promise<void> {
  // ==========================================================
  // GET /api/v1/conversations
  // ==========================================================
  app.get('/conversations', async (request) => {
    const query = listConversationsQuerySchema.parse(request.query);
    const user = await getOrCreateDefaultUser();

    const page = await listConversations({
      userId: user.id,
      archived: query.archived,
      limit: query.page_size,
      offset: toOffset(query.page, query.page_size),
    });

    return ok({
      items: page.items.map(toConversationSummary),
      pagination: paginate({
        page: query.page,
        pageSize: query.page_size,
        total: page.total,
      }),
    });
  });

  // ==========================================================
  // GET /api/v1/conversations/:id
  // ==========================================================
  app.get('/conversations/:id', async (request) => {
    const { id } = conversationIdParamSchema.parse(request.params);

    /**
     * 这里用 findConversationById 而不是 alive 版本：
     * 删除后的会话仍应能按 id 打开并显示「[已删除的对话]」，
     * 否则前端的会话链接会变成永久 404。
     *
     * ⚠️ 但**不返回消息**：消息是物理删除的（C29），本来就查不到；
     *    即使能查到也不该返回 —— 用户删了就不该再看到内容。
     */
    const conversation = await findConversationById(id);
    if (!conversation) throw notFound('会话不存在');

    // 首页消息随详情返回（docs/04 §13 的响应里带 messages）
    const messages = await findMessages({ conversationId: id, limit: 50 });

    return ok({
      ...toConversationSummary(conversation),
      status: conversation.status,
      archived_at: conversation.archivedAt,
      deleted_at: conversation.deletedAt,
      messages: messages.items.map(toMessageDto),
    });
  });

  // ==========================================================
  // GET /api/v1/conversations/:id/messages
  // ==========================================================
  app.get('/conversations/:id/messages', async (request) => {
    const { id } = conversationIdParamSchema.parse(request.params);
    const query = conversationMessagesQuerySchema.parse(request.query);

    /**
     * 先确认会话存在：否则「会话 id 打错」与「会话没有消息」
     * 都会返回空列表，前端无法区分，用户会以为数据丢了。
     */
    const conversation = await findConversationById(id);
    if (!conversation) throw notFound('会话不存在');

    const page = await findMessages({
      conversationId: id,
      limit: query.page_size,
      offset: toOffset(query.page, query.page_size),
    });

    return ok({
      items: page.items.map(toMessageDto),
      pagination: paginate({
        page: query.page,
        pageSize: query.page_size,
        total: page.total,
      }),
    });
  });

  // ==========================================================
  // PATCH /api/v1/conversations/:id
  // ==========================================================
  app.patch('/conversations/:id', async (request) => {
    const { id } = conversationIdParamSchema.parse(request.params);
    const body = updateConversationSchema.parse(request.body);

    const updated = await updateConversation(id, { title: body.title });
    /**
     * updateConversation 内部已排除已删除的会话（aliveConversationCondition）——
     * 改一条已删除会话的标题会让「删除后不留内容痕迹」的承诺失效（C38）。
     */
    if (!updated) throw notFound('会话不存在或已删除');

    return ok({
      id: updated.id,
      title: updated.title,
      updated_at: updated.updatedAt,
    });
  });

  // ==========================================================
  // DELETE /api/v1/conversations/:id
  // ==========================================================
  app.delete('/conversations/:id', async (request) => {
    const { id } = conversationIdParamSchema.parse(request.params);
    const query = deleteConversationQuerySchema.parse(request.query);

    const existing = await findAliveConversationById(id);
    if (!existing) {
      // 已删除的会话再删一次：返回 404 而不是静默成功 ——
      // 静默成功会让调用方以为这次真的删掉了一个会话
      const any = await findConversationById(id);
      if (any) throw notFound('会话已删除');
      throw notFound('会话不存在');
    }

    /**
     * docs/03 §24.2 定义了两种删除语义，且明确要求「前端需明确提示差异」。
     * 因此这里**不替用户选**：缺省 keep（保守，不删数据），
     * 想连派生记忆一起删必须显式传参。
     */
    const result = await deleteConversation(
      id,
      query.delete_derived_memories ? 'delete' : 'keep',
      {}
    );

    return ok({
      deleted_messages: result.deletedMessages,
      deleted_memories: result.deletedMemories,
      memory_policy: query.delete_derived_memories ? 'delete' : 'keep',
    });
  });
}

// ============================================================
// DTO 转换
// ============================================================

/**
 * 会话摘要 DTO。
 *
 * ⚠️ 刻意**不返回 userId**：单用户系统里它是内部实现细节，
 *    暴露出去只会让前端产生「这是多用户系统」的错觉。
 *    也不返回 status/deletedAt —— 列表接口本来就只返回未删除的。
 */
function toConversationSummary(c: Conversation) {
  return {
    id: c.id,
    title: c.title,
    summary: c.summary,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

/**
 * 消息 DTO（docs/04 §13 的形状）。
 *
 * sequence 是 bigint 列（mode: number），由 pg 驱动返回 number。
 * 但驱动在某些配置下会返回字符串 —— 因此显式 Number() 转换，
 * 避免前端拿到 "3" 与 3 两种形状（实测过 MAX() 返回字符串的情况）。
 */
function toMessageDto(m: Message) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    sequence: Number(m.sequence),
    created_at: m.createdAt,
  };
}
