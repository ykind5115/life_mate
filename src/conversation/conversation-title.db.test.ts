/**
 * 会话标题生成的集成测试（docs/12 §方案 2，对应 docs/11 反馈 4）
 *
 * 【为什么需要真库】
 *   本文件要验证的判据是「当前标题是否还等于占位标题」——
 *   它必须真的落库、真的读回来才成立。
 *   而最危险的一条（后台补写标题不能把旧会话顶到列表最前）
 *   依赖 conversations.updated_at 的真实行为，mock 掉就等于没测。
 *
 * LLM 用假 provider（本文件不联网）。
 *
 * 数据洁癖：每个用例跑在自己的顶层事务里，结束即回滚（见 _test-helpers.ts）。
 *
 * 前置：docker compose up -d postgres
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { closePool } from '../database/client.js';
import {
  opts,
  withTestContext,
  type TestExecutor,
} from '../database/repository/_test-helpers.js';
import {
  appendMessage,
  createConversation,
  deleteConversation,
  findAliveConversationById,
  updateConversation,
} from '../database/repository/conversation-store.js';
import type { LLMProvider } from '../llm/provider.js';
import type { LLMGenerateResult, LLMStreamChunk } from '../llm/types.js';
import { buildPlaceholderTitle, generateConversationTitle } from './conversation-title.js';

after(async () => {
  await closePool();
});

/** 只会回一句固定文本的假 provider（本文件不联网） */
function fakeProvider(reply: string, onCall?: () => void): LLMProvider {
  return {
    providerName: 'fake',
    defaultModel: 'fake-model',
    generate: (): Promise<LLMGenerateResult> => {
      onCall?.();
      return Promise.resolve({
        content: reply,
        toolCalls: [],
        model: 'fake-model',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      });
    },
    // eslint-disable-next-line require-yield
    stream: async function* (): AsyncIterable<LLMStreamChunk> {
      throw new Error('本用例不该走流式');
    },
  };
}

/** 造一个「首轮对话已完成」的会话，标题为占位标题 */
async function seedFirstTurn(
  exec: TestExecutor,
  userId: string,
  firstMessage = '早上好呀，你知道现在是什么时间吗'
) {
  const placeholder = buildPlaceholderTitle(firstMessage);
  const c = await createConversation({ userId, title: placeholder }, opts(exec));
  await appendMessage({ conversationId: c.id, role: 'user', content: firstMessage }, opts(exec));
  await appendMessage({ conversationId: c.id, role: 'assistant', content: '早上好。' }, opts(exec));
  return { conversation: c, placeholder };
}

test('把占位标题替换成 LLM 生成的标题', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const { conversation, placeholder } = await seedFirstTurn(exec, userId);

    const result = await generateConversationTitle(
      {
        conversationId: conversation.id,
        placeholderTitle: placeholder,
        provider: fakeProvider('标题：公安运维与 AI 开发。'),
      },
      opts(exec)
    );

    assert.equal(result.generated, true);
    // 前缀与句末标点都要被清掉 —— 否则列表里会出现「标题：…。」
    assert.equal(result.title, '公安运维与 AI 开发');

    const after = await findAliveConversationById(conversation.id, opts(exec));
    assert.equal(after?.title, '公安运维与 AI 开发');
  });
});

test('标题为 NULL 的会话会生成标题（本功能上线前的历史会话）', async () => {
  /**
   * 🔴 实测踩到的 bug：`createConversation` 允许 title 为 NULL，
   *    而**本功能上线之前的会话全是 NULL**。
   *    最初的判据只有「当前标题 !== 占位标题 就跳过」，
   *    于是 `null !== placeholder` 被判成「已有标题」——
   *    回填脚本对两个真实会话全部输出 already_titled，一个都没生成。
   *
   * 这条用例锁死这个分支：title 为 NULL 必须被当作「没有标题」。
   */
  await withTestContext(async ({ exec, userId }) => {
    const c = await createConversation({ userId }, opts(exec)); // title 缺省 → NULL
    await appendMessage({ conversationId: c.id, role: 'user', content: '历史会话' }, opts(exec));
    await appendMessage({ conversationId: c.id, role: 'assistant', content: '嗯' }, opts(exec));

    assert.equal(c.title, null, '前提：这一行确实是 NULL');

    const result = await generateConversationTitle(
      {
        conversationId: c.id,
        placeholderTitle: buildPlaceholderTitle('历史会话'),
        provider: fakeProvider('历史会话'),
      },
      opts(exec)
    );

    assert.equal(result.generated, true, 'title 为 NULL 时必须生成，不能被判成 already_titled');
    const after = await findAliveConversationById(c.id, opts(exec));
    assert.equal(after?.title, '历史会话');
  });
});

