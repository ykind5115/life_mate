/**
 * 离线评测用的标注对话集（golden dataset）
 *
 * 【这个文件解决什么问题】
 *   PRD §15 的六个成功标准里，前五个都直接依赖记忆质量：
 *     ① Memory Precision  记住的东西有多少是正确的？
 *     ② Memory Recall     该想起来的时候有多少真的想起来了？
 *     ③ Memory Noise      数据库里有多少垃圾记忆？
 *     ④ Memory Conflict   发生变化的信息能不能正确处理？
 *     ⑤ Long-term Consistency
 *   在这份文件之前，这些指标**一个都测不了** —— 只能靠人工看抽取结果，
 *   那不是可持续的调优方式（改一次提示词就要重新肉眼比对一遍）。
 *
 * 【为什么必须手工标注】
 *   用 LLM 生成"应该抽什么"再让 LLM 判断"抽得对不对"，
 *   等于自己给自己出题自己判卷 —— 指标会很好看，但不可信。
 *   因此 shouldExtract 是**人写死的期望**，只在最后做语义匹配时才用 LLM
 *   （因为抽取出的措辞必然与标注不同，字符串比对没意义）。
 *
 * 【设计取舍】
 *   每个会话同时标注两类信息：
 *     · shouldExtract    —— 该被记住的（衡量 Recall / Precision 的分母与分子）
 *     · shouldNotExtract —— 容易被误抽的（衡量 Noise；这些都是 §8.1 里
 *                           明确说"不该记"的东西：琐事、寒暄、对 AI 的指令）
 *
 *   ⚠️ 本文件是我基于 PRD/docs 的判据写的**首版标注**，不是产品方给的。
 *      它会随着真实使用中发现的偏差而调整 —— 但调整必须是显式的
 *      （改这里 + 在提交信息里说明为什么），否则指标会失去可比性。
 */

/** 期望被抽取的一条记忆 */
export interface ExpectedMemory {
  /** 期望的事实内容（用自己的话写，不必与模型输出逐字相同） */
  content: string;
  /** 期望的类型 */
  type: 'fact' | 'preference' | 'event' | 'goal' | 'relationship' | 'state';
  /**
   * 期望的槽位（可选）。
   *
   * 留空表示「这条信息不属于受控词表里的任何槽位」——
   * 此时**不**用槽位命中率惩罚它。若填了，则会检查模型是否也填了这个槽位。
   */
  predicateKey?: string;
  /** 该条在对话里的重要性档位，用于检查 importance 是否离谱 */
  importance?: 'low' | 'medium' | 'high';
}

/** 一条不该被抽取的信息，以及它不该被抽的理由 */
export interface ForbiddenMemory {
  /** 容易被误抽的那句话（原样摘录，便于人核对） */
  text: string;
  /** 为什么不该抽（对应提示词里"不该记住的"清单） */
  reason:
    | 'trivial' // 一次性日常琐事
    | 'smalltalk' // 闲谈寒暄
    | 'assistant_instruction' // 对 AI 的指令或抱怨
    | 'knowledge_qa' // 纯知识问答
    | 'speculation' // 模型自己的推测（用户没说）
    | 'third_party'; // 与用户无关的第三方隐私
}

/**
 * 评分口径。
 *
 * ⚠️ 这个开关会改变指标数值，因此必须随基线一起汇报 ——
 *    换了口径再对比数字，会得出错误结论。
 *
 * 首版基线（2026-09-23，P=0.818 R=1.000 F1=0.900）用的是默认（宽松）口径。
 */
