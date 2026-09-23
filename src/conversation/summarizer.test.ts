/**
 * 会话摘要生成的集成测试（docs/03 §12.3）
 *
 * 【重点：区间选的是**最早**的未摘要消息，而不是最新的】
 *   摘要的目的是把最早的旧消息腾出上下文。
 *   取最新的会把刚聊过的内容压成摘要 ——
 *   用户下一句问「刚才说的那个」时原文已经没了。
 *
 * 前置：pnpm test（脚本已指定 .env.test → lifemate_test）
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';

import { closePool, db } from '../database/client.js';
import { conversations } from '../database/schema/conversations.js';
import { messages } from '../database/schema/messages.js';
import { conversationSummaries } from '../database/schema/conversation-summaries.js';
import { resolveTestUser } from '../database/repository/_test-helpers.js';
import { maxSummarizedSequence } from '../database/repository/summary-store.js';
import { assertTestDatabase } from '../shared/test-guard.js';
import { maybeSummarize, SUMMARY_BATCH_SIZE, SUMMARY_THRESHOLD } from './summarizer.js';
import type { GenerateInput, LLMProvider } from '../llm/provider.js';
import type { LLMGenerateResult, LLMStreamChunk } from '../llm/types.js';

after(async () => {
  await closePool();
});

// ============================================================
// 夹具
// ============================================================

class StubProvider implements LLMProvider {
  readonly providerName = 'stub';
  readonly defaultModel = 'stub-model';
  readonly received: GenerateInput[] = [];

  async generate(input: GenerateInput): Promise<LLMGenerateResult> {
    this.received.push(input);
    return {
      content: '用户在这段对话里讨论了备考安排与工作节奏。',
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 30, reasoningTokens: 0 },
      model: 'stub-model',
      finishReason: 'stop',
    };
  }

  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<LLMStreamChunk> {
    throw new Error('本测试不使用 stream');
  }
}

interface SummaryFixture {
  provider: StubProvider;
  conversationId: string;
  /** 造 n 条消息，返回最新序号 */
  seedMessages: (n: number) => Promise<number>;
}

async function withConversation(
  fn: (f: SummaryFixture) => Promise<void>
): Promise<void> {
  assertTestDatabase('summarizer.test.ts / withConversation');

  const user = await resolveTestUser('summarizer.test.ts');

  const rows = await db
    .insert(conversations)
    .values({ userId: user.id, title: '[test] 摘要' })
    .returning();
  const conversationId = rows[0]!.id;

  const provider = new StubProvider();

  const seedMessages = async (n: number): Promise<number> => {
    let seq = await maxSequence(conversationId);
    for (let i = 0; i < n; i++) {
      seq += 1;
      await db.insert(messages).values({
        conversationId,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `第 ${seq} 条消息`,
        sequence: seq,
      });
    }
    return seq;
  };

  try {
    await fn({ provider, conversationId, seedMessages });
  } finally {
    // summaries 与 messages 由 conversations 级联删除，但顺序上先清干净更稳
    await db.delete(conversationSummaries).where(eq(conversationSummaries.conversationId, conversationId));
    await db.delete(messages).where(eq(messages.conversationId, conversationId));
    await db.delete(conversations).where(eq(conversations.id, conversationId));
  }
}

async function maxSequence(conversationId: string): Promise<number> {
  const rows = await db
    .select({ seq: messages.sequence })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return rows.reduce((max, r) => Math.max(max, Number(r.seq)), 0);
}

// ============================================================
// 阈值行为
// ============================================================

test('消息数未达阈值时不生成摘要，也不调用 LLM', async () => {
  await withConversation(async ({ provider, conversationId, seedMessages }) => {
    const latest = await seedMessages(SUMMARY_THRESHOLD); // 恰好等于阈值

    const result = await maybeSummarize({
      conversationId,
      latestSequence: latest,
      provider,
    });

    assert.equal(result.generated, false);
    assert.equal(result.skippedReason, 'below_threshold');
    assert.equal(provider.received.length, 0, '未达阈值不该调用模型');
  });
});

