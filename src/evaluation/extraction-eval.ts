/**
 * 记忆抽取质量评测（PRD §15 的 ①②③）
 *
 * 【为什么需要 LLM 做匹配，而不是字符串比对】
 *   标注写的是「用户在北京做数据工程师」，模型可能输出
 *   「用户从事数据工程师工作，base 北京」—— 语义相同，字符串完全不同。
 *   用字符串比对测出来的指标毫无意义。
 *   因此匹配用 LLM 判，但**判据由标注方给定**（golden 集是人写的），
 *   不是让模型自己出题自己判。
 *
 * 【⚠️ 指标定义是本实现提出的，docs 里只有问题没有公式】
 *   PRD §15 只写了三个问题：
 *     ① Memory Precision  记住的东西有多少是正确的？
 *     ② Memory Recall     该想起来的时候有多少真的想起来了？
 *     ③ Memory Noise      数据库里有多少垃圾记忆？
 *   没有给分子分母。以下是本实现采用的**可计算定义**，需要确认：
 *
 *     precision = 正确抽取数 / 实际抽取数
 *       「正确」= 能匹配上某条 shouldExtract 的标注
 *     recall    = 被抽到的标注数 / 标注总数
 *     noise     = 抽到了 shouldNotExtract（琐事、寒暄、推测）的条数
 *       noise 单独计数而不是并入 precision：
 *       抽出一条"无害但没用"的记忆，与抽出一条"把助手的推测当成用户事实"的记录，
 *       严重性完全不同 —— 后者会污染后续所有对话。混在一起会掩盖后者。
 *
 *   另有三个辅助指标：
 *     slotAccuracy  —— 填了槽位的记忆里，槽位填对的比例
 *     forbiddenHits —— 命中 shouldNotExtract 的具体条目（便于定位提示词缺陷）
 *     typeAccuracy  —— 类型判断正确的比例
 */
import type { LLMProvider } from '../llm/provider.js';
import type { Memory } from '../database/schema/memories.js';
import {
  SCORING_POLICY,
  type EvaluationConversation,
  type ExpectedMemory,
} from './dataset.js';

// ============================================================
// 类型
// ============================================================

/** 一条抽取结果与标注的比对结果 */
export interface MatchResult {
  memoryId: string;
  content: string;
  /**
   * 这条抽取覆盖了哪些期望（下标）。
   * 空数组表示它没被任何期望引用 —— 可能多余，也可能是评审漏填 byActualIndexes。
   */
  coveredExpectedIndexes: number[];
  /** 这条抽取是否算「有用的」（计入 precision 的分子） */
  useful: boolean;
  /** 是否命中 shouldNotExtract */
  forbiddenReason: string | null;
  /** 评审指出的无依据断言（含期望之外、且对话里也没有依据的信息） */
  ungroundedClaim: string | null;
  /** 槽位是否正确（仅当它覆盖的标注指定了 predicateKey 时有意义） */
  slotCorrect: boolean | null;
  /** 类型是否正确 */
  typeCorrect: boolean | null;
}

export interface ConversationScore {
  conversationId: string;
  focus: string;
  extracted: number;
  expected: number;
  /** 匹配上标注的抽取条数 */
  truePositives: number;
  /** 漏掉的标注条数 */
  missed: number;
  /** 误抽（匹配不上任何标注，也没落进 forbidden） */
  spurious: number;
  /** 抽出了明确不该抽的内容 */
  forbidden: number;
  /** 记录在案的额外断言条数（宽松口径下不影响分数，仅作观察） */
  extraClaims: number;
  /** 槽位命中率：填了槽位的记忆里填对的比例 */
  slotAccuracy: number | null;
  typeAccuracy: number | null;
  matches: MatchResult[];
  /** 漏掉的标注内容（便于人看"漏了什么"） */
  missedContents: string[];
  /** 抽出的内容（便于人复核匹配是否合理） */
  extractedContents: string[];
  /** 每项的耗时与用量，用于评估成本 */
  timingMs: number;
}