export const SCORING_POLICY = {
  /**
   * 「额外断言」是否算误抽。
   *
   * false（宽松，默认）：不算。理由 —— 文档 §8.1 的判据是「有长期价值」，
   *   用户说了「偏实时，主要是 Flink 那套」，这确实有长期价值，记下来是对的；
   *   是我的标注没有穷举，不是模型多记。
   * true（严格）：算。用于**专项排查「提示词是否在编造」**——
   *   extraClaim 本来就是评审在"期望里没有、但抽取里出现"时标的。
   *
   * ⚠️ 用宽松口径时，precision **不能**用来发现"模型多记/编造"这类问题。
   *    要做到那点必须用严格口径单独跑一次做对比。
   */
  extraClaimsCountAsSpurious: false,

  /**
   * ⚠️ 已知的口径局限，不是可配置项，写在这里以免被遗忘：
   *
   *   评审允许「一条抽取覆盖多条期望」时只匹配其中一条。
   *   若模型把「考虑换城市」与「顾虑是工作机会和父母养老」并成一条，
   *   另一条标注就算**漏抽** —— 但信息其实没丢。
   *   也就是说 **recall 在"模型倾向合并"时会偏低**（保守方向）。
   *
   *   反之若模型把一条标注拆成两条，第二条会算误抽（precision 偏低）。
   *
   *   两个方向的偏差都是**保守**的（指标偏低而非偏高），因此可以接受；
   *   但解读时要知道：真实的信息完整度**不差于**这里报出的 recall。
   */
  knownBias: 'recall 在模型合并多条信息时偏低；precision 在模型拆条时偏低。两者均为保守方向。',
} as const;

export interface EvaluationConversation {
  id: string;
  /** 这组对话想考察什么能力 */
  focus: string;
  /** 对话内容。role 只有 user / assistant */
  turns: { role: 'user' | 'assistant'; content: string }[];
  shouldExtract: ExpectedMemory[];
  shouldNotExtract: ForbiddenMemory[];
}

