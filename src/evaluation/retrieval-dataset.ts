/**
 * 检索质量评测的标注集（docs/03 §18.5 的「检索可离线评测」）
 *
 * 【为什么需要单独的评测集】
 *   抽取评测（src/evaluation/dataset.ts）测的是「该记的记住没有」；
 *   这里是另一个问题：**「该想起来的时候想起来了没有」**（PRD §15 的 ②）。
 *
 *   检索质量目前无法测量，而 retrieval-config.ts 里好几个参数是
 *   文档给定值 + 我的估计（NORM_VECTOR_MIN、DECAY_HALF_LIFE_DAYS.preference、
 *   MIN_BIGRAM_HIT_RATIO）。没有评测就只能拍脑袋调，改完也不知道好坏。
 *
 * 【为什么语料是人工构造的固定集合，而不是复用真实库】
 *   ① 可复现：真实库随使用不断变化，指标会漂移，无法归因到代码改动
 *   ② 有干扰项：必须包含**看起来相关但其实不该召回**的记忆，
 *      否则「全召回」也能拿满分，测不出区分能力
 *   ③ 可控规模：语料要显著大于注入条数（Top-8），
 *      否则 recall@8 恒等于 1，指标没有意义
 *
 * 【设计要点】
 *   · 语料 40 条，涵盖六种记忆类型与各种槽位
 *   · 每个查询标注 relevant（必须召回）与 distractor（**不该**召回）
 *   · distractor 刻意与查询**主题相关但事实不同** —— 这是最容易误召的一类
 */

/** 语料里的一条记忆 */
export interface CorpusMemory {
  /** 评测内的稳定标识（不是数据库 id） */
  key: string;
  content: string;
  type: 'fact' | 'preference' | 'event' | 'goal' | 'relationship' | 'state';
  /**
   * 槽位。**必须来自 PREDICATE_KEYS**，否则库层 CHECK 会拒绝插入。
   *
   * ⚠️ 留空（不给这个字段）是常态：语料里有多个「学习项」
   *    （Rust / 钢琴 / 素描），而词表里只有一个 skill.learning ——
   *    给它们同一个槽位会撞 uq_memories_current_slot。
   *    这也顺便反映真实情况：无槽位记忆确实占多数（C28 的设计预期）。
   */
  predicateKey?: string;
  objectValue?: string;
  /** 多久之前建立（天）。用于验证时效项是否按类型正确衰减 */
  daysAgo?: number;
  importance?: number;
}

/** 一个查询及其标注 */
export interface RetrievalQuery {
  id: string;
  query: string;
  /** 这次考察什么能力 */
  focus: string;
  /** 必须被召回的语料 key */
  relevant: string[];
  /**
   * 不该被召回的语料 key。
   *
   * ⚠️ 只列**容易被误召**的。把全部无关项都列进来没有意义
   *    （任何检索器都不会召回它们），只会稀释指标。
   */
  distractors?: string[];
}

// ============================================================
// 语料
// ============================================================

