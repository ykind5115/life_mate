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
  const facts = contents.findIndex((c) => c.includes('你记得的关于对方的事'));
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

// ============================================================
// 时间注入（docs/12 §方案 1，对应 docs/11 反馈 1.2 与 5）
// ============================================================

/** 北京时间（UTC+8）的构造助手：给 UTC 时刻，断言里写北京时间 */
function utc(iso: string): Date {
  return new Date(iso);
}

test('系统提示里带「当前时间」，且时区可注入', () => {
  const ctx = buildChatContext({
    ...base,
    timezone: 'Asia/Shanghai',
    now: utc('2026-09-26T12:18:00Z'), // 北京 20:18
  });

  const sys = ctx.messages[0]!.content;
  assert.match(sys, /当前时间/, '系统提示必须给出「现在」——反馈 1.2 的根因就是没有它');
  assert.match(sys, /2026年09月26日/, '日期按注入的时区渲染');
  assert.match(sys, /20:18/, '精确到分钟');
});

test('时区缺省不是 UTC —— 容器 TZ=UTC 时不能把北京时间算错', () => {
  /**
   * 这条是防回归：容器与 CI 的 TZ 通常是 UTC，
   * 而用户在中国。若缺省写成 UTC，凌晨 0-8 点的对话会被算到前一天。
   * 2026-09-26T16:30Z = 北京 09-27 00:30。
   */
  const ctx = buildChatContext({ ...base, now: utc('2026-09-26T16:30:00Z') });

  assert.match(ctx.messages[0]!.content, /2026年09月27日/, '缺省时区应为 Asia/Shanghai');
  assert.match(ctx.messages[0]!.content, /00:30/, '不能用 24:51 这种非法时刻');
});

test('午夜时刻不能渲染成 24 点', () => {
  // hourCycle 不显式指定 h23 时，zh-CN 的 00:10 会渲染成 24:10
  const ctx = buildChatContext({
    ...base,
    now: utc('2026-09-25T16:10:00Z'), // 北京 00:10
  });

  const sys = ctx.messages[0]!.content;
  assert.match(sys, /00:10/);
  assert.doesNotMatch(sys, /24:10/);
});

test('首条历史消息一定带时间标记（作为后续标记的锚点）', () => {
  const ctx = buildChatContext({
    ...base,
    recentMessages: [
      { role: 'user', content: '很久以前说的', createdAt: utc('2026-09-24T00:51:00Z') },
      { role: 'assistant', content: '嗯', createdAt: utc('2026-09-24T00:51:00Z') },
    ],
    now: utc('2026-09-24T01:00:00Z'),
  });

  const idx = ctx.messages.findIndex((m) => m.content.includes('08:51'));
  assert.ok(idx !== -1, '首条历史消息必须有时间标记，否则后面所有标记都失去参照');
  assert.equal(ctx.messages[idx]!.role, 'system');
  // 必须在对应消息**之前**
  assert.equal(ctx.messages[idx + 1]!.content, '很久以前说的');
});

test('间隔小于阈值不打标记，大于阈值才打', () => {
  const ctx = buildChatContext({
    ...base,
    recentMessages: [
      { role: 'user', content: '起点', createdAt: utc('2026-09-24T00:51:00Z') }, // 08:51
      { role: 'user', content: '30 分钟后', createdAt: utc('2026-09-24T01:21:00Z') }, // 09:21
      { role: 'user', content: '又过 2 小时', createdAt: utc('2026-09-24T03:30:00Z') }, // 11:30
    ],
    now: utc('2026-09-24T03:40:00Z'),
  });

  // 08:51 与 11:30 各一个标记；09:21 距 08:51 只有 30 分钟 → 不标
  assert.equal(ctx.meta.timeMarkerCount, 2);
  const contents = ctx.messages.map((m) => m.content);
  assert.ok(contents.some((c) => c.includes('08:51')));
  assert.ok(contents.some((c) => c.includes('11:30')));
  assert.ok(!contents.some((c) => c.includes('09:21')), '30 分钟不该打标记');
});

