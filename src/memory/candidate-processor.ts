/**
 * 记忆判定流程（§13.7）—— Q2 决策的核心执行点
 *
 * 【为什么这段逻辑必须是确定性的】
 *   判定「该新增 / 该去重 / 是冲突」依赖槽位比较，而不是让 LLM 自由发挥。
 *   LLM 只在一个**窄任务**里出场：槽位确认相同、取值不同时，
 *   判断这是「事实变化」「真正冲突」还是「其实可共存」（三选一）。
 *
 *   这样才能让 PRD §15 的指标可测量、可回归：
 *     去重是否命中 → 确定性可测
 *     冲突是否识别 → 确定性可测 + LLM 窄任务可单独评测
 */
import { createHash } from 'node:crypto';

import type { Memory } from '../database/schema/memories.js';
import type { PredicateKey } from '../database/schema/enums.js';
import {
  createConflictMemory,
  createMemory,
  mergeDuplicate,
  supersedeMemory,
} from '../database/repository/memory-store.js';
import { findCurrentBySlot } from '../database/repository/memory-queries.js';
import type { NormalizedCandidate } from './extraction-schema.js';

/** 事务内外通用执行器，与 repository 保持一致 */
type Executor = Parameters<Parameters<typeof import('../database/client.js').db.transaction>[0]>[0];
type ExecutorLike = Parameters<typeof createMemory>[1] extends { executor?: infer E } ? E : never;

/**
 * 槽位确认相同、取值不同时，由 LLM 做的「三选一」窄任务。
 *
 * 抽成接口而非直接调 LLM 的原因：
 *   ① 便于测试注入固定判定，从而确定性地覆盖三个分支
 *   ② 便于后续加缓存或改为更小的模型（这个任务很窄，可用更便宜的模型）
 */
export interface SlotAdjudicator {
  adjudicate(input: {
    existing: Memory;
    candidate: NormalizedCandidate;
  }): Promise<'state_change' | 'conflict' | 'coexist'>;
}

/** 判定结果 */
export type CandidateOutcome =
  | { kind: 'created'; memory: Memory; reason: 'no_slot' | 'no_existing' | 'coexist' }
  | { kind: 'merged'; memory: Memory; reason: 'identical_value' }
  | { kind: 'superseded'; memory: Memory; previous: Memory; reason: 'state_change' }
  | { kind: 'conflict'; memory: Memory; existing: Memory; reason: 'conflict' };

export interface ProcessCandidateOptions {
  userId: string;
  candidate: NormalizedCandidate;
  /** 判定器。缺省时「取值不同」一律按冲突处理（保守：不擅自覆盖用户已有事实） */
  adjudicator?: SlotAdjudicator;
  executor?: ExecutorLike;
  /** 覆盖槽位（仅 coexist 分支会用到，把候选挪到另一个槽位） */
  overrideSlot?: { predicateKey: PredicateKey; objectValue: string };
}

/**
 * 处理一条候选记忆。
 *
 * 流程（严格对应 §13.7 的判定树）：
 *
 *   候选记忆
 *      │
 *      ├── 无槽位 ────────────→ 新增（不参与冲突判定）
 *      │
 *      ├── 取同槽位当前有效记忆
 *      │     ├── 无命中 ──────→ 新增
 *      │     ├── 取值等价 ────→ 去重合并（sourceCount++，不新建）
 *      │     └── 取值不同 ────→ LLM 三选一
 *      │            ├── state_change → supersede
 *      │            ├── conflict     → 以 conflict 状态落库，等用户裁决
 *      │            └── coexist      → 按新增处理
 *      └── ...
 */
