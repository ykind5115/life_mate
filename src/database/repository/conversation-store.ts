/**
 * Conversation / Message 写操作与状态查询
 *
 * 依据：《数据库设计 V1.1》§9（conversations）、§10（messages）、§24.3（删除顺序）
 *
 * 【本文件的三个关键纪律】
 *
 * ① sequence 必须在**单条 SQL 内**分配（§10.4）
 *    先 SELECT MAX(sequence) 再 INSERT 是经典的竞态写法：
 *    并发的两次请求会读到同一个 max，然后一起插入同一个序号，
 *    第二条撞 uq_messages_conversation_sequence 报错。
 *    这里用 INSERT ... SELECT 子查询在库里原子完成。
 *
 * ② 会话是软删除，messages 与摘要必须**物理删除**（C29）
 *    两张表都没有 deleted_at，文档也明确要求内容不得残留。
 *
 * ③ 删除会话时 title / summary 必须置占位文案（C38）
 *    title 是从对话内容生成的，属于用户可见的私密信息；
 *    保留原文与 §24.1 的删除意图直接冲突。
 */
import { and, asc, count, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';

import { db } from '../client.js';
import { conversations, type Conversation } from '../schema/conversations.js';
import { messages, type Message } from '../schema/messages.js';
import {
  parseMessageMetadata,
  type MessageMetadata,
} from '../schema/message-metadata.js';
import { conversationSummaries } from '../schema/conversation-summaries.js';
import { memories } from '../schema/memories.js';
import { memoryEmbeddings } from '../schema/memory-embeddings.js';
import { memorySources } from '../schema/memory-sources.js';
import type { ExecutorOption, Paginated } from './types.js';

/**
 * C38：会话删除时的固定占位文案。
 *
 * 契约值 —— 前端可能按它判断「这是一条已删除的会话」，因此不允许各写各的。
 */
export const DELETED_CONVERSATION_TITLE = '[已删除的对话]';

/** 未删除的会话谓词。用于所有面向用户的列表与详情查询 */
function aliveConversationCondition() {
  return and(isNull(conversations.deletedAt), ne(conversations.status, 'deleted'))!;
}

/**
 * appendMessage 接受的 metadata 形状。
 *
 * 用具名别名而不是 `Record<string, unknown>`：调用方在编译期就能看到
 * 允许哪些键，而不是运行时才被 Zod 拒绝。
 */
export type MessageMetadataInput = MessageMetadata;

// ============================================================
// 会话
// ============================================================

/**
 * 新建会话。
 *
 * title 允许为空：调用方（ChatService）会在首轮对话时先写一个占位标题，
 * 随后由后台的 conversation-title 服务用 LLM 覆盖成正式标题。
 * 本层只提供写入能力，不决定标题内容 —— 生成策略属于 service 层。
 */
export async function createConversation(
  input: { userId: string; title?: string | null; summary?: string | null },
  options: ExecutorOption = {}
): Promise<Conversation> {
  const exec = options.executor ?? db;

  const rows = await exec
    .insert(conversations)
    .values({
      userId: input.userId,
      title: input.title ?? null,
      summary: input.summary ?? null,
      status: 'active',
    })
    .returning();

  const conversation = rows[0];
  if (!conversation) throw new Error('插入会话后未返回记录');
  return conversation;
}

/**
 * 按 id 取会话，**包含已删除的**。
 *
 * 调用方若需要区分，请自行检查 status / deletedAt。
 * 为什么不做成「只取未删除的」：删除后要回显「[已删除的对话]」也得取到行，
 * 而且 id 是 UUID，拿不到和拿到一条 deleted 是两种不同的错误语义。
 */
export async function findConversationById(
  id: string,
  options: ExecutorOption = {}
): Promise<Conversation | undefined> {
  const exec = options.executor ?? db;

  const rows = await exec
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);

  return rows[0];
}

/**
 * 按 id 取**未删除**的会话。
 *
 * 聊天入口必须用这个：往已删除的会话里追加消息会违背用户的删除意图。
 */
