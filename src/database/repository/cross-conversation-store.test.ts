/**
 * findPreviousConversationWithTail 的真库测试（docs/15）
 *
 * 【为什么必须用真库测】
 *   这个查询的每条过滤条件都是「少写一个字就出事」的类型，
 *   而且出事方式是**静默的**：
 *     · 少 user_id 过滤  → 别人的对话被拼进当前用户的上下文（隐私事故）
 *     · 少 deleted_at 过滤 → 用户删掉的对话复活（与删除意图直接冲突）
 *     · 少时间窗        → 隔了一周的旧话题被硬接上来
 *   这些用 mock 测不出来 —— mock 只会照着你写的条件返回，
 *   它不知道你漏了哪个条件。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eq, sql } from 'drizzle-orm';

import { conversations } from '../schema/conversations.js';
import { messages } from '../schema/messages.js';
import { withTestContext, seedUser, type TestExecutor } from './_test-helpers.js';
import { findPreviousConversationWithTail } from './conversation-store.js';

const NOW = new Date('2026-10-08T10:15:00+08:00');
const MIN = 60_000;

/** 建一个会话并写入若干条消息，返回会话 id */
async function seedConversation(
  exec: TestExecutor,
  userId: string,
  params: {
    title: string;
    /** 每条消息的内容；顺序即 sequence */
    contents: string[];
    /** 最后一条消息的时间。其余依次往前推一分钟 */
    lastAt: Date;
    deleted?: boolean;
  }
): Promise<string> {
  const rows = await exec
    .insert(conversations)
    .values({
      userId,
      title: params.title,
      status: params.deleted ? 'deleted' : 'active',
      ...(params.deleted ? { deletedAt: sql`now()` } : {}),
    })
    .returning({ id: conversations.id });

  const conversationId = rows[0]!.id;

  for (let i = 0; i < params.contents.length; i++) {
    const offset = (params.contents.length - 1 - i) * MIN;
    await exec.insert(messages).values({
      conversationId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: params.contents[i]!,
      sequence: i + 1,
      createdAt: new Date(params.lastAt.getTime() - offset),
    });
  }

  return conversationId;
}

test('🔴 省略 excludeConversationId 时不能报错（新会话第一轮的真实调用）', async () => {
  /**
   * 这是**真实场景里唯一的调用形状** —— 新会话第一轮时，
   * 当前会话 id 根本不存在（还没有会话），所以没有可排除的对象。
   *
   * 实测踩到（2026-10-08）：第一版在调用处写 `existingConversationId ?? ''`，
   * 空串被拿去和 uuid 列比较，PostgreSQL 报
   *   invalid input syntax for type uuid: ""   （22P02）
   * 于是这个功能在**真实场景下 100% 失效** ——
   * 而当时写的 9 个测试全都传了合法 UUID，一个都没抓到。
   *
   * 教训：测试要覆盖**调用方真正会传的形状**，
   *      而不是「方便测试传的形状」。可选参数必须测「不传」。
   */
  await withTestContext(async ({ exec, userId }) => {
    await seedConversation(exec, userId, {
      title: '上一个会话',
      contents: ['刚刚说的话'],
      lastAt: new Date(NOW.getTime() - 1 * MIN),
    });

    const found = await findPreviousConversationWithTail(
      // 注意：这里**不传** excludeConversationId
      { userId, since: new Date(NOW.getTime() - 120 * MIN), limit: 6 },
      { executor: exec }
    );

    assert.ok(found, '不排除任何会话时，应当能取到上一个会话');
    assert.deepEqual(found.messages.map((m) => m.content), ['刚刚说的话']);
  });
});

