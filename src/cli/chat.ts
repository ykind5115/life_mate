/**
 * 终端聊天客户端
 *
 * 【为什么需要它】
 *   V1.0 还没有 Web UI（Phase 7 未开始），而 API 只能靠 curl 调 ——
 *   那不是能日常使用的形态。这个脚本让你现在就能真的用起来。
 *
 * 【零新增依赖】
 *   用 Node 内置的 readline + fetch（Node 18+ 自带），不引入任何包。
 *   AGENTS.md §2 要求新增依赖前说明理由 —— 这里根本没新增。
 *
 * 【用法】
 *   先启动服务：pnpm dev        （另开一个终端窗口）
 *   再运行本脚本：pnpm chat
 *
 *   输入消息回车发送；输入 :help 看命令。
 */
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';

const BASE = process.env['LIFEMATE_URL'] ?? 'http://127.0.0.1:3000';

// ============================================================
// 终端着色（不引依赖，直接写 ANSI）
// ============================================================

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// ============================================================
// 会话状态
// ============================================================

let conversationId: string | null = null;
/** 上次回答的元信息，供 :meta 查看 */
let lastMeta: Record<string, unknown> | null = null;

// ============================================================
// 主循环
// ============================================================

const rl = createInterface({ input: stdin, output: stdout });

/** 服务是否活着 */
async function checkServer(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function printBanner(): void {
  console.log(C.bold('\n  LifeMate') + C.dim(` — 终端对话（${BASE}）`));
  console.log(C.dim('  输入 :help 查看命令，:quit 退出\n'));
}

/**
 * 发送一条消息，逐 token 打印回答。
 *
 * 用 SSE 流式端点 —— 逐字输出的体验比等整段好得多，
 * 尤其是在模型要思考十几秒的时候（能看到它正在写）。
 */
async function send(message: string): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      conversationId ? { conversation_id: conversationId, message } : { message }
    ),
  });

  if (!res.ok) {
    // 参数错误等以普通 JSON 返回（校验发生在建立 SSE 之前）
    const body = (await res.json()) as { error?: { code: string; message: string; details?: unknown } };
    console.log(C.red(`\n  ✗ ${body.error?.code}: ${body.error?.message}`));
    if (body.error?.details) {
      console.log(C.dim('    ' + JSON.stringify(body.error.details)));
    }
    return;
  }

  if (!res.body) {
    console.log(C.red('\n  ✗ 响应没有 body'));
    return;
  }

  stdout.write('\n  ');
  const decoder = new TextDecoder();
  let buffer = '';
  let printedAny = false;

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });

    // SSE 以空行分隔事件
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;

      const payload = line.slice(5).trim();
      if (!payload) continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }

      switch (event['type']) {
        case 'token': {
          // 逐 token 打印；把换行也缩进，避免回答的左边缘跳来跳去
          const text = String(event['content'] ?? '');
          stdout.write(text.replace(/\n/g, '\n  '));
          printedAny = true;
          break;
        }
        case 'message': {
          if (event['role'] === 'assistant' && typeof event['conversation_id'] === 'string') {
            conversationId = event['conversation_id'];
          }
          break;
        }
        case 'meta': {
          lastMeta = (event['data'] as Record<string, unknown>) ?? null;
          const ctx = lastMeta?.['context'] as Record<string, number> | undefined;
          if (ctx && (ctx['injectedMemoryCount'] ?? 0) > 0) {
            // 让用户看到"它想起了什么" —— 那是这个产品的核心体验
            stdout.write('\n' + C.dim(`  （召回了 ${ctx['injectedMemoryCount']} 条记忆）`));
          }
          break;
        }
        case 'error': {
          console.log('\n' + C.red(`  ✗ ${event['code']}: ${event['message']}`));
          break;
        }
        case 'done':
          break;
      }
    }
  }

  if (!printedAny) console.log(C.yellow('  （没有输出内容）'));
  console.log('\n');

  // 抽取是后台跑的，给个提示让用户知道"正在记"
  if (lastMeta && (lastMeta['tool_calls_executed'] as number) > 0) {
    console.log(C.dim(`  （调用了 ${lastMeta['tool_calls_executed']} 次工具）\n`));
  }
}

// ============================================================
// 命令
// ============================================================

async function showHelp(): Promise<void> {
  console.log(`
  ${C.bold('命令')}
    ${C.cyan(':help')}      显示本帮助
    ${C.cyan(':new')}       开始新会话
    ${C.cyan(':mem')}       看最近记住的东西
    ${C.cyan(':search')} ${C.dim('<词>')} 搜索记忆
    ${C.cyan(':goals')}     看目标
    ${C.cyan(':timeline')}  看人生时间线
    ${C.cyan(':meta')}      看上次回答的元信息（召回数、token 用量）
    ${C.cyan(':quit')}      退出
`);
}

