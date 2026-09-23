/**
 * extraction_runs 仓库操作（§11）
 *
 * 这是为**正确性**服务的表，不是可观测性表（§11.1）。
 * 它保证「同一段消息恰好被抽取一次」。
 *
 * 两条硬性规则（都来自审计发现，见 docs/03 §0.3）：
 *
 * ① C19 —— 幂等键是 (conversation_id, **start_sequence**, extractor_version)
 *    不是 end_sequence。end_sequence 每次触发都在变，
 *    无法拦截「[1,5] 与 [1,10]」这类区间重叠的重复抽取。
 *
 * ② C21 —— 进度推进只统计 succeeded
 *    start_sequence = COALESCE(MAX(end_sequence) WHERE succeeded, 0) + 1
 *    若把 failed 也算进去，失败区间会被**永久跳过**且无任何提示。
 */
import { and, eq, sql } from 'drizzle-orm';

import { db } from '../client.js';
import { extractionRuns, type ExtractionRun } from '../schema/extraction-runs.js';
import type { ExecutorOption } from './types.js';

/**
 * 计算下一次抽取应从哪条消息开始（C21）。
 *
 * ⚠️ 只统计 status='succeeded' 的记录。
 *    失败区间因此会被下一次触发自然覆盖，无需特殊重试逻辑。
 */
export async function nextStartSequence(
  conversationId: string,
  options: ExecutorOption = {}
): Promise<number> {
  const exec = options.executor ?? db;

  /**
   * ⚠️ 必须显式 ::int 转型。
   *
   * bigint 列经 node-postgres 返回的是**字符串**（避免精度丢失），
   * 因此 `MAX(end_sequence)` 拿到的是 "21" 而不是 21。
   * 若只写 sql<number | null>，类型断言是假的：
   * 运行时仍是字符串，会让 `startSequence + maxMessages - 1`
   * 变成字符串拼接（"21" + 50 - 1 → NaN 或意外结果）。
   *
   * 消息序号不可能超过 2^31，::int 安全。
   */
  const rows = await exec
    .select({ maxEnd: sql<number | null>`MAX(${extractionRuns.endSequence})::int` })
    .from(extractionRuns)
    .where(
      and(
        eq(extractionRuns.conversationId, conversationId),
        eq(extractionRuns.status, 'succeeded')
      )
    );

  const maxEnd = rows[0]?.maxEnd ?? null;
  return (maxEnd ?? 0) + 1;
}

/** 尝试登记一次抽取的结果 */
export type ClaimResult =
  | { claimed: true; run: ExtractionRun }
  | { claimed: false; reason: 'already_succeeded' | 'in_progress' | 'duplicate' };

/**
 * 尝试认领（claim）一次抽取。
 *
 * 这是幂等的核心：先尝试登记，登记不上就说明这段消息已被抽取或正在抽取，
 * 直接返回、不重复执行。
 *
 * 实现用 ON CONFLICT + WHERE 限定可复用的状态：
 *   - succeeded 的记录不可复用（这就是幂等键的作用）
 *   - failed / pending 的记录可复用（重试场景）
 *   - running 的记录不复用（避免两个并发执行同时跑）
 *
 * ⚠️ ON CONFLICT 的 DO UPDATE 必须带 WHERE 条件限定可复用状态。
 *    否则一次成功的抽取会被同起点的后续触发覆盖，
 *    导致「已经抽过的区间被重新执行」—— 正是幂等键要防止的事。
 */
export async function claimExtractionRun(
  params: {
    conversationId: string;
    startSequence: number;
    endSequence: number;
    extractorVersion: string;
  },
  options: ExecutorOption = {}
): Promise<ClaimResult> {
  const exec = options.executor ?? db;

  const inserted = await exec
    .insert(extractionRuns)
    .values({
      conversationId: params.conversationId,
      startSequence: params.startSequence,
      endSequence: params.endSequence,
      extractorVersion: params.extractorVersion,
      status: 'running',
    })
    .onConflictDoUpdate({
      target: [
        extractionRuns.conversationId,
        extractionRuns.startSequence,
        extractionRuns.extractorVersion,
      ],
      set: {
        status: 'running',
        endSequence: params.endSequence,
        error: null,
        finishedAt: null,
      },
      // 只复用失败/待执行的记录；已成功或正在执行的都不复用
      setWhere: sql`${extractionRuns.status} IN ('failed','pending')`,
    })
    .returning();

  const run = inserted[0];
  if (run) {
    return { claimed: true, run };
  }

  // 没拿到记录：说明命中了幂等键但状态不可复用。查明原因用于日志与告警
  const existing = await exec
    .select({ status: extractionRuns.status })
    .from(extractionRuns)
    .where(
      and(
        eq(extractionRuns.conversationId, params.conversationId),
        eq(extractionRuns.startSequence, params.startSequence),
        eq(extractionRuns.extractorVersion, params.extractorVersion)
      )
    )
    .limit(1);

  const status = existing[0]?.status;
  if (status === 'succeeded') return { claimed: false, reason: 'already_succeeded' };
  if (status === 'running') return { claimed: false, reason: 'in_progress' };
  return { claimed: false, reason: 'duplicate' };
}

/** 标记抽取成功，并记录产出统计 */
export async function completeExtractionRun(
  runId: string,
  stats: {
    memoriesCreated: number;
    memoriesUpdated: number;
    memoriesSuperseded: number;
    conflictsFound: number;
  },
  options: ExecutorOption = {}
): Promise<void> {
  const exec = options.executor ?? db;

  await exec
    .update(extractionRuns)
    .set({
      status: 'succeeded',
      memoriesCreated: stats.memoriesCreated,
      memoriesUpdated: stats.memoriesUpdated,
      memoriesSuperseded: stats.memoriesSuperseded,
      conflictsFound: stats.conflictsFound,
      error: null,
      finishedAt: sql`now()`,
    })
    .where(eq(extractionRuns.id, runId));
}

/**
 * 标记抽取失败。
 *
 * 失败记录**保留**（用于告警与质量回溯），但不参与进度推进 ——
 * 因此失败区间会被下一次触发重新覆盖（C21）。
 */
export async function failExtractionRun(
  runId: string,
  error: string,
  options: ExecutorOption = {}
): Promise<void> {
  const exec = options.executor ?? db;

  await exec
    .update(extractionRuns)
    .set({ status: 'failed', error, finishedAt: sql`now()` })
    .where(eq(extractionRuns.id, runId));
}

/** 查询某会话的抽取历史，用于调试与前端进度展示 */
export async function listExtractionRuns(
  conversationId: string,
  options: ExecutorOption = {}
): Promise<ExtractionRun[]> {
  const exec = options.executor ?? db;

  return exec
    .select()
    .from(extractionRuns)
    .where(eq(extractionRuns.conversationId, conversationId))
    .orderBy(extractionRuns.startSequence);
}
