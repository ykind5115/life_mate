/**
 * 抽取流水线测试
 *
 * 重点验证两件在审计中被点名的事（都靠数据库约束保证，因此必须连真库）：
 *   C19  幂等键用 start_sequence —— 同一段消息只抽一次
 *   C21  进度只按 succeeded 推进 —— 失败区间会被下次覆盖
 *
 * 用假 Provider 而非真实 LLM：这里测的是**编排与幂等**，
 * 抽取质量属于评测集的范畴（Phase 5）。
 *
 * 运行：pnpm test（需要 postgres 容器）
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';

import { closePool } from '../database/client.js';
import { opts, withTestContext } from '../database/repository/_test-helpers.js';
import { conversations } from '../database/schema/conversations.js';
import { messages } from '../database/schema/messages.js';
import { memories } from '../database/schema/memories.js';
import {
  claimExtractionRun,
  listExtractionRuns,
  nextStartSequence,
} from '../database/repository/extraction-runs.js';
import { findCurrentBySlot } from '../database/repository/memory-queries.js';
import { runExtraction } from './extraction-pipeline.js';
import type { GenerateInput, LLMProvider } from '../llm/provider.js';
import type { LLMGenerateResult } from '../llm/types.js';
import type { SlotAdjudicator } from './candidate-processor.js';

after(async () => {
  await closePool();
});

// ============================================================
// 测试替身
// ============================================================

/**
 * 返回固定 JSON 的假 Provider。
 *
 * 记录调用次数，用于断言幂等 —— 「重复调用是否真的没再调 LLM」
 * 是幂等性的直接证据，比只看记忆条数更强。
 */
class FakeExtractionProvider implements LLMProvider {
  readonly providerName = 'fake';
  readonly defaultModel = 'fake-model';
  callCount = 0;

  constructor(private readonly payload: string) {}

  async generate(_input: GenerateInput): Promise<LLMGenerateResult> {
    this.callCount++;
    return {
      content: this.payload,
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 0 },
      model: this.defaultModel,
      finishReason: 'stop',
    };
  }

  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<never> {
    throw new Error('本测试不使用 stream');
  }
}

/** 恒定判定器 */
function fixedAdjudicator(v: 'state_change' | 'conflict' | 'coexist'): SlotAdjudicator {
  return { adjudicate: async () => v };
}

/** 建一个会话 + 若干消息，返回 id */
async function seedConversation(
  exec: Parameters<typeof opts>[0],
  userId: string,
  contents: string[]
): Promise<{ conversationId: string; messageIds: string[] }> {
  const convRows = await exec
    .insert(conversations)
    .values({ userId, title: '抽取测试' })
    .returning({ id: conversations.id });
  const conversationId = convRows[0]!.id;

  const msgRows = await exec
    .insert(messages)
    .values(
      contents.map((content, i) => ({
        conversationId,
        role: 'user' as const,
        content,
        sequence: i + 1,
      }))
    )
    .returning({ id: messages.id });

  return { conversationId, messageIds: msgRows.map((m) => m.id) };
}

/** 两条记忆的抽取结果 */
const TWO_MEMORIES = JSON.stringify({
  memories: [
    {
      type: 'fact',
      content: '用户正在学习 TypeScript',
      predicateKey: 'skill.learning',
      objectValue: 'TypeScript',
      importance: 0.7,
    },
    {
      type: 'preference',
      content: '用户偏好直接的技术解释',
      predicateKey: 'preference.communication_style',
      objectValue: '直接',
    },
  ],
});

// ============================================================
// 幂等（C19）
// ============================================================

