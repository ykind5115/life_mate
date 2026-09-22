/**
 * 记忆抽取的输出契约（Q2 决策的落地）
 *
 * 依据：docs/03 §13.7、docs/01 §8.1~§8.4
 *
 * 【为什么必须是结构化的，而不是自由文本】
 *   冲突判定的最小单位不是「一条记忆文本」，而是「同一槽位上的两个取值」。
 *   向量相似度无法区分「相似」与「矛盾」——这两者是正交维度：
 *
 *     记忆 A：用户住在广州       字面不相似
 *     记忆 B：用户已经搬到深圳   → 却真冲突
 *
 *     记忆 C：用户计划学 Python   语义高度相似
 *     记忆 D：用户在用 TypeScript → 却可共存
 *
 *   没有 subject/predicate 信息，系统就没有确定性依据，
 *   只能完全依赖 LLM 临场判断，而那个判断不可复现、无法回归测试。
 *   （审计 P0-2）
 */
import { z } from 'zod';

import { MEMORY_TYPES, MEMORY_POLARITIES, PREDICATE_KEYS } from '../database/schema/enums.js';

/**
 * 抽取器返回的单条候选记忆。
 *
 * ⚠️ 字段说明中的「缺省行为」很重要：LLM 常会漏字段或给多余字段。
 *    本 schema 用 .catch() / .optional() 让缺失走明确缺省，
 *    而不是让整批抽取因一条不合格而全废。
 */
export const candidateMemorySchema = z.object({
  /** 记忆类型。非法值丢弃该条（不猜测） */
  type: z.enum(MEMORY_TYPES),

  /**
   * 展示给用户的自然语言正文。
   *
   * 要求：完整、自足、以「用户」为主语。
   * ❌ 不要写「他」「这个」等依赖上下文的指代 —— 记忆脱离对话后必须可独立理解。
   */
  content: z.string().min(1).max(500),

  /**
   * 规范化主体。V1.0 单用户场景固定为 'user'。
   * 缺省由调用方补 'user'。
   */
  subjectKey: z.string().max(100).optional(),

  /**
   * 规范化槽位，**必须来自受控词表**（§13.7）。
   *
   * 词表之外的信息不参与冲突判定 —— 宁可漏判，不可错判。
   * 用 z.enum 而非 z.string 是刻意的：让非法槽位在解析阶段就被拒绝，
   * 而不是带着脏值进入冲突判定流程。
   */
  predicateKey: z.enum(PREDICATE_KEYS).optional(),

  /** 规范化取值。与 predicateKey 配对使用 */
  objectValue: z.string().max(500).optional(),

  /** 极性。缺省视为 affirm（肯定表述） */
  polarity: z.enum(MEMORY_POLARITIES).optional(),

  /** 重要性 0~1。缺省 0.5，越界由 .catch 收敛到边界值 */
  importance: z.number().min(0).max(1).optional(),

  /** 置信度 0~1。缺省 1.0 */
  confidence: z.number().min(0).max(1).optional(),

  /**
   * 该记忆所依据的原文片段。
   *
   * 用途：让抽取结果可追溯到具体消息（§15 来源追踪），
   * 也便于人工核查抽取质量。
   */
  evidence: z.string().max(500).optional(),
});

export type CandidateMemory = z.infer<typeof candidateMemorySchema>;

/** 抽取器返回的完整结果 */
export const extractionResultSchema = z.object({
  /**
   * 候选记忆列表。可以为空 —— 大部分闲聊不该形成长期记忆（§13 的提取原则）。
   * 上限 20 条：单次对话片段产生过多记忆通常意味着抽取器过度积极。
   */
  memories: z.array(candidateMemorySchema).max(20),

  /**
   * 抽取器的简短说明（1~2 句）。
   * 用途：调试提示词效果、人工核查时快速理解模型意图。
   * ⚠️ 不落库、不展示给用户。
   */
  note: z.string().max(300).optional(),
});

export type ExtractionResult = z.infer<typeof extractionResultSchema>;

/**
 * 宽松解析：从 LLM 的原始文本中提取 JSON 并校验。
 *
 * 需要处理的现实情况（都实测过或属常见模式）：
 *   ① 模型把 JSON 包在 ```json 代码块里
 *   ② JSON 前后有解释性文字
 *   ③ 顶层是数组而非对象
 *
 * ⚠️ 解析失败必须抛错，不能返回空结果 ——
 *    空结果会被上层当成「这段对话没有值得记的内容」，
 *    从而静默丢失记忆。这是抽取流水线最危险的失败模式。
 */
export function parseExtractionResult(raw: string): ExtractionResult {
  const jsonText = extractJsonBlock(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `抽取结果不是合法 JSON。原始输出前 200 字：${raw.slice(0, 200)}\n` +
        `解析错误：${err instanceof Error ? err.message : String(err)}`
    );
  }

  // 容忍模型直接返回数组
  const normalized = Array.isArray(parsed) ? { memories: parsed } : parsed;

  const result = extractionResultSchema.safeParse(normalized);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `抽取结果不符合契约：\n${issues}\n` + `原始输出前 300 字：${raw.slice(0, 300)}`
    );
  }

  return result.data;
}

/**
 * 从可能带 markdown 包装的文本中取出 JSON 主体。
 */
function extractJsonBlock(raw: string): string {
  const trimmed = raw.trim();

  // ① ```json ... ``` 或 ``` ... ```
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence?.[1]) return fence[1].trim();

  // ② 前后有解释文字：取第一个 { 到最后一个 }，或第一个 [ 到最后一个 ]
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');

  let start = -1;
  let openChar = '';
  let closeChar = '';

  if (firstBrace === -1 && firstBracket === -1) return trimmed;

  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    start = firstBracket;
    openChar = '[';
    closeChar = ']';
  } else {
    start = firstBrace;
    openChar = '{';
    closeChar = '}';
  }

  const end = trimmed.lastIndexOf(closeChar);
  if (end > start && trimmed[start] === openChar) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

/**
 * 归一化候选记忆：补齐缺省值，产出可直接进入判定流程的形状。
 *
 * ⚠️ 类型上刻意把 polarity / content 等写成**非可选**：
 *    normalizeCandidate 保证这些字段一定有值（polarity 缺省为 affirm）。
 *    若沿用 CandidateMemory 的可选类型，「可能 undefined」会一路传播到
 *    写库调用，在 exactOptionalPropertyTypes 下无法通过类型检查 ——
 *    而那正是这里要表达的实事：归一化之后就不该再有 undefined。
 */
export interface NormalizedCandidate {
  type: CandidateMemory['type'];
  content: string;
  subjectKey: string;
  predicateKey: string | null;
  objectValue: string | null;
  polarity: NonNullable<CandidateMemory['polarity']>;
  importanceScore: number;
  confidenceScore: number;
  evidence: string | null;
}

export function normalizeCandidate(c: CandidateMemory): NormalizedCandidate {
  return {
    type: c.type,
    content: c.content.trim(),
    // V1.0 单用户，主体固定
    subjectKey: c.subjectKey?.trim() || 'user',
    // 只有槽位与取值同时存在才有判定意义
    predicateKey: c.predicateKey ?? null,
    objectValue: c.objectValue?.trim() ?? null,
    polarity: c.polarity ?? 'affirm',
    importanceScore: c.importance ?? 0.5,
    confidenceScore: c.confidence ?? 1.0,
    evidence: c.evidence ?? null,
  };
}
