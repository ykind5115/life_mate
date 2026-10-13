/**
 * 守护「public/ 下都是能直接跑的原生 JS」
 *
 * 【为什么需要这条测试】
 *   前端是零构建的（docs/16 决策 A2）：浏览器直接加载 public/*.js，
 *   没有 TypeScript 编译这一步。因此那里**不能出现任何 TS 语法** ——
 *   一个 `let x: string` 或 `export interface Foo {}` 就会让整个模块
 *   在浏览器里语法错误，而页面表现为「一片空白」或某个功能静默失效。
 *
 *   🔴 这个错我犯过**两次**：
 *     · core.js 里的 `export type Child = …`（2026-10-08 前端改版）
 *     · recorder.js 里的 `let stream: MediaStream`（2026-10-13 加 STT）
 *   两次都是「顺手写了类型注释」，两次都是 `node --check` 才发现。
 *   人不会因为犯过一次就不再犯 —— 因此改成让机器每次检查。
 *
 * 【为什么用 node --check 而不是正则扫】
 *   正则会漏（我试过：`? :` 三目里的冒号会被误报，而某些 TS 语法
 *   又扫不出来）。node --check 是真正的解析器，它说语法错就是语法错。
 *
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PUBLIC_DIR = join(process.cwd(), 'public');

/** public/ 下所有 .js（不含 .ts —— 那是测试，走 tsx） */
function publicJsFiles(): string[] {
  return readdirSync(PUBLIC_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => join(PUBLIC_DIR, f));
}

test('public/ 下每个 .js 都是合法的原生 JS（零构建，不允许 TS 语法）', () => {
  const files = publicJsFiles();

  // 至少要有这几个核心文件 —— 少了说明目录结构变了，测试本身要更新
  assert.ok(files.length >= 3, `public/ 下的 .js 太少（${files.length} 个），检查是否找错目录`);

  for (const file of files) {
    assert.doesNotThrow(
      () => {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      },
      `${file} 不是合法的原生 JS。\n` +
        `前端零构建，public/*.js 由浏览器直接加载 ——\n` +
        `里面出现 TypeScript 语法（类型标注、interface、enum…）会让整个模块加载失败。`
    );
  }
});

test('public/ 下的 .js 不出现 TypeScript 专有语法', () => {
  /**
   * node --check 能抓住绝大多数情况，但有两类它抓不到：
   *   · `export type Foo = …`（类型导出）在 .js 里是语法错 —— 能抓到
   *   · 但有人可能「用 JSDoc 写类型」这种是合法的，不该误报
   *
   * 因此这里只扫**确定的 TS 专有写法**，作为第二道防线。
   * 宁可漏，不可误报 —— 误报会让人开始忽略这条测试。
   */
  const forbidden = [
    { re: /^\s*export\s+interface\s+\w+/m, what: 'export interface' },
    { re: /^\s*export\s+type\s+\w+\s*=/m, what: 'export type' },
    { re: /^\s*interface\s+\w+\s*\{/m, what: 'interface 声明' },
    { re: /^\s*(?:export\s+)?enum\s+\w+\s*\{/m, what: 'enum 声明' },
  ];

  for (const file of publicJsFiles()) {
    const source = readFileSync(file, 'utf8');
    for (const { re, what } of forbidden) {
      assert.doesNotMatch(source, re, `${file} 里出现了 TypeScript 的「${what}」`);
    }
  }
});

test('测试工具本身有效：故意塞一段 TS 语法应当被抓出来', () => {
  /**
   * ⚠️ 守测试工具。
   *    如果哪天有人把 --check 换成别的东西、或路径写错了，
   *    这条会失败 —— 否则上面两条可能一直在「测一个空集合」而全绿。
   */
  const dir = mkdtempSync(join(tmpdir(), 'lm-jscheck-'));
  const bad = join(dir, 'bad.js');
  writeFileSync(bad, 'let x: string = "1";\n', 'utf8');

  try {
    assert.throws(
      () => execFileSync(process.execPath, ['--check', bad], { stdio: 'pipe' }),
      '带类型标注的 .js 必须被 node --check 拒绝'
    );
  } finally {
    unlinkSync(bad);
  }

  // 确认 public/ 目录本身找得到（否则上面两条是空转）
  assert.ok(publicJsFiles().length > 0, 'publicJsFiles() 不该返回空数组');
});
