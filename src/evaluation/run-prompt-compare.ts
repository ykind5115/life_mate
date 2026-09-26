/**
 * 系统提示词 v1 → v2 的前后对比
 *
 * 运行：pnpm eval:prompt-compare
 *
 * ⚠️ 会真实调用 LLM：用例数 × 2（新旧各一次）
 *    当前 3 个用例 → 6 次调用。输出上限刻意压到 900 token/次。
 *
 * 【为什么要做这个对比】（docs/12 §4 的决策 6）
 *   这一轮有两处独立改动同时上线：
 *     ① 时间注入（context-builder）—— 让模型看得见时间
 *     ② 提示词重写（v1 → v2）   —— 让它别说机制、别一次问三个
 *   不分开测就分不清「回答变好了」是谁的功劳。
 *   因此本脚本**两版用完全相同的上下文**：
 *   同一份对话历史、同一份记忆、同一个「当前时间」。
 *   唯一的变量是系统提示词。
 *
 * 【用例来源】docs/11 的三条实测反馈，逐字使用用户的原话。
 *   这不是我编的测试集 —— 正是它们触发了这次改动，
 *   用它们对比才回答得了「反馈里那些毛病好了没有」。
 *
 * 【输出的读法】
 *   脚本末尾会打印一份**机械检查**：把反馈里点名的说法当作模式去匹配。
 *   它不能替代人的判断（措辞千变万化），但它能立刻抓出
 *   「机制词照样漏出来」这类硬伤。
 */
import { CHAT_SYSTEM_PROMPT, buildKnownFactsSection } from '../conversation/prompts.js';
import { buildChatContext } from '../conversation/context-builder.js';
import { AGENT_PROMPT_V1, buildKnownFactsSectionV1 } from './prompts/agent-prompt-v1.js';
import { closePool } from '../database/client.js';

// ============================================================
// 用例
// ============================================================

/** 与两版共用的「现在」。固定值 —— 否则两次运行的时间不同，又是一处变量 */
const NOW = new Date('2026-09-26T12:18:00Z'); // 北京 20:18

interface Case {
  name: string;
  /** 这条用例要验证的反馈编号 */
  feedback: string;
  /** 用户原话 */
  message: string;
  /** 之前的对话（可空） */
  history?: { role: 'user' | 'assistant'; content: string; createdAt: Date }[];
  /** 注入的记忆（可空） */
  memories?: { content: string; type: string; validFrom?: Date | null }[];
}

const CASES: Case[] = [
  {
    name: '反馈 1：问时间与身份，且没有记忆',
    feedback: '反馈 1（回答像机器人、把工作原理说出来）',
    message: '早上好呀，你知道现在是什么时间吗，你知道我是谁吗？',
  },
  {
    name: '反馈 1.3：记忆里没有的事，怎么表述',
    feedback: '反馈 1.3（「我这边都没搜到相关记录」是分析内容，不该讲出来）',
    message: '我最近在学冲浪，你觉得难吗',
    memories: [
      {
        content: '用户在工作中做运维，同时在推进 AI 相关开发',
        type: 'fact',
        validFrom: new Date('2026-09-20T00:00:00Z'),
      },
    ],
  },
  {
    name: '反馈 3：一次问三个问题',
    feedback: '反馈 3（像审问，一次问太多）',
    message: '对，我是外包驻场，主要做网络运维，另外也在搞 AI 业务拓展开发',
    history: [
      {
        role: 'user',
        content: '我在公安机关这边上班',
        createdAt: new Date('2026-09-26T03:00:00Z'),
      },
      {
        role: 'assistant',
        content: '公安机关的活儿挺杂的。你具体是做什么方向？',
        createdAt: new Date('2026-09-26T03:00:00Z'),
      },
    ],
  },
  {
    name: '反馈 6：换话题时会不会做会议纪要',
    feedback: '反馈 6（生硬、像会议纪要、用「随你」收尾）',
    message: '我不想聊这个话题了',
    history: [
      {
        role: 'user',
        content: '这几天假期我基本都在睡觉',
        createdAt: new Date('2026-09-26T11:00:00Z'),
      },
      {
        role: 'assistant',
        content: '难得有空就好好歇着。',
        createdAt: new Date('2026-09-26T11:00:00Z'),
      },
      {
        role: 'user',
        content: '我最近想学 agent，但一直拖着没动手',
        createdAt: new Date('2026-09-26T11:30:00Z'),
      },
      {
        role: 'assistant',
        content: '拖着往往是因为不知道从哪儿下手。你卡在哪一步？',
        createdAt: new Date('2026-09-26T11:30:00Z'),
      },
    ],
  },
];

// ============================================================
// 机械检查 —— 反馈里点名的说法
// ============================================================

/**
 * 机制叙述类模式。
 *
 * 这些是用户原话里出现过的具体表述（docs/11 反馈 1 的注 1 与注 3）。
 * 命中即说明「把工作原理讲出来了」这个毛病还在。
 */
const MECHANISM_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /检索/, what: '「检索」' },
  { pattern: /长期记忆|记忆库/, what: '「长期记忆」' },
  { pattern: /系统(里|中|那边|检索|会|在后台)/, what: '「系统…」' },
  { pattern: /上下文|数据库|调出来|存(进|入)了?记忆/, what: '机制词' },
  { pattern: /换个说法|换一种方式说/, what: '「换个说法」（反馈 1 点名）' },
  { pattern: /我这边(没|没有)(搜到|找到|记录)/, what: '「我这边没搜到」（反馈 1 点名）' },
];