test('超过阈值时生成摘要，覆盖最早的 batchSize 条', async () => {
  await withConversation(async ({ provider, conversationId, seedMessages }) => {
    const latest = await seedMessages(SUMMARY_THRESHOLD + 5);

    const result = await maybeSummarize({
      conversationId,
      latestSequence: latest,
      provider,
    });

    assert.equal(result.generated, true);
    assert.equal(result.covered?.from, 1);
    assert.equal(
      result.covered?.to,
      SUMMARY_BATCH_SIZE,
      '必须从最早开始取 batchSize 条，而不是取最新的'
    );

    // 材料里应是第 1 ~ 第 20 条，不含第 21 条之后
    const sent = JSON.stringify(provider.received.at(-1)!.messages);
    assert.ok(sent.includes('第 1 条消息'));
    assert.ok(sent.includes(`第 ${SUMMARY_BATCH_SIZE} 条消息`));
    assert.ok(!sent.includes(`第 ${SUMMARY_BATCH_SIZE + 1} 条消息`), '不应包含批次之外的消息');
  });
});

test('生成后进度推进：maxSummarizedSequence 反映已摘要到的位置', async () => {
  await withConversation(async ({ provider, conversationId, seedMessages }) => {
    const latest = await seedMessages(SUMMARY_THRESHOLD + 5);

    assert.equal(await maxSummarizedSequence(conversationId), 0, '初始为 0');

    await maybeSummarize({ conversationId, latestSequence: latest, provider });

    assert.equal(await maxSummarizedSequence(conversationId), SUMMARY_BATCH_SIZE);
  });
});

test('已摘要区间之后消息不足阈值时不再生成（不会无限重复摘要）', async () => {
  await withConversation(async ({ provider, conversationId, seedMessages }) => {
    const latest = await seedMessages(SUMMARY_THRESHOLD + 5);

    const first = await maybeSummarize({ conversationId, latestSequence: latest, provider });
    assert.equal(first.generated, true);

    /**
     * 再触发一次：未摘要的只剩 15 条（35 - 20），低于阈值 30。
     * 若不按「未摘要数」判断而按「总消息数」判断，
     * 这里会重复生成摘要 —— 白花钱且产生重叠区间。
     */
    const second = await maybeSummarize({ conversationId, latestSequence: latest, provider });
    assert.equal(second.generated, false);
    assert.equal(second.skippedReason, 'below_threshold');
  });
});

test('未摘要消息为 0 时返回 no_unsummarized_messages', async () => {
  await withConversation(async ({ provider, conversationId, seedMessages }) => {
    const latest = await seedMessages(SUMMARY_THRESHOLD + 5);
    await maybeSummarize({ conversationId, latestSequence: latest, provider });

    // 假装进度已经追上最新序号
    const result = await maybeSummarize({
      conversationId,
      latestSequence: SUMMARY_BATCH_SIZE,
      provider,
    });

    assert.equal(result.generated, false);
    assert.equal(result.skippedReason, 'no_unsummarized_messages');
  });
});

test('区间上限不超过最新序号（消息不够一个批次时）', async () => {
  await withConversation(async ({ provider, conversationId, seedMessages }) => {
    // 阈值改小以便触发，但消息数少于 batchSize
    const latest = await seedMessages(10);

    const result = await maybeSummarize({
      conversationId,
      latestSequence: latest,
      provider,
      threshold: 5,
      batchSize: 20,
    });

    assert.equal(result.generated, true);
    assert.equal(result.covered?.from, 1);
    assert.equal(result.covered?.to, 10, '区间终点应被最新序号截断，不能超过它');
  });
});

test('摘要内容为空时抛错（不让空摘要落库）', async () => {
  await withConversation(async ({ conversationId, seedMessages }) => {
    const latest = await seedMessages(SUMMARY_THRESHOLD + 1);

    const emptyProvider: LLMProvider = {
      providerName: 'empty',
      defaultModel: 'x',
      generate: () =>
        Promise.resolve({
          content: '   ',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 0, reasoningTokens: 0 },
          model: 'x',
          finishReason: 'stop',
        }),
      // eslint-disable-next-line require-yield
      stream: async function* (): AsyncIterable<LLMStreamChunk> {
        throw new Error('unused');
      },
    };

    await assert.rejects(
      () => maybeSummarize({ conversationId, latestSequence: latest, provider: emptyProvider }),
      /空内容/
    );
  });
});

test('提示词要求第三人称、保留时间因果、不编造', async () => {
  await withConversation(async ({ provider, conversationId, seedMessages }) => {
    const latest = await seedMessages(SUMMARY_THRESHOLD + 1);
    await maybeSummarize({ conversationId, latestSequence: latest, provider });

    const system = provider.received.at(-1)!.messages[0]!.content;
    assert.match(system, /第三人称/);
    assert.match(system, /时间顺序与因果/);
    assert.match(system, /不要编造/);
  });
});
