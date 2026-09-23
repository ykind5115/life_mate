/**
 * 检索质量评测运行器（PRD §15 的 ② Memory Recall）
 *
 * 【测什么】
 *   对标注集里的每个查询跑**真实检索链路**（向量 + 关键词 + 结构化
 *   → RRF → 重排），然后算：
 *     Recall@k  —— 该召回的有没有进来（k = 1 / 3 / 8）
 *     MRR       —— 第一条相关结果排多前
 *     干扰项命中 —— 主题相关但事实不同的东西有没有被误召回
 *     通道贡献   —— 向量与关键词各自贡献了多少（用于判断两路是否都有效）
 *
 * 【为什么 k 取 1 / 3 / 8】
 *   8 是 §18.5 的注入条数（也就是「实际会影响回答」的那批），
 *   因此 Recall@8 是最重要的指标。
 *   1 与 3 用来看排序质量 —— 只有 8 达标而 1 很差，说明排序需要调。
 *
 * 【语料是构造的，不是真实库】（理由见 retrieval-dataset.ts）
 *   因此本评测用**独立的临时用户**，跑完清理，
 *   不去动开发库里已有的记忆。
 *
 * 【运行】pnpm eval:retrieval
 *   需要 postgres + embedding 容器在跑。会真实调用 embedding 服务
 *   （但不调用 LLM —— 检索本身不用模型）。
 *
 * ⚠️ 本脚本会写库。默认拒绝在非测试库上运行。
 */
import { eq, sql } from 'drizzle-orm';

import { closePool, db } from '../database/client.js';
import { users } from '../database/schema/users.js';
import { memories } from '../database/schema/memories.js';
import { memoryEmbeddings } from '../database/schema/memory-embeddings.js';
import {
  buildEmbeddedText,
  embed,
  embeddingModelId,
  embeddingDimensions,
  toVectorLiteral,
} from '../llm/embedding.js';
import { currentDatabaseName, isTestDatabaseName } from '../shared/test-guard.js';
import { retrieveMemories } from '../memory/retriever.js';
import { RETRIEVAL_CORPUS, RETRIEVAL_QUERIES } from './retrieval-dataset.js';
import { createHash } from 'node:crypto';

/** 注入条数（§18.5）。Recall@8 是最重要的指标 */
const TOP_K = 8;

async function main(): Promise<void> {
  guardDatabase();

  const runId = Date.now().toString(36);
  const created = await db.insert(users).values({ name: `eval-retrieval-${runId}` }).returning();
  const user = created[0]!;

  console.log(`\n检索质量评测（用户 eval-retrieval-${runId}）`);
  console.log(`语料 ${RETRIEVAL_CORPUS.length} 条 / 查询 ${RETRIEVAL_QUERIES.length} 个\n`);
  console.log('═'.repeat(78));

  try {
    const keyToId = await seedCorpus(user.id);
    console.log(`已写入语料并生成向量（${Object.keys(keyToId).length} 条）\n`);

    const rows: QueryResult[] = [];

    for (const q of RETRIEVAL_QUERIES) {
      const result = await retrieveMemories({ userId: user.id, query: q.query, limit: TOP_K });

      const returnedKeys = result.memories
        .map((m) => idToKey(keyToId, m.id))
        .filter((k): k is string => k !== null);

      const relevant = new Set(q.relevant);
      const distractors = new Set(q.distractors ?? []);

      const hits = returnedKeys.filter((k) => relevant.has(k));
      const firstHitIndex = returnedKeys.findIndex((k) => relevant.has(k));

      rows.push({
        id: q.id,
        query: q.query,
        focus: q.focus,
        relevant: q.relevant,
        returnedKeys,
        hits,
        recall1: firstHitIndex === 0 ? 1 : 0,
        recall3: hits.filter((k) => returnedKeys.indexOf(k) < 3).length / q.relevant.length,
        recall8: hits.length / q.relevant.length,
        reciprocalRank: firstHitIndex >= 0 ? 1 / (firstHitIndex + 1) : 0,
        distractorHits: returnedKeys.filter((k) => distractors.has(k)),
        channelHits: result.diagnostics.channelHits,
        degraded: result.diagnostics.degradations,
      });
    }

    printReport(rows);
  } finally {
    await cleanup(user.id);
    await closePool();
  }
}

// ============================================================
// 语料写入
// ============================================================

/** key → 数据库 id */
type KeyMap = Record<string, string>;

async function seedCorpus(userId: string): Promise<KeyMap> {
  const map: KeyMap = {};
  const now = Date.now();

  for (const item of RETRIEVAL_CORPUS) {
    const createdAt = new Date(now - (item.daysAgo ?? 0) * 86_400_000);

    const inserted = await db
      .insert(memories)
      .values({
        userId,
        type: item.type,
        content: item.content,
        subjectKey: 'user',
        predicateKey: item.predicateKey ?? null,
        objectValue: item.objectValue ?? null,
        importanceScore: item.importance ?? 0.5,
        status: 'active',
        // 事实生效时间与建立时间一致 —— 评测不考察 valid_from 的精度
        validFrom: createdAt,
        createdAt,
        updatedAt: createdAt,
      })
      .returning({ id: memories.id });

    const id = inserted[0]!.id;
    map[item.key] = id;

    /**
     * 逐条生成向量。
     *
     * ⚠️ 用与生产**完全一致**的 buildEmbeddedText 与模型标识 ——
     *    自己拼一份文本会让向量的分布与生产不同，评测结果没有意义。
     *    （实测教训的同理：检索与写入的 toVectorLiteral 曾各有一份，
     *      格式一漂移就静默算错相似度。）
     */
    const embeddedText = buildEmbeddedText({
      type: item.type,
      subject: 'user',
      content: item.content,
      timeHint: `${createdAt.toISOString().slice(0, 10)} 起有效`,
    });
    const vec = await embed(embeddedText);

    await db.insert(memoryEmbeddings).values({
      memoryId: id,
      model: embeddingModelId,
      dim: embeddingDimensions,
      embeddedText,
      contentHash: createHash('sha256').update(embeddedText, 'utf8').digest('hex'),
      // 与 memory-store 的写法一致：显式 ::vector 转型
      embedding: sql`${toVectorLiteral(vec)}::vector` as never,
      status: 'ready',
    });
  }

  return map;
}

