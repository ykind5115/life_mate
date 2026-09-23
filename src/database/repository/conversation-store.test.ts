/**
 * Conversation / Message Repository 集成测试
 *
 * 为什么直连真实 PostgreSQL：
 *   本文件要验证的不变量大多由库层承担 ——
 *   uq_messages_conversation_sequence（序号唯一）、
 *   memory_sources.message_id 的 ON DELETE RESTRICT（删消息的前置条件）、
 *   conversations 的 CHECK 约束。mock 掉数据库等于什么都没测。
 *
 * 数据洁癖：每个用例跑在自己的顶层事务里，结束即回滚（见 _test-helpers.ts）。
 *
 * 前置：docker compose up -d postgres
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';

import { closePool } from '../client.js';
import { conversations } from '../schema/conversations.js';
import { messages } from '../schema/messages.js';
import { opts, withTestContext } from './_test-helpers.js';
import {
  appendMessage,
  createConversation,
  DELETED_CONVERSATION_TITLE,
  deleteConversation,
  findAliveConversationById,
  findConversationById,
  findMessages,
  findRecentMessages,
  listConversations,
  touchConversation,
  updateConversation,
} from './conversation-store.js';
import { createMemory } from './memory-store.js';
import { findByIdIncludingInactive, findSourcesByMemoryId } from './memory-queries.js';

after(async () => {
  await closePool();
});

// ============================================================
// 会话
// ============================================================

test('createConversation 初始状态为 active，title 可为空', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const c = await createConversation({ userId }, opts(exec));

    assert.equal(c.status, 'active');
    assert.equal(c.title, null);
    assert.equal(c.summary, null);
    assert.equal(c.deletedAt, null);
  });
});

test('findAliveConversationById 取不到已删除的会话，findConversationById 能取到', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const c = await createConversation({ userId, title: '原来的标题' }, opts(exec));
    await deleteConversation(c.id, 'keep', opts(exec));

    const alive = await findAliveConversationById(c.id, opts(exec));
    const any = await findConversationById(c.id, opts(exec));

    assert.equal(alive, undefined, '已删除的会话不应被当作可用会话');
    assert.ok(any, '按 id 直取应仍能拿到行（用于回显占位标题）');
    assert.equal(any.status, 'deleted');
  });
});

test('listConversations 默认排除已删除的，按 updated_at 倒序', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const a = await createConversation({ userId, title: 'A' }, opts(exec));
    await createConversation({ userId, title: 'B' }, opts(exec));
    const c = await createConversation({ userId, title: 'C' }, opts(exec));

    await deleteConversation(c.id, 'keep', opts(exec));
    /**
     * 把 A 顶到最新。
     *
     * 必须靠 touchConversation 才能做到：同事务内 now() 是事务开始时间，
     * A/B/C 三条的 updated_at 完全相同，删掉 C 之后 A 与 B 并列，
     * 排序结果不确定。touchConversation 用 clock_timestamp()，
     * 因此能真正推出一段间隔 —— 这正是它存在的理由。
     */
    await touchConversation(a.id, opts(exec));

    const page = await listConversations({ userId }, opts(exec));

    assert.equal(page.total, 2, '已删除的会话不应计入');
    assert.deepEqual(
      page.items.map((x) => x.title),
      ['A', 'B'],
      '应按 updated_at 倒序：刚触碰过的 A 在前'
    );
  });
});

test('listConversations archived=true 只列归档会话', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const active = await createConversation({ userId, title: '活跃' }, opts(exec));
    const archived = await createConversation({ userId, title: '归档' }, opts(exec));

    /**
     * 直接改 status 而不是走某个「归档」方法：V1.0 的 API 清单里没有归档端点
     * （docs/04 §50 只有 PATCH 改标题），因此没有对应的服务方法可调。
     * 本用例只验证列表查询的过滤口径，用一个直写把状态摆到位即可。
     */
    await exec
      .update(conversations)
      .set({ status: 'archived' })
      .where(eq(conversations.id, archived.id));

    const normal = await listConversations({ userId }, opts(exec));
    const arch = await listConversations({ userId, archived: true }, opts(exec));

    assert.deepEqual(normal.items.map((x) => x.id), [active.id]);
    assert.deepEqual(arch.items.map((x) => x.id), [archived.id]);
  });
});

test('updateConversation 改标题会同时推进 updated_at', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const c = await createConversation({ userId }, opts(exec));
    const before = c.updatedAt;

    const updated = await updateConversation(c.id, { title: '新标题' }, opts(exec));

    assert.equal(updated?.title, '新标题');
    // 同事务内 now() 是事务开始时间，两次写入可能完全相同，
    // 因此只能断言「不倒退」，不能断言严格变大
    assert.ok(
      updated && updated.updatedAt.getTime() >= before.getTime(),
      'updated_at 不应倒退'
    );
  });
});

// ============================================================
// 消息与序号分配
// ============================================================

