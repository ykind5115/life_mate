/**
 * 安全的错误信息提取与日志化
 *
 * 【为什么必须有这个文件，而不是各处自己 `console.error(err)`】
 *
 *   🔴 2026-09-29 实测发现：`log.error({ err })` 会把**数据库参数值打进日志**。
 *      用真实 Fastify logger 打一次 Drizzle 的查询错误，产出是：
 *
 *        {"err":{"message":"Failed query: insert into \"messages\" …
 *                 params: 用户的私密对话内容-应绝不出现在日志里,user,x,1",
 *                "stack":"…params: 用户的私密对话内容…",
 *                "params":["用户的私密对话内容-应绝不出现在日志里","user","x",1]}}
 *
 *      三处同时泄露：错误消息里、stack 里、以及 `params` 数组本身。
 *      这直接违反 docs/03 §29.1「永不记录的字段」与
 *      §16.2「不得存任何级别的敏感正文副本」。
 *
 *      而泄露点是通用错误处理器 —— 也就是说**任何**一次 5xx
 *      （插入记忆失败、更新目标失败、写消息失败…）都可能把用户正文写进日志文件。
 *      这不是理论风险：writeMessage 的 content 就是用户原话。
 *
 * 【所以规则是】
 *   绝不把原始 error 对象交给 logger。一律先过 toLogError()。
 *   Pino 的默认 err 序列化器会把 enumerable 属性（含 params/query）
 *   原样带上，连 cause 链一起 —— 那是为通用场景设计的，不适合存私密数据的系统。
 *
 * 【保留什么，丢弃什么】
 *   保留：错误类型、postgres 错误码、约束名、堆栈、SQL 语句文本
 *         （语句里只有表名列名与 $1 占位符，**没有值**，对排查最有用）
 *   丢弃：params / parameters（就是值）、错误消息里的值
 *
 *   约束名与 SQL 文本是 schema 层面的信息，不含用户数据；
 *   而 `params` 恰好就是「用户说了什么」。这个区分是整个文件的立足点。
 */

/** 从错误对象上摘出来的安全字段 */
export interface LogError {
  /**
   * 错误类名，如 DrizzleQueryError / LLMError。
   *
   * ⚠️ 键名是 `errType` 而**不是** `type` 或 `name` —— 两个都是实测踩出来的：
   *    · `name`  → pino 的 err 序列化器见到它就把整个输出形状重写掉
   *    · `type`  → 同样被覆盖。pino 总是把自己算出的构造函数名写进 `type`
   *                （对它而言「是 Error 实例」时得到类名，对我们这个普通对象
   *                 则得到 `'Object'`），**覆盖掉我们传的值**。
   *    也就是说这两个键名下游都拿不到我们的值。换一个它不管的键最省事，
   *    而且比依赖「pino 的合并顺序恰好如何」更可靠 —— 那属于实现细节，
   *    换个版本就可能变。
   */
  errType: string;
  /** 可读消息。**已脱敏**：命中的参数值会被替换掉 */
  message: string;
  /** postgres 错误码，如 23505（唯一约束冲突）。纯数字，不含数据 */
  code?: string;
  /** 违反的约束名。schema 层面的标识，不含数据 */
  constraint?: string;
  /** 堆栈。同一进程内是代码路径，不含用户数据 */
  stack?: string;
}

/**
 * postgres 驱动挂在错误对象上的字段名。
 *
 * 注意 `query` **不在这里** —— SQL 文本要保留（它只有列名与占位符）。
 * 被丢弃的是承载**值**的那些字段。
 */
const VALUE_BEARING_KEYS = ['params', 'parameters', 'values', 'detail', 'where'] as const;

/**
 * 把任意错误转成安全的日志对象。
 *
 * @param err 原始错误（可以是任何东西）
 * @returns 可直接交给 logger 的对象；**不含任何参数值**
 */