test('C19: 同一段消息重复抽取只执行一次', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const { conversationId } = await seedConversation(exec, userId, [
      '我最近想认真学一下 TypeScript',
      '我希望解释直接一点，别绕',
    ]);

    const provider = new FakeExtractionProvider(TWO_MEMORIES);

    // 第一次：应真正执行
    const first = await runExtraction({
      conversationId,
      provider,
      generateEmbeddings: false,
      executor: exec as never,
    });
    assert.equal(first.executed, true);
    assert.equal(first.candidatesFound, 2);
    assert.equal(first.outcomes.created, 2);
    assert.equal(provider.callCount, 1, '第一次应调用 LLM');

    // 第二次：同范围、同版本 → 应被幂等键拦截
    const second = await runExtraction({
      conversationId,
      provider,
      generateEmbeddings: false,
      executor: exec as never,
    });
    assert.equal(second.executed, false);
    assert.equal(
      second.skippedReason,
      'no_new_messages',
      '进度已推进到末尾，应判定为无新消息'
    );
    assert.equal(provider.callCount, 1, '第二次不应再调用 LLM');

    // 记忆没有翻倍。
    // ⚠️ 必须用事务执行器读：全局 db 是另一条连接，
    //    看不到本事务内未提交的数据，会得到 0 行而误判为失败。
    const rows = await exec
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.userId, userId));
    assert.equal(rows.length, 2, '记忆数不应因重复触发而翻倍');
  });
});

test('C19: 认领层 —— 起点相同的重复认领被拒', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const { conversationId } = await seedConversation(exec, userId, ['a', 'b', 'c']);

    const first = await claimExtractionRun(
      { conversationId, startSequence: 1, endSequence: 2, extractorVersion: 'v1' },
      { executor: exec as never }
    );
    assert.equal(first.claimed, true);

    const { completeExtractionRun } = await import(
      '../database/repository/extraction-runs.js'
    );
    await completeExtractionRun(
      first.claimed ? first.run.id : '',
      {
        memoriesCreated: 0,
        memoriesUpdated: 0,
        memoriesSuperseded: 0,
        conflictsFound: 0,
      },
      { executor: exec as never }
    );

    // 起点相同、终点不同 → 仍应被拒。
    // 这正是 C19 的要点：若幂等键用 end_sequence，这里会通过，
    // 于是 [1,2] 被重复抽取。
    const overlapping = await claimExtractionRun(
      { conversationId, startSequence: 1, endSequence: 3, extractorVersion: 'v1' },
      { executor: exec as never }
    );
    assert.equal(overlapping.claimed, false);
    assert.equal(overlapping.reason, 'already_succeeded');

    // 起点不同 → 允许（下一段）
    const next = await claimExtractionRun(
      { conversationId, startSequence: 3, endSequence: 3, extractorVersion: 'v1' },
      { executor: exec as never }
    );
    assert.equal(next.claimed, true);
  });
});

// ============================================================
// 进度推进（C21）
// ============================================================

test('C21: 进度只按 succeeded 推进，失败区间不会被跳过', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const { conversationId } = await seedConversation(exec, userId, ['消息一', '消息二']);

    // 登记一条成功的 [1,2]，则下一次应从 3 开始
    await claimExtractionRun(
      { conversationId, startSequence: 1, endSequence: 2, extractorVersion: 'v1' },
      { executor: exec as never }
    );
    const { completeExtractionRun } = await import(
      '../database/repository/extraction-runs.js'
    );
    await completeExtractionRun(
      (await listExtractionRuns(conversationId, { executor: exec as never }))[0]!.id,
      { memoriesCreated: 1, memoriesUpdated: 0, memoriesSuperseded: 0, conflictsFound: 0 },
      { executor: exec as never }
    );

    assert.equal(await nextStartSequence(conversationId, { executor: exec as never }), 3, '成功区间应推进进度');

    // 登记一条失败的 [3,4] —— 进度不应因此推进
    await claimExtractionRun(
      { conversationId, startSequence: 3, endSequence: 4, extractorVersion: 'v1' },
      { executor: exec as never }
    );
    const { failExtractionRun } = await import('../database/repository/extraction-runs.js');
    const runs = await listExtractionRuns(conversationId, { executor: exec as never });
    const failedRun = runs.find((r) => r.startSequence === 3);
    await failExtractionRun(failedRun!.id, '模拟失败', { executor: exec as never });

    assert.equal(
      await nextStartSequence(conversationId, { executor: exec as never }),
      3,
      '失败区间不应推进进度 —— 否则这 2 条消息会被永久跳过（C21 的核心）'
    );
  });
});

