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

import type { StoreExecutor } from '../database/repository/types.js';
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

/**
 * 执行器类型。
 *
 * 直接复用仓库导出的 StoreExecutor，**不在这里重新定义或推导** ——
 * 曾试过用条件类型从仓库签名推导，结果推出了 never，
 * 使测试里的 `as never` 变成假通过。类型要么显式，要么别写。
 */
export type ExecutorLike = StoreExecutor;

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

  /**
   * 来源消息。**由调用方提供，不由 LLM 提供**。
   *
   * ⚠️ 为什么要显式传入而不是靠候选里的 evidence：
   *    evidence 是 LLM 摘录的**文本**，不是可解析的指针。
   *    用它无法回答「这条记忆来自哪条消息」，也就无法实现
   *    §15 的来源追踪与「点击记忆跳转到原始对话」。
   *    来源必须是**确定性的 message_id**，而只有调用方（抽取编排层）
   *    知道本次抽取覆盖了哪些消息。
   *
   * ⚠️ 这个字段是**必填**的。此前它是隐式的（写死 sourceType='system'
   *    且所有指针为 null），导致抽取产出的记忆全部无法追溯 ——
   *    而这类缺口不会报错，只会让产品承诺静默失效。
   *    设为必填后，调用方必须在编译期就决定来源。
   *
   * 允许空数组：表示「确无消息来源」（如用户手工创建）。
   * 但那时 sourceType 应相应设为 'manual'。
   */
  source: { messageIds: string[] };

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

  /**
   * 来源指针。
   *
   * 每条来源消息产生一条 memory_sources 记录（§15.2）——
   * 一条记忆可能同时由多句话支撑，全部记下来才能完整追溯。
   *
   * sourceType 固定为 'conversation'：抽取的来源一定是对话。
   * 'manual'（用户手工创建）与 'goal_projection'（Goal 投影）
   * 走别的入口，不在本流程。
   */
  const sources =
    options.source.messageIds.length > 0
      ? options.source.messageIds.map((messageId) => ({
          sourceType: 'conversation' as const,
          messageId,
        }))
      : // 无消息来源：manual 在 chk_sources_has_origin 的豁免列表内
        [{ sourceType: 'manual' as const }];

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
    /**
     * 事实生效时间（业务时间）。
     *
     * ⚠️ 只有模型明确给出了时间线索时才传。
     *    不传的语义是「自记录起有效」—— 那是诚实的表达。
     *
     *    刻意**不**在这里用「对话发生时间」兜底：
     *    实测踩到过 —— 用户说「我上周三搬到杭州」，
     *    事件记为 09-16，而记忆的 valid_from 被写成对话当天 09-23，
     *    于是 Agent 把搬家日期说成了 09-23。
     *    valid_from 属 C25 的不可变字段，写错只能重建记忆，
     *    因此必须在写入时就留空而不是填一个近似值。
     */
    ...(candidate.validFrom !== null ? { validFrom: candidate.validFrom } : {}),
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
    execOpt(options)
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

/**
 * 生成槽位指纹。
 *
 * 用途：把「同一槽位」聚合成一个短的稳定标识，用于
 *   ① 日志与告警里按槽位聚合冲突率 —— 冲突率异常的槽位通常意味着
 *      提示词对该槽位的边界定义不清，或该属性本身易变
 *   ② 离线评测按槽位统计 Precision / Conflict 指标
 *
 * 不用把 subjectKey 与 predicateKey 直接拼进日志的原因：
 * 它们是受控词表值，本身可读；但加上哈希后能作为**稳定的字典键**，
 * 避免同一槽位因大小写或空白差异被算成两组。
 */
export function slotFingerprint(params: {
  subjectKey: string;
  predicateKey: string;
}): string {
  const normalize = (s: string): string => s.trim().toLowerCase();
  return createHash('sha256')
    .update(`${normalize(params.subjectKey)}::${normalize(params.predicateKey)}`)
    .digest('hex')
    .slice(0, 16);
}

// ============================================================
// 执行器透传
// ============================================================

/**
 * 把执行器透传给仓库方法。
 *
 * 读写共用同一个函数：仓库的读写方法都接受 { executor }，
 * 形状相同，没必要分成两个（此前 execOpt / readOpt 实现完全一样，
 * 属于重复代码）。
 */
function execOpt(options: ProcessCandidateOptions): { executor: ExecutorLike } | undefined {
  return options.executor ? { executor: options.executor } : undefined;
}