export interface EvaluationSummary {
  conversations: ConversationScore[];

  /** 汇总指标（所有会话合计，不是平均 —— 平均会被短会话稀释） */
  overall: {
    precision: number;
    recall: number;
    f1: number;
    /** 噪声条数（绝对值，不是比率） */
    noise: number;
    /** 噪声率 = 噪声 / 总抽取数 */
    noiseRate: number;
    slotAccuracy: number | null;
    typeAccuracy: number | null;
    extracted: number;
    expected: number;
  };
}

// ============================================================
// 匹配（LLM 判定）
// ============================================================

/**
 * 评审提示词。
 *
 * 【为什么问「每条期望被覆盖了吗」而不是「每条抽取对应哪条期望」】
 *   1:1 匹配在两种常见情况下会给出错误结论（实测踩到过）：
 *
 *     ① 模型合并：抽出「用户是数据工程师，工作偏实时方向，主要使用 Flink」，
 *        而标注拆成了两条。1:1 匹配下第二条必然判为"漏抽"，
 *        但信息其实没丢 —— recall 被低估。
 *     ② 期望重叠：标注里既有「用户在北京做数据工程师」又有
 *        「用户在北京居住」，一条抽取「用户在北京工作生活」同时覆盖两者。
 *        1:1 匹配下评审会难以取舍，实测给出了矛盾的判断。
 *
 *   改成「逐条期望问是否被覆盖」后：
 *     · 合并/拆分不再影响 recall（只看信息在不在）
 *     · 覆盖多条期望是允许的（不再要求 exclusive）
 *     · 多出来的信息由 ungrounded 单独列出（衡量编造）
 */
const MATCH_SYSTEM_PROMPT = `你是记忆抽取质量的评审员。给你两组信息：
- 【期望】人类标注的、这段对话里**应该**被记住的信息
- 【实际】系统实际抽取出来的记忆

请完成两个独立任务。

## 任务一：逐条检查【期望】是否被【实际】覆盖

对**每一条**期望，判断它的核心事实是否出现在某条（或多条）实际记忆里。

- 只比语义，不要因为措辞、语序、详略不同就判为未覆盖
- 允许多条实际记忆**共同**覆盖一条期望；也允许一条实际记忆覆盖多条期望
- 期望里的信息被合并进一条更长的实际记忆 → 算覆盖
- 主题相关但事实不同（如"用户在北京工作"与"用户在北京居住"）**不算**覆盖
- 由**助手**说出、而非用户陈述的内容，不算覆盖用户的事实

## 任务二：找出【实际】里没有依据的断言

对每一条实际记忆，判断它是否包含【期望】里没有、且**对话里也没有明确依据**的断言。
- 措辞更详细但依据充分（如用户说"偏实时，主要是 Flink"，实际写成
  "工作偏实时方向，主要使用 Flink"）→ **不算**无依据
- 把助手的推测写成用户的事实 → **算**无依据
- 添加了用户从未提及的具体信息（数字、时间、人物）→ **算**无依据

## 输出

只输出 JSON，不要任何解释文字：

{
  "coverage": [
    { "expectedIndex": 0, "covered": true, "byActualIndexes": [0], "note": null }
  ],
  "ungrounded": [
    { "actualIndex": 1, "claim": "具体没有依据的断言", "note": "为什么" }
  ]
}

coverage 必须包含**每一条**期望（expectedIndex 从 0 起）。
ungrounded 只列确实无依据的，没有就给空数组。`;

interface JudgeResponse {
  coverage: {
    expectedIndex: number;
    covered: boolean;
    byActualIndexes: number[];
    note: string | null;
  }[];
  ungrounded: {
    actualIndex: number;
    claim: string;
    note: string | null;
  }[];
}

