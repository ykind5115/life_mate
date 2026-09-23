/**
 * 离线评测运行器（PRD §15 的 ①②③）
 *
 * 【做什么】
 *   对 golden 集里的每组对话：
 *     ① 写入一个**临时用户**的会话与消息
 *     ② 跑真实的抽取流水线（真 LLM + 真 embedding）
 *     ③ 读回抽出的记忆，与标注做语义匹配（LLM 评审）
 *     ④ 算出 precision / recall / noise 等指标
 *   最后清理临时数据并打印报告。
 *
 * 【为什么要临时用户，而不是用默认用户】
 *   评测会往库里写记忆。用默认用户意味着跑一次评测就污染一次真实记忆。
 *   临时用户 + 结束后级联清理，让评测可以随时反复跑。
 *
 * 【运行】
 *   pnpm eval:extraction
 *   需要：postgres + embedding 容器在跑，.env 里有可用的 LLM key。
 *   会产生真实 LLM 调用（每组对话 2 次：抽取 + 评审），注意成本。
 *
 * ⚠️ 本脚本会**写库**。默认拒绝在非测试库上运行 ——
 *    若要在开发库上跑（例如想看真实环境下抽取质量），
 *    必须显式设 ALLOW_EVAL_ON_DEV_DB=1，并知道它会新增数据。
 */
import { eq, inArray } from 'drizzle-orm';

import { closePool, db } from '../database/client.js';
import { users } from '../database/schema/users.js';
import { memories } from '../database/schema/memories.js';
import { conversations } from '../database/schema/conversations.js';
import { messages } from '../database/schema/messages.js';
import { memorySources } from '../database/schema/memory-sources.js';
import { runExtraction } from '../memory/extraction-pipeline.js';
import { getLLMProvider } from '../llm/index.js';
import { currentDatabaseName, isTestDatabaseName } from '../shared/test-guard.js';
import { EVALUATION_SET, type EvaluationConversation } from './dataset.js';
import {
  matchExtractedToExpected,
  scoreConversation,
  summarize,
  type ConversationScore,
  type EvaluationSummary,
} from './extraction-eval.js';

const EVAL_EXTRACTOR_VERSION = 'eval-v1';

async function main(): Promise<void> {
  guardDatabase();

  /**
   * 每次评测用一个独立的用户，名字带时间戳。
   * 这样并发跑两次评测也不会互相干扰（各写各的记忆）。
   */
  const runId = Date.now().toString(36);
  const created = await db
    .insert(users)
    .values({ name: `eval-${runId}` })
    .returning();
  const user = created[0]!;

  console.log(`\n离线评测开始（用户 eval-${runId}，${EVALUATION_SET.length} 组对话）\n`);
  console.log('═'.repeat(78));

  const provider = getLLMProvider();
  const scores: ConversationScore[] = [];

  try {
    for (const conversation of EVALUATION_SET) {
      const score = await evaluateOne({
        conversation,
        userId: user.id,
        provider,
      });
      scores.push(score);
      printConversationScore(score);
    }

    const overall = summarize(scores);
    printSummary(overall);

    // 把汇总打印成一行便于贴进提交信息或文档
    console.log('\n一行汇总（便于记录基线）：');
    console.log(
      `  P=${overall.precision.toFixed(3)} R=${overall.recall.toFixed(3)} ` +
        `F1=${overall.f1.toFixed(3)} noise=${overall.noise} ` +
        `slot=${overall.slotAccuracy === null ? 'n/a' : overall.slotAccuracy.toFixed(2)} ` +
        `type=${overall.typeAccuracy === null ? 'n/a' : overall.typeAccuracy.toFixed(2)}\n`
    );
  } finally {
    await cleanup(user.id);
    await closePool();
  }
}

// ============================================================
// 单组评测
// ============================================================

async function evaluateOne(params: {
  conversation: EvaluationConversation;
  userId: string;
  provider: ReturnType<typeof getLLMProvider>;
}): Promise<ConversationScore> {
  const { conversation, userId, provider } = params;
  const started = Date.now();

  // ---------- ① 写入会话与消息 ----------
  const convRows = await db
    .insert(conversations)
    .values({ userId, title: `[eval] ${conversation.id}` })
    .returning();
  const conversationId = convRows[0]!.id;

  let sequence = 1;
  for (const turn of conversation.turns) {
    await db.insert(messages).values({
      conversationId,
      role: turn.role,
      content: turn.content,
      sequence: sequence++,
    });
  }

  // ---------- ② 跑真实抽取 ----------
  const summary = await runExtraction({
    conversationId,
    provider,
    extractorVersion: EVAL_EXTRACTOR_VERSION,
    /**
     * 关掉向量生成：评测的是**抽取质量**，不是 embedding 服务。
     * 生成向量会让每组对话多花几百毫秒且毫无收益。
     * （检索质量是另一个评测，见 docs/03 §18.5 的「检索可离线评测」）
     */
    generateEmbeddings: false,
  });

  // ---------- ③ 读回抽出的记忆 ----------
  /**
   * 按来源反查本次抽取产出的记忆。
   *
   * ⚠️ 不能用「该用户名下的全部记忆」—— 那样会把上一组的产出算进来。
   *    memory_sources 是「记忆从哪来」的唯一凭证（§15.4），用它过滤最准确。
   */
  const memoryIds = await db
    .selectDistinct({ memoryId: memorySources.memoryId })
    .from(memorySources)
    .innerJoin(messages, eq(messages.id, memorySources.messageId))
    .where(eq(messages.conversationId, conversationId));

  const ids = memoryIds.map((r) => r.memoryId);
  const extracted = ids.length
    ? await db.select().from(memories).where(inArray(memories.id, ids))
    : [];

  // ---------- ④ 语义匹配 + 评分 ----------
  const judged = await matchExtractedToExpected({
    provider,
    expected: conversation.shouldExtract,
    memories: extracted,
  });

  void summary;

  return scoreConversation({
    conversation,
    memories: extracted,
    judged,
    timingMs: Date.now() - started,
  });
}

