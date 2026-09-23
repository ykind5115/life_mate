/**
 * 真实 LLM 端到端验证
 *
 * 用一段真实对话跑完整抽取链路，并**对比思考模式开/关的抽取质量**。
 *
 * 运行：pnpm llm:e2e
 *
 * ⚠️ 会真实调用 LLM 与 embedding 服务，产生少量费用（约几千 token）。
 * ⚠️ 数据会真实落库，但脚本结尾会清理（按固定 UUID 删除）。
 *
 * 【为什么这个脚本值得存在】
 *   单元测试用假 Provider 验证的是编排与幂等，**验证不了抽取质量**。
 *   而「思考模式对抽取有没有帮助」这类问题只能靠真实数据回答 ——
 *   否则只能凭印象推荐，那正是我此前做过的事。
 */
import { sql } from 'drizzle-orm';

import { closePool, db } from '../database/client.js';
import { conversations } from '../database/schema/conversations.js';
import { messages } from '../database/schema/messages.js';
import { memories } from '../database/schema/memories.js';
import { embeddingDimensions, embeddingModelId } from '../llm/embedding.js';
import { env } from '../shared/env.js';
import { runExtraction } from '../memory/extraction-pipeline.js';

/** 固定 UUID，便于重复运行与清理 */
const TEST_USER_ID = '00000000-0000-0000-0000-0000000000ee';

/**
 * 验证用对话。
 *
 * 刻意包含多种情况，以便同时观察「该抽的」与「不该抽的」：
 *   · 稳定事实（职业、居住城市）—— 该抽
 *   · 偏好（沟通方式）—— 该抽
 *   · 长期目标 —— 该抽
 *   · 情绪状态 —— 该抽，但**不得**被诊断成疾病
 *   · 一次性琐事 —— 不该抽
 *   · 纯寒暄 —— 不该抽
 */
const CONVERSATION = [
  { role: 'user' as const, content: '最近工作上有点烦，领导老是临时问进度。' },
  { role: 'assistant' as const, content: '听起来挺被动的。是沟通节奏的问题，还是任务本身不确定？' },
  { role: 'user' as const, content: '都有吧。我在广州这边做后端，团队节奏比较快。' },
  { role: 'assistant' as const, content: '明白。那你自己希望怎么调整？' },
  { role: 'user' as const, content: '我希望你以后解释技术问题直接一点，别绕圈子。' },
  { role: 'assistant' as const, content: '好，我尽量直接给结论再补细节。' },
  { role: 'user' as const, content: '对了今天中午吃了个鸡腿，还行。' },
  { role: 'assistant' as const, content: '哈哈，简单的一餐。' },
  { role: 'user' as const, content: '我打算今年认真把 TypeScript 学透，后面想自己写个 Agent 项目。' },
  { role: 'assistant' as const, content: '这个目标挺具体的。是想深入类型系统，还是先能写出可维护的项目？' },
  { role: 'user' as const, content: '先能写项目吧，边做边深入。' },
];

interface ExtractionView {
  label: string;
  memories: {
    type: string;
    content: string;
    slot: string | null;
    value: string | null;
  }[];
  wallMs: number;
  adjudicationCalls: number;
  /** 契约诊断：降级与丢弃的事实。不展示它，分级策略就等于没做 */
  diagnostics: {
    rawCount: number;
    validCount: number;
    dropped: { index: number; reason: string; rawPreview: string }[];
    degradations: { index: number; field: string; original: string; action: string }[];
    slotCoverage: { withSlot: number; total: number };
  };
}

async function cleanup(): Promise<void> {
  // 按固定 user id 清理：memories / conversations 级联删除 messages
  await db.execute(sql`DELETE FROM memories WHERE user_id = ${TEST_USER_ID}`);
  await db.execute(sql`DELETE FROM conversations WHERE user_id = ${TEST_USER_ID}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${TEST_USER_ID} OR name = 'e2e-reasoning'`);
}

async function prepare(): Promise<string> {
  await cleanup();

  await db.execute(
    sql`INSERT INTO users (id, name) VALUES (${TEST_USER_ID}, 'e2e-reasoning')`
  );

  const convRows = await db
    .insert(conversations)
    .values({ userId: TEST_USER_ID, title: '抽取质量对比' })
    .returning({ id: conversations.id });
  const conversationId = convRows[0]!.id;

  await db.insert(messages).values(
    CONVERSATION.map((m, i) => ({
      conversationId,
      role: m.role,
      content: m.content,
      sequence: i + 1,
    }))
  );

  return conversationId;
}

/** 跑一次抽取并读出结果视图 */
async function extractOnce(
  label: string,
  thinking: { type: 'enabled' | 'disabled' }
): Promise<ExtractionView> {
  // 每次用独立会话，避免幂等键把第二次拦掉
  const conversationId = await prepare();

  const started = Date.now();
  const summary = await runExtraction({ conversationId, thinking });
  const wallMs = Date.now() - started;

  const rows = await db
    .select({
      type: memories.type,
      content: memories.content,
      predicateKey: memories.predicateKey,
      objectValue: memories.objectValue,
    })
    .from(memories)
    .where(sql`${memories.userId} = ${TEST_USER_ID}`);

  return {
    label,
    memories: rows.map((r) => ({
      type: r.type,
      content: r.content,
      slot: r.predicateKey,
      value: r.objectValue,
    })),
    wallMs,
    adjudicationCalls: summary.adjudicationCalls,
    diagnostics: summary.diagnostics,
  };
}