test('锚点是「上一个标记点」：同一天的两段也要各自带日期', () => {
  /**
   * 防一个实测踩到的错：曾按「与上一条消息同一天 → 只写时刻」渲染，
   * 于是 11:30 的标记退化成光秃秃一个「（11:30）」——
   * 模型既不知道是哪一天，也看不出与上一段隔了 2 小时。
   * 时间标记的全部价值就是锚定时间，为省字符把它变得有歧义是亏的。
   */
  const ctx = buildChatContext({
    ...base,
    recentMessages: [
      { role: 'user', content: '起点', createdAt: utc('2026-09-24T00:51:00Z') },
      { role: 'user', content: '30 分钟后', createdAt: utc('2026-09-24T01:21:00Z') },
      { role: 'user', content: '又过 2 小时', createdAt: utc('2026-09-24T03:30:00Z') },
    ],
    now: utc('2026-09-24T03:40:00Z'),
  });

  const marker = ctx.messages.map((m) => m.content).find((c) => c.includes('11:30'))!;
  assert.match(marker, /2026年09月24日/, '同一天也要写全日期');
  assert.match(marker, /距离上面这条消息已经过去 2 小时/, '要说明与上一段的间隔');
  assert.doesNotMatch(marker, /现在是/, '距「现在」只有 10 分钟，不该说「已经过去」');
});

test('跨天时标出日期与星期', () => {
  const ctx = buildChatContext({
    ...base,
    recentMessages: [
      { role: 'user', content: '第一天', createdAt: utc('2026-09-24T00:51:00Z') },
      { role: 'user', content: '第三天', createdAt: utc('2026-09-26T08:00:00Z') },
    ],
    now: utc('2026-09-26T08:05:00Z'),
  });

  const contents = ctx.messages.map((m) => m.content);
  assert.ok(contents.some((c) => c.includes('2026年09月24日 星期四')));
  assert.ok(contents.some((c) => c.includes('2026年09月26日 星期六')));
});

test('最后一条历史消息距「现在」超过阈值时，额外说明过了多久', () => {
  /**
   * 这是整次改动的关键 —— 反馈 5 的原话是
   * 「同一个会话中，我隔了两天再跟他讲话，她根本就分不清中间过了多长时间」。
   * 只标历史时间不够：必须让模型知道**这段沉默有多长**。
   */
  const ctx = buildChatContext({
    ...base,
    recentMessages: [
      { role: 'user', content: '两天前说的', createdAt: utc('2026-09-24T00:00:00Z') },
    ],
    now: utc('2026-09-26T05:00:00Z'), // 相距 2 天 5 小时
  });

  const marker = ctx.messages.find((m) => m.content.includes('距离这条消息已经过去'))!;
  assert.ok(marker, '必须说明距离现在过了多久');
  assert.match(marker.content, /2 天 5 小时/);
  assert.match(marker.content, /现在是 2026年09月26日/);
});

test('间隔不足阈值时不加「距离现在」那句（同一段连续对话不该被说成断开）', () => {
  const ctx = buildChatContext({
    ...base,
    recentMessages: [
      { role: 'user', content: '刚说的', createdAt: utc('2026-09-26T04:50:00Z') },
    ],
    now: utc('2026-09-26T05:00:00Z'), // 相距 10 分钟
  });

  assert.ok(
    !ctx.messages.some((m) => m.content.includes('距离这条消息已经过去')),
    '10 分钟的间隔属于同一段对话，不该声称「已经过去」'
  );
});

test('历史消息没有 createdAt 时完全不插标记（不抛错、不假装是现在）', () => {
  const ctx = buildChatContext(base);

  assert.equal(ctx.meta.timeMarkerCount, 0);
  // 只有系统提示里的那一条「当前时间」，没有历史标记
  assert.equal(
    ctx.messages.filter((m) => m.role === 'system' && m.content.startsWith('（')).length,
    0
  );
});

test('时间标记插在对应消息之前，不改变历史消息本身的顺序', () => {
  const ctx = buildChatContext({
    ...base,
    recentMessages: [
      { role: 'user', content: 'A', createdAt: utc('2026-09-24T00:51:00Z') },
      { role: 'assistant', content: 'B', createdAt: utc('2026-09-24T03:30:00Z') },
      { role: 'user', content: 'C', createdAt: utc('2026-09-26T08:00:00Z') },
    ],
    now: utc('2026-09-26T08:10:00Z'),
  });

  const seq = ctx.messages
    .filter((m) => m.role !== 'system')
    .map((m) => m.content);
  assert.deepEqual(seq, ['A', 'B', 'C', '现在几点了']);
});
