/**
 * 系统提示词的测试（docs/12 §方案 3，对应 docs/11 反馈 1 / 3 / 6）
 *
 * 【为什么提示词也要测试】
 *   提示词的行为差异无法用断言表达，但**它包含哪些约束**可以。
 *   用户实测反馈的四类问题都源于提示词里**缺了某条约束**或缺错了：
 *     · 缺「一次最多两个问题」→ 一次问三个（反馈 3）
 *     · 缺「不要总结已聊内容」→ 像会议纪要（反馈 6）
 *     · 多了一句「建议用户换个说法」→ 张嘴讲机制（反馈 1）
 *   这些是**可以断言**的，而且一旦被后续改动删掉，
 *   同样的反馈会原样复现。本文件就是那条防线。
 *
 * 纯字符串测试，不碰数据库、不调 LLM。
 *
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AGENT_PROMPT_VERSION,
  buildKnownFactsSection,
  CHAT_SYSTEM_PROMPT,
} from './prompts.js';

// ============================================================
// 不允许出现的东西 —— 反馈 1「不要把工作原理说出来」
// ============================================================

test('提示词里不得出现「建议用户换个说法」这类系统口吻', () => {
  /**
   * v1 原文：「如果用户问起过去说过的事而现有信息不足，
   *           直接说明你没找到，并建议用户换个说法或补充细节。」
   * 实测结果是模型回答：「我这边没检索到，不代表你以前从没提过，
   *   只是这次没调出来。如果之前确实聊过，你换个说法再说一遍，
   *   我可能就能找到。」—— 用户的原话是「真的像个机器人」。
   */
  assert.doesNotMatch(CHAT_SYSTEM_PROMPT, /换个说法/);
  assert.doesNotMatch(CHAT_SYSTEM_PROMPT, /你换个方式/);
});

test('提示词里不得让模型声称自己「记住了」是系统行为', () => {
  /**
   * v1 原文：「不要声称你「记住了」本次对话 ——
   *           写入长期记忆由系统在后台完成，你只负责正常对话。」
   *
   * ⚠️ 这句话**事实是错的**：本次会话的消息原文就在上下文里，
   *    模型确实看得到，不是「记不住」。
   *    正确的约束是「想不起来时用人话承认」，而不是禁止它承认记得。
   */
  assert.doesNotMatch(CHAT_SYSTEM_PROMPT, /不要声称你/);
  assert.doesNotMatch(CHAT_SYSTEM_PROMPT, /由系统在后台完成/);
});

test('提示词里不得出现会被复述的机制词汇', () => {
  /**
   * 用户反馈里被点名的原话：「我刚刚翻了一下手头能找到的长期记忆，
   * 没有检索到关于你的任何内容」。
   * 这些词一旦出现在提示词里，模型就会在回答里照样说出来。
   *
   * ⚠️ 连**禁令本身**也不许出现这些词。
   *    曾经写成「不要提『记忆』『检索』『上下文』『系统』这些词」，
   *    那等于把要避免的词又喂了一遍 —— 提示词里的每个词都是输入，
   *    禁令里列举的禁用词同样会被采样。
   *    正确的写法是只描述要避免的**行为**（解释内部过程），
   *    一个具体词都不提。
   */
  for (const word of ['检索', '数据库', '上下文', '工作流', '系统']) {
    assert.doesNotMatch(CHAT_SYSTEM_PROMPT, new RegExp(word), `提示词不得出现「${word}」`);
  }
});

test('明确禁止描述「自己怎么工作」，并给出正面的替代说法', () => {
  // 只禁不给替代，模型会退化成「我无法回答这个问题」这类更硬的拒绝
  assert.match(CHAT_SYSTEM_PROMPT, /不要把你怎么工作的讲出来/);
  assert.match(CHAT_SYSTEM_PROMPT, /你还没跟我说过这个/);
  assert.match(CHAT_SYSTEM_PROMPT, /我记不清了/);
});

// ============================================================
// 必须包含的东西
// ============================================================

test('提问数量有硬性上限，且写明是两个', () => {
  // docs/11 反馈 3.2 原话：「我觉得一次性问1-2个问题就行了」
  assert.match(CHAT_SYSTEM_PROMPT, /一次最多问两个问题/);
  assert.match(CHAT_SYSTEM_PROMPT, /挑最想知道的先问/);
});

