/**
 * 极简 markdown 渲染（浏览器与 Node 通用，不碰 DOM）
 *
 * 【为什么单独成文件】
 *   app.js 是浏览器脚本，测试没法直接 import 它。
 *   而这里的逻辑涉及 **XSS 防护**，必须有回归测试 ——
 *   所以抽成一个没有 DOM 依赖的纯模块，两边都能用。
 *
 * 【唯一的铁律：先整体转义，再加标签】
 *   顺序反了就是 XSS。页面渲染的是**模型输出**与**用户自己的记忆内容**，
 *   前者可能包含任意字符（包括 <script>），后者是私密数据。
 *
 * 【支持的范围刻意很小】
 *   代码块、行内代码、加粗、标题行、无序列表。
 *   不做完整 markdown：那需要引库，而收益有限（这个界面主要显示对话）。
 */

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 把纯文本渲染成安全的 HTML 片段。
 *
 * @param {string} text 模型输出或用户内容（**不可信**）
 * @returns {string} 可直接放进 innerHTML 的 HTML
 */
export function renderMarkdown(text) {
  let s = escapeHtml(text);

  // 代码块
  s = s.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre class="code">${code.replace(/\n$/, '')}</pre>`;
  });

  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // 加粗
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  // 标题（行首 #）
  s = s.replace(/^#{1,3} (.+)$/gm, '<strong>$1</strong>');

  // 无序列表：连续以 - 或 * 开头的行。
  //
  // ⚠️ 返回值末尾要补回一个 '\n'：正则里的 `(?:\n|$)` 会**吃掉**列表项后面的
  //    那个换行，导致紧跟其后的正文被粘到列表上（实测：列表后的「结尾」
  //    会渲染进 <ul> 里）。
  s = s.replace(/(?:^[ \t]*[-*] .+$(?:\n|$))+/gm, (block) => {
    const items = block
      .trimEnd()
      .split('\n')
      .map((l) => `<li>${l.replace(/^[ \t]*[-*] /, '')}</li>`)
      .join('');
    return `<ul>${items}</ul>\n`;
  });

  // 列表末尾若是文档结尾，多出的换行会渲染成空行 —— 去掉
  s = s.replace(/<\/ul>\n$/, '</ul>');

  return s;
}
