/**
 * 幂等键存储（docs/04 §46）
 *
 * 【文档状态与实现取舍 —— 需要确认】
 *   docs/04 §46 只说「后续实现 Chat API 时应增加 Idempotency-Key …… V1.0 实现时纳入」，
 *   没有规定存储方案。
 *   docs/06 的 P2-6 给了两个候选：「一张轻量 idempotency_keys 表或内存缓存即可」，
 *   并强调「抽取流水线自身的幂等由 extraction_runs 保证，二者互补」。
 *
 *   本实现选**内存缓存**，理由：
 *     ① 该表若落库需要走 docs/03 的 Schema 变更流程（先改文档再改 Drizzle），
 *        而 docs/03 里没有这张表 —— 为一个非核心功能扩表不划算
 *     ② 幂等要防的场景是「网络超时后的重试」，重试发生在秒级；
 *        进程重启本来就意味着服务端状态重置，此时客户端也不该重试同一个键
 *     ③ 单用户本地部署，进程生命周期就是服务生命周期
 *
 *   ⚠️ 明确的代价：进程重启后，之前用过的键会被当作新键，
 *      同一次请求可能被执行两次。因此**幂等键不能当作「不重复对话」的保证**，
 *      它只是「同一进程内短时间重试」的优化。
 *
 * 【与 extraction_runs 幂等的分工】
 *   本存储保证「HTTP 请求不被重复执行」；
 *   extraction_runs 保证「同一段对话不被重复抽取」。
 *   前者失效时后者仍然兜底 —— 这是两层，不是重复。
 */

/** 缓存条目的存活时间。超过它视为新请求 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** 缓存上限。超过后按插入顺序淘汰最旧的（不是 LRU，够用） */
const DEFAULT_MAX_ENTRIES = 500;

interface Entry<T> {
  /** 请求指纹。用于识别「同一个键被用于不同请求」 */
  fingerprint: string;
  /** 已完成的响应。仍在执行时为 undefined */
  response?: T | undefined;
  /** 正在执行中的 Promise，用于让并发同键请求等待同一次执行 */
  inFlight?: Promise<T> | undefined;
  createdAt: number;
}

/** 幂等键被复用于不同请求体（docs/06 提到的 IDEMPOTENCY_CONFLICT） */
export class IdempotencyConflictError extends Error {
  readonly key: string;
  constructor(key: string) {
    super('同一个 Idempotency-Key 被用于了不同的请求内容');
    this.name = 'IdempotencyConflictError';
    this.key = key;
  }
}

export class IdempotencyStore<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly options: { ttlMs?: number; maxEntries?: number } = {}
  ) {}

  private get ttlMs(): number {
    return this.options.ttlMs ?? DEFAULT_TTL_MS;
  }

  private get maxEntries(): number {
    return this.options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * 用幂等键执行一次操作。
   *
   * 三种情况：
   *   ① key 为 null        → 直接执行，不缓存
   *   ② 命中且已完成       → 返回缓存结果，**不重复执行**
   *   ③ 命中但正在执行中   → 等待同一个 Promise（并发同键只会跑一次）
   *   ④ 命中但请求体不同   → 抛 IdempotencyConflictError
   *
   * @param fingerprint 请求指纹。同键不同指纹说明客户端复用错了键，
   *                    静默返回上一个结果会让用户以为新消息发出去了。
   */
  async run(
    key: string | null,
    fingerprint: string,
    fn: () => Promise<T>
  ): Promise<{ value: T; replayed: boolean }> {
    if (key === null) {
      return { value: await fn(), replayed: false };
    }

    this.evictExpired();

    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError(key);
      }
      if (existing.response !== undefined) {
        return { value: existing.response, replayed: true };
      }
      if (existing.inFlight) {
        return { value: await existing.inFlight, replayed: true };
      }
    }

    const entry: Entry<T> = existing ?? { fingerprint, createdAt: Date.now() };
    entry.fingerprint = fingerprint;

    const promise = fn();
    entry.inFlight = promise;

    // 先登记再 await：否则并发的第二个请求会在 await 期间看不到 inFlight
    this.entries.set(key, entry);
    this.evictOverflow();

    try {
      const value = await promise;
      entry.response = value;
      entry.inFlight = undefined;
      return { value, replayed: false };
    } catch (err) {
      /**
       * 失败时**删除条目**，让客户端可以用同一个键重试。
       *
       * 保留失败结果会让「第一次因为 LLM 抖动失败」的请求
       * 永远卡在错误上 —— 而幂等的目的是防重复执行，不是防重试。
       */
      this.entries.delete(key);
      throw err;
    }
  }

  /** 当前缓存条目数。用于测试与健康检查 */
  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  // ------------------------------------------------------------

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      // 执行中的条目不淘汰：淘汰会让并发的同键请求各跑一次
      if (entry.inFlight) continue;
      if (now - entry.createdAt > this.ttlMs) this.entries.delete(key);
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      // Map 保持插入顺序，第一个就是最旧的
      const oldest = this.entries.keys().next();
      if (oldest.done) return;

      const entry = this.entries.get(oldest.value);
      // 同样跳过执行中的
      if (entry?.inFlight) {
        const next = [...this.entries.entries()].find(([, e]) => !e.inFlight);
        if (!next) return;
        this.entries.delete(next[0]);
        continue;
      }
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * 计算请求指纹。
 *
 * 只用消息内容与会话 id —— 不掺入时间戳，否则同一个键的两次调用
 * 永远算出不同指纹，冲突检测会误报。
 */
export function fingerprintChat(body: { conversationId: string | null; message: string }): string {
  // 简单拼接足够：这不是安全哈希，只用于区分请求内容
  return `${body.conversationId ?? 'new'}\u0000${body.message}`;
}