test('传空串 excludeConversationId 会报错，而不是被静默接受（防回归）', async () => {
  /**
   * 反向确认修复是「不加条件」而不是「换个哨兵值」：
   * 传空串仍然应当报错 —— 那说明调用方还在传非法值。
   *
   * 这里**宁可炸掉也不静默返回 null**：静默会让功能看起来正常、
   * 实际却没生效，那是最难查的一类故障（本次已经踩过一次）。
   */
  await withTestContext(async ({ exec, userId }) => {
    await assert.rejects(
      () =>
        findPreviousConversationWithTail(
          {
            userId,
            excludeConversationId: '',
            since: new Date(NOW.getTime() - 120 * MIN),
            limit: 6,
          },
          { executor: exec }
        ),
      /**
       * ⚠️ 匹配 cause 里的原始 postgres 文案，不是 Drizzle 包装的外层。
       *    Drizzle 只在外层写 "Failed query: <SQL>"，
       *    真正的原因（invalid input syntax for type uuid）在 cause 上。
       */
      (err: unknown) => {
        let cur: unknown = err;
        while (cur instanceof Error) {
          if (/invalid input syntax for type uuid/i.test(cur.message)) return true;
          cur = (cur as { cause?: unknown }).cause;
        }
        return false;
      },
      '空串应当报 uuid 语法错误'
    );
  });
});

// ============================================================
// 正常路径
// ============================================================

test('取到时间窗内最近的会话，消息按时间正序且不带当前会话', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const prev = await seedConversation(exec, userId, {
      title: '上一个会话',
      contents: ['第一句', '第二句', '第三句'],
      lastAt: new Date(NOW.getTime() - 1 * MIN),
    });
    const current = await seedConversation(exec, userId, {
      title: '当前会话',
      contents: ['当前会话里已经有消息了'],
      lastAt: NOW,
    });

    const found = await findPreviousConversationWithTail(
      { userId, excludeConversationId: current, since: new Date(NOW.getTime() - 120 * MIN), limit: 6 },
      { executor: exec }
    );

    assert.ok(found, '应当找到上一个会话');
    assert.equal(found.conversation.id, prev, '必须是上一个会话，不能是当前会话');
    assert.deepEqual(
      found.messages.map((m) => m.content),
      ['第一句', '第二句', '第三句'],
      '消息必须按时间正序（倒序会让模型把因果讲反）'
    );
  });
});

test('多会话时选「最后说话时间最新」的那个', async () => {
  await withTestContext(async ({ exec, userId }) => {
    await seedConversation(exec, userId, {
      title: '更早的会话',
      contents: ['很久以前'],
      lastAt: new Date(NOW.getTime() - 90 * MIN),
    });
    const newest = await seedConversation(exec, userId, {
      title: '刚刚那个会话',
      contents: ['刚刚说的'],
      lastAt: new Date(NOW.getTime() - 2 * MIN),
    });

    const found = await findPreviousConversationWithTail(
      { userId, excludeConversationId: '00000000-0000-4000-8000-000000000000', since: new Date(NOW.getTime() - 120 * MIN), limit: 6 },
      { executor: exec }
    );

    assert.equal(found?.conversation.id, newest, '要选最后说话时间最新的，不是最早创建的');
  });
});

test('limit 生效：只取末尾 N 条，且取的是**末尾**不是开头', async () => {
  /**
   * ⚠️ 取错方向是个很难发现的错：拿到最早 N 条时，
   *    模型看到的是「这段对话怎么开头的」，而不是「聊到哪了」——
   *    接不上问题的症状会原样保留。
   */
  await withTestContext(async ({ exec, userId }) => {
    await seedConversation(exec, userId, {
      title: '长会话',
      contents: ['1', '2', '3', '4', '5', '6', '7', '8'],
      lastAt: new Date(NOW.getTime() - 1 * MIN),
    });

    const found = await findPreviousConversationWithTail(
      { userId, excludeConversationId: '00000000-0000-4000-8000-000000000000', since: new Date(NOW.getTime() - 120 * MIN), limit: 3 },
      { executor: exec }
    );

    assert.deepEqual(found?.messages.map((m) => m.content), ['6', '7', '8'], '要取末尾 3 条');
  });
});

// ============================================================
// 三个必须的排除条件
// ============================================================

test('🔴 时间窗外的会话不参与衔接', async () => {
  /**
   * 用户选了 2 小时。隔了半天再开新会话时，
   * 把旧话题硬接上来比接不上更糟 —— 那会让模型以为用户还在聊那件事。
   */
  await withTestContext(async ({ exec, userId }) => {
    await seedConversation(exec, userId, {
      title: '三小时前的会话',
      contents: ['三小时前说的话'],
      lastAt: new Date(NOW.getTime() - 180 * MIN),
    });

    const found = await findPreviousConversationWithTail(
      { userId, excludeConversationId: '00000000-0000-4000-8000-000000000000', since: new Date(NOW.getTime() - 120 * MIN), limit: 6 },
      { executor: exec }
    );

    assert.equal(found, null, '超过时间窗就不该衔接');
  });
});

