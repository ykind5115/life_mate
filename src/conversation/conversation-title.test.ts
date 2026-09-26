/**
 * 会话标题生成的测试（docs/12 §方案 2，对应 docs/11 反馈 4）
 *
 * 【只测纯函数 + 用假 provider 测一次端到端】
 *   本文件**不碰数据库**：generateConversationTitle 需要库，
 *   它的行为由 conversation-title.db.test.ts 覆盖。
 *   这里覆盖的是「模型输出脏了怎么办」—— 那是纯字符串逻辑，
 *   也是这个功能唯一容易出错的地方（模型经常不听话）。
 *
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildPlaceholderTitle,
  cleanTitle,
  TITLE_MAX_CHARS,
  TITLE_PLACEHOLDER_MAX_CHARS,
} from './conversation-title.js';

// ============================================================
// 占位标题
// ============================================================

test('占位标题取首条消息，短消息原样保留', () => {
  assert.equal(buildPlaceholderTitle('帮我看看简历'), '帮我看看简历');
});

test('占位标题把换行与连续空白压成单个空格', () => {
  // 标题是一行 —— 会话列表里的容器不会为多行留高度
  assert.equal(buildPlaceholderTitle('第一行\n\n第二行'), '第一行 第二行');
  assert.equal(buildPlaceholderTitle('  前后有空格  '), '前后有空格');
  assert.equal(buildPlaceholderTitle('多个    空格'), '多个 空格');
});

test('占位标题超长时截断并加省略号', () => {
  const long = '早上好呀，你知道现在是什么时间吗，你知道我是谁吗？';
  const title = buildPlaceholderTitle(long);

  assert.equal(title.length, TITLE_PLACEHOLDER_MAX_CHARS + 1); // +1 是省略号
  assert.ok(title.endsWith('…'));
  assert.ok(long.startsWith(title.slice(0, -1)), '截断处必须是原文前缀，不能改动内容');
});

test('占位标题：空消息回退到「新对话」而不是空字符串', () => {
  /**
   * 列表里显示空白项比显示「新对话」糟得多 ——
   * 用户会以为那条会话坏了。
   */
  assert.equal(buildPlaceholderTitle(''), '新对话');
  assert.equal(buildPlaceholderTitle('   \n  '), '新对话');
});

// ============================================================
// 标题清洗 —— 模型经常不听话，这里逐种实测到的脏输出
// ============================================================

test('清洗：去掉「标题：」这类前缀（中英文冒号都算）', () => {
  assert.equal(cleanTitle('标题：公安运维与 AI 开发'), '公安运维与 AI 开发');
  assert.equal(cleanTitle('标题:公安运维'), '公安运维');
  // 英文标题也走同一条路径（截断上限对英文同样适用）
  assert.equal(cleanTitle('title: ops work'), 'ops work');
});

test('清洗：去掉成对的引号与书名号', () => {
  assert.equal(cleanTitle('"公安运维与 AI 开发"'), '公安运维与 AI 开发');
  assert.equal(cleanTitle('“公安运维与 AI 开发”'), '公安运维与 AI 开发');
  assert.equal(cleanTitle('「公安运维与 AI 开发」'), '公安运维与 AI 开发');
  assert.equal(cleanTitle('《公安运维与 AI 开发》'), '公安运维与 AI 开发');
});

test('清洗：去掉句末标点', () => {
  assert.equal(cleanTitle('公安运维与 AI 开发。'), '公安运维与 AI 开发');
  assert.equal(cleanTitle('公安运维与 AI 开发！'), '公安运维与 AI 开发');
  assert.equal(cleanTitle('公安运维与 AI 开发~~~'), '公安运维与 AI 开发');
});

test('清洗：去掉 markdown 加粗与井号', () => {
  assert.equal(cleanTitle('**公安运维与 AI 开发**'), '公安运维与 AI 开发');
  assert.equal(cleanTitle('## 公安运维与 AI 开发'), '公安运维与 AI 开发');
});

test('清洗：只取第一行 —— 模型常在标题后面追加解释', () => {
  const raw = '公安运维与 AI 开发\n\n这个标题概括了对话的主要内容，因为用户提到了…';
  assert.equal(cleanTitle(raw), '公安运维与 AI 开发');
});

test('清洗：超长标题截断', () => {
  const raw = '一个非常非常非常非常长的标题超过了上限需要被截断处理';
  const out = cleanTitle(raw);

  assert.ok(out !== null);
  assert.equal(out.length, TITLE_MAX_CHARS + 1);
  assert.ok(out.endsWith('…'));
});

test('清洗：空输出返回 null（调用方保留占位标题）', () => {
  assert.equal(cleanTitle(''), null);
  assert.equal(cleanTitle('   \n  '), null);
  // 全是标点，清洗后什么都不剩
  assert.equal(cleanTitle('。。。'), null);
});

test('清洗：清洗不干净时返回 null，而不是把残渣当标题', () => {
  /**
   * 若模型输出的是「"标题一" 和 "标题二" 都可以」这类句子，
   * 按「去掉首尾引号」处理会得到 `标题一" 和 "标题二` —— 明显是垃圾。
   * 与其写进库里，不如保留占位标题等下一轮重试。
   */
  assert.equal(cleanTitle('"标题一" 和 "标题二" 都可以，你选一个'), null);
});