test('写明该引导才引导：不追问、不没话找话', () => {
  assert.match(CHAT_SYSTEM_PROMPT, /不是为了把对话填满/);
  assert.match(CHAT_SYSTEM_PROMPT, /不要追问/);
  assert.match(CHAT_SYSTEM_PROMPT, /没话找话/);
});

test('换话题时不许总结已聊内容、不许说「随你」', () => {
  /**
   * 反馈 6 的实例：
   * 「好，那就不聊。你这几天假期主要是睡觉，聊了工作、聊了她，
   *   也说了学 agent 的进度。还有一天假，明天想干嘛，随你。」
   * 三个问题：总结像会议纪要、「随你」是敷衍收尾、又抛了一个新问题。
   */
  assert.match(CHAT_SYSTEM_PROMPT, /不要总结已经聊过的内容/);
  assert.match(CHAT_SYSTEM_PROMPT, /随你/);
});

test('语气改成「熟人」而不是「助手」', () => {
  assert.match(CHAT_SYSTEM_PROMPT, /客服口吻/);
  assert.match(CHAT_SYSTEM_PROMPT, /朋友/);
  // 每句都附问句是反馈 1.4 与 6 共同点到的问题
  assert.match(CHAT_SYSTEM_PROMPT, /不用每句话都收在一个问题上/);
});

test('人格有主见，但身份边界写明「不假装有人类生活」', () => {
  /**
   * 用户提供的人格基调要求「有主见、可以礼貌反对」，
   * 同时要求「不虚构人类年龄、职业、经历」。
   * 这两条要同时在场 —— 只给主见会让模型开始编经历。
   */
  assert.match(CHAT_SYSTEM_PROMPT, /要有自己的判断/);
  assert.match(CHAT_SYSTEM_PROMPT, /不要替对方做决定/);
  assert.match(CHAT_SYSTEM_PROMPT, /不假装自己有身体/);
});

test('防幻觉的底线一条都不能少', () => {
  // 这是删掉机制叙述之后**唯一**不能跟着删的部分
  assert.match(CHAT_SYSTEM_PROMPT, /绝不允许编造/);
  assert.match(CHAT_SYSTEM_PROMPT, /想不起来的时候/);
});

test('保留 PRD §10.3 的约束：不对心理状态下诊断', () => {
  assert.match(CHAT_SYSTEM_PROMPT, /不要对对方的心理状态下诊断或贴标签/);
});

test('提示词长度受控（每轮对话的固定开销）', () => {
  /**
   * 规则越多，回答越像在逐条满足需求 —— 而用户的诉求是「像朋友」。
   * 给一个上限，避免后续不断往里加条款。
   */
  assert.ok(
    CHAT_SYSTEM_PROMPT.length < 1200,
    `提示词过长（${CHAT_SYSTEM_PROMPT.length} 字）：它会渗进回答的形态`
  );
});

test('提示词版本已随本次重写递增', () => {
  // 提示词变了而版本没变，行为变化就无法与版本对应（文件头的硬要求）
  assert.equal(AGENT_PROMPT_VERSION, 'v2');
});

// ============================================================
// 记忆段落
// ============================================================

test('记忆段落用第一人称标题，且不含机制词汇', () => {
  const section = buildKnownFactsSection([
    { content: '用户住在成都', type: 'fact', validFrom: null },
  ])!;

  assert.match(section, /你记得的关于对方的事/);
  assert.doesNotMatch(section, /系统|检索|上下文|数据库/);
});

test('记忆段落仍保留「不要断言对方没说过」的防幻觉提示', () => {
  /**
   * 删掉它，模型会把「这里没有」当成「对方从未提过」，
   * 进而断言「你从来没说过这件事」—— 那是在编造一个否定的结论。
   */
  const section = buildKnownFactsSection([
    { content: '用户住在成都', type: 'fact', validFrom: null },
  ])!;

  assert.match(section, /不要因为这里没有就断言对方没说过/);
});

test('记忆段落保留日期标注（用于区分「之前提过」与「刚说的」）', () => {
  const section = buildKnownFactsSection([
    { content: '用户在学 Rust', type: 'fact', validFrom: new Date('2026-01-15T00:00:00Z') },
  ])!;

  assert.match(section, /2026-01-15 起/);
  assert.match(section, /不要说成对方刚刚说的/);
});

test('没有记忆时返回 null（调用方整段不插入）', () => {
  assert.equal(buildKnownFactsSection([]), null);
});