export function toLogError(err: unknown): LogError {
  if (!(err instanceof Error)) {
    /**
     * 不是 Error 时也无法保证内容安全：`String(err)` 可能把整个对象
     * 序列化出来（例如某个库抛了个字符串或对象）。
     * 因此只记类型，**不记内容** —— 宁可少一条信息，也不冒泄露的风险。
     */
    return { errType: typeof err, message: '[非 Error 类型的异常，内容已省略]' };
  }

  /**
   * ⚠️ 这里必须用 `errorText` 之外的方式取消息。
   *    Drizzle 把参数值拼进了 message（`params: a,b,c`），
   *    因此消息本身也要过一遍脱敏。
   */
  const rawParams = collectParamValues(err);
  const message = redactValues(err.message, rawParams);

  const code = readString(err, 'code');
  const constraint = readString(err, 'constraint');

  return {
    errType: errorTypeName(err),
    message: message.slice(0, 1000),
    ...(code !== undefined ? { code } : {}),
    ...(constraint !== undefined ? { constraint } : {}),
    ...(typeof err.stack === 'string'
      ? { stack: redactValues(err.stack, rawParams).slice(0, 4000) }
      : {}),
  };
}

/**
 * 取错误的**真实**类名。
 *
 * ⚠️ 不能只用 `err.name`：实测 Drizzle 的 `DrizzleQueryError`
 *    把 `name` 设成了 `'Error'`（类名在 `constructor.name` 上）。
 *    只读 `name` 会把所有数据库错误都记成「Error」，
 *    而「这是数据库错误还是 LLM 错误」正是排查时第一个要区分的。
 */
function errorTypeName(err: Error): string {
  const ctorName = (err.constructor as { name?: string } | undefined)?.name;
  if (typeof ctorName === 'string' && ctorName.length > 0 && ctorName !== 'Object') {
    return ctorName;
  }
  return err.name || 'Error';
}

/**
 * 把错误链拼成一行文本，用于日志消息。
 *
 * 等价于此前散落在 5 个文件里的 describeError()，但**做了脱敏**。
 * 统一到这里之后，「哪份实现忘了脱敏」这个风险就不存在了。
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  let depth = 0;

  while (cur && depth < 5) {
    if (cur instanceof Error) {
      parts.push(`${cur.name}: ${cur.message}`);
      cur = (cur as { cause?: unknown }).cause;
    } else if (typeof cur === 'object') {
      const o = cur as Record<string, unknown>;
      if (typeof o['message'] === 'string') parts.push(o['message']);
      if (typeof o['constraint'] === 'string') parts.push(`constraint=${o['constraint']}`);
      cur = o['cause'];
    } else {
      if (cur !== undefined && cur !== null) parts.push(String(cur));
      break;
    }
    depth += 1;
  }

  /**
   * ⚠️ 拼完再统一脱敏，而不是逐段脱敏：
   *    参数值可能横跨拼接边界（前一段结尾 + 后一段开头），
   *    逐段处理会漏掉那种情况。
   */
  const values = collectParamValues(err);
  return redactValues(parts.join(' | '), values).slice(0, 1000);
}

// ============================================================
// 内部
// ============================================================

/**
 * 顺着 cause 链收集「承载值」的字段内容。
 *
 * 用途有两个：① 知道哪些值需要从文本里抹掉 ② 调试时判断有没有值被丢
 * （后者不做 —— 我们刻意不看这些值本身）。
 */
function collectParamValues(err: unknown, maxDepth = 5): string[] {
  const values: string[] = [];
  let cur: unknown = err;
  let depth = 0;

  while (cur && depth < maxDepth) {
    if (typeof cur === 'object') {
      const record = cur as Record<string, unknown>;
      for (const key of VALUE_BEARING_KEYS) {
        const raw = record[key];
        if (Array.isArray(raw)) {
          for (const v of raw) {
            if (typeof v === 'string' && v.length >= 4) values.push(v);
            else if (typeof v === 'number') values.push(String(v));
          }
        } else if (typeof raw === 'string' && raw.length >= 4) {
          values.push(raw);
        }
      }
      cur = record['cause'];
    } else {
      break;
    }
    depth += 1;
  }

  /**
   * 长的先替换：若短值是长值的子串，先处理短的会把长值切碎，
   * 导致剩下的片段仍含有部分内容。
   */
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/**
 * 把命中的参数值替换成占位符。
 *
 * ⚠️ 这不是「黑名单过滤」（§29.1 明确反对黑名单），而是
 *    **已知值的确切替换**：我们不是在猜什么内容敏感，
 *    而是把「本来就不该进日志的那几个字符串」精确抹掉。
 *    白名单在结构层面（toLogError 只输出 LogError 的 5 个字段）。
 */
function redactValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of values) {
    if (v.length === 0) continue;
    out = out.split(v).join('[已脱敏]');
  }
  return out;
}

/** 读一个字符串字段，兼做类型收窄 */
function readString(obj: object, key: string): string | undefined {
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