/**
 * 用 LLM 判定抽取结果对标注的覆盖情况。
 *
 * 失败时**抛出**而不是返回空覆盖：返回空会让 precision 与 recall 双双变成 0，
 * 看起来像"质量极差"，而实际是评测本身坏了。那种误导比直接报错更糟。
 */
export async function matchExtractedToExpected(params: {
  provider: LLMProvider;
  expected: ExpectedMemory[];
  memories: Memory[];
}): Promise<JudgeResponse> {
  const expectedList = params.expected
    .map((e, i) => `${i}. [${e.type}] ${e.content}`)
    .join('\n');

  /**
   * ⚠️ 只给模型看 content 与 type，**不给** predicateKey。
   *    给了槽位会让它把"槽位相同"当成"语义相同"的证据，
   *    于是「用户住在北京」与「用户在北京工作」都会被判覆盖。
   *    槽位正确性由我们自己在覆盖判定之后单独比对。
   */
  const actualList =
    params.memories.length > 0
      ? params.memories.map((m, i) => `${i}. [${m.type}] ${m.content}`).join('\n')
      : '（本次没有抽取到任何记忆）';

  const res = await params.provider.generate({
    messages: [
      { role: 'system', content: MATCH_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `【期望】\n${expectedList}\n\n【实际】\n${actualList}\n\n请完成两个任务并输出 JSON。`,
      },
    ],
    maxOutputTokens: 2048,
    // 判定是格式化的分类任务，不需要思维链；关掉省一半延迟与费用
    thinking: { type: 'disabled' },
  });

  return parseJudgeResponse(res.content, params.expected.length, params.memories.length);
}

/**
 * 解析评审输出。
 *
 * 容错而非严格：模型偶尔会包 markdown 代码块或加一句解释。
 * 但**条数不足要补齐为"未覆盖"** —— 少判一条会让那条期望凭空算成漏抽或命中，
 * 指标会失真。补齐方向选"未覆盖"是保守的（宁可低估质量也不虚报）。
 */
export function parseJudgeResponse(
  raw: string,
  expectedCount: number,
  actualCount: number
): JudgeResponse {
  let text = raw.trim();

  // 剥离 markdown 代码块
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence?.[1]) text = fence[1].trim();

  // 截取第一个 { 到最后一个 }，容忍前后解释文字
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last <= first) {
    throw new Error(`评审输出里找不到 JSON：${raw.slice(0, 200)}`);
  }

  const obj = JSON.parse(text.slice(first, last + 1)) as Partial<JudgeResponse>;

  const rawCoverage = Array.isArray(obj.coverage) ? obj.coverage : [];
  const byIndex = new Map(rawCoverage.map((c) => [c.expectedIndex, c]));

  const coverage: JudgeResponse['coverage'] = [];
  for (let i = 0; i < expectedCount; i++) {
    const found = byIndex.get(i);
    coverage.push(
      found
        ? {
            expectedIndex: i,
            covered: found.covered === true,
            byActualIndexes: Array.isArray(found.byActualIndexes)
              ? found.byActualIndexes.filter((x) => x >= 0 && x < actualCount)
              : [],
            note: found.note ?? null,
          }
        : {
            expectedIndex: i,
            covered: false,
            byActualIndexes: [],
            note: '评审未返回该条，按未覆盖计',
          }
    );
  }

  const ungrounded = (Array.isArray(obj.ungrounded) ? obj.ungrounded : []).filter(
    (u) => typeof u.actualIndex === 'number' && u.actualIndex >= 0 && u.actualIndex < actualCount
  );

  return { coverage, ungrounded };
}

// ============================================================
// 评分
// ============================================================

