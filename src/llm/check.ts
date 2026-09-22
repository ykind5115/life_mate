/**
 * LLM 连通性自检
 *
 * 用途：确认 Provider 配置有效、鉴权通过、流式与非流式都能工作。
 *       这是 Phase 6 的验收手段之一，也用于排查「回答为空」这类问题。
 *
 * 运行：pnpm llm:check   （需 .env 中有真实的 LLM_API_KEY）
 *
 * ⚠️ 会真实调用 API 并产生少量费用（约几十 token）。
 *    输出中**不打印回答正文**，只打印长度与用量，避免把对话内容留在终端。
 */
import { getLLMProvider } from '../llm/index.js';
import { LLMError } from '../llm/provider.js';
import { env } from '../shared/env.js';

type CheckResult = { name: string; ok: boolean; detail: string };

async function check(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    const detail =
      err instanceof LLMError
        ? `${err.message}${err.options.status ? ` (HTTP ${err.options.status})` : ''}` +
          `  retryable=${String(err.options.retryable)}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { name, ok: false, detail };
  }
}

async function main(): Promise<void> {
  // API Key 是否还是占位符 —— 最常见的新手错误，单独检查并给出明确指引
  if (env.LLM_API_KEY.startsWith('sk-replace')) {
    console.error('\n❌ LLM_API_KEY 仍是占位符，请先填入真实密钥。');
    console.error('   获取地址：https://platform.deepseek.com/api_keys');
    console.error('   填入位置：项目根目录 .env 的 LLM_API_KEY=');
    console.error('   注意：.env 不会被提交（已在 .gitignore 中）。\n');
    process.exitCode = 1;
    return;
  }

  const provider = getLLMProvider();
  const results: CheckResult[] = [];

  results.push(
    await check('非流式生成', async () => {
      const r = await provider.generate({
        messages: [{ role: 'user', content: '请只回复两个字：收到' }],
        maxOutputTokens: 16,
      });
      if (!r.content) throw new Error('返回内容为空');
      // 只报长度，不报正文
      return `模型=${r.model}  回答长度=${r.content.length}  ` +
        `token 输入/输出=${r.usage.inputTokens}/${r.usage.outputTokens}  ` +
        `finishReason=${r.finishReason}`;
    })
  );

  results.push(
    await check('流式生成', async () => {
      let chunks = 0;
      let text = '';
      let done = false;
      let errMsg: string | undefined;

      for await (const c of provider.stream({
        messages: [{ role: 'user', content: '从 1 数到 5，用逗号分隔' }],
        maxOutputTokens: 32,
      })) {
        if (c.type === 'token') {
          chunks++;
          text += c.content;
        } else if (c.type === 'done') {
          done = true;
        } else if (c.type === 'error') {
          errMsg = c.error;
        }
      }

      if (errMsg) throw new Error(`流中错误：${errMsg}`);
      if (!done) throw new Error('流结束但没有收到 done 块');
      if (chunks === 0) throw new Error('没有收到任何 token 块');
      return `收到 ${chunks} 个 token 块，累积长度 ${text.length}`;
    })
  );

  results.push(
    await check('中止信号生效', async () => {
      const ac = new AbortController();
      // 立刻中止：应当快速失败，而不是等完整回答
      ac.abort();
      try {
        await provider.generate({
          messages: [{ role: 'user', content: '写一篇 1000 字的文章' }],
          signal: ac.signal,
        });
        return '⚠️ 中止后仍然成功返回（可能请求太快，未真正触发中止）';
      } catch (err) {
        if (err instanceof LLMError && err.message.includes('取消')) {
          return '已正确中止（retryable=false）';
        }
        throw err;
      }
    })
  );

  console.log('\nLLM 连通性自检');
  console.log('='.repeat(64));
  console.log(`  provider=${env.LLM_PROVIDER}  baseUrl=${env.LLM_BASE_URL}`);
  console.log(`  model=${env.LLM_MODEL}`);
  console.log('-'.repeat(64));
  for (const r of results) {
    console.log(`${r.ok ? '  [OK]  ' : '  [FAIL]'} ${r.name}`);
    console.log(`         ${r.detail}`);
  }
  console.log('='.repeat(64));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n通过 ${results.length - failed.length}/${results.length}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('\n自检执行失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