export async function processCandidate(
  options: ProcessCandidateOptions
): Promise<CandidateOutcome> {
  const { userId, candidate } = options;
  const slot = options.overrideSlot ?? {
    predicateKey: candidate.predicateKey,
    objectValue: candidate.objectValue,
  };

  const sources = candidate.evidence
    ? [{ sourceType: 'system' as const }]
    : [{ sourceType: 'system' as const }];

  const createInput = {
    userId,
    type: candidate.type,
    content: candidate.content,
    subjectKey: candidate.subjectKey,
    ...(slot.predicateKey !== null ? { predicateKey: slot.predicateKey } : {}),
    ...(slot.objectValue !== null ? { objectValue: slot.objectValue } : {}),
    polarity: candidate.polarity,
    importanceScore: candidate.importanceScore,
    confidenceScore: candidate.confidenceScore,
    sources,
  };

  // ---------- 分支一：无槽位 → 直接新增 ----------
  // §13.7：「predicate_key 为空 → 只存储，不参与冲突判定」
  if (slot.predicateKey === null || slot.objectValue === null) {
    const memory = await createMemory(createInput, execOpt(options));
    return { kind: 'created', memory, reason: 'no_slot' };
  }

  // ---------- 分支二：查同槽位的当前有效记忆 ----------
  const existing = await findCurrentBySlot(
    { userId, subjectKey: candidate.subjectKey, predicateKey: slot.predicateKey },
    readOpt(options)
  );

  if (!existing) {
    const memory = await createMemory(createInput, execOpt(options));
    return { kind: 'created', memory, reason: 'no_existing' };
  }

  // ---------- 分支三：取值等价 → 去重合并 ----------
  if (isEquivalentValue(existing.objectValue, slot.objectValue)) {
    const memory = await mergeDuplicate(
      {
        memoryId: existing.id,
        sources,
        confidenceScore: candidate.confidenceScore,
      },
      execOpt(options)
    );
    return { kind: 'merged', memory, reason: 'identical_value' };
  }

  // ---------- 分支四：取值不同 → LLM 三选一 ----------
  const verdict = options.adjudicator
    ? await options.adjudicator.adjudicate({ existing, candidate })
    : // 无判定器时保守处理：不擅自覆盖用户已有的事实
      ('conflict' as const);

  if (verdict === 'state_change') {
    const { created, old } = await supersedeMemory(
      { oldMemoryId: existing.id, newMemory: createInput },
      execOpt(options)
    );
    return { kind: 'superseded', memory: created, previous: old, reason: 'state_change' };
  }

  if (verdict === 'coexist') {
    // §13.7 的「可共存」要求「检查 predicate 是否实际不同，修正后按新增处理」。
    // 但自动修正 predicate 需要判断「这句话到底属于哪个槽位」，
    // 那超出了本函数的确定性边界，因此**只接受调用方显式指定的新槽位**。
    //
    // 没有指定时退化为冲突（落到等用户裁决），而不是随便塞进一个槽位 ——
    // 硬套错槽位会污染后续的冲突判定，比让用户裁决一次更糟。
    const corrected = options.overrideSlot;

    if (corrected && corrected.predicateKey !== slot.predicateKey) {
      // 用修正后的槽位重新走一遍：此时是同槽位新增或去重
      return processCandidate({
        ...options,
        overrideSlot: corrected,
        candidate: { ...candidate, predicateKey: corrected.predicateKey },
      });
    }

    const conflictMemory = await createConflictMemory(createInput, execOpt(options));
    return {
      kind: 'conflict',
      memory: conflictMemory,
      existing,
      reason: 'conflict',
    };
  }

  // verdict === 'conflict'
  // 以 conflict 状态落库：保留上下文便于用户审阅，但不参与召回（C35）
  const conflictMemory = await createConflictMemory(createInput, execOpt(options));
  return { kind: 'conflict', memory: conflictMemory, existing, reason: 'conflict' };
}

// ============================================================
// 取值等价判定
// ============================================================

/**
 * 判断两个槽位取值是否等价（即应走去重而不是冲突）。
 *
 * ⚠️ 这是**确定性**判定，必须保守：
 *   宁可不合并（多一条记录，用户可裁决），也不要错合并
 *   （错合并会把「用户搬到深圳」并进「用户住在广州」，直接篡改事实）。
 *
 * 判定顺序：
 *   ① 完全相等 → 等价
 *   ② 去掉空白与全半角差异后相等 → 等价
 *   ③ 其余一律视为不同（进入 LLM 判定）
 */
export function isEquivalentValue(a: string | null, b: string | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;

  const norm = (s: string): string =>
    s
      .trim()
      .toLowerCase()
      // 全角转半角（仅处理常见区间，避免引入依赖）
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/\s+/g, '');

  return norm(a) === norm(b);
}

/** 生成槽位指纹，用于日志与去重统计 */
export function slotFingerprint(params: {
  subjectKey: string;
  predicateKey: string;
}): string {
  return createHash('sha256')
    .update(`${params.subjectKey}::${params.predicateKey}`)
    .digest('hex')
    .slice(0, 16);
}

// ============================================================
// 执行器透传
// ============================================================

function execOpt(options: ProcessCandidateOptions): { executor: ExecutorLike } | undefined {
  return options.executor ? { executor: options.executor } : undefined;
}

function readOpt(options: ProcessCandidateOptions): { executor: ExecutorLike } | undefined {
  return options.executor ? { executor: options.executor } : undefined;
}

/** 供调用方了解：本模块不生成 embedding（§25.2，须在事务外做） */
export type { Executor };
