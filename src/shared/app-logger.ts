/**
 * 进程级日志器（带请求关联）
 *
 * 【为什么需要它，而不是各处 console.*】
 *   服务端此前有三种记日志的方式，各自丢不同的东西：
 *
 *     ① routes/chat.ts  用 request.log  → 有 request_id，但没有结构化字段
 *     ② chat-service.ts 用 console.*    → 没有 request_id（已改注入）
 *     ③ 后台任务（抽取/摘要/标题触发器、检索、设置解析）用 console.*
 *        → 既没有 request_id，也没有会话 id 之外的任何关联
 *
 *   第 ③ 类是这次要解决的：它们是 fire-and-forget 的后台任务，
 *   **不在请求上下文里**，所以拿不到 `request.log`。
 *   于是「这条回答为什么没记住」要同时看两处日志，而两处之间没有任何关联键。
 *
 * 【做法：进程级绑定一次真实 logger，各处用绑定后的实例】
 *   server.ts 启动时 bindAppLogger(app.log) 一次；之后任何地方
 *   （包括请求结束很久之后才跑完的后台任务）都能记出结构化日志。
 *
 *   为什么不在每个调用点传 logger：后台任务的调用链很长
 *   （route → service → trigger → pipeline），一路透传 logger 会污染
 *   所有签名，而它们中的大多数并不关心日志。绑定一次更省事且不易漏。
 *
 * 【缺省是"什么都不做"】
 *   脚本与测试不初始化它 —— 此时日志静默而非报错。
 *   理由：观测绝不能把业务搞挂，而 CLI 脚本的输出来自 console.log，
 *   不需要这些诊断日志（它们会污染脚本的输出）。
 *   需要看日志时显式调用，避免"忘记初始化导致什么都没有"这种情况
 *   变成静默失败 —— 因此 logXXX 函数在未初始化时是**无操作**，
 *   而 initializeAppLogger 会把"是否绑上"这件事变成一次显式动作。
 */

/** 只要求实际用到的三个方法，避免把 pino 的类型引到所有模块 */
export interface AppLogger {
  debug: (obj: Record<string, unknown>, msg: string) => void;
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

let bound: AppLogger | undefined;

/**
 * 绑定进程级日志器。由 server.ts 在组装 Fastify 之后调用一次。
 *
 * 重复调用会覆盖 —— 测试里每个用例 buildServer 一次，
 * 必须让最后一次生效，否则日志会写到已关闭的实例上。
 */
export function initializeAppLogger(logger: AppLogger): void {
  bound = logger;
}

/** 仅供测试：解除绑定，避免用例之间互相影响 */
export function resetAppLogger(): void {
  bound = undefined;
}

/** 当前是否已绑定。用于诊断「为什么我的日志没出来」 */
export function appLoggerBound(): boolean {
  return bound !== undefined;
}

/**
 * 记一条后台日志。
 *
 * ⚠️ 未绑定时**静默跳过**，不抛错也不回退到 console：
 *    回退会让「脚本输出」与「服务日志」混在一起，
 *    而脚本本来就该用 console.log 打自己的输出。
 *
 * @param fields 结构化字段。**不得含消息正文或记忆正文**（§29.1）
 */
export function logInfo(fields: Record<string, unknown>, msg: string): void {
  bound?.info(fields, msg);
}

export function logWarn(fields: Record<string, unknown>, msg: string): void {
  bound?.warn(fields, msg);
}

export function logError(fields: Record<string, unknown>, msg: string): void {
  bound?.error(fields, msg);
}