test('🔴 已删除的会话不参与衔接', async () => {
  /**
   * 用户删掉一段对话就是不希望它再出现。
   * 若它还能被拼进下一个会话的上下文，删除意图就落空了 ——
   * 与 §24.1 直接冲突。
   */
  await withTestContext(async ({ exec, userId }) => {
    await seedConversation(exec, userId, {
      title: '已删除的会话',
      contents: ['这段内容用户已经删了'],
      lastAt: new Date(NOW.getTime() - 1 * MIN),
      deleted: true,
    });

    const found = await findPreviousConversationWithTail(
      { userId, excludeConversationId: '00000000-0000-4000-8000-000000000000', since: new Date(NOW.getTime() - 120 * MIN), limit: 6 },
      { executor: exec }
    );

    assert.equal(found, null, '已删除的会话绝不能复活');
  });
});

test('🔴 用户隔离：别人的会话绝不能被取到', async () => {
  /**
   * 这是多用户下唯一的隔离依据。少写 user_id 过滤 = 隐私事故，
   * 而且是静默的 —— 用户不会知道自己的上下文里混进了别人的话。
   */
  await withTestContext(async ({ exec, userId }) => {
    const otherUserId = await seedUser(exec, 'someone-else');
    await seedConversation(exec, otherUserId, {
      title: '别人的会话',
      contents: ['这是另一个用户的私密内容'],
      lastAt: new Date(NOW.getTime() - 1 * MIN),
    });

    const found = await findPreviousConversationWithTail(
      { userId, excludeConversationId: '00000000-0000-4000-8000-000000000000', since: new Date(NOW.getTime() - 120 * MIN), limit: 6 },
      { executor: exec }
    );

    assert.equal(found, null, '不能取到其他用户的会话');
  });
});

test('排除当前会话：自己不会被当成「上一个」', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const current = await seedConversation(exec, userId, {
      title: '只有我自己',
      contents: ['刚才说的话'],
      lastAt: new Date(NOW.getTime() - 1 * MIN),
    });

    const found = await findPreviousConversationWithTail(
      { userId, excludeConversationId: current, since: new Date(NOW.getTime() - 120 * MIN), limit: 6 },
      { executor: exec }
    );

    assert.equal(found, null, '不能把自己当成上一个会话（否则会把当前会话复制一份）');
  });
});

test('空会话（没有任何消息）不参与衔接', async () => {
  await withTestContext(async ({ exec, userId }) => {
    await exec.insert(conversations).values({ userId, title: '空会话', status: 'active' });

    const found = await findPreviousConversationWithTail(
      { userId, excludeConversationId: '00000000-0000-4000-8000-000000000000', since: new Date(NOW.getTime() - 120 * MIN), limit: 6 },
      { executor: exec }
    );

    assert.equal(found, null, '空会话没有可衔接的内容');
  });
});

test('只按 messages 的时间判断，不看 conversations.updated_at', async () => {
  /**
   * ⚠️ updated_at 会被标题生成、摘要写入等后台动作刷新 ——
   *    那些动作与「用户最后说话的时间」不是一回事。
   *    用它会选错会话：一个刚被后台改过标题的旧会话会被误认为「刚刚聊过」。
   */
  await withTestContext(async ({ exec, userId }) => {
    const old = await seedConversation(exec, userId, {
      title: '很久没说话的会话',
      contents: ['三小时前说的'],
      lastAt: new Date(NOW.getTime() - 180 * MIN),
    });

    // 模拟后台动作刷新了 updated_at
    await exec
      .update(conversations)
      .set({ updatedAt: sql`now()` })
      .where(eq(conversations.id, old));

    const found = await findPreviousConversationWithTail(
      { userId, excludeConversationId: '00000000-0000-4000-8000-000000000000', since: new Date(NOW.getTime() - 120 * MIN), limit: 6 },
      { executor: exec }
    );

    assert.equal(found, null, 'updated_at 被刷新不代表用户刚说过话');
  });
});
