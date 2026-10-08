/**
 * 跨会话衔接的测试（docs/15）
 *
 * 【这些用例在守什么】
 *   实测（2026-10-08）：用户在 1 分钟内换了会话窗口继续聊，模型连续三次
 *   坚称「你没跟我说过」，第二次还编了个理由（「你刚才没细讲项目本身」）。
 *   根因是上下文组装只看当前会话 —— 新会话第一轮的历史是空数组。
 *
 *   这里覆盖三层：
 *     ① 组装层：注入了什么、位置对不对、标注了没有（纯函数，无库）
 *     ② 查询层：时间窗 / 排除自己 / 排除已删除 / 用户隔离（真库）
 *     ③ 端到端：新会话第一轮接得上、第二轮不再注入（真 HTTP）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildChatContext } from './context-builder.js';

const NOW = new Date('2026-10-08T10:15:00+08:00');

/** 上一个会话的末尾三条（对应实测里会话 A 的结尾） */
const PREV_TAIL = [
  {
    role: 'user' as const,
    content: '现在初版已经差不多了，把前端页面设计一下，连上模型的API就可以测试了',
    createdAt: new Date('2026-10-08T10:14:00+08:00'),
  },
  {
    role: 'assistant' as const,
    content: '那差不多了，前端页面这步通常比想的花时间……测完有啥结果跟我说说。',
    createdAt: new Date('2026-10-08T10:14:30+08:00'),
  },
];

function contentOf(messages: { content: string }[]): string {
  return messages.map((m) => m.content).join('\n---\n');
}

// ============================================================
// ① 组装层
// ============================================================

test('新会话第一轮会带上「刚刚在另一个对话里聊到」', () => {
  const ctx = buildChatContext({
    recentMessages: [],
    userMessage: '我国庆节期间除了做项目之外，就是睡觉了',
    previousConversation: { title: '国庆后返工聊 agent 进度', messages: PREV_TAIL },
    now: NOW,
    timezone: 'Asia/Shanghai',
  });

  const all = contentOf(ctx.messages);
  assert.match(all, /刚刚在另一个对话里聊到/, '必须有这一段');
  assert.match(all, /把前端页面设计一下/, '必须带上上一个会话的原文');
  assert.equal(ctx.meta.previousConversationCount, 2, '观测字段要记条数');
});

test('🔴 标注必须说清「这是另一个对话」并堵住「编理由」', () => {
  /**
   * 这是本次问题的核心 —— 模型当时说「你刚才没细讲项目本身」，
   * 它并不是在撒谎，而是**真的不知道自己看过什么**：
   * 上下文里只有当前会话，于是「我不知道」被合理化成「你没说过」。
   *
   * 因此措辞必须同时做到三件事：
   *   ① 承认看过（并且不是当前对话里的）
   *   ② 说明这与系统规则「想不起来就说没说过」不冲突 ——
   *      这条最关键：不改写这句，模型会把「另一个对话」当成
   *      「我想不起来的记忆」，然后按系统规则否认（实测 3 次里 2 次如此）
   *   ③ 不要问上面已经回答了的问题
   */
  const ctx = buildChatContext({
    recentMessages: [],
    userMessage: '继续',
    previousConversation: { messages: PREV_TAIL },
    now: NOW,
    timezone: 'Asia/Shanghai',
  });

  const all = contentOf(ctx.messages);
  assert.match(all, /另一个对话/, '要标明来源不是当前对话');
  assert.match(all, /你确实见过它/, '要明确说这是它见过的内容，不是想不起来的记忆');
  assert.match(
    all,
    /并不冲突/,
    '必须显式说明与「想不起来就说没说过」那条规则不冲突，否则模型会照那条否认'
  );
  assert.match(all, /不要说你没听过/, '要明确禁止「我没听过」这类否认');
  assert.match(all, /上面已经回答了的问题/, '要禁止重复询问上下文已回答的事');
});

test('段落位置在「当前会话历史」之前', () => {
  /**
   * 与摘要同一条理由：它讲的是「之前」的事，
   * 放在当前历史之后会被模型当成刚发生的。
   */
  const ctx = buildChatContext({
    recentMessages: [
      { role: 'user', content: '【当前会话的第一句】', createdAt: new Date('2026-10-08T10:15:30+08:00') },
    ],
    userMessage: '【当前这句】',
    previousConversation: { messages: PREV_TAIL },
    now: NOW,
    timezone: 'Asia/Shanghai',
  });

  const idxPrev = ctx.messages.findIndex((m) => m.content.includes('刚刚在另一个对话里聊到'));
  const idxCur = ctx.messages.findIndex((m) => m.content.includes('【当前会话的第一句】'));

  assert.ok(idxPrev >= 0 && idxCur >= 0);
  assert.ok(idxPrev < idxCur, '上一会话段落必须排当前历史之前');
});

test('不传 previousConversation 时**不插入任何段落**', () => {
  /**
   * 与摘要同一个纪律：没有内容就不插段落，
   * 而不是插一句「（无上一个对话）」—— 那白占 token 且暗示信息缺失。
   */
  const ctx = buildChatContext({
    recentMessages: [],
    userMessage: '你好',
    now: NOW,
    timezone: 'Asia/Shanghai',
  });

  assert.doesNotMatch(contentOf(ctx.messages), /另一个对话/);
  assert.equal(ctx.meta.previousConversationCount, 0);
});

test('上一个会话是空数组时也不插入段落', () => {
  const ctx = buildChatContext({
    recentMessages: [],
    userMessage: '你好',
    previousConversation: { messages: [] },
    now: NOW,
    timezone: 'Asia/Shanghai',
  });

  assert.doesNotMatch(contentOf(ctx.messages), /另一个对话/);
  assert.equal(ctx.meta.previousConversationCount, 0);
});

test('渲染出「距今多久」，且分钟级要写得准', () => {
  /**
   * 「刚刚」是相对判断：相隔 1 分钟与相隔 100 分钟，
   * 模型该有的语气完全不同（「你刚说」 vs 「你之前提到」）。
   */
  const ctx = buildChatContext({
    recentMessages: [],
    userMessage: '继续',
    // 距 NOW（10:15）1 分钟
    previousConversation: { messages: PREV_TAIL },
    now: NOW,
    timezone: 'Asia/Shanghai',
  });

  assert.match(contentOf(ctx.messages), /距今约 1 分钟|距今约不到 1 分钟/);
});

test('相距较久时「距今」按小时表述', () => {
  const ctx = buildChatContext({
    recentMessages: [],
    userMessage: '继续',
    previousConversation: {
      messages: [
        {
          role: 'user',
          content: '两小时前说的话',
          createdAt: new Date('2026-10-08T08:15:00+08:00'),
        },
      ],
    },
    now: NOW,
    timezone: 'Asia/Shanghai',
  });

  assert.match(contentOf(ctx.messages), /距今约 2 小时/);
});

test('注入的正文里不出现角色前缀混乱（对方 / 你）', () => {
  const ctx = buildChatContext({
    recentMessages: [],
    userMessage: '继续',
    previousConversation: { messages: PREV_TAIL },
    now: NOW,
    timezone: 'Asia/Shanghai',
  });

  const all = contentOf(ctx.messages);
  // 用户的话标「对方」，模型自己的话标「你」—— 便于模型分清谁说过什么
  assert.match(all, /对方：现在初版已经差不多了/);
  assert.match(all, /你：那差不多了/);
});