export async function findAliveConversationById(
  id: string,
  options: ExecutorOption = {}
): Promise<Conversation | undefined> {
  const exec = options.executor ?? db;

  const rows = await exec
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), aliveConversationCondition()))
    .limit(1);

  return rows[0];
}

/**
 * 分页列出会话（默认排除已删除与已归档，可按需包含归档）。
 *
 * 返回的 title 已由删除流程置为占位文案，因此这里不需要额外过滤内容。
 */
export async function listConversations(
  filter: {
    userId: string;
    /** true 时只列归档的；缺省只列未归档的 */
    archived?: boolean;
    limit?: number;
    offset?: number;
  },
  options: ExecutorOption = {}
): Promise<Paginated<Conversation>> {
  const exec = options.executor ?? db;
  const limit = clampLimit(filter.limit);
  const offset = Math.max(0, filter.offset ?? 0);

  const conds = [
    eq(conversations.userId, filter.userId),
    aliveConversationCondition(),
    eq(conversations.status, filter.archived ? 'archived' : 'active'),
  ];

  const where = and(...conds);

  const [items, totalRows] = await Promise.all([
    exec
      .select()
      .from(conversations)
      .where(where)
      /**
       * 最近有动静的排前面（用户找的是「刚才聊的那个」）。
       *
       * ⚠️ created_at 这个次级排序键不是装饰：
       *    now() 在**同一个事务内是常量**（事务开始时间），
       *    因此同一事务里创建的多条会话 updated_at 完全相同，
       *    只按 updated_at 排序的结果是不确定的 —— 实测复现过，
       *    同一份数据两次查询给出不同顺序（分页时还会导致条目重复/丢失）。
       */
      .orderBy(desc(conversations.updatedAt), desc(conversations.createdAt))
      .limit(limit)
      .offset(offset),
    exec.select({ n: count() }).from(conversations).where(where),
  ]);

  return { items, total: totalRows[0]?.n ?? 0, limit, offset };
}

/**
 * 更新会话标题或摘要（不改状态）。
 *
 * @param options.withUpdatedAt 是否推进 updated_at，缺省 true。
 *
 * ⚠️ 为什么要能关掉它：
 *    「自动生成标题」是**后台**补写 —— 用户发完消息、响应已经返回之后才跑。
 *    它若推进 updated_at，会把一条**旧会话**顶到列表最前面。
 *    实测场景：用户在第一轮聊完就再没碰过这个会话，
 *    第二天打开列表，标题生成任务迟到完成 → 那条旧会话跳到顶部。
 *    标题是元数据，不是「有新消息」，不该影响排序。
 *    用户手动改名（PATCH /conversations/:id）仍然要推进 —— 那是主动操作。
 */
export async function updateConversation(
  id: string,
  patch: { title?: string; summary?: string | null },
  options: ExecutorOption & { withUpdatedAt?: boolean } = {}
): Promise<Conversation | undefined> {
  const exec = options.executor ?? db;
  const withUpdatedAt = options.withUpdatedAt ?? true;

  const rows = await exec
    .update(conversations)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      // clock_timestamp 而非 now()：now() 在事务内是常量，推不动排序（见 touchConversation）
      ...(withUpdatedAt ? { updatedAt: sql`clock_timestamp()` } : {}),
    })
    .where(and(eq(conversations.id, id), aliveConversationCondition()))
    .returning();

  return rows[0];
}

/**
 * 触碰会话的 updated_at。
 *
 * 每条消息落库后都要调用 —— 否则列表按 updated_at 排序时，
 * 刚聊过的会话会沉到底部。
 *
 * ⚠️ 这里用 clock_timestamp() 而不是 now()：
 *    now() 返回的是**事务开始时间**，在同一个事务内是常量。
 *    一次聊天会把「用户消息 + 助手消息」写在同一个事务里，
 *    用 now() 时这次会话的 updated_at 与事务开始时创建的会话完全相同，
 *    「刚聊过的排最前」就不成立了。
 *    clock_timestamp() 返回语句实际执行的时刻，才能真正推进顺序。
 *
 *    副作用：同一事务内多次触碰会得到递增但属于「真实时间」的值，
 *    这正是列表排序想要的语义。
 */