export const EVALUATION_SET: EvaluationConversation[] = [
  // ============================================================
  // ① 稳定的个人事实：最基础的能力，不能漏也不能编
  // ============================================================
  {
    id: 'basic-facts',
    focus: '稳定事实的抽取：职业、居住地、姓名。不应漏，也不应无中生有',
    turns: [
      { role: 'user', content: '你好，我叫陈默，现在在北京做数据工程师。' },
      {
        role: 'assistant',
        content: '你好陈默。数据工程师，主要做数仓还是偏实时？',
      },
      { role: 'user', content: '偏实时，主要是 Flink 那套。' },
      { role: 'assistant', content: '实时链路排查起来挺费神的，尤其是反压的时候。' },
    ],
    shouldExtract: [
      { content: '用户的名字是陈默', type: 'fact', importance: 'medium' },
      {
        content: '用户在北京做数据工程师',
        type: 'fact',
        predicateKey: 'residence.city',
        importance: 'high',
      },
      {
        /**
         * 用户在对话里明确说了「偏实时，主要是 Flink 那套」——
         * 这是有长期价值的技术背景信息，应当记住。
         * 首版标注漏了它，导致模型记住反被判成误抽（我的标注不全，不是模型的错）。
         */
        content: '用户的工作偏实时方向，主要使用 Flink',
        type: 'fact',
        importance: 'medium',
      },
    ],
    shouldNotExtract: [
      { text: '你好', reason: 'smalltalk' },
      { text: '主要做数仓还是偏实时？', reason: 'knowledge_qa' },
    ],
  },

  // ============================================================
  // ② 槽位边界：情绪不能填进 health.status（实测踩过的坑）
  // ============================================================
  {
    id: 'emotion-slot-boundary',
    focus: 'state.emotion 与 health.status 的区分 —— 情绪不该被当成健康记录',
    turns: [
      { role: 'user', content: '最近被项目进度追得有点烦，晚上老是睡不好。' },
      {
        role: 'assistant',
        content: '听起来挺累的。是排期本身紧，还是中间总被打断？',
      },
      { role: 'user', content: '排期紧。不过我去年查出来有慢性胃炎，可能也有关系。' },
      { role: 'assistant', content: '那吃饭规律上可能得注意一下。' },
    ],
    shouldExtract: [
      {
        content: '用户近期因项目进度感到烦躁',
        type: 'state',
        predicateKey: 'state.emotion',
        importance: 'low',
      },
      {
        content: '用户有慢性胃炎',
        type: 'fact',
        predicateKey: 'health.status',
        importance: 'medium',
      },
      {
        /**
         * ⚠️ 「晚上睡不好」是**用户自己说的**（"晚上老是睡不好"），
         *    因此它属于可抽取的状态，不是推测。
         *
         *    首版基线里这条被判成 noise(speculation) —— 那是**我的标注错了**，
         *    不是模型错了。已修正。
         *
         *    这里刻意保留为 shouldExtract 而不是删掉：
         *    它是「用户自述的短期状态」这一类的代表，
         *    而且暴露了一个真实约束 —— 受控词表里没有睡眠/作息的负面状态槽位
         *    （habit.sleep 是"作息习惯"不是"最近睡不好"）。
         *    因此这条不应期望填槽位。
         */
        content: '用户近期晚上睡不好',
        type: 'state',
        importance: 'low',
      },
    ],
    shouldNotExtract: [
      { text: '那吃饭规律上可能得注意一下', reason: 'assistant_instruction' },
    ],
  },

  // ============================================================
  // ③ 噪声控制：一堆琐事里只该抽出一两条
  // ============================================================
  {
    id: 'noise-control',
    focus: '琐事与寒暄不应变成记忆（Memory Noise 的直接来源）',
    turns: [
      { role: 'user', content: '今天中午吃了个鸡腿饭，还行。' },
      { role: 'assistant', content: '鸡腿饭挺顶饱的。' },
      { role: 'user', content: '你刚才回答得有点慢啊。' },
      { role: 'assistant', content: '抱歉，刚才在查资料。' },
      { role: 'user', content: '对了，我从今年开始每周跑三次步，坚持得还不错。' },
      { role: 'assistant', content: '能坚持下来不容易。' },
    ],
    shouldExtract: [
      {
        content: '用户从今年开始每周跑三次步',
        type: 'preference',
        predicateKey: 'habit.exercise',
        importance: 'medium',
      },
    ],
    shouldNotExtract: [
      { text: '今天中午吃了个鸡腿饭', reason: 'trivial' },
      { text: '你刚才回答得有点慢啊', reason: 'assistant_instruction' },
      { text: '还行', reason: 'smalltalk' },
    ],
  },

  // ============================================================
  // ④ 目标与计划：跨度判断（月/年 vs 周）
  // ============================================================
  {
    id: 'goal-vs-plan',
    focus: '长期目标与近期计划的槽位区分',
    turns: [
      { role: 'user', content: '我想在三年内攒够首付，在北京买个小两居。' },
      { role: 'assistant', content: '这个目标挺具体的。有大概的预算区间吗？' },
      { role: 'user', content: '五百万左右吧。这周先去银行问问贷款利率。' },
      { role: 'assistant', content: '问清楚利率上浮和提前还款条款。' },
    ],
    shouldExtract: [
      {
        content: '用户计划三年内在北京买房，预算约五百万',
        type: 'goal',
        predicateKey: 'goal.long_term',
        importance: 'high',
      },
      {
        content: '用户计划这周去银行咨询贷款利率',
        type: 'fact',
        predicateKey: 'plan.near_term',
        importance: 'low',
      },
    ],
    shouldNotExtract: [
      { text: '问清楚利率上浮和提前还款条款', reason: 'assistant_instruction' },
    ],
  },

  // ============================================================
  // ⑤ 不确定表述：含糊的话不该被记成确定的事实
  // ============================================================
  {
    id: 'hedged-statements',
    focus: '含糊表述的尺度：用户明确说"还没想好"的意向可以记为低置信状态，但不得升级成确定事实，也不得由助手的话推断',
    turns: [
      { role: 'user', content: '我可能会考虑换个城市生活吧，还没想好。' },
      { role: 'assistant', content: '有什么在犹豫的点吗？' },
      { role: 'user', content: '主要是工作机会和父母的养老问题。' },
      { role: 'assistant', content: '听起来你更倾向于留在离父母近的地方。' },
    ],
    shouldExtract: [
      {
        content: '用户在考虑换城市生活，但还没有决定',
        type: 'state',
        importance: 'low',
      },
      {
        content: '用户换城市的顾虑是工作机会与父母养老',
        type: 'fact',
        importance: 'low',
      },
    ],
    shouldNotExtract: [
      {
        /**
         * ⚠️ 这句是**助手说的**，不是用户说的。
         *    把它记成用户的倾向就是典型的"把推测当事实"（PRD §10.2）——
         *    而且是模型自己推测后又被自己记住，错误会自我强化。
         */
        text: '听起来你更倾向于留在离父母近的地方',
        reason: 'speculation',
      },
    ],
  },
];
