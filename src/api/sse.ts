/**
 * SSE（Server-Sent Events）编码与写出（docs/04 §11）
 *
 * 【只用原生 reply.raw，不引入 @fastify/sse 一类插件】
 *   理由：SSE 的线上格式只有几行，自己写能保证「转义、flush、背压、
 *   客户端断开」这四件事被显式处理；引入插件反而要读它的源码才知道
 *   这四件事是怎么做的（尤其是断开检测，各家实现差异很大）。
 *   依赖越少，出问题时越容易定位。
 *
 * 【为什么每条 data 都要 JSON.stringify】
 *   模型输出的文字里可能有换行。SSE 以换行分隔事件字段，
 *   未转义的换行会把一条消息劈成两条，前端收到半截 JSON。
 *   JSON.stringify 会转义换行与引号，这是唯一安全的做法。
 */
import type { ServerResponse } from 'node:http';

/**
 * SSE 事件类型（docs/04 §11 定义了 token / done，其余为本次实现补充）。
 *
 * ⚠️ 文档只规定了 `token` 与 `done` 两种。这里多出四种，
 *    它们都服务于「一次流式响应里的失败与元信息」这个文档未展开的场景：
 *      · message  —— 落库后的消息 id（文档的 done 里没有 id，
 *                     前端拿不到 message_id 就无法做后续引用与反馈）
 *      · progress —— 模型在调用工具时的中间说明（不是给用户的回答）
 *      · error    —— 流已经开始后发生的错误（此时改不了 HTTP 状态码）
 *      · meta     —— 用量与截断信息
 *    属于对文档的**补充**而非违背：token/done 的语义保持不变。
 */
export type SseEvent =
  | { type: 'token'; content: string }
  | { type: 'progress'; turn: number; content: string }
  | { type: 'message'; role: 'user' | 'assistant'; message_id: string; conversation_id: string }
  | { type: 'meta'; data: Record<string, unknown> }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' };

export interface SseStreamOptions {
  /** 心跳间隔（ms）。0 表示关闭。默认 15s，防止中间层掐断空闲连接 */
  heartbeatMs?: number;
  /** 客户端断开时的回调（用于中止上游 LLM 调用） */
  onClose?: () => void;
}

/**
 * 一个已建立连接的 SSE 通道。
 *
 * 生命周期：
 *   new SseStream(res) → write 若干事件 → close()
 * 连接断开后 write 变成静默无操作（不抛错），
 * 因为「客户端走了」不是服务端错误。
 */
export class SseStream {
  private closed = false;
  private heartbeat?: NodeJS.Timeout;

  constructor(
    private readonly res: ServerResponse,
    private readonly options: SseStreamOptions = {}
  ) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform：禁止中间层压缩，否则 token 会被缓冲住，失去逐字效果
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 反向代理（nginx）需要它才不会缓冲
      'X-Accel-Buffering': 'no',
    });
    // 立即冲刷响应头，让前端能马上进入「已连接」状态
    res.flushHeaders?.();

    const heartbeatMs = options.heartbeatMs ?? 15_000;
    if (heartbeatMs > 0) {
      this.heartbeat = setInterval(() => {
        // 注释行（以 : 开头）是 SSE 规范里的心跳，客户端会忽略
        this.writeRaw(': ping\n\n');
      }, heartbeatMs);
      this.heartbeat.unref?.();
    }

    res.on('close', () => {
      this.closed = true;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.options.onClose?.();
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * 写一个事件。
   *
   * 背压处理：raw.write 返回 false 表示内核缓冲区已满。
   * 这里**不等待 drain** 而是继续写 —— 对 SSE 而言，
   * 阻塞在 drain 上会让整个 Agent 循环停住（onToken 是同步回调）。
   * 代价是极端慢的客户端可能堆积内存，但单用户本地场景不会发生；
   * 真要处理应在上层做「丢弃中间 token、只保留最终消息」的降级。
   */
  write(event: SseEvent): void {
    this.writeRaw(`data: ${JSON.stringify(event)}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.res.end();
  }

  // ------------------------------------------------------------

  private writeRaw(chunk: string): void {
    // 已断开时静默丢弃：客户端走了不是错误
    if (this.closed || this.res.writableEnded) return;
    this.res.write(chunk);
  }
}

/**
 * 从 HTTP 请求头解析幂等键（docs/04 §46）。
 *
 * 返回 null 表示客户端没提供 —— 此时不做幂等处理，
 * **不要**用 request id 之类自动生成的键去代替：
 * 那会让「同一次请求的重试」被当成新请求，幂等形同虚设。
 */
export function parseIdempotencyKey(headers: Record<string, unknown>): string | null {
  const raw = headers['idempotency-key'];
  if (typeof raw !== 'string') return null;

  const key = raw.trim();
  // 限制长度与字符集：键会被用作内存缓存的 key，且要能安全进日志
  if (key.length === 0 || key.length > 200) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) return null;

  return key;
}