test('标题为空串的会话也会生成标题', async () => {
  // createConversation 的 `title: input.title ?? null` 允许空串进来，
  // 空串与 NULL 一样是「没有标题」
  await withTestContext(async ({ exec, userId }) => {
    const c = await createConversation({ userId, title: '' }, opts(exec));
    await appendMessage({ conversationId: c.id, role: 'user', content: '空标题' }, opts(exec));
    await appendMessage({ conversationId: c.id, role: 'assistant', content: '嗯' }, opts(exec));

    const result = await generateConversationTitle(
      {
        conversationId: c.id,
        placeholderTitle: buildPlaceholderTitle('空标题'),
        provider: fakeProvider('空标题'),
      },
      opts(exec)
    );

    assert.equal(result.generated, true);
  });
});

test('已有正式标题时跳过，不调用 LLM', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const { conversation } = await seedFirstTurn(exec, userId);

    let called = 0;

    // 传一个与库里不同的 placeholderTitle，模拟「已经有正式标题了」
    const result = await generateConversationTitle(
      {
        conversationId: conversation.id,
        placeholderTitle: '一个完全不同的字符串',
        provider: fakeProvider('不该被调用', () => {
          called += 1;
        }),
      },
      opts(exec)
    );

    assert.equal(result.generated, false);
    assert.equal(result.skippedReason, 'already_titled');
    assert.equal(called, 0, '已有正式标题时不该调 LLM —— 那是白花钱');
  });
});

test('用户手动改过名之后不会被后台生成覆盖', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const { conversation, placeholder } = await seedFirstTurn(exec, userId);

    // 用户手动改名
    await updateConversation(conversation.id, { title: '我自己起的名字' }, opts(exec));

    const result = await generateConversationTitle(
      {
        conversationId: conversation.id,
        placeholderTitle: placeholder,
        provider: fakeProvider('机器起的名字'),
      },
      opts(exec)
    );

    assert.equal(result.generated, false);
    assert.equal(result.skippedReason, 'already_titled');

    const after = await findAliveConversationById(conversation.id, opts(exec));
    assert.equal(after?.title, '我自己起的名字', '用户改的名字必须保住');
  });
});

test('模型输出清洗后不可用时保留占位标题，且不报错', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const { conversation, placeholder } = await seedFirstTurn(exec, userId);

    const result = await generateConversationTitle(
      {
        conversationId: conversation.id,
        placeholderTitle: placeholder,
        provider: fakeProvider('   '),
      },
      opts(exec)
    );

    assert.equal(result.generated, false);
    assert.equal(result.skippedReason, 'empty_output');

    const after = await findAliveConversationById(conversation.id, opts(exec));
    assert.equal(after?.title, placeholder, '失败时保留占位标题，而不是写空值');
  });
});

test('后台生成标题**不推进** updated_at（否则旧会话会被顶到列表最前）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const { conversation, placeholder } = await seedFirstTurn(exec, userId);

    const before = await findAliveConversationById(conversation.id, opts(exec));
    assert.ok(before);

    // clock_timestamp() 的精度足够高，同一条记录改两次必然能看出差别
    await new Promise((r) => setTimeout(r, 20));

    await generateConversationTitle(
      {
        conversationId: conversation.id,
        placeholderTitle: placeholder,
        provider: fakeProvider('新标题'),
      },
      opts(exec)
    );

    const after = await findAliveConversationById(conversation.id, opts(exec));
    assert.equal(after?.title, '新标题');
    assert.equal(
      after?.updatedAt.getTime(),
      before.updatedAt.getTime(),
      '标题是元数据，后台补写不该改变会话在列表中的排序位置'
    );
  });
});

test('会话不到两条消息时跳过（材料不足）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const placeholder = buildPlaceholderTitle('只有一句话');
    const c = await createConversation({ userId, title: placeholder }, opts(exec));
    await appendMessage(
      { conversationId: c.id, role: 'user', content: '只有一句话' },
      opts(exec)
    );

    const result = await generateConversationTitle(
      { conversationId: c.id, placeholderTitle: placeholder, provider: fakeProvider('标题') },
      opts(exec)
    );

    assert.equal(result.generated, false);
    assert.equal(result.skippedReason, 'too_few_messages');
  });
});

test('会话不存在时返回 not_found，不抛错', async () => {
  await withTestContext(async ({ exec }) => {
    const result = await generateConversationTitle(
      {
        conversationId: '00000000-0000-0000-0000-000000000000',
        placeholderTitle: 'x',
        provider: fakeProvider('标题'),
      },
      opts(exec)
    );

    assert.equal(result.generated, false);
    assert.equal(result.skippedReason, 'not_found');
  });
});

test('已删除的会话不生成标题（C38：删除后标题已是占位文案）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const { conversation, placeholder } = await seedFirstTurn(exec, userId);

    await deleteConversation(conversation.id, 'keep', opts(exec));

    const result = await generateConversationTitle(
      { conversationId: conversation.id, placeholderTitle: placeholder, provider: fakeProvider('x') },
      opts(exec)
    );

    assert.equal(result.generated, false);
    assert.equal(result.skippedReason, 'not_found');
  });
});