async function showMemories(): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/memories?page_size=20`);
  const body = (await res.json()) as {
    data?: { items: MemoryDto[]; pagination: { total: number } };
  };
  const items = body.data?.items ?? [];

  console.log(C.bold(`\n  当前有效记忆 ${body.data?.pagination.total ?? 0} 条：\n`));
  for (const m of items) {
    const slot = m.predicate_key ? C.dim(`[${m.predicate_key}]`) : C.dim('[无槽位]');
    console.log(`    ${C.cyan(m.type.padEnd(12))} ${slot} ${m.content}`);
  }
  console.log();
}

interface MemoryDto {
  id: string;
  type: string;
  content: string;
  predicate_key: string | null;
  object_value: string | null;
  importance_score?: number;
}

async function searchMemories(query: string): Promise<void> {
  const res = await fetch(
    `${BASE}/api/v1/memories/search?q=${encodeURIComponent(query)}&limit=5`
  );
  const body = (await res.json()) as {
    data?: { items: (MemoryDto & { score: number })[]; diagnostics?: { channelHits: Record<string, number> } };
  };
  const items = body.data?.items ?? [];

  console.log(C.bold(`\n  「${query}」的检索结果：\n`));
  if (items.length === 0) {
    console.log(C.dim('    （没有匹配的记忆）\n'));
    return;
  }
  for (const m of items) {
    console.log(`    ${C.green(m.score.toFixed(3))} ${m.content}`);
  }
  const ch = body.data?.diagnostics?.channelHits;
  if (ch) console.log(C.dim(`\n    通道命中: 向量 ${ch['vector']} / 关键词 ${ch['keyword']} / 槽位 ${ch['slot']}\n`));
}

async function showGoals(): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/goals?page_size=20`);
  const body = (await res.json()) as {
    data?: { items: { title: string; status: string; target_at: string | null; is_ongoing: boolean }[]; pagination: { total: number } };
  };
  const items = body.data?.items ?? [];

  console.log(C.bold(`\n  目标 ${body.data?.pagination.total ?? 0} 个：\n`));
  if (items.length === 0) {
    console.log(C.dim('    （还没有目标。用 API 创建：POST /api/v1/goals）\n'));
    return;
  }
  for (const g of items) {
    const mark = g.is_ongoing ? C.green('●') : C.dim('○');
    const target = g.target_at ? C.dim(` → ${g.target_at.slice(0, 10)}`) : '';
    console.log(`    ${mark} ${g.title} ${C.dim(`(${g.status})`)}${target}`);
  }
  console.log();
}

async function showTimeline(): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/timeline?page_size=30`);
  const body = (await res.json()) as {
    data?: { months: { month: string; total: number; items: { title: string; event_time: string; category: string | null }[] }[]; pagination: { total: number } };
  };
  const months = body.data?.months ?? [];

  console.log(C.bold(`\n  人生时间线 ${body.data?.pagination.total ?? 0} 条：\n`));
  if (months.length === 0) {
    console.log(C.dim('    （还没有事件）\n'));
    return;
  }
  for (const m of months) {
    console.log(`    ${C.bold(m.month)} ${C.dim(`(${m.total})`)}`);
    for (const e of m.items) {
      const cat = e.category ? C.dim(`[${e.category}]`) : '';
      console.log(`      ${e.event_time.slice(0, 10)} ${cat} ${e.title}`);
    }
  }
  console.log();
}

function showMeta(): void {
  if (!lastMeta) {
    console.log(C.dim('\n  （还没有对话记录）\n'));
    return;
  }
  console.log(C.bold('\n  上次回答的元信息：\n'));
  console.log('    ' + JSON.stringify(lastMeta, null, 2).replace(/\n/g, '\n    ') + '\n');
}

// ============================================================
// 入口
// ============================================================

async function main(): Promise<void> {
  printBanner();

  if (!(await checkServer())) {
    console.log(C.red(`  ✗ 连不上服务（${BASE}）`));
    console.log(C.dim('    请先在另一个终端窗口运行：pnpm dev\n'));
    process.exit(1);
  }

  // 读出已有会话数，给个开场提示
  try {
    const res = await fetch(`${BASE}/api/v1/memories?page_size=1`);
    const body = (await res.json()) as { data?: { pagination: { total: number } } };
    const n = body.data?.pagination.total ?? 0;
    if (n > 0) {
      console.log(C.dim(`  已记住 ${n} 条关于你的事。直接开始聊就行。\n`));
    } else {
      console.log(C.dim('  还没有任何记忆。聊几句，系统会在后台自己整理。\n'));
    }
  } catch {
    // 读不到记忆数不影响使用
  }

  rl.setPrompt(C.green('  你 > '));
  rl.prompt();

  /**
   * 用 for await 逐行读，而不是 rl.on('line')。
   *
   * 理由：send() 是异步的，事件回调里 await 会让多行输入交错。
   * 逐行读可以保证「上一次回答打印完再处理下一句」。
   */
  for await (const rawLine of rl) {
    const line = rawLine.trim();

    if (line.length === 0) {
      rl.prompt();
      continue;
    }

    if (line.startsWith(':')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      try {
        switch (cmd) {
          case 'help':
          case 'h':
            await showHelp();
            break;
          case 'new':
            conversationId = null;
            lastMeta = null;
            console.log(C.dim('\n  已开始新会话。\n'));
            break;
          case 'mem':
            await showMemories();
            break;
          case 'search':
            if (rest.length === 0) console.log(C.dim('\n  用法: :search 关键词\n'));
            else await searchMemories(rest.join(' '));
            break;
          case 'goals':
            await showGoals();
            break;
          case 'timeline':
            await showTimeline();
            break;
          case 'meta':
            showMeta();
            break;
          case 'quit':
          case 'q':
          case 'exit':
            console.log(C.dim('\n  再见。\n'));
            rl.close();
            return;
          default:
            console.log(C.dim(`\n  未知命令 :${cmd}，输入 :help 查看\n`));
        }
      } catch (err) {
        console.log(C.red(`\n  ✗ 命令失败：${err instanceof Error ? err.message : String(err)}\n`));
      }
      rl.prompt();
      continue;
    }

    try {
      await send(line);
    } catch (err) {
      console.log(C.red(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`));
    }
    rl.prompt();
  }
}

main().catch((err: unknown) => {
  console.error('\n客户端异常：', err instanceof Error ? err.message : err);
  process.exit(1);
});
