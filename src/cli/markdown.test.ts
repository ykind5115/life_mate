/**
 * markdown 渲染与 XSS 防护的测试
 *
 * 【为什么必须测】
 *   renderMarkdown 的输出直接进 innerHTML，内容来自**模型输出**与
 *   **用户自己的记忆**。这里出错就是 XSS —— 而模型输出完全不可信
 *   （用户可以让模型复述一段带 <script> 的文本）。
 *
 *   此外它还负责显示：列表/代码块渲染错了，用户看到的就是一团糊。
 *
 * 测试对象是 public/markdown.js —— 它是纯函数模块（不碰 DOM），
 * 因此可以被 Node 直接 import。app.js 则不行（那是浏览器脚本）。
 *
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escapeHtml, renderMarkdown } from '../../public/markdown.js';

// ============================================================
// XSS 防护（本文件最重要的一组）
// ============================================================

test('renderMarkdown：script 标签被转义', () => {
  assert.equal(
    renderMarkdown('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;'
  );
});

test('renderMarkdown：img onerror 这类属性注入被转义', () => {
  assert.equal(
    renderMarkdown('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;'
  );
});

test('renderMarkdown：代码块内部同样被转义（不能因为进了 pre 就放松）', () => {
  assert.equal(
    renderMarkdown('```\n<script>x</script>\n```'),
    '<pre class="code">&lt;script&gt;x&lt;/script&gt;</pre>'
  );
});

test('escapeHtml：& 先处理，不产生双重转义问题', () => {
  // 若先把 < 换成 &lt; 再处理 &，就会把 &lt; 变成 &amp;lt;
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
});

test('escapeHtml：双引号被转义（防止属性逃逸）', () => {
  assert.equal(escapeHtml('a"b'), 'a&quot;b');
});

test('renderMarkdown：转义后的内容不会被后续规则误解为标签', () => {
  /**
   * 用户输入「<strong>假加粗</strong>」时，转义后应显示为纯文本，
   * 而不是真的渲染成加粗 —— 否则用户能伪造格式。
   */
  const out = renderMarkdown('<strong>假加粗</strong>');
  assert.equal(out, '&lt;strong&gt;假加粗&lt;/strong&gt;');
  assert.ok(!out.includes('<strong>假加粗'));
});

// ============================================================
// markdown 渲染
// ============================================================

test('renderMarkdown：加粗', () => {
  assert.equal(renderMarkdown('这是**重点**内容'), '这是<strong>重点</strong>内容');
});

test('renderMarkdown：行内代码', () => {
  assert.equal(renderMarkdown('用 `pnpm test` 运行'), '用 <code>pnpm test</code> 运行');
});

test('renderMarkdown：代码块保留内部换行', () => {
  assert.equal(
    renderMarkdown('```js\nconst a = 1;\nconst b = 2;\n```'),
    '<pre class="code">const a = 1;\nconst b = 2;</pre>'
  );
});

test('renderMarkdown：标题行渲染为加粗', () => {
  assert.equal(renderMarkdown('## 小节'), '<strong>小节</strong>');
  assert.equal(renderMarkdown('### 三级'), '<strong>三级</strong>');
});

test('renderMarkdown：无序列表', () => {
  assert.equal(
    renderMarkdown('- 第一条\n- 第二条'),
    '<ul><li>第一条</li><li>第二条</li></ul>'
  );
});

test('renderMarkdown：列表后的正文不被粘进列表（回归）', () => {
  /**
   * 实测踩到过：列表正则里的 `(?:\n|$)` 会吃掉列表项后的换行，
   * 导致紧跟其后的正文被渲染进 <ul> 里。
   * 表现是「列表下面那句话说不出为什么缩进了」。
   */
  assert.equal(
    renderMarkdown('开头\n- 项目\n结尾'),
    '开头\n<ul><li>项目</li></ul>\n结尾'
  );
});

test('renderMarkdown：列表在文末时不产生多余空行', () => {
  assert.equal(renderMarkdown('开头\n- 项目'), '开头\n<ul><li>项目</li></ul>');
});

test('renderMarkdown：两个列表之间的正文保持独立', () => {
  assert.equal(
    renderMarkdown('- A\n中间\n- B'),
    '<ul><li>A</li></ul>\n中间\n<ul><li>B</li></ul>'
  );
});

// ============================================================
// 边界情况
// ============================================================

test('renderMarkdown：空字符串与纯换行不报错', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown('\n\n'), '\n\n');
});

test('renderMarkdown：未闭合的代码块不吞掉内容', () => {
  // 模型流式输出时可能出现未闭合的代码块（还没输出完），
  // 这时不应把内容吃掉，否则用户看着一段文字凭空消失
  assert.equal(renderMarkdown('```\n没有结束'), '```\n没有结束');
});

test('renderMarkdown：普通中文与换行原样保留', () => {
  assert.equal(renderMarkdown('第一行\n第二行'), '第一行\n第二行');
});
