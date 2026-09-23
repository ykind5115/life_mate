/**
 * public/markdown.js 的类型声明
 *
 * 为什么需要：那个文件是给浏览器用的原生 JS（没有构建步骤，
 * 因此不能写成 .ts）。而 src/ 下的测试要 import 它，
 * 于是 TypeScript 需要一个声明文件。
 *
 * 这是「前端保持零构建步骤」与「测试要类型检查」之间的折中：
 * 声明文件只有两个函数，维护成本可以忽略。
 */

/** 转义 HTML 特殊字符。& 先处理，避免双重转义 */
export function escapeHtml(s: string): string;

/**
 * 把不可信文本渲染成安全的 HTML 片段。
 *
 * ⚠️ 返回值可直接放进 innerHTML —— 实现保证先整体转义再加标签。
 */
export function renderMarkdown(text: string): string;