// ============================================================
// 报告
// ============================================================

interface QueryResult {
  id: string;
  query: string;
  focus: string;
  relevant: string[];
  returnedKeys: string[];
  hits: string[];
  recall1: number;
  recall3: number;
  recall8: number;
  reciprocalRank: number;
  distractorHits: string[];
  channelHits: { vector: number; keyword: number; slot: number };
  degraded: string[];
}

function printReport(rows: QueryResult[]): void {
  console.log('逐查询结果');
  console.log('─'.repeat(78));

  for (const r of rows) {
    const flag = r.recall8 >= 1 ? '✓' : r.recall8 > 0 ? '△' : '✗';
    const r1 = r.recall1 ? 'R@1' : '   ';
    console.log(
      `${flag} ${r1} [${r.hits.length}/${r.relevant.length}] ${r.query}`
    );
    if (r.recall8 < 1) {
      const missed = r.relevant.filter((k) => !r.hits.includes(k));
      console.log(`      漏: ${missed.join(', ')}`);
    }
    if (r.distractorHits.length > 0) {
      console.log(`      误召: ${r.distractorHits.join(', ')}`);
    }
    if (r.degraded.length > 0) {
      console.log(`      降级: ${r.degraded.join(', ')}`);
    }
  }

  // ---------- 汇总 ----------
  const n = rows.length;
  const mean = (f: (r: QueryResult) => number): number =>
    rows.reduce((s, r) => s + f(r), 0) / n;

  const recall1 = mean((r) => (r.recall1 ? 1 : 0));
  const mrr = mean((r) => r.reciprocalRank);
  /** Recall@k 按「相关项被召回的比例」在查询间取平均 */
  const recallAt = (k: number): number =>
    mean((r) => {
      const inTopK = r.returnedKeys.slice(0, k).filter((x) => r.relevant.includes(x));
      return inTopK.length / r.relevant.length;
    });

  const totalDistractors = rows.reduce((s, r) => s + r.distractorHits.length, 0);
  const allRelevant = rows.reduce((s, r) => s + r.relevant.length, 0);
  const allHits = rows.reduce((s, r) => s + r.hits.length, 0);

  /** 通道覆盖：有多少查询的关键词通道有命中（判断它是否真的在工作） */
  const queriesWithKeyword = rows.filter((r) => r.channelHits.keyword > 0).length;

  console.log(`\n${'═'.repeat(78)}`);
  console.log('汇总（PRD §15 ② Memory Recall）\n');
  console.log(`  Recall@1    ${(recall1 * 100).toFixed(1)}%   （第一条就命中）`);
  console.log(`  Recall@3    ${(recallAt(3) * 100).toFixed(1)}%`);
  console.log(`  Recall@${TOP_K}    ${(recallAt(TOP_K) * 100).toFixed(1)}%   ← 最重要（注入条数）`);
  console.log(`  MRR         ${mrr.toFixed(3)}`);
  console.log(`  总体召回率  ${((allHits / allRelevant) * 100).toFixed(1)}%  （命中 ${allHits} / 应召回 ${allRelevant}）`);
  console.log(`\n  干扰项误召  ${totalDistractors} 条`);
  console.log(
    `  关键词通道有效查询  ${queriesWithKeyword}/${n}` +
      (queriesWithKeyword === 0 ? '   ⚠️ 一路都没命中，检查中文切分' : '')
  );

  console.log('\n一行汇总（便于记录基线）：');
  console.log(
    `  R@1=${recall1.toFixed(3)} R@3=${recallAt(3).toFixed(3)} R@${TOP_K}=${recallAt(TOP_K).toFixed(3)} ` +
      `MRR=${mrr.toFixed(3)} 干扰=${totalDistractors} 关键词命中查询=${queriesWithKeyword}/${n}\n`
  );
}

// ============================================================
// 杂项
// ============================================================

function idToKey(map: KeyMap, id: string): string | null {
  for (const [key, value] of Object.entries(map)) {
    if (value === id) return key;
  }
  return null;
}

function guardDatabase(): void {
  if (isTestDatabaseName(currentDatabaseName())) return;
  if (process.env['ALLOW_EVAL_ON_DEV_DB'] === '1') {
    console.warn(`\n⚠️  正在非测试库（${currentDatabaseName()}）上运行评测，结束后会清理。\n`);
    return;
  }

  console.error(
    `\n拒绝运行：当前库是 ${currentDatabaseName()}，不是测试库。\n` +
      `评测会写入语料（结束后清理），默认只允许在库名含 "test" 的库上运行。\n\n` +
      `临时覆盖：$env:DATABASE_URL="...lifemate_test"; pnpm eval:retrieval\n` +
      `或在开发库上跑：$env:ALLOW_EVAL_ON_DEV_DB="1"; pnpm eval:retrieval\n`
  );
  process.exit(1);
}

async function cleanup(userId: string): Promise<void> {
  await db.delete(memories).where(eq(memories.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  console.log('已清理评测语料。');
}

main().catch(async (err: unknown) => {
  console.error('\n评测失败：', err instanceof Error ? err.message : err);
  await closePool();
  process.exit(1);
});
