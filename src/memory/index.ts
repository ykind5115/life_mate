/**
 * Memory 模块导出入口
 *
 * 本模块负责把对话变成长期记忆（Q2 决策的核心）。
 *
 * 分层位置（AGENTS.md §3）：
 *   Agent Tool / API Controller
 *        ↓
 *   本模块（判定流程）
 *        ↓
 *   Repository 层（只有它碰数据库）
 *
 * 职责边界：
 *   本模块**不做**的事 ——
 *     · 不生成 embedding（§25.2：外部调用，须在事务外做，由上层编排）
 *     · 不碰 Agent 对话循环（那是 agent 模块的事）
 */
export {
  candidateMemorySchema,
  extractionResultSchema,
  normalizeCandidate,
  parseExtractionResult,
  type CandidateMemory,
  type ExtractionResult,
  type NormalizedCandidate,
} from './extraction-schema.js';

export {
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionMessages,
  buildExtractionUserMessage,
} from './extraction-prompt.js';

export {
  isEquivalentValue,
  processCandidate,
  slotFingerprint,
  type CandidateOutcome,
  type ProcessCandidateOptions,
  type ExecutorLike,
  type SlotAdjudicator,
} from './candidate-processor.js';

export {
  runExtraction,
  EXTRACTOR_VERSION,
  type RunExtractionParams,
  type ExtractionSummary,
} from './extraction-pipeline.js';

export {
  LlmSlotAdjudicator,
  parseVerdict,
  type SlotVerdict,
} from './slot-adjudicator.js';

// ---------- 召回（docs/03 §18）----------

export {
  retrieveMemories,
  type RetrieveParams,
  type RetrievalResult,
  type RetrievalDiagnostics,
  type RetrievalDegradation,
} from './retriever.js';

export {
  fuseByRrf,
  rerank,
  normalizeVector,
  typeAwareRecency,
  decay,
  type RetrievalCandidate,
  type ScoredCandidate,
} from './retrieval-fusion.js';

export {
  RRF_K,
  CHANNEL_LIMIT,
  FUSION_LIMIT,
  INJECT_LIMIT,
  RERANK_WEIGHTS,
  NORM_VECTOR_MIN,
  NORM_VECTOR_MAX,
  DECAY_HALF_LIFE_DAYS,
  SOURCE_COUNT_SATURATION,
} from './retrieval-config.js';