// ============================================================
// 输出
// ============================================================

function printConversationScore(s: ConversationScore): void {
  console.log(`\n▸ ${s.conversationId}  （${s.timingMs}ms）`);
  console.log(`  考察：${s.focus}`);
  console.log(
    `  抽取 ${s.extracted} 条 / 期望 ${s.expected} 条 → ` +
      `命中 ${s.truePositives}、漏 ${s.missed}、误抽 ${s.spurious}、噪声 ${s.forbidden}`
  );
  if (s.slotAccuracy !== null) console.log(`  槽位正确率：${(s.slotAccuracy * 100).toFixed(0)}%`);

  if (s.extractedContents.length > 0) {
    console.log('  实际抽出：');
    for (const m of s.matches) {
      const flag = m.useful
        ? '✓'
        : m.forbiddenReason !== null
          ? `✗噪声(${m.forbiddenReason})`
          : '✗多余';
      const slot = m.slotCorrect === null ? '' : m.slotCorrect ? ' [槽位对]' : ' [槽位错]';
      const ungrounded = m.ungroundedClaim === null ? '' : ` [无依据：${m.ungroundedClaim}]`;
      console.log(`    ${flag} ${m.content}${slot}${ungrounded}`);
    }
  }
  if (s.missedContents.length > 0) {
    console.log('  漏掉：');
    for (const c of s.missedContents) console.log(`    ✗ ${c}`);
  }
}

function printSummary(o: EvaluationSummary['overall']): void {
  console.log(`\n${'═'.repeat(78)}`);
  console.log('汇总（PRD §15 的 ①②③）\n');
  console.log(`  ① Memory Precision   ${(o.precision * 100).toFixed(1)}%  （抽出的里有多少是对的）`);
  console.log(`  ② Memory Recall      ${(o.recall * 100).toFixed(1)}%  （该抽的里抽到了多少）`);
  console.log(`     F1                ${(o.f1 * 100).toFixed(1)}%`);
  console.log(`  ③ Memory Noise       ${o.noise} 条（噪声率 ${(o.noiseRate * 100).toFixed(1)}%）`);
  console.log(`     槽位正确率         ${o.slotAccuracy === null ? 'n/a' : (o.slotAccuracy * 100).toFixed(1) + '%'}`);
  console.log(`     类型正确率         ${o.typeAccuracy === null ? 'n/a' : (o.typeAccuracy * 100).toFixed(1) + '%'}`);
  console.log(`\n  合计：抽取 ${o.extracted} 条，期望 ${o.expected} 条`);
}

// ============================================================
// 杂项
// ============================================================

function guardDatabase(): void {
  if (isTestDatabaseName(currentDatabaseName())) return;
  if (process.env['ALLOW_EVAL_ON_DEV_DB'] === '1') {
    console.warn(
      `\n⚠️  正在非测试库（${currentDatabaseName()}）上运行评测。` +
        `本次会写入数据，结束后会清理自己创建的用户与记忆。\n`
    );
    return;
  }

  console.error(
    `\n拒绝运行：当前库是 ${currentDatabaseName()}，不是测试库。\n\n` +
      `评测会写入数据。虽然结束后会清理，但为了避免任何意外，\n` +
      `默认只允许在库名含 "test" 的库上运行。\n\n` +
      `若确实要在开发库上跑（例如想看真实环境下的抽取质量）：\n` +
      `  $env:ALLOW_EVAL_ON_DEV_DB="1"; pnpm eval:extraction\n`
  );
  process.exit(1);
}

/** 删除本次评测创建的全部数据（用户 → 级联不到记忆，需按顺序删） */
async function cleanup(userId: string): Promise<void> {
  const convs = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.userId, userId));

  const convIds = convs.map((c) => c.id);

  if (convIds.length > 0) {
    const msgs = await db
      .select({ id: messages.id })
      .from(messages)
      .where(inArray(messages.conversationId, convIds));
    const msgIds = msgs.map((m) => m.id);

    // 顺序不能变：来源行 → 记忆（连带向量级联）→ 消息 → 会话
    // memory_sources.message_id 是 ON DELETE RESTRICT，不先删会挡住消息删除
    if (msgIds.length > 0) {
      await db.delete(memorySources).where(inArray(memorySources.messageId, msgIds));
    }
    await db.delete(memories).where(eq(memories.userId, userId));
    await db.delete(messages).where(inArray(messages.conversationId, convIds));
    await db.delete(conversations).where(eq(conversations.userId, userId));
  }

  await db.delete(users).where(eq(users.id, userId));
  console.log('已清理评测数据。');
}

main().catch(async (err: unknown) => {
  console.error('\n评测失败：', err instanceof Error ? err.message : err);
  await closePool();
  process.exit(1);
});