export async function touchConversation(
  id: string,
  options: ExecutorOption = {}
): Promise<void> {
  const exec = options.executor ?? db;

  await exec
    .update(conversations)
    .set({ updatedAt: sql`clock_timestamp()` })
    .where(eq(conversations.id, id));
}

// ============================================================
// 消息
// ============================================================

/**
 * 追加一条消息，序号在库内原子分配（§10.4）。
 *
 * 为什么不用「先查 max 再插入」：并发请求会读到同一个 max 并插入同一个序号，
 * 第二条撞 uq_messages_conversation_sequence。这里的 INSERT ... SELECT
 * 让 PostgreSQL 在一条语句内完成读取与写入。
 *
 * ⚠️ 唯一约束仍然是最终防线：真正的并发下仍可能有一个请求拿到 23505，
 *    调用方（服务层）应把它当作「可重试的序号冲突」而不是内部错误。
 *    单用户场景下不会发生，但不能假设它不会。
 *
 * ⚠️ metadata 在**这里**校验，而不是信调用方（§16.3 的强制要求）。
 *    白名单之外的键会抛 ZodError —— 这是刻意的：
 *    静默丢弃会让「我明明写了为什么查不到」变成新的谜题，
 *    而允许任意键则等于 §16.2 那条「不得存正文副本」形同虚设。
 */
export async function appendMessage(
  input: {
    conversationId: string;
    role: Message['role'];
    content: string;
    /** 白名单结构，见 database/schema/message-metadata.ts */
    metadata?: MessageMetadataInput;
  },
  options: ExecutorOption = {}
): Promise<Message> {
  const exec = options.executor ?? db;

  const rows = await exec
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      metadata: parseMessageMetadata(input.metadata),
      sequence: sql`(
        SELECT COALESCE(MAX(${messages.sequence}), 0) + 1
          FROM ${messages}
         WHERE ${messages.conversationId} = ${input.conversationId}
      )`,
    })
    .returning();

  const message = rows[0];
  if (!message) throw new Error('插入消息后未返回记录');
  return message;
}

/**
 * 分页读取会话消息，按 sequence 升序。
 *
 * ⚠️ 升序是刻意的：前端聊天窗按时间正序渲染。
 *    但要注意「升序 + 分页」的正确用法是**从第 1 页往后翻**，
 *    「取最近 N 条」请用 findRecentMessages —— 用升序分页去取最后一页
 *    会先扫过前面所有行。
 */
export async function findMessages(
  params: { conversationId: string; limit?: number; offset?: number },
  options: ExecutorOption = {}
): Promise<Paginated<Message>> {
  const exec = options.executor ?? db;
  const limit = clampLimit(params.limit);
  const offset = Math.max(0, params.offset ?? 0);

  const where = eq(messages.conversationId, params.conversationId);

  const [items, totalRows] = await Promise.all([
    exec
      .select()
      .from(messages)
      .where(where)
      .orderBy(asc(messages.sequence))
      .limit(limit)
      .offset(offset),
    exec.select({ n: count() }).from(messages).where(where),
  ]);

  return { items, total: totalRows[0]?.n ?? 0, limit, offset };
}

/**
 * 取「上一个会话」及其末尾若干条消息（跨会话衔接用，docs/15）。
 *
 * 【要解决什么】
 *   用户在短时间内开两个会话时，第二个会话的第一轮历史是空的 ——
 *   上下文组装只看当前会话，导致模型接不上「刚刚聊到哪」。
 *   实测（2026-10-08）：会话 A 10:14 结束、会话 B 10:15 开始，
 *   模型在 B 里连续三次坚称「你没跟我说过」，还编了个「你刚才没细讲」的理由。
 *
 * 【为什么必须带 user_id 过滤】
 *   多用户隔离的**唯一**依据就是这个条件。少写它等于把别人的对话
 *   拼进当前用户的上下文 —— 与记忆检索同一个纪律，不是可选项。
 *
 * 【排除条件】
 *   · 当前会话自己（excludeConversationId）—— 否则会把自己当成"上一个"
 *   · 已删除的会话（deleted_at IS NOT NULL）—— 用户删掉的内容不得复活，
 *     这与 §24.1 的删除意图直接冲突
 *   · 没有任何消息的会话 —— 空会话没有可衔接的内容
 */