/**
 * 按覆盖口径评分。
 *
 * 【口径说明 —— 这几个定义 docs 里没有，是本实现提出的】
 *
 *   recall    = 被覆盖的期望数 / 期望总数
 *               分子分母都在「期望」这一侧，与模型是否合并/拆分无关。
 *
 *   precision = 有用抽取数 / 抽取总数
 *               「有用」= 这条抽取被用来覆盖了至少一条期望。
 *               未被任何期望引用的抽取算误抽。
 *
 *   ⚠️ 已知局限：评审在标记 covered 时给出 byActualIndexes，
 *      但模型不一定填全。因此 precision 会**略偏低**
 *      （一条有用的抽取若未被引用，会被当成误抽）。
 *      这是保守方向，可以接受；不要把它解读成"模型在编造"。
 */
export function scoreConversation(params: {
  conversation: EvaluationConversation;
  memories: Memory[];
  judged: JudgeResponse;
  timingMs: number;
  /** 评分口径。缺省用 dataset 里的默认值 */
  policy?: { extraClaimsCountAsSpurious: boolean };
}): ConversationScore {
  const { conversation, memories, judged } = params;
  const policy = params.policy ?? SCORING_POLICY;

  // ---------- 期望侧 ----------
  const coveredExpectedIndexes = new Set(
    judged.coverage.filter((c) => c.covered).map((c) => c.expectedIndex)
  );

  /**
   * 被引用过的抽取下标 —— 用来区分「有用的抽取」与「多余的抽取」。
   *
   * ⚠️ 一条抽取可能覆盖多条期望（合并抽取），此时只算一次有用。
   */
  const referencedActualIndexes = new Set<number>();
  for (const c of judged.coverage) {
    if (!c.covered) continue;
    for (const idx of c.byActualIndexes) referencedActualIndexes.add(idx);
  }

  const ungroundedByIndex = new Map(judged.ungrounded.map((u) => [u.actualIndex, u.claim]));

  // ---------- 逐条抽取分类 ----------
  const results: MatchResult[] = memories.map((memory, i) => {
    const referenced = referencedActualIndexes.has(i);
    const forbiddenReason = findForbidden(conversation, memory.content);
    const ungrounded = ungroundedByIndex.get(i) ?? null;

    /**
     * 这条抽取覆盖了哪些期望 —— 回填给评测报告用。
     * 评审没填 byActualIndexes 时这里会是空数组，但 covered 仍来自期望侧判定，
     * 因此 recall 不受影响。
     */
    const coveredIndexes = judged.coverage
      .filter((c) => c.covered && c.byActualIndexes.includes(i))
      .map((c) => c.expectedIndex);

    /**
     * 槽位与类型判定：把这条抽取与它覆盖的第一条「带期望槽位」的标注比对。
     * 覆盖多条时取第一条 —— 槽位本来就是"每条记忆一个"，多覆盖时无法逐一判定。
     */
    const judgeTarget = coveredIndexes
      .map((idx) => conversation.shouldExtract[idx])
      .find((e): e is ExpectedMemory => e !== undefined);

    const slotCorrect =
      judgeTarget?.predicateKey !== undefined && coveredIndexes.length > 0
        ? memory.predicateKey === judgeTarget.predicateKey
        : null;

    const typeCorrect = coveredIndexes.length > 0 && judgeTarget ? memory.type === judgeTarget.type : null;

    /**
     * 严格口径下，「夹带了无依据断言」的抽取不算有用 ——
     * 它确实覆盖了某条期望，但同时也污染了记忆库。
     * 宽松口径下仍算有用（如实记录在 extraClaim 里）。
     */
    const useful = referenced || coveredIndexes.length > 0;

    return {
      memoryId: memory.id,
      content: memory.content,
      coveredExpectedIndexes: coveredIndexes,
      useful: policy.extraClaimsCountAsSpurious && ungrounded !== null ? false : useful,
      forbiddenReason,
      ungroundedClaim: ungrounded,
      slotCorrect,
      typeCorrect,
    };
  });

  const truePositives = results.filter((r) => r.useful).length;
  const forbidden = results.filter((r) => r.forbiddenReason !== null).length;
  const spurious = results.length - truePositives;

  const slotJudged = results.filter((r) => r.slotCorrect !== null);
  const typeJudged = results.filter((r) => r.typeCorrect !== null);

  return {
    conversationId: conversation.id,
    focus: conversation.focus,
    extracted: memories.length,
    expected: conversation.shouldExtract.length,
    truePositives,
    missed: conversation.shouldExtract.length - coveredExpectedIndexes.size,
    spurious,
    forbidden,
    extraClaims: results.filter((r) => r.ungroundedClaim !== null).length,
    slotAccuracy:
      slotJudged.length > 0
        ? slotJudged.filter((r) => r.slotCorrect === true).length / slotJudged.length
        : null,
    typeAccuracy:
      typeJudged.length > 0
        ? typeJudged.filter((r) => r.typeCorrect === true).length / typeJudged.length
        : null,
    matches: results,
    missedContents: conversation.shouldExtract
      .filter((_, i) => !coveredExpectedIndexes.has(i))
      .map((e) => e.content),
    extractedContents: memories.map((m) => m.content),
    timingMs: params.timingMs,
  };
}

