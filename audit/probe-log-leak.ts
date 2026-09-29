/**
 * 探针：验证「错误路径不会把数据库参数值打进日志」。
 *
 * 【为什么必须有这个探针】
 *   这是一条**踩过的事故**：2026-09-29 实测 `log.error({ err })` 打出了
 *     "params":["用户的私密对话内容-应绝不出现在日志里","user","x",1]
 *   修完之后必须有办法重新验证它，否则下次有人「为了调试」改回
 *   `{ err }` 时不会有任何提示。
 *
 * 做法：让一个真实的数据库错误穿过**真实的错误处理器**
 *      （buildServer 里那个 setErrorHandler），捕获 stdout 的日志行，
 *      断言敏感值没有出现。
 *
 * 运行：pnpm probe:log-leak
 * ⚠️ 会让一次写入失败（uuid 格式错误），不写任何数据。
 */
import { buildServer } from '../src/api/server.js';
import { closePool, db } from '../src/database/client.js';
import { messages } from '../src/database/schema/messages.js';
import { conversations } from '../src/database/schema/conversations.js';
import { users } from '../src/database/schema/users.js';
import { asc } from 'drizzle-orm';

/** 这个字符串就是「用户正文」。它绝不该出现在日志里 */
const SENSITIVE = '敏感用户正文-必须被脱敏-abc123xyz';

const captured: string[] = [];
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
  captured.push(String(chunk));
  return originalWrite(chunk as string, ...(rest as []));
}) as typeof process.stdout.write;

const app = await buildServer({ logLevel: 'error' });

/** 一条会 500 的路由：把敏感值塞进 uuid 列 */
app.post('/probe-leak', async () => {
  const [user] = await db.select().from(users).orderBy(asc(users.createdAt)).limit(1);
  await db.insert(conversations).values({ userId: user!.id, title: 'probe' });
  const [conv] = await db.select().from(conversations).orderBy(asc(conversations.createdAt)).limit(1);

  // conversation_id 是 uuid 列，塞非 uuid 必然抛错，且错误里带参数值
  await db.insert(messages).values({
    conversationId: SENSITIVE,
    role: 'user',
    content: SENSITIVE,
    sequence: 999999,
  });
  void conv;
  return { ok: true };
});

const res = await app.inject({ method: 'POST', url: '/probe-leak' });
await app.close();

process.stdout.write = originalWrite;

const logText = captured.join('');

console.log('='.repeat(70));
console.log(`HTTP 状态：${res.statusCode}（预期 500 —— 错误确实发生了）`);
console.log('='.repeat(70));

/** 逐条检查：日志里出现了什么、不该出现什么 */
const checks = [
  { name: '敏感值未出现在日志中', ok: !logText.includes(SENSITIVE) },
  {
    name: 'params 数组未被打印（那是原始参数值）',
    ok: !/"params"\s*:\s*\[/.test(logText),
  },
  {
    name: '堆栈仍然保留（排查需要）',
    ok: /"stack"/.test(logText),
  },
  {
    /**
     * ⚠️ 断言时要注意 JSON 转义：日志行里的引号是 \"messages\"。
     *    第一版写成 /insert into "messages"/ 直接假失败 ——
     *    文本明明在，是断言写错了。
     */
    name: 'SQL 语句文本仍保留（只有列名与占位符，排查最有用）',
    ok: /insert into \\"messages\\"/.test(logText),
  },
  {
    name: 'request_id 仍然带上（可关联到具体请求）',
    ok: /"reqId"/.test(logText),
  },
  {
    /**
     * 错误类名要能区分「数据库错误」与「LLM 错误」。
     *  · 用 constructor.name 而不是 err.name —— Drizzle 的 name 是 'Error'
     *  · 键名用 errType —— `type` 与 `name` 都会被 pino 覆盖（实测）
     */
    name: '错误类型是 DrizzleQueryError（不是笼统的 Object/Error）',
    ok: /"errType"\s*:\s*"DrizzleQueryError"/.test(logText),
  },
];

let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? '✅' : '❌'} ${c.name}`);
  if (!c.ok) failed += 1;
}

console.log('\n--- 实际日志（前 900 字符）---');
console.log(logText.slice(0, 900));

console.log(
  failed === 0
    ? '\n结论：错误路径已脱敏，且保留了排查所需的字段。'
    : `\n结论：${failed} 项未通过。`
);

await closePool();
process.exit(failed === 0 ? 0 : 1);