export const RETRIEVAL_CORPUS: CorpusMemory[] = [
  // ---------- 居住 / 职业（稳定事实，带槽位）----------
  { key: 'city', content: '用户居住在杭州', type: 'fact', predicateKey: 'residence.city', objectValue: '杭州', daysAgo: 400 },
  { key: 'country', content: '用户居住在中国', type: 'fact', predicateKey: 'residence.country', objectValue: '中国', daysAgo: 400 },
  { key: 'role', content: '用户从事数据分析工作', type: 'fact', predicateKey: 'employment.role', objectValue: '数据分析', daysAgo: 400, importance: 0.8 },
  { key: 'company', content: '用户在一家做机器人的公司工作', type: 'fact', predicateKey: 'employment.company', objectValue: '机器人公司', daysAgo: 60, importance: 0.8 },
  { key: 'school', content: '用户本科就读于南京大学', type: 'fact', predicateKey: 'education.school', objectValue: '南京大学', daysAgo: 3000 },
  { key: 'major', content: '用户所学专业是统计学', type: 'fact', predicateKey: 'education.major', objectValue: '统计学', daysAgo: 3000 },

  // ---------- 学习 / 兴趣 ----------
  // 只有 Rust 用 skill.learning 槽位；钢琴与素描留空（同槽位会撞唯一索引）
  { key: 'rust', content: '用户最近在学习 Rust，目的是自己写一些小工具', type: 'fact', predicateKey: 'skill.learning', objectValue: 'Rust', daysAgo: 20, importance: 0.7 },
  { key: 'piano', content: '用户在学习钢琴，想年底弹一首完整的曲子', type: 'fact', daysAgo: 15 },
  { key: 'sketch', content: '用户从今年三月开始学素描，每周去一次画室', type: 'fact', daysAgo: 200 },
  { key: 'coffee', content: '用户平时喜欢喝手冲咖啡', type: 'preference', predicateKey: 'interest.hobby', objectValue: '手冲咖啡', daysAgo: 100 },
  { key: 'running', content: '用户每周跑三次步', type: 'preference', predicateKey: 'habit.exercise', objectValue: '跑步，每周三次', daysAgo: 90 },
  { key: 'sleep', content: '用户习惯凌晨一点左右睡觉', type: 'preference', predicateKey: 'habit.sleep', objectValue: '凌晨一点', daysAgo: 80 },
  { key: 'spicy', content: '用户吃不了太辣的东西', type: 'preference', predicateKey: 'preference.food', objectValue: '不吃辣', daysAgo: 120 },
  { key: 'style', content: '用户偏好直接、具体的技术解释，不喜欢铺垫', type: 'preference', predicateKey: 'preference.communication_style', objectValue: '直接、具体', daysAgo: 30 },

  // ---------- 目标 / 计划 ----------
  { key: 'ielts', content: '用户的目标是考到雅思 7 分', type: 'goal', predicateKey: 'goal.long_term', objectValue: '雅思 7 分', daysAgo: 10, importance: 0.9 },
  // 加拿大与买房都留空：goal.long_term 已被雅思占用
  { key: 'canada', content: '用户计划明年秋天去加拿大读研', type: 'goal', daysAgo: 10, importance: 0.9 },
  { key: 'house', content: '用户计划三年内在北京买一套小两居，预算约五百万', type: 'goal', daysAgo: 5, importance: 0.8 },
  { key: 'bankloan', content: '用户计划这周去银行咨询贷款利率', type: 'fact', daysAgo: 3 },

  // ---------- 人际关系 ----------
  { key: 'xiaoyu', content: '用户的女朋友叫小雨，从事设计工作', type: 'relationship', predicateKey: 'relationship.person', objectValue: '小雨（女友）', daysAgo: 40 },
  { key: 'cat', content: '用户养了一只叫团子的猫', type: 'fact', daysAgo: 50 },
  { key: 'mom', content: '用户的母亲住在苏州，身体不好需要照顾', type: 'relationship', daysAgo: 200 },
  { key: 'colleague', content: '用户的同事张伟负责前端部分', type: 'relationship', daysAgo: 25 },

  // ---------- 事件 ----------
  { key: 'move', content: '用户于2026年9月16日从北京搬到杭州', type: 'event', daysAgo: 7 },
  { key: 'jobchange', content: '用户于2026年8月28日入职一家新公司', type: 'event', daysAgo: 26 },
  { key: 'graduate', content: '用户于2020年6月大学毕业', type: 'event', daysAgo: 2280 },
  { key: 'catadopt', content: '用户于2026年初领养了团子', type: 'event', daysAgo: 260 },

  // ---------- 阶段性状态（用于验证时效衰减）----------
  // state.emotion 只有一个位置，第二条留空
  { key: 'tired', content: '用户最近因为项目排期紧感到疲惫', type: 'state', predicateKey: 'state.emotion', objectValue: '疲惫', daysAgo: 3 },
  { key: 'anxious', content: '用户最近对雅思考试有点焦虑', type: 'state', daysAgo: 5 },
  { key: 'stomach', content: '用户有慢性胃炎', type: 'fact', predicateKey: 'health.status', objectValue: '慢性胃炎', daysAgo: 300 },
  { key: 'busy', content: '用户这两个月在赶一个交付项目', type: 'state', daysAgo: 20 },
  { key: 'sick', content: '用户半个月前感冒发烧了一周', type: 'state', daysAgo: 15 },

  // ---------- 干扰项：主题相关但事实不同 ----------
  { key: 'decoy-shenzhen', content: '用户提到过想去深圳发展', type: 'state', daysAgo: 45 },
  { key: 'decoy-su', content: '用户的大学室友在苏州工作', type: 'relationship', daysAgo: 150 },
  { key: 'decoy-python', content: '用户三年前用过 Python 做数据清洗', type: 'fact', daysAgo: 1100 },
  { key: 'decoy-tea', content: '用户不喜欢喝奶茶', type: 'preference', daysAgo: 60 },
  { key: 'decoy-dog', content: '用户小时候家里养过狗', type: 'fact', daysAgo: 5000 },
  { key: 'decoy-marathon', content: '用户曾想报名马拉松但没去', type: 'state', daysAgo: 180 },
  { key: 'decoy-japanese', content: '用户以前学过一点日语，已经忘得差不多了', type: 'fact', daysAgo: 900 },
  { key: 'decoy-beijing', content: '用户在北京工作过四年', type: 'fact', daysAgo: 90 },
  { key: 'decoy-cheap', content: '用户想买个便宜点的键盘', type: 'state', daysAgo: 35 },
  { key: 'decoy-sister', content: '用户的妹妹在读高中', type: 'relationship', daysAgo: 400 },
];