/**
 * 判断某条抽取正文是否"讲的就是这句不该记的话"。
 *
 * 【为什么能用字符重叠而不是 LLM 判定】
 *   模型抽出来的正文必然是**改写**过的（要求"用用户作主语、脱离上下文可理解"），
 *   因此不能整句比对。但它改写时会保留原句里的大部分实词，
 *   所以「原句的字符有多少比例出现在抽取正文里」是一个可靠的近似。
 *
 * 【阈值方向必须选对】
 *   宁可漏判：漏判只让噪声指标偏乐观；
 *   错判（把正常记忆当噪声）会让指标偏悲观，并把人引向错误的调优方向。
 *   因此阈值取 0.6 —— 明显高于"偶然重合"，又低于"逐字照抄"。
 */
export function looksLikeForbidden(sourceText: string, content: string): boolean {
  const source = normalize(sourceText);
  const target = normalize(content);

  if (source.length === 0) return false;
  // 太短的句子（如「还行」）字符重合没有统计意义，直接要求包含
  if (source.length <= 4) return target.includes(source);

  const hit = [...source].filter((ch) => target.includes(ch)).length;
  return hit / source.length >= 0.6;
}

/** 去掉标点与空白，只留实义字符 —— 否则标点会稀释重合比例 */
function normalize(s: string): string {
  return s.replace(/[\s，。！？、；：""''（）,.!?;:()[\]{}~—-]/g, '');
}

function findForbidden(
  conversation: EvaluationConversation,
  content: string
): string | null {
  for (const f of conversation.shouldNotExtract) {
    if (looksLikeForbidden(f.text, content)) return f.reason;
  }
  return null;
}

/** 汇总多个会话的分数 */
export function summarize(scores: ConversationScore[]): EvaluationSummary['overall'] {
  const extracted = scores.reduce((n, s) => n + s.extracted, 0);
  const expected = scores.reduce((n, s) => n + s.expected, 0);
  const tp = scores.reduce((n, s) => n + s.truePositives, 0);
  const noise = scores.reduce((n, s) => n + s.forbidden, 0);

  const precision = extracted > 0 ? tp / extracted : 0;
  const recall = expected > 0 ? tp / expected : 0;

  const slotJudged = scores.flatMap((s) => s.matches.filter((m) => m.slotCorrect !== null));
  const typeJudged = scores.flatMap((s) => s.matches.filter((m) => m.typeCorrect !== null));

  return {
    precision,
    recall,
    f1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    noise,
    noiseRate: extracted > 0 ? noise / extracted : 0,
    slotAccuracy:
      slotJudged.length > 0
        ? slotJudged.filter((m) => m.slotCorrect === true).length / slotJudged.length
        : null,
    typeAccuracy:
      typeJudged.length > 0
        ? typeJudged.filter((m) => m.typeCorrect === true).length / typeJudged.length
        : null,
    extracted,
    expected,
  };
}