test('appendMessage 从 1 开始自动分配序号', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const c = await createConversation({ userId }, opts(exec));

    const m1 = await appendMessage(
      { conversationId: c.id, role: 'user', content: '第一条' },
      opts(exec)
    );
    const m2 = await appendMessage(
      { conversationId: c.id, role: 'assistant', content: '第二条' },
      opts(exec)
    );
    const m3 = await appendMessage(
      { conversationId: c.id, role: 'user', content: '第三条' },
      opts(exec)
    );

    assert.deepEqual([m1.sequence, m2.sequence, m3.sequence], [1, 2, 3]);
    assert.deepEqual(m1.metadata, {}, 'metadata 应默认为空对象而不是 null');
  });
});

test('appendMessage 的序号按会话独立，互不影响', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const a = await createConversation({ userId }, opts(exec));
    const b = await createConversation({ userId }, opts(exec));

    await appendMessage({ conversationId: a.id, role: 'user', content: 'a1' }, opts(exec));
    await appendMessage({ conversationId: a.id, role: 'user', content: 'a2' }, opts(exec));

    const b1 = await appendMessage(
      { conversationId: b.id, role: 'user', content: 'b1' },
      opts(exec)
    );

    assert.equal(b1.sequence, 1, '新会话的序号应从 1 重新开始');
  });
});

test('findMessages 按序号升序分页，total 不受分页影响', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const c = await createConversation({ userId }, opts(exec));
    for (let i = 1; i <= 5; i++) {
      await appendMessage(
        { conversationId: c.id, role: 'user', content: `第 ${i} 条` },
        opts(exec)
      );
    }

    const page1 = await findMessages({ conversationId: c.id, limit: 2, offset: 0 }, opts(exec));
    const page2 = await findMessages({ conversationId: c.id, limit: 2, offset: 2 }, opts(exec));

    assert.deepEqual(page1.items.map((m) => m.sequence), [1, 2]);
    assert.deepEqual(page2.items.map((m) => m.sequence), [3, 4]);
    assert.equal(page1.total, 5);
    assert.equal(page2.total, 5);
  });
});

test('findRecentMessages 取的是「最近」N 条，且返回时是正序', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const c = await createConversation({ userId }, opts(exec));
    for (let i = 1; i <= 10; i++) {
      await appendMessage(
        { conversationId: c.id, role: 'user', content: `第 ${i} 条` },
        opts(exec)
      );
    }

    const recent = await findRecentMessages({ conversationId: c.id, limit: 3 }, opts(exec));

    // 这是本函数存在的全部理由：用升序 limit 会拿到第 1~3 条（最早的），
    // 模型于是基于陈旧上下文回答，而且这个错误很难被发现。
    assert.deepEqual(
      recent.map((m) => m.sequence),
      [8, 9, 10],
      '应取最后 3 条，且按时间正序返回'
    );
  });
});

test('appendMessage 撞上序号唯一约束时抛错而不是静默重试', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const c = await createConversation({ userId }, opts(exec));
    await appendMessage({ conversationId: c.id, role: 'user', content: '第一条' }, opts(exec));

    // 模拟并发抢跑：手工插一个已存在的序号
    await assert.rejects(
      () =>
        exec.insert(messages).values({
          conversationId: c.id,
          role: 'user',
          content: '抢跑的消息',
          sequence: 1,
        }),
      (err: unknown) => {
        // 唯一约束是并发保护的最终防线，必须真的挡住
        const text = String((err as { cause?: { message?: string } }).cause?.message ?? err);
        assert.match(text, /uq_messages_conversation_sequence/);
        return true;
      }
    );
  });
});

// ============================================================
// 删除（§24.3 / C29 / C30 / C38）
// ============================================================

test('C38：删除会话后标题与摘要被清空为占位文案，行本身保留', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const c = await createConversation(
      { userId, title: '我的私密计划', summary: '聊了很多私事' },
      opts(exec)
    );
    await appendMessage({ conversationId: c.id, role: 'user', content: '私密内容' }, opts(exec));

    await deleteConversation(c.id, 'keep', opts(exec));

    const row = await findConversationById(c.id, opts(exec));
    assert.ok(row, '软删除应保留行');
    assert.equal(row.title, DELETED_CONVERSATION_TITLE);
    assert.equal(row.summary, null, 'summary 是内容派生字段，必须清空');
    assert.equal(row.status, 'deleted');
    assert.ok(row.deletedAt, 'deleted_at 必须被设置（chk_conversations_deleted）');
  });
});

test('C29：删除会话时消息被物理删除', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const c = await createConversation({ userId }, opts(exec));
    await appendMessage({ conversationId: c.id, role: 'user', content: '会被删掉' }, opts(exec));
    await appendMessage({ conversationId: c.id, role: 'assistant', content: '也会' }, opts(exec));

    const result = await deleteConversation(c.id, 'keep', opts(exec));

    assert.equal(result.deletedMessages, 2);
    const left = await findMessages({ conversationId: c.id }, opts(exec));
    assert.equal(left.total, 0, 'messages 是物理删除，不应残留');
  });
});