/** 敷衍收尾（反馈 6 点名） */
const DISMISSIVE_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /随你/, what: '「随你」' },
  { pattern: /你自己定/, what: '「你自己定」（反馈 1 注 4）' },
];

/** 一次问了几个问题 —— 用问号计数近似 */
function countQuestions(text: string): number {
  return (text.match(/[？?]/g) ?? []).length;
}

interface Outcome {
  label: string;
  text: string;
}

function check(text: string): string[] {
  const hits: string[] = [];
  for (const { pattern, what } of [...MECHANISM_PATTERNS, ...DISMISSIVE_PATTERNS]) {
    if (pattern.test(text)) hits.push(what);
  }
  return hits;
}

// ============================================================
// 执行
// ============================================================

async function callWith(
  systemPrompt: string,
  factsSection: string | null,
  c: Case
): Promise<string> {
  const { getLLMProvider } = await import('../llm/index.js');
  const provider = getLLMProvider();

  /**
   * ⚠️ 用 buildChatContext 而不是手工拼 messages。
   *    这样两版走的是**同一条组装路径**，连时间标记的格式都一致 ——
   *    否则「新版看起来好一些」可能只是因为新版恰好带了时间。
   */
  const ctx = buildChatContext({
    systemPrompt,
    recentMessages: (c.history ?? []).map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
    })),
    userMessage: c.message,
    timezone: 'Asia/Shanghai',
    now: NOW,
    retrieval: { performed: false, memories: [] },
  });

  /**
   * 记忆段落按各自的版本重建。
   * v1 的段落结尾写着「以上是系统检索到的部分记忆，可能不完整」，
   * v2 改成了「你记得的关于对方的事」——这本身就是对比的一个观测点。
   */
  const messages = [...ctx.messages];
  if (factsSection !== null) {
    messages.splice(1, 0, { role: 'system', content: factsSection });
  }

  const res = await provider.generate({
    messages,
    maxOutputTokens: 900,
    thinking: { type: 'disabled' },
  });

  return res.content.trim();
}

async function main(): Promise<void> {
  console.log('='.repeat(78));
  console.log('系统提示词 v1 → v2 前后对比（唯一变量：系统提示词）');
  console.log(`用例 ${CASES.length} 个，每个跑两版 → ${CASES.length * 2} 次 LLM 调用`);
  console.log('='.repeat(78));

  const summary: { name: string; v1Hits: string[]; v2Hits: string[]; v1Q: number; v2Q: number }[] =
    [];

  for (const c of CASES) {
    console.log(`\n${'─'.repeat(78)}`);
    console.log(`【${c.name}】`);
    console.log(`对应 ${c.feedback}`);
    console.log(`用户原话：${c.message}`);
    if (c.history && c.history.length > 0) {
      console.log(`（含 ${c.history.length} 条历史消息）`);
    }
    console.log('─'.repeat(78));

    const v1Facts = c.memories ? buildKnownFactsSectionV1(c.memories) : null;
    const v2Facts = c.memories ? buildKnownFactsSection(c.memories) : null;

    const outcomes: Outcome[] = [];

    for (const [label, prompt, facts] of [
      ['v1（旧）', AGENT_PROMPT_V1, v1Facts],
      ['v2（新）', CHAT_SYSTEM_PROMPT, v2Facts],
    ] as const) {
      try {
        const text = await callWith(prompt, facts, c);
        outcomes.push({ label, text });
      } catch (err) {
        outcomes.push({
          label,
          text: `[调用失败] ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    for (const o of outcomes) {
      const hits = check(o.text);
      const q = countQuestions(o.text);
      console.log(`\n──── ${o.label} ${'─'.repeat(60 - o.label.length)}`);
      console.log(o.text);
      console.log(
        `\n  ▸ 问号数 ${q}${hits.length > 0 ? `　▸ 命中问题模式：${hits.join('、')}` : '　▸ 未命中问题模式'}`
      );
    }

    summary.push({
      name: c.name,
      v1Hits: check(outcomes[0]!.text),
      v2Hits: check(outcomes[1]!.text),
      v1Q: countQuestions(outcomes[0]!.text),
      v2Q: countQuestions(outcomes[1]!.text),
    });
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('汇总（机械检查，不能替代人的判断）');
  console.log('='.repeat(78));
  console.log(
    ['用例'.padEnd(34), 'v1 命中', 'v2 命中', 'v1 问号', 'v2 问号'].join(' │ ')
  );
  console.log('─'.repeat(78));
  for (const s of summary) {
    console.log(
      [
        s.name.slice(0, 32).padEnd(34),
        String(s.v1Hits.length).padStart(7),
        String(s.v2Hits.length).padStart(7),
        String(s.v1Q).padStart(7),
        String(s.v2Q).padStart(7),
      ].join(' │ ')
    );
  }

  console.log(
    '\n注：问号数只是近似 —— 「一次最多问两个问题」的 v2 约束' +
      '不保证问号数一定 ≤ 2（反问句、引用对方的话都会带上问号）。'
  );
  console.log('真正的判断标准是读上面两版的实际回答。');
}

main()
  .catch((err: unknown) => {
    console.error('对比失败：', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
