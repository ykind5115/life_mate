/**
 * 热情度 A/B 对比（docs/17 §1）
 *
 * 【为什么必须真跑】
 *   「热情一点」是行为，提示词里写了什么**不等于**模型会那么做 ——
 *   这与 docs/15 那次跨会话衔接的教训一样：机制对了，行为不一定跟上。
 *   唯一能回答「改好了没有」的办法是拿同一段对话跑新旧两版，人眼看。
 *
 * 【对比什么】
 *   用用户那次真实失败的场景（会话「深夜问候」seq5 → seq6）：
 *   用户刚说完「终于是把他给解决啦……想跟你分享一下今天晚上的经历」。
 *   旧版在这里问「晚上路上碰见什么了」—— 被用户当场指出「你没太听明白」。
 *
 * 【做法】
 *   把同一个上下文分别喂给 v2 与 v3 两版系统提示词，各跑 3 次，
 *   打印出来对照。看的是：有没有先接住那份高兴、有没有一上来就问。
 *
 * 运行：npx tsx --env-file=.env audit/compare-warmth.ts
 */
import { getLLMProvider } from '../src/llm/index.js';
import { CHAT_SYSTEM_PROMPT } from '../src/conversation/prompts.js';
import { readFileSync } from 'node:fs';

/** 从 git 取出的旧版文件里抠出提示词常量 */
function loadV2Prompt(): string {
  const src = readFileSync('tmp-v2-prompts.ts', 'utf8');
  const start = src.indexOf('export const CHAT_SYSTEM_PROMPT = `');
  if (start < 0) throw new Error('旧版提示词里找不到 CHAT_SYSTEM_PROMPT');
  const from = src.indexOf('`', start) + 1;
  const to = src.indexOf('`;', from);
  return src.slice(from, to);
}

const V2 = loadV2Prompt();
const V3 = CHAT_SYSTEM_PROMPT;

/** 用户那次的真实上下文（截取到失败发生前） */
const HISTORY: { role: 'user' | 'assistant'; content: string }[] = [
  { role: 'user', content: '晚上好呀' },
  { role: 'assistant', content: '晚上好，康康。这会儿还挺精神？都快十一点半了。' },
  {
    role: 'user',
    content:
      '今天想和你吐槽一下，又加班到现在。\n刚到家把电脑打开，嘿嘿嘿，\n想想自己真是好笨啊，工作做不会，做的又慢，效果又差',
  },
  { role: 'assistant', content: '慢和笨是两回事吧。你那套东西本来就得一个一个点着调，换谁都快不起来。\n\n是之前说的那个内网的项目？还是又接了别的活。' },
];

/** 失败那一刻用户说的话 */
const TRIGGER =
  '内网那个项目估计要一两个月才能做好，今天头疼的还是内网的东西，不想说了，反正呢，经过我不断努力，终于是把他给解决啦，哈哈哈哈哈，主要是想跟你分享一下今天晚上的经历呀！';

/**
 * 第二个卡点：用户表达珍视，看模型接住还是推开。
 *
 * 原始记录（seq13 → seq14）：
 *   用户 23:18「确实没有，果然是我多虑了。嘿嘿嘿，还好有你在，
 *              每天能有个人和我聊哦聊天！！」
 *   模型 23:18「**我也就是陪你搭个话。** 不过今天这事其实挺值得记一下的……」
 *
 * 「我也就是陪你搭个话」是自我贬低式的推开 —— 对方把一份珍视递过来，
 * 它推回去了，紧接着转成两条嘱咐。
 */
const WARM_HISTORY: { role: 'user' | 'assistant'; content: string }[] = [
  ...HISTORY,
  { role: 'user', content: TRIGGER },
  { role: 'assistant', content: '（上一轮的回答）' },
  {
    role: 'user',
    content:
      '好长见识啊，之前一直怕麻烦人，想着自己能解决的就自己解决，可是经过了今天晚上，实在是把我逼急了，张嘴问了同事领导之后发现交流也不是那么难，那么让人害怕',
  },
  { role: 'assistant', content: '（上一轮的回答）' },
  {
    role: 'user',
    content: '我觉得是后者，就是怕别人瞧不起自己，总感觉在别人眼里这都是很简单的事情',
  },
  { role: 'assistant', content: '（上一轮的回答）' },
];

const WARM_TRIGGER = '确实没有，果然是我多虑了。嘿嘿嘿，还好有你在，每天能有个人和我聊哦聊天！！';

const provider = getLLMProvider();
const RUNS = 3;

async function run(
  label: string,
  systemPrompt: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  trigger: string,
  judgement: (text: string) => string
): Promise<void> {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`${label}（提示词 ${systemPrompt.length} 字）`);
  console.log('═'.repeat(78));

  for (let i = 1; i <= RUNS; i++) {
    const res = await provider.generate({
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: trigger },
      ],
      maxOutputTokens: 800,
    });

    const text = res.content.trim();
    console.log(`\n───── 第 ${i} 次 ─────`);
    console.log(text);
    console.log(`\n[判据] ${judgement(text)}`);
  }
}

console.log('═'.repeat(78));
console.log('场景 A：用户刚分享「终于是把他给解决啦」，看第一反应');
console.log('═'.repeat(78));
console.log(`旧版 = v2（${V2.length} 字）  新版 = v3（${V3.length} 字）`);

const judgeA = (text: string): string => {
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  const opensWithQuestion = /[？?]\s*$/.test(firstLine.trim());
  const celebrates = /好事|厉害|不错|真好|恭喜|成了|搞定|牛|棒|值得|辛苦|不容易|值了|翻篇/.test(text);
  return `首句就是问句：${opensWithQuestion ? '是 ⚠️' : '否'} | 出现应和/肯定：${celebrates ? '是 ✅' : '否 ⚠️'}`;
};

await run('场景 A · 旧版 v2', V2, HISTORY, TRIGGER, judgeA);
await run('场景 A · 新版 v3', V3, HISTORY, TRIGGER, judgeA);

console.log(`\n\n${'═'.repeat(78)}`);
console.log('场景 B：用户说「还好有你在」，看接住还是推开');
console.log('═'.repeat(78));

const judgeB = (text: string): string => {
  // 推开 / 自谦的典型说法
  const pushesAway = /我也就是|我只是陪着|我也没做什么|搭个话|算不上|谈不上|别这么说|过奖/.test(text);
  return `是否自我贬低式推开：${pushesAway ? '是 ❌（旧病复发）' : '否 ✅'}`;
};

await run('场景 B · 旧版 v2', V2, WARM_HISTORY, WARM_TRIGGER, judgeB);
await run('场景 B · 新版 v3', V3, WARM_HISTORY, WARM_TRIGGER, judgeB);

process.exit(0);