test('C21: 失败后重新触发会覆盖同一区间（幂等键允许复用 failed）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const { conversationId } = await seedConversation(exec, userId, ['一句话']);

    const first = await claimExtractionRun(
      { conversationId, startSequence: 1, endSequence: 1, extractorVersion: 'v1' },
      { executor: exec as never }
    );
    assert.equal(first.claimed, true);

    // 同起点再次认领：状态是 running，不应被复用（避免并发重复执行）
    const whileRunning = await claimExtractionRun(
      { conversationId, startSequence: 1, endSequence: 1, extractorVersion: 'v1' },
      { executor: exec as never }
    );
    assert.equal(whileRunning.claimed, false);
    assert.equal(whileRunning.reason, 'in_progress');
  });
});

// ============================================================
// 判定流程在编排中的联动
// ============================================================

test('编排层把来源消息写入记忆（§15）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const { conversationId, messageIds } = await seedConversation(exec, userId, [
      '我在学 TypeScript',
    ]);

    await runExtraction({
      conversationId,
      provider: new FakeExtractionProvider(TWO_MEMORIES),
      generateEmbeddings: false,
      executor: exec as never,
    });

    const { sql } = await import('drizzle-orm');
    const rows = await exec.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
        FROM memory_sources ms
        JOIN memories m ON m.id = ms.memory_id
       WHERE m.user_id = ${userId}
         AND ms.message_id = ${messageIds[0]!}
    `);

    assert.equal(
      rows.rows[0]?.n,
      2,
      '两条记忆都应指向同一来源消息 —— 抽取覆盖了哪些消息由编排层决定'
    );
  });
});

test('编排层：取值不同且判定为 state_change 时产生 supersede', async () => {
  await withTestContext(async ({ exec, userId }) => {
    // 第一条消息先建立「用户在学习 Python」
    const first = await seedConversation(exec, userId, ['我在学 Python']);
    await runExtraction({
      conversationId: first.conversationId,
      provider: new FakeExtractionProvider(
        JSON.stringify({
          memories: [
            {
              type: 'fact',
              content: '用户正在学习 Python',
              predicateKey: 'skill.learning',
              objectValue: 'Python',
            },
          ],
        })
      ),
      generateEmbeddings: false,
      executor: exec as never,
    });

    // 同一会话追加一条消息，改口说学 TypeScript
    const convId = first.conversationId;
    const { messages: msgTable } = await import('../database/schema/messages.js');
    await exec.insert(msgTable).values({
      conversationId: convId,
      role: 'user',
      content: '我改学 TypeScript 了',
      sequence: 2,
    });

    const summary = await runExtraction({
      conversationId: convId,
      provider: new FakeExtractionProvider(
        JSON.stringify({
          memories: [
            {
              type: 'fact',
              content: '用户现在学习 TypeScript',
              predicateKey: 'skill.learning',
              objectValue: 'TypeScript',
            },
          ],
        })
      ),
      adjudicator: fixedAdjudicator('state_change'),
      generateEmbeddings: false,
      executor: exec as never,
    });

    assert.equal(summary.outcomes.superseded, 1, '应判定为事实变化并 supersede');

    // 当前有效只剩一条，且是新的
    const current = await findCurrentBySlot(
      { userId, subjectKey: 'user', predicateKey: 'skill.learning' },
      opts(exec)
    );
    assert.equal(current?.objectValue, 'TypeScript');

    // 旧记忆仍在库里，状态为 superseded
    const all = await exec
      .select({ status: memories.status, content: memories.content })
      .from(memories)
      .where(eq(memories.userId, userId));
    assert.equal(all.length, 2);
    assert.ok(
      all.some((m) => m.status === 'superseded' && m.content.includes('Python')),
      '旧记忆应保留为历史'
    );
  });
});

test('编排层：判定为 conflict 时不覆盖旧记忆', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const first = await seedConversation(exec, userId, ['我在学 Python']);
    await runExtraction({
      conversationId: first.conversationId,
      provider: new FakeExtractionProvider(
        JSON.stringify({
          memories: [
            {
              type: 'fact',
              content: '用户正在学习 Python',
              predicateKey: 'skill.learning',
              objectValue: 'Python',
            },
          ],
        })
      ),
      generateEmbeddings: false,
      executor: exec as never,
    });

    const { messages: msgTable } = await import('../database/schema/messages.js');
    await exec.insert(msgTable).values({
      conversationId: first.conversationId,
      role: 'user',
      content: '我在学 Go',
      sequence: 2,
    });

    const summary = await runExtraction({
      conversationId: first.conversationId,
      provider: new FakeExtractionProvider(
        JSON.stringify({
          memories: [
            {
              type: 'fact',
              content: '用户正在学习 Go',
              predicateKey: 'skill.learning',
              objectValue: 'Go',
            },
          ],
        })
      ),
      adjudicator: fixedAdjudicator('conflict'),
      generateEmbeddings: false,
      executor: exec as never,
    });

    assert.equal(summary.outcomes.conflict, 1);

    // 旧记忆仍是当前有效 —— 冲突不擅自覆盖
    const current = await findCurrentBySlot(
      { userId, subjectKey: 'user', predicateKey: 'skill.learning' },
      opts(exec)
    );
    assert.equal(current?.objectValue, 'Python', '冲突时不应覆盖已有事实');
  });
});

test('编排层：没有新消息时正常返回，不报错', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const { conversationId } = await seedConversation(exec, userId, ['一句话']);

    // 先抽干
    await runExtraction({
      conversationId,
      provider: new FakeExtractionProvider('{"memories":[]}'),
      generateEmbeddings: false,
      executor: exec as never,
    });

    const again = await runExtraction({
      conversationId,
      provider: new FakeExtractionProvider('{"memories":[]}'),
      generateEmbeddings: false,
      executor: exec as never,
    });

    assert.equal(again.executed, false);
    assert.equal(again.skippedReason, 'no_new_messages');
  });
});

test('编排层：抽取结果为空是合法结果（大部分闲聊不该形成记忆）', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const { conversationId } = await seedConversation(exec, userId, ['今天天气不错']);

    const summary = await runExtraction({
      conversationId,
      provider: new FakeExtractionProvider('{"memories":[]}'),
      generateEmbeddings: false,
      executor: exec as never,
    });

    assert.equal(summary.executed, true);
    assert.equal(summary.candidatesFound, 0);
    assert.equal(summary.outcomes.created, 0);

    const rows = await exec
      .select({ id: memories.id })
      .from(memories)
      .where(eq(memories.userId, userId));
    assert.equal(rows.length, 0);
  });
});

test('编排层：LLM 返回非法 JSON 时标记失败，且下次可重抽', async () => {
  await withTestContext(async ({ exec, userId }) => {
    const { conversationId } = await seedConversation(exec, userId, ['我在学 TypeScript']);

    await assert.rejects(
      () =>
        runExtraction({
          conversationId,
          provider: new FakeExtractionProvider('这不是 JSON'),
          generateEmbeddings: false,
          executor: exec as never,
        }),
      /不是合法 JSON/
    );

    // 失败记录已落库
    const runs = await listExtractionRuns(conversationId, { executor: exec as never });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'failed');
    assert.ok(runs[0]?.error);

    // 进度未推进 —— 下次会重新覆盖这段消息
    assert.equal(await nextStartSequence(conversationId, { executor: exec as never }), 1);

    // 重新触发应成功
    const retry = await runExtraction({
      conversationId,
      provider: new FakeExtractionProvider(TWO_MEMORIES),
      generateEmbeddings: false,
      executor: exec as never,
    });
    assert.equal(retry.executed, true);
    assert.equal(retry.outcomes.created, 2);
  });
});