export async function findPreviousConversationWithTail(
  params: {
    userId: string;
    /**
     * 要排除的会话（通常是当前会话）。
     *
     * ⚠️ **可以省略**，省略时不加排除条件。
     *    不要传空串来「表示没有」—— `id <> ''` 会和 uuid 列比较，
     *    PostgreSQL 直接报 `invalid input syntax for type uuid: ""`（22P02）。
     *    实测踩到（2026-10-08）：新会话第一轮恰好没有会话 id，
     *    于是这个功能在**真实场景下 100% 失效**，而当时写的测试
     *    全都传了合法 UUID，一个都没抓到。
     */
    excludeConversationId?: string;
    /** 只考虑「最后一条消息」在此时刻之后的会话（时间窗） */
    since: Date;
    /** 取末尾多少条消息 */
    limit: number;
  },
  options: ExecutorOption = {}
): Promise<{ conversation: Conversation; messages: Message[] } | null> {
  const exec = options.executor ?? db;

  /**
   * 找「最后一条消息最新」的那个会话。
   *
   * 用 messages 的 max(created_at) 而不是 conversations.updated_at：
   *   updated_at 会被标题生成、摘要写入等后台动作刷新，
   *   那些动作与「用户最后说话的时间」不是一回事 —— 用它会选错会话。
   */
  const latestMessageAt = sql<Date>`max(${messages.createdAt})`;

  const conds = [
    eq(conversations.userId, params.userId),
    isNull(conversations.deletedAt),
  ];
  // 条件式加入，而不是传一个空串进去
  if (params.excludeConversationId !== undefined) {
    conds.push(ne(conversations.id, params.excludeConversationId));
  }

  const rows = await exec
    .select({
      conversation: conversations,
      lastMessageAt: latestMessageAt,
    })
    .from(conversations)
    .innerJoin(messages, eq(messages.conversationId, conversations.id))
    .where(and(...conds))
    .groupBy(conversations.id)
    .having(sql`max(${messages.createdAt}) >= ${params.since}`)
    .orderBy(desc(latestMessageAt))
    .limit(1);

  const found = rows[0];
  if (!found) return null;

  const tail = await findRecentMessages(
    { conversationId: found.conversation.id, limit: params.limit },
    options
  );

  // 理论上 innerJoin 已保证非空；真为空也只是没有可注入的内容
  if (tail.length === 0) return null;

  return { conversation: found.conversation, messages: tail };
}

/**
 * 取会话最近的 N 条消息，**返回时按时间正序**。
 *
 * 用途：组装 Agent 上下文。实现上先按 sequence 倒序取 N 条，
 * 再在内存里反转 —— 直接用升序 limit N 会拿到**最早**的 N 条，
 * 那是个很容易写错、且错了不容易发现的地方（模型会基于陈旧上下文回答）。
 */
export async function findRecentMessages(
  params: { conversationId: string; limit: number },
  options: ExecutorOption = {}
): Promise<Message[]> {
  const exec = options.executor ?? db;

  const rows = await exec
    .select()
    .from(messages)
    .where(eq(messages.conversationId, params.conversationId))
    .orderBy(desc(messages.sequence))
    .limit(Math.max(1, Math.trunc(params.limit)));

  return rows.reverse();
}

// ============================================================
// 删除（§24.3 + C29 + C30 + C38）
// ============================================================

/** 删除会话时如何处置由它派生的记忆 */
export type DerivedMemoryPolicy =
  /** 保留记忆（「只想清理聊天列表」） */
  | 'keep'
  /** 连同失去全部来源的记忆一并删除（「这段内容不该存在」） */
  | 'delete';

export interface DeleteConversationResult {
  /** 被软删除的派生记忆数（policy='delete' 时可能非 0） */
  deletedMemories: number;
  /** 删除的消息数 */
  deletedMessages: number;
}