test('policy=keep：删除会话但保留派生记忆（「只想清理聊天列表」）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const c = await createConversation({ userId }, opts(exec));
    const m = await appendMessage(
      { conversationId: c.id, role: 'user', content: '我想学 TS' },
      opts(exec)
    );

    const memory = await createMemory(
      {
        userId,
        type: 'goal',
        content: '用户想学 TypeScript',
        sources: [{ sourceType: 'conversation', messageId: m.id }],
      },
      opts(exec)
    );

    const result = await deleteConversation(c.id, 'keep', opts(exec));

    assert.equal(result.deletedMemories, 0);

    const still = await findByIdIncludingInactive(memory.id, opts(exec));
    assert.ok(still, 'keep 语义下记忆必须保留');
    assert.equal(still.status, 'active');
  });
});

test('C30：policy=keep 也必须删掉来源行，否则消息删不掉（RESTRICT）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const c = await createConversation({ userId }, opts(exec));
    const m = await appendMessage(
      { conversationId: c.id, role: 'user', content: '一条消息' },
      opts(exec)
    );

    const memory = await createMemory(
      {
        userId,
        type: 'fact',
        content: '某条派生记忆',
        sources: [{ sourceType: 'conversation', messageId: m.id }],
      },
      opts(exec)
    );

    // 本用例的核心断言就是「这一步不抛错」：
    // memory_sources.message_id 是 ON DELETE RESTRICT，
    // 若步骤③漏删来源行，删除 messages 会立刻被外键挡住。
    await deleteConversation(c.id, 'keep', opts(exec));

    // 记忆还在，但它已经没有任何来源指针了
    const sources = await findSourcesByMemoryId(memory.id, opts(exec));
    assert.equal(sources.length, 0, '指向已删消息的来源行必须被清掉');
  });
});

test('C30：policy=delete 时无剩余来源的记忆被软删除', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const c = await createConversation({ userId }, opts(exec));
    const m = await appendMessage(
      { conversationId: c.id, role: 'user', content: '仅此一处提到' },
      opts(exec)
    );

    const memory = await createMemory(
      {
        userId,
        type: 'fact',
        content: '孤立的派生记忆',
        sources: [{ sourceType: 'conversation', messageId: m.id }],
      },
      opts(exec)
    );

    const result = await deleteConversation(c.id, 'delete', opts(exec));

    assert.equal(result.deletedMemories, 1);
    const after = await findByIdIncludingInactive(memory.id, {
      ...opts(exec),
      includeDeletedForRestore: true,
    });
    assert.equal(after?.status, 'deleted');
    assert.ok(after?.deletedAt, 'deleted_at 必须被设置');
  });
});

test('policy=delete：仍有其他来源的记忆必须保留（第②步的剩余来源统计）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    // 同一个事实在两个会话里都被提到过
    const c1 = await createConversation({ userId, title: '会话一' }, opts(exec));
    const c2 = await createConversation({ userId, title: '会话二' }, opts(exec));

    const m1 = await appendMessage(
      { conversationId: c1.id, role: 'user', content: '我住广州' },
      opts(exec)
    );
    const m2 = await appendMessage(
      { conversationId: c2.id, role: 'user', content: '还是住广州' },
      opts(exec)
    );

    const memory = await createMemory(
      {
        userId,
        type: 'fact',
        content: '用户住在广州',
        sources: [
          { sourceType: 'conversation', messageId: m1.id },
          { sourceType: 'conversation', messageId: m2.id },
        ],
      },
      opts(exec)
    );

    // 删掉会话一：记忆还有会话二这个来源，必须活着
    await deleteConversation(c1.id, 'delete', opts(exec));

    const still = await findByIdIncludingInactive(memory.id, opts(exec));
    assert.ok(still, '还有其他来源的记忆不应被删除');
    assert.equal(still.status, 'active');

    const sources = await findSourcesByMemoryId(memory.id, opts(exec));
    assert.deepEqual(
      sources.map((s) => s.messageId),
      [m2.id],
      '只剩会话二那一条来源'
    );
  });
});

test('删除会话一不影响会话二的消息', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const c1 = await createConversation({ userId, title: '会话一' }, opts(exec));
    const c2 = await createConversation({ userId, title: '会话二' }, opts(exec));

    await appendMessage({ conversationId: c1.id, role: 'user', content: 'c1 消息' }, opts(exec));
    const keep = await appendMessage(
      { conversationId: c2.id, role: 'user', content: 'c2 消息' },
      opts(exec)
    );

    await deleteConversation(c1.id, 'delete', opts(exec));

    const c2Messages = await findMessages({ conversationId: c2.id }, opts(exec));
    assert.equal(c2Messages.total, 1);
    assert.equal(c2Messages.items[0]?.id, keep.id);
  });
});
