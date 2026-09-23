/**
 * Context Builder 的测试
 *
 * 【重点：摘要的**位置**】
 *   docs/03 §12.4 明确要求摘要位于最近消息**之前**：
 *   「否则模型会误判时间顺序」。
 *   摘要讲的是较早的事，放到最近消息之后会被当成刚发生的 ——
 *   这类错误不会报错，只会让回答的时序推理悄悄变错。
 *
 * 纯函数测试，不需要数据库与 LLM。
 *
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildChatContext, estimateTokens } from './context-builder.js';

const base = {
  userMessage: '现在几点了',
  recentMessages: [
    { role: 'user' as const, content: '最近消息一' },
    { role: 'assistant' as const, content: '最近消息二' },
  ],
};

test('没有摘要时不插入摘要段落（不写「无更早对话」这类废话）', () => {
  const ctx = buildChatContext(base);

  const roles = ctx.messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'user']);

  const text = JSON.stringify(ctx.messages);
  assert.doesNotMatch(text, /更早部分的摘要/, '没有摘要时不该出现摘要段落');
  assert.equal(ctx.meta.summaryCount, 0);
});

test('有摘要时插在**最近消息之前**（§12.4 的硬要求）', () => {
  const ctx = buildChatContext({
    ...base,
    summaries: ['用户之前提到在准备考试'],
  });

  const contents = ctx.messages.map((m) => m.content);
  const summaryIdx = contents.findIndex((c) => c.includes('更早部分的摘要'));
  const firstHistoryIdx = contents.indexOf('最近消息一');

  assert.ok(summaryIdx !== -1, '摘要段落应存在');
  assert.ok(firstHistoryIdx !== -1);
  assert.ok(
    summaryIdx < firstHistoryIdx,
    '摘要必须在最近消息之前 —— 放到后面模型会把早先的事当成刚发生的'
  );

  // 结构：system(规则) + system(摘要) + 历史... + 当前消息
  assert.equal(ctx.messages[0]!.role, 'system');
  assert.equal(ctx.messages[1]!.role, 'system');
  assert.equal(ctx.messages[1]!.content.includes('更早部分的摘要'), true);
});

test('多条摘要按传入顺序排列并编号', () => {
  const ctx = buildChatContext({
    ...base,
    summaries: ['第一段摘要', '第二段摘要'],
  });

  const section = ctx.messages.find((m) => m.content.includes('更早部分的摘要'))!;
  assert.match(section.content, /【第 1 段】第一段摘要/);
  assert.match(section.content, /【第 2 段】第二段摘要/);
  assert.ok(
    section.content.indexOf('第一段') < section.content.indexOf('第二段'),
    '摘要顺序必须保持传入顺序（调用方已按 sequence 正序排好）'
  );
  assert.equal(ctx.meta.summaryCount, 2);
});

test('摘要段落显式提示「有损压缩，细节不要凭摘要推断」', () => {
  const ctx = buildChatContext({ ...base, summaries: ['某段摘要'] });
  const section = ctx.messages.find((m) => m.content.includes('更早部分的摘要'))!;

  /**
   * 不提示的话模型会把摘要与原文一视同仁，
   * 在用户追问细节时用摘要里被压缩掉的信息作答 —— 那是错的。
   */
  assert.match(section.content, /有损压缩/);
  assert.match(section.content, /不要凭摘要推断/);
});

test('检索到的记忆与摘要可以同时存在，顺序为 规则 → 记忆 → 摘要 → 历史', () => {
  const ctx = buildChatContext({
    ...base,
    summaries: ['更早的摘要'],
    retrieval: {
      performed: true,
      memories: [{ id: 'm1', content: '用户住在成都', type: 'fact', validFrom: null }],
    },
  });

  const contents = ctx.messages.map((m) => m.content);
  const rules = contents.findIndex((c) => c.includes('LifeMate'));
  const facts = contents.findIndex((c) => c.includes('已知信息（来自长期记忆'));
  const summary = contents.findIndex((c) => c.includes('更早部分的摘要'));
  const history = contents.indexOf('最近消息一');

  assert.ok(rules < facts, '规则在最前');
  assert.ok(facts < summary, '记忆在摘要之前');
  assert.ok(summary < history, '摘要在历史之前');
});

test('meta.approxTokens 覆盖全部消息', () => {
  const ctx = buildChatContext({ ...base, summaries: ['一段摘要是这样的'] });

  const expected = ctx.messages.reduce((n, m) => n + estimateTokens(m.content), 0);
  assert.equal(ctx.meta.approxTokens, expected);
  assert.ok(ctx.meta.approxTokens > 0);
});

test('estimateTokens：中文按字符数估算，不返回 0 或 NaN', () => {
  assert.equal(estimateTokens('中文四个字'), 5);
  assert.equal(estimateTokens(''), 0);
  assert.ok(!Number.isNaN(estimateTokens('abc')));
});