/**
 * 删除会话。
 *
 * 严格按 §24.3 的顺序执行，顺序不可调换：
 *
 *   ① 经 messages JOIN 找出受影响的记忆（C22：memory_sources 已无 conversation_id）
 *   ② 统计每条受影响记忆的**剩余**来源数
 *   ③ 无剩余来源者：记忆与向量置 deleted
 *      —— 无论哪一支，都要删掉指向被删消息的 memory_sources 行（C30）
 *   ④ 物理删除 messages（此刻 RESTRICT 外键才真的没有阻碍）
 *   ⑤ 物理删除 conversation_summaries（消息已不存在，摘要没有保留意义）
 *   ⑥ 会话置 deleted + 清空 title / summary（C38）
 *
 * ⚠️ 第 ① 步不能改写成「先删来源行再反查」：
 *    来源行是「记忆从哪来」的唯一凭证，先删就再也判断不出
 *    某条记忆是否还有其他来源，第 ② 步会把所有记忆误判为应删。
 */
export async function deleteConversation(
  conversationId: string,
  policy: DerivedMemoryPolicy = 'keep',
  options: ExecutorOption = {}
): Promise<DeleteConversationResult> {
  const exec = options.executor ?? db;

  return exec.transaction(async (tx) => {
    // ---------- ① 受影响的记忆 ----------
    const affected = await tx
      .selectDistinct({ memoryId: memorySources.memoryId })
      .from(memorySources)
      .innerJoin(messages, eq(messages.id, memorySources.messageId))
      .where(eq(messages.conversationId, conversationId));

    const affectedIds = affected.map((r) => r.memoryId);

    // 本会话全部消息 id —— 步骤 ③ 两支都要按它删来源行
    const convMessages = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));

    const messageIds = convMessages.map((m) => m.id);

    let deletedMemories = 0;

    if (affectedIds.length > 0 && policy === 'delete') {
      // ---------- ② 剩余来源数 ----------
      /**
       * messageIds 为空时短路：notInArray 生成 `NOT IN ()`，
       * 在 PostgreSQL 里是语法错误。空数组在这里等价于「没有来源行要排除」。
       */
      const remaining = await tx
        .select({ memoryId: memorySources.memoryId, n: count() })
        .from(memorySources)
        .where(
          messageIds.length === 0
            ? inArray(memorySources.memoryId, affectedIds)
            : and(
                inArray(memorySources.memoryId, affectedIds),
                notInArray(memorySources.messageId, messageIds)
              )
        )
        .groupBy(memorySources.memoryId);

      const remainingMap = new Map(remaining.map((r) => [r.memoryId, r.n]));

      // ---------- ③b 无剩余来源者：记忆与向量一并置 deleted ----------
      const orphaned = affectedIds.filter((id) => (remainingMap.get(id) ?? 0) === 0);

      if (orphaned.length > 0) {
        await tx
          .update(memories)
          .set({ status: 'deleted', deletedAt: sql`now()`, updatedAt: sql`now()` })
          .where(inArray(memories.id, orphaned));

        await tx
          .update(memoryEmbeddings)
          .set({ status: 'deleted' })
          .where(inArray(memoryEmbeddings.memoryId, orphaned));

        deletedMemories = orphaned.length;
      }
    }

    // ---------- ③a + ③b 共同的一步：删掉指向被删消息的来源行 ----------
    // 漏掉这一步会让第 ④ 步被 message_id 的 ON DELETE RESTRICT 挡住（C30）
    if (messageIds.length > 0) {
      await tx.delete(memorySources).where(inArray(memorySources.messageId, messageIds));
    }

    // ---------- ④ 物理删除消息 ----------
    await tx.delete(messages).where(eq(messages.conversationId, conversationId));

    // ---------- ⑤ 物理删除摘要 ----------
    await tx
      .delete(conversationSummaries)
      .where(eq(conversationSummaries.conversationId, conversationId));

    // ---------- ⑥ 会话软删除 + 清空内容派生字段（C38）----------
    await tx
      .update(conversations)
      .set({
        title: DELETED_CONVERSATION_TITLE,
        summary: null,
        status: 'deleted',
        deletedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(conversations.id, conversationId));

    return { deletedMemories, deletedMessages: messageIds.length };
  });
}

// ============================================================
// 内部
// ============================================================

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** 与 memory-queries 的 clampLimit 保持一致的防护口径 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}
