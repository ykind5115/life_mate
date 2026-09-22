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
        // ⚠️ 推理模型需要足够预算：max_tokens 同时约束思维链与最终回答。
        //    实测 deepseek-flash 答这句要 148 推理 + 47 回答 token。
        //    给 16 会全部烧在思维链上、content 为空（那时会抛错，不会静默）。
        maxOutputTokens: 512,
      });
      if (!r.content) throw new Error('返回内容为空');
      const reasoningNote =
        r.usage.reasoningTokens > 0 ? `（其中推理 ${r.usage.reasoningTokens}）` : '';
      return (
        `模型=${r.model}  回答长度=${r.content.length}  ` +
        `token 输入/输出=${r.usage.inputTokens}/${r.usage.outputTokens}${reasoningNote}  ` +
        `finishReason=${r.finishReason}`
      );
    })
  );

  results.push(
    await check('空回答守卫生效（预算被推理吃光时应报错而非静默返回空）', async () => {
      try {
        await provider.generate({
          messages: [{ role: 'user', content: '请详细介绍一下你自己，写 500 字' }],
          // 刻意给极小的预算，逼出「全部用于推理、回答为空」的情形
          maxOutputTokens: 8,
        });
      } catch (err) {
        if (err instanceof LLMError) {
          return `已正确抛出：${err.message}（retryable=${String(err.options.retryable)}）`;
        }
        throw err;
      }
      // 也可以不触发（例如模型这次没走推理就直接回答），不算失败
      return '⚠️ 未触发（模型本次未耗尽预算）。守卫逻辑本身由单元测试覆盖';
    })
  );

  results.push(
    await check('返回模型与请求一致（防止别名导致归属不准）', async () => {
      const r = await provider.generate({
        messages: [{ role: 'user', content: 'ok' }],
        // 预算要足够：实测该模型即便对 "ok" 也可能花掉上百推理 token
        maxOutputTokens: 1024,
      });

      if (r.model !== env.LLM_MODEL) {
        // 不算失败（厂商可能做别名映射），但必须让使用者知道，
        // 否则日志与用量核算里的模型归属会与配置不一致
        return (
          `⚠️ 请求 ${env.LLM_MODEL}，实际返回 ${r.model}。` +
          `可能是厂商别名映射 —— 建议改用真实模型名（先查 /models）`
        );
      }
      return `请求与返回一致：${r.model}`;
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
        // 推理模型需要足够预算，否则 token 全用于思维链、无回答可流式产出
        maxOutputTokens: 1024,
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