// ============================================================
// 查询
// ============================================================

export const RETRIEVAL_QUERIES: RetrievalQuery[] = [
  {
    id: 'residence',
    query: '我现在住在哪个城市？',
    focus: '直接问居住地 —— 槽位明确，应稳定命中',
    relevant: ['city'],
    distractors: ['decoy-beijing', 'decoy-shenzhen'],
  },
  {
    id: 'job',
    query: '我在哪家公司工作？',
    focus: '职业类事实',
    relevant: ['company'],
    distractors: ['decoy-beijing', 'role'],
  },
  {
    id: 'pet-name',
    query: '我养的那只猫叫什么名字？',
    focus: '具体实体名 —— 字面重合，关键词通道应能帮上忙',
    relevant: ['cat', 'catadopt'],
    distractors: ['decoy-dog'],
  },
  {
    id: 'learning',
    query: '我最近在学什么？',
    focus: '多个学习项并存，应尽量都召回',
    relevant: ['rust', 'piano', 'sketch'],
    distractors: ['decoy-python', 'decoy-japanese'],
  },
  {
    id: 'goals',
    query: '我有什么长期目标？',
    focus: '目标类 —— 检验 type=goal 与 plan 槽位是否被召回',
    relevant: ['ielts', 'canada'],
    distractors: ['decoy-marathon'],
  },
  {
    id: 'partner',
    query: '我女朋友是做什么的？',
    focus: '人际关系 + 职业属性',
    relevant: ['xiaoyu'],
    distractors: ['decoy-sister', 'mom'],
  },
  {
    id: 'food-pref',
    query: '我有什么忌口吗？',
    focus: '**换了说法**（「忌口」vs「吃不了辣」）—— 主要检验向量通道',
    relevant: ['spicy'],
    distractors: ['coffee', 'decoy-tea'],
  },
  {
    id: 'exercise',
    query: '我平时运动吗？',
    focus: '习惯类',
    relevant: ['running'],
    distractors: ['decoy-marathon'],
  },
  {
    id: 'sleep',
    query: '我一般几点睡？',
    focus: '生活作息',
    relevant: ['sleep'],
    distractors: ['tired'],
  },
  {
    id: 'health',
    query: '我身体上有什么老毛病？',
    focus: '健康状况 —— 注意不能被「最近疲惫」这类状态挤掉',
    relevant: ['stomach'],
    distractors: ['tired', 'sick', 'anxious'],
  },
  {
    id: 'recent-emotion',
    query: '我最近心情怎么样？',
    focus: '**时效敏感**：近期的情绪应排在几个月前的事件之前',
    relevant: ['tired', 'anxious'],
    distractors: ['decoy-cheap', 'busy', 'sick'],
  },
  {
    id: 'education',
    query: '我是什么学历背景？',
    focus: '教育类事实',
    relevant: ['school', 'major'],
    distractors: ['decoy-python'],
  },
  {
    id: 'communication',
    query: '我更喜欢你怎么跟我说话？',
    focus: '沟通偏好 —— 措辞与记忆差异很大，考验语义召回',
    relevant: ['style'],
    distractors: [],
  },
  {
    id: 'house-plan',
    query: '我买房的事有什么进展？',
    focus: '具体计划',
    relevant: ['house', 'bankloan'],
    distractors: ['decoy-cheap'],
  },
  {
    id: 'when-moved',
    query: '我什么时候搬家的？',
    focus: '时间点事件 —— 检验 event 类型是否被召回',
    relevant: ['move'],
    distractors: ['decoy-beijing'],
  },
  {
    id: 'mother',
    query: '我家里人的情况怎么样？',
    focus: '多位家人并存，应召回主要的',
    relevant: ['mom'],
    distractors: ['decoy-sister', 'xiaoyu'],
  },
];