function printView(v: ExtractionView): void {
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`【${v.label}】`);
  console.log(`  耗时 ${String(v.wallMs)} ms   判定调用 ${String(v.adjudicationCalls)} 次`);

  const d = v.diagnostics;
  const coverage =
    d.slotCoverage.total > 0
      ? `${String(Math.round((d.slotCoverage.withSlot / d.slotCoverage.total) * 100))}%`
      : 'n/a';
  console.log(
    `  契约：模型给出 ${String(d.rawCount)} 条 → 有效 ${String(d.validCount)} 条` +
      `   槽位命中率 ${coverage}`
  );

  // 降级与丢弃必须被展示 —— 分级策略的价值就在于「不静默」
  if (d.dropped.length > 0) {
    console.log(`  ⚠️ 丢弃 ${String(d.dropped.length)} 条（条目级）：`);
    for (const x of d.dropped) {
      console.log(`      [${String(x.index)}] ${x.reason}`);
      console.log(`          ${x.rawPreview}`);
    }
  }
  if (d.degradations.length > 0) {
    console.log(`  ⚠️ 降级 ${String(d.degradations.length)} 处（字段级，内容已保留）：`);
    for (const x of d.degradations) {
      console.log(`      [${String(x.index)}] ${x.field}: ${x.original} → ${x.action}`);
    }
  }
  if (d.dropped.length === 0 && d.degradations.length === 0) {
    console.log('  ✅ 无丢弃、无降级（模型输出完全符合契约）');
  }

  console.log(`  抽出 ${String(v.memories.length)} 条记忆：`);

  for (const m of v.memories) {
    const slot = m.slot ? `${m.slot}=${m.value ?? ''}` : '（无槽位）';
    console.log(`    · [${m.type}] ${m.content}`);
    console.log(`        槽位：${slot}`);
  }
}

/** 质量检查：这些是「必须/必须不」出现的项 */
function checkQuality(v: ExtractionView): { name: string; ok: boolean }[] {
  const all = v.memories.map((m) => `${m.content} ${m.slot ?? ''}`).join(' | ');

  return [
    {
      name: '抽到居住城市（广州）',
      ok: /residence\.city|广州/.test(all),
    },
    {
      name: '抽到沟通方式偏好',
      ok: /preference\.communication_style|直接/.test(all),
    },
    {
      name: '抽到学习目标（TypeScript）',
      ok: /skill\.learning|TypeScript/.test(all),
    },
    {
      name: '未把「吃鸡腿」当长期记忆',
      ok: !/鸡腿/.test(all),
    },
    {
      name: '未做心理/疾病诊断',
      ok: !/抑郁|焦虑症|心理疾病|诊断/.test(all),
    },
    {
      name: '未输出 type=goal（目标由 Goal 实体管理）',
      ok: !v.memories.some((m) => m.type === 'goal'),
    },
    {
      name: '带槽位的记忆占比 ≥ 50%（结构化有效）',
      ok:
        v.memories.length > 0 &&
        v.memories.filter((m) => m.slot !== null).length / v.memories.length >= 0.5,
    },
  ];
}

async function main(): Promise<void> {
  console.log('真实 LLM 端到端验证：抽取质量 + 思考模式对比');
  console.log('='.repeat(72));
  console.log(`模型：${env.LLM_MODEL}    embedding：${embeddingModelId}(${String(embeddingDimensions)}维)`);
  console.log(`对话长度：${String(CONVERSATION.length)} 条消息`);

  const results: ExtractionView[] = [];

  // ---------- 第一遍：思考模式开启（默认）----------
  const withThinking = await extractOnce('思考开启（enabled）', { type: 'enabled' });
  printView(withThinking);
  results.push(withThinking);

  // ---------- 第二遍：思考关闭 ----------
  const withoutThinking = await extractOnce('思考关闭（disabled）', { type: 'disabled' });
  printView(withoutThinking);
  results.push(withoutThinking);

  // ---------- 质量检查 ----------
  console.log(`\n${'='.repeat(72)}`);
  console.log('质量检查');
  console.log('='.repeat(72));

  const checks = results.map((v) => ({ label: v.label, items: checkQuality(v) }));

  for (const c of checks) {
    console.log(`\n【${c.label}】`);
    for (const item of c.items) {
      console.log(`  ${item.ok ? '[OK]  ' : '[FAIL]'} ${item.name}`);
    }
    const passed = c.items.filter((i) => i.ok).length;
    console.log(`  通过 ${String(passed)}/${String(c.items.length)}`);
  }

  // ---------- 对比结论 ----------
  console.log(`\n${'='.repeat(72)}`);
  console.log('对比');
  console.log('='.repeat(72));
  console.log(
    `  思考开启：${String(withThinking.memories.length)} 条记忆 / ${String(withThinking.wallMs)} ms / ` +
      `判定 ${String(withThinking.adjudicationCalls)} 次`
  );
  console.log(
    `  思考关闭：${String(withoutThinking.memories.length)} 条记忆 / ${String(withoutThinking.wallMs)} ms / ` +
      `判定 ${String(withoutThinking.adjudicationCalls)} 次`
  );

  // 清理
  await cleanup();
  console.log('\n（已清理本次验证数据）');
}

main()
  .catch(async (err: unknown) => {
    console.error('\n验证失败：', err instanceof Error ? err.message : err);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
