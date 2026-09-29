/**
 * 幻觉复现：重放 2026-09-29 09:23 那一轮
 *
 * 运行：pnpm replay:hallucination [轮数]
 *
 * ⚠️ 会真实调用 LLM（每轮一次 + 一次检索）。**只读数据库，不写任何东西。**
 *
 * 【要回答的问题】
 *   用户报告：seq 4 的回答里出现了「吃饭聊」「这个人你本来就认识」——
 *   而他既没说过，库里 47 条记忆里也没有一条提到吃饭或熟人。
 *
 *   这到底是**记忆的错**（检索喂了错的东西）还是**模型的错**（凭空生成）？
 *   两者的修法完全不同，因此必须先分清：
 *     · 检索的错 → 修检索
 *     · 生成的错 → 才轮到讨论「回答之后加过滤」
 *
 * 【怎么分清】
 *   同一个上下文跑两遍，唯一变量是**有没有注入记忆**：
 *     A 组：真实检索结果（与线上一致）
 *     B 组：完全不注入记忆
 *   若 B 组照样编，就说明与记忆无关，是生成阶段的问题。
 *
 * 【为什么从库里读历史而不是手抄】
 *   手抄会漏掉时间戳、角色、顺序这些细节，而重放的价值就在于
 *   「模型当时看到的**一模一样**」。
 */
import { db, closePool } from '../src/database/client.js';
import { messages } from '../src/database/schema/messages.js';
import { users } from '../src/database/schema/users.js';
import { asc, eq } from 'drizzle-orm';
import { buildChatContext, DEFAULT_RECENT_MESSAGE_LIMIT } from '../src/conversation/context-builder.js';
import { retrieveMemories } from '../src/memory/retriever.js';
import { createMemoryTools } from '../src/memory/tools.js';
import { runAgent } from '../src/agent/loop.js';

const CONVERSATION_ID = '0f37c974-58ea-43dc-be26-524f04b608ab';
/** 要重放的那一轮：用户的这一条，以及它之后的助手回答 */
const TARGET_SEQUENCE = 3;

/** 幻觉的判据（用户点名的两处具体说法） */
const HALLUCINATION_MARKERS = [
  { pattern: /吃饭|这顿|吃个饭/, what: '「吃饭」' },
  { pattern: /本来就认识|熟人|以前一起干过|你认识他/, what: '「本来就认识」' },
];

async function main(): Promise<void> {
  const rounds = Number(process.argv[2] ?? '2');

  const [user] = await db.select().from(users).orderBy(asc(users.createdAt)).limit(1);
  if (!user) throw new Error('找不到用户');

  const all = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, CONVERSATION_ID))
    .orderBy(asc(messages.sequence));

  const targetIndex = all.findIndex((m) => m.sequence === TARGET_SEQUENCE);
  if (targetIndex === -1) throw new Error(`找不到 sequence=${TARGET_SEQUENCE}`);

  const target = all[targetIndex]!;
  const history = all.slice(0, targetIndex);
  const actualAnswer = all[targetIndex + 1];

  console.log('='.repeat(78));
  console.log(`重放会话 ${CONVERSATION_ID} 的 sequence=${TARGET_SEQUENCE}`);
  console.log(`历史 ${history.length} 条，用户当前消息：${target.content}`);
  console.log('='.repeat(78));

  console.log('\n【线上实际发生的回答（seq 4）】');
  console.log(actualAnswer?.content ?? '(没有这一条)');

  // ---------- 真实检索 ----------
  const retrieval = await retrieveMemories({ userId: user.id, query: target.content });
  console.log(`\n【检索诊断】命中 向量${retrieval.diagnostics.channelHits.vector}/` +
    `关键词${retrieval.diagnostics.channelHits.keyword}/槽位${retrieval.diagnostics.channelHits.slot}，` +
    `融合 ${retrieval.diagnostics.fusedCount}，返回 ${retrieval.diagnostics.returned}` +
    (retrieval.diagnostics.degradations.length > 0
      ? `，降级：${retrieval.diagnostics.degradations.join(',')}`
      : ''));

  console.log(`\n【当时会注入的 ${retrieval.memories.length} 条记忆】`);
  for (const [i, m] of retrieval.memories.entries()) {
    console.log(`  ${i + 1}. [${m.type}] ${m.content}`);
  }

  // 记忆里有没有吃饭 / 熟人 —— 先做机械检查
  const allText = retrieval.memories.map((m) => m.content).join('\n');
  const inMemory = HALLUCINATION_MARKERS.filter((h) => h.pattern.test(allText));
  console.log(
    `\n注入的记忆里是否含幻觉关键词：${inMemory.length === 0 ? '否（一条都没有）' : inMemory.map((h) => h.what).join('、')}`
  );

  // ---------- 两组的唯一变量：注入记忆 vs 不注入 ----------
  const { getLLMProvider } = await import('../src/llm/index.js');
  const provider = getLLMProvider();

  const groups: { label: string; memories: typeof retrieval.memories }[] = [
    { label: 'A 组：注入真实检索结果（与线上一致）', memories: retrieval.memories },
    { label: 'B 组：完全不注入记忆（对照）', memories: [] },
  ];

  for (const group of groups) {
    console.log(`\n${'─'.repeat(78)}`);
    console.log(group.label);
    console.log('─'.repeat(78));

    let fabricated = 0;

    for (let r = 1; r <= rounds; r++) {
      const ctx = buildChatContext({
        recentMessages: history.slice(-DEFAULT_RECENT_MESSAGE_LIMIT).map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          createdAt: m.createdAt,
        })),
        userMessage: target.content,
        timezone: user.timezone,
        retrieval: { performed: true, memories: group.memories },
      });

      const result = await runAgent({
        provider,
        messages: ctx.messages,
        // 与线上一致：带只读工具，让模型可能自己去查（seq 4 当时就是这样，iterations=2）
        tools: createMemoryTools({ userId: user.id }),
      });

      const hits = HALLUCINATION_MARKERS.filter((h) => h.pattern.test(result.content));
      if (hits.length > 0) fabricated += 1;

      console.log(`\n--- 第 ${r} 轮（iterations=${result.iterations}）---`);
      console.log(result.content);
      console.log(
        `\n  ▸ ${hits.length > 0 ? `❗命中幻觉模式：${hits.map((h) => h.what).join('、')}` : '未命中幻觉模式'}`
      );
    }

    console.log(`\n>>> ${group.label}：${rounds} 轮里 ${fabricated} 轮出现幻觉`);
  }
}

try {
  await main();
} catch (err) {
  console.error('重放失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await closePool();
}
