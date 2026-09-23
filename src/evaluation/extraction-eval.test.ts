/**
 * 评测指标计算的单元测试
 *
 * 【为什么这些必须测】
 *   评测脚本本身出错是最危险的情况 —— 它会给出一个看起来合理的数字，
 *   然后所有调优决策都建立在错误数字上。而且这类错误不会让脚本崩溃，
 *   只会让指标悄悄偏乐观或偏悲观。
 *
 *   因此这里用**构造数据**把每个分支算一遍，不依赖 LLM 与数据库。
 *   实测教训：覆盖口径的实现第一版把 spurious 算成了 -1（重复扣减），
 *   如果没测就会得出"precision 超过 100%"这种明显荒谬的结果。
 *
 * 运行：pnpm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Memory } from '../database/schema/memories.js';
import type { EvaluationConversation } from './dataset.js';
import {
  looksLikeForbidden,
  parseJudgeResponse,
  scoreConversation,
  summarize,
} from './extraction-eval.js';

// ============================================================
// 构造数据
// ============================================================

function mem(
  id: string,
  content: string,
  type = 'fact',
  predicateKey: string | null = null
): Memory {
  return {
    id,
    userId: 'u1',
    type,
    content,
    subjectKey: 'user',
    predicateKey,
    objectValue: null,
    polarity: null,
    importanceScore: 0.6,
    confidenceScore: 1.0,
    status: 'active',
    validFrom: null,
    validUntil: null,
    supersededBy: null,
    sourceCount: 1,
    createdAt: new Date('2026-09-23T00:00:00Z'),
    updatedAt: new Date('2026-09-23T00:00:00Z'),
    deletedAt: null,
  };
}

const conversation: EvaluationConversation = {
  id: 'test',
  focus: '测试用',
  turns: [],
  shouldExtract: [
    { content: '用户住在北京', type: 'fact', predicateKey: 'residence.city' },
    { content: '用户是数据工程师', type: 'fact', predicateKey: 'employment.role' },
  ],
  shouldNotExtract: [{ text: '今天中午吃了个鸡腿饭', reason: 'trivial' }],
};

/**
 * 构造评审输出。
 *
 * coverage 用「期望下标 → 覆盖它的抽取下标数组」表示。
 * ⚠️ 空数组表示**未被覆盖**（没有抽取引用它），不是"覆盖了但没说是谁"——
 *    本文件第一版把两者混为一谈，导致"漏抽"用例假失败。
 */
function judge(
  coverageMap: Record<number, number[]>,
  ungrounded: { actualIndex: number; claim: string }[] = [],
  expectedCount = 2
) {
  return {
    coverage: Array.from({ length: expectedCount }, (_, i) => {
      const refs = coverageMap[i] ?? [];
      return {
        expectedIndex: i,
        covered: refs.length > 0,
        byActualIndexes: refs,
        note: null,
      };
    }),
    ungrounded: ungrounded.map((u) => ({ ...u, note: null })),
  };
}

// ============================================================
// 评分
// ============================================================

test('全部覆盖：precision=recall=1，无噪声', () => {
  const memories = [
    mem('m1', '用户在北京居住', 'fact', 'residence.city'),
    mem('m2', '用户从事数据工程师工作', 'fact', 'employment.role'),
  ];

  const score = scoreConversation({
    conversation,
    memories,
    judged: judge({ 0: [0], 1: [1] }),
    timingMs: 100,
  });

  assert.equal(score.truePositives, 2);
  assert.equal(score.missed, 0);
  assert.equal(score.spurious, 0);
  assert.equal(score.slotAccuracy, 1);
  assert.equal(score.typeAccuracy, 1);
});

test('漏抽：recall 下降，missed 列出漏掉的标注', () => {
  const memories = [mem('m1', '用户在北京居住', 'fact', 'residence.city')];

  const score = scoreConversation({
    conversation,
    memories,
    judged: judge({ 0: [0], 1: [] }),
    timingMs: 100,
  });

  assert.equal(score.missed, 1);
  assert.deepEqual(score.missedContents, ['用户是数据工程师']);

  const overall = summarize([score]);
  assert.equal(overall.precision, 1);
  assert.equal(overall.recall, 0.5);
});

test('一条抽取覆盖多条期望时算全部覆盖（合并抽取不扣 recall）', () => {
  /**
   * 这是改用覆盖口径的核心原因。
   *
   * 1:1 匹配下，一条抽取覆盖两条期望时，另一条必然判漏 ——
   * 但信息其实没丢。实测踩到过：模型抽出「用户是数据工程师，
   * 工作偏实时方向，主要使用 Flink」，而标注拆成两条，recall 被低估。
   */
  const memories = [mem('m1', '用户在北京做数据工程师', 'fact', 'residence.city')];

  const score = scoreConversation({
    conversation,
    memories,
    judged: judge({ 0: [0], 1: [0] }), // 同一条抽取覆盖两条期望
    timingMs: 100,
  });

  assert.equal(score.missed, 0, '两条期望都被覆盖，不该算漏');
  assert.equal(score.truePositives, 1, '但抽取只有一条，precision 分子仍是 1');
  assert.deepEqual(score.matches[0]!.coveredExpectedIndexes, [0, 1]);
});

test('未被任何期望引用的抽取算误抽，precision 下降', () => {
  const memories = [
    mem('m1', '用户在北京居住', 'fact', 'residence.city'),
    mem('m2', '用户从事数据工程师工作', 'fact', 'employment.role'),
    mem('m3', '用户喜欢喝咖啡'), // 标注意外，也没被引用
  ];

  const score = scoreConversation({
    conversation,
    memories,
    judged: judge({ 0: [0], 1: [1] }),
    timingMs: 100,
  });

  assert.equal(score.truePositives, 2);
  assert.equal(score.spurious, 1);

  const overall = summarize([score]);
  assert.ok(Math.abs(overall.precision - 2 / 3) < 1e-9);
});

test('噪声单独计数，且不会被重复算进误抽', () => {
  const memories = [
    mem('m1', '用户在北京居住', 'fact', 'residence.city'),
    mem('m2', '用户今天中午吃了鸡腿饭'),
  ];

  const score = scoreConversation({
    conversation,
    memories,
    judged: judge({ 0: [0], 1: [] }),
    timingMs: 100,
  });

  assert.equal(score.forbidden, 1);
  assert.equal(score.spurious, 1, '噪声那条也是未被引用的抽取，算一条误抽');
  assert.equal(
    score.truePositives + score.spurious,
    score.extracted,
    '命中 + 误抽必须等于抽取总数（spurious 含噪声，不再单独相加）'
  );
  assert.equal(score.matches[1]!.forbiddenReason, 'trivial');

  const overall = summarize([score]);
  assert.equal(overall.noise, 1);
  assert.equal(overall.noiseRate, 0.5);
});

test('槽位填错会被单独指出，且不影响覆盖判定', () => {
  const memories = [
    mem('m1', '用户在北京居住', 'fact', 'employment.role'), // 槽位错
    mem('m2', '用户从事数据工程师工作', 'fact', 'employment.role'),
  ];

  const score = scoreConversation({
    conversation,
    memories,
    judged: judge({ 0: [0], 1: [1] }),
    timingMs: 100,
  });

  assert.equal(score.truePositives, 2, '槽位错不影响覆盖');
  assert.equal(score.slotAccuracy, 0.5);
  assert.equal(score.matches[0]!.slotCorrect, false);
});

test('类型填错会被单独指出', () => {
  const memories = [
    mem('m1', '用户在北京居住', 'preference', 'residence.city'),
    mem('m2', '用户从事数据工程师工作', 'fact', 'employment.role'),
  ];

  const score = scoreConversation({
    conversation,
    memories,
    judged: judge({ 0: [0], 1: [1] }),
    timingMs: 100,
  });

  assert.equal(score.typeAccuracy, 0.5);
});

test('未覆盖任何期望的抽取不做槽位/类型判定', () => {
  const memories = [mem('m1', '用户喜欢喝咖啡', 'preference')];

  const score = scoreConversation({
    conversation,
    memories,
    judged: judge({ 0: [], 1: [] }),
    timingMs: 100,
  });

  assert.equal(score.matches[0]!.slotCorrect, null);
  assert.equal(score.slotAccuracy, null, '没有任何可判定的条目时应为 null 而不是 0');
});

test('宽松口径下无依据断言不影响分数，但**始终记录**', () => {
  const memories = [
    mem('m1', '用户在北京居住', 'fact', 'residence.city'),
    mem('m2', '用户从事数据工程师工作', 'fact', 'employment.role'),
  ];

  const score = scoreConversation({
    conversation,
    memories,
    judged: judge({ 0: [0], 1: [1] }, [{ actualIndex: 1, claim: '用户偏好远程办公' }]),
    timingMs: 100,
    policy: { extraClaimsCountAsSpurious: false },
  });

  assert.equal(score.spurious, 0, '宽松口径下不算误抽');
  assert.equal(score.extraClaims, 1, '但仍要记录，排查编造时是第一手证据');
  assert.equal(score.matches[1]!.ungroundedClaim, '用户偏好远程办公');
});

test('严格口径下无依据断言使该条不算有用（precision 下降）', () => {
  const memories = [
    mem('m1', '用户在北京居住', 'fact', 'residence.city'),
    mem('m2', '用户从事数据工程师工作', 'fact', 'employment.role'),
  ];

  const score = scoreConversation({
    conversation,
    memories,
    judged: judge({ 0: [0], 1: [1] }, [{ actualIndex: 1, claim: '用户偏好远程办公' }]),
    timingMs: 100,
    policy: { extraClaimsCountAsSpurious: true },
  });

  const overall = summarize([score]);
  assert.equal(score.truePositives, 1, '夹带无依据断言的那条不算有用');
  assert.ok(Math.abs(overall.precision - 0.5) < 1e-9);
});

test('spurious 永不为负（回归：重复扣减曾算出 -1）', () => {
  /**
   * 覆盖口径的第一版实现里，「夹带额外断言」被当成独立类别扣了一次，
   * 而那条本来就在 truePositives 里 —— 结果 spurious = 2 - 2 - 1 = -1。
   * 那会让 precision 超过 100%。
   */
  const memories = [
    mem('m1', '用户在北京居住', 'fact', 'residence.city'),
    mem('m2', '用户从事数据工程师工作', 'fact', 'employment.role'),
  ];

  for (const strict of [false, true]) {
    const score = scoreConversation({
      conversation,
      memories,
      judged: judge({ 0: [0], 1: [1] }, [{ actualIndex: 0, claim: 'x' }]),
      timingMs: 1,
      policy: { extraClaimsCountAsSpurious: strict },
    });

    assert.ok(score.spurious >= 0, `strict=${strict} 时 spurious 不应为负`);
    const overall = summarize([score]);
    assert.ok(overall.precision >= 0 && overall.precision <= 1, 'precision 必须落在 [0,1]');
  }
});

test('summary 用合计而不是平均（短会话不该被长会话稀释）', () => {
  const short = scoreConversation({
    conversation: {
      id: 'short',
      focus: '',
      turns: [],
      shouldExtract: [{ content: 'x', type: 'fact' }],
      shouldNotExtract: [],
    },
    memories: [mem('a', 'x')],
    judged: judge({ 0: [0] }, [], 1),
    timingMs: 1,
  });

  const long = scoreConversation({
    conversation: {
      id: 'long',
      focus: '',
      turns: [],
      shouldExtract: Array.from({ length: 9 }, (_, i) => ({
        content: `y${i}`,
        type: 'fact' as const,
      })),
      shouldNotExtract: [],
    },
    memories: [mem('b', 'y0')],
    judged: judge({ 0: [0] }, [], 9),
    timingMs: 1,
  });

  const overall = summarize([short, long]);

  assert.equal(overall.precision, 1, '合一：命中 2 / 抽取 2');
  assert.equal(overall.recall, 0.2, '合计召回：命中 2 / 期望 10');
});

test('完全没有抽取时各指标为 0 而不是 NaN', () => {
  const score = scoreConversation({
    conversation,
    memories: [],
    judged: judge({ 0: [], 1: [] }),
    timingMs: 10,
  });

  assert.equal(score.extracted, 0);
  assert.equal(score.missed, 2);

  const overall = summarize([score]);
  assert.equal(overall.precision, 0);
  assert.equal(overall.recall, 0);
  assert.equal(overall.f1, 0);
  assert.equal(overall.slotAccuracy, null);
  assert.ok(!Number.isNaN(overall.f1));
});

// ============================================================
// 评审输出解析
// ============================================================

test('parseJudgeResponse 剥离 markdown 代码块', () => {
  const raw =
    '```json\n{"coverage":[{"expectedIndex":0,"covered":true,"byActualIndexes":[0]}],"ungrounded":[]}\n```';
  const parsed = parseJudgeResponse(raw, 1, 1);
  assert.equal(parsed.coverage[0]!.covered, true);
});

test('parseJudgeResponse 容忍前后解释文字', () => {
  const raw =
    '我的判断如下：\n{"coverage":[{"expectedIndex":0,"covered":false,"byActualIndexes":[]}],"ungrounded":[]}\n以上。';
  const parsed = parseJudgeResponse(raw, 1, 1);
  assert.equal(parsed.coverage[0]!.covered, false);
});

test('parseJudgeResponse 对缺失的期望补齐为「未覆盖」（保守方向）', () => {
  /**
   * 少判一条时若直接丢弃，那条期望既不算命中也不算漏 —— recall 会凭空变好。
   * 补齐方向选"未覆盖"是保守的：宁可低估质量也不虚报。
   */
  const raw = '{"coverage":[{"expectedIndex":0,"covered":true,"byActualIndexes":[]}],"ungrounded":[]}';
  const parsed = parseJudgeResponse(raw, 3, 2);

  assert.equal(parsed.coverage.length, 3);
  assert.equal(parsed.coverage[0]!.covered, true);
  assert.equal(parsed.coverage[1]!.covered, false);
  assert.match(parsed.coverage[2]!.note ?? '', /未返回/);
});

test('parseJudgeResponse 过滤越界的抽取下标（防止伪造引用）', () => {
  const raw =
    '{"coverage":[{"expectedIndex":0,"covered":true,"byActualIndexes":[0,99,-1]}],"ungrounded":[{"actualIndex":42,"claim":"x"}]}';
  const parsed = parseJudgeResponse(raw, 1, 1);

  assert.deepEqual(parsed.coverage[0]!.byActualIndexes, [0], '越界下标应被过滤');
  assert.equal(parsed.ungrounded.length, 0, '越界的 ungrounded 应被丢弃');
});

test('parseJudgeResponse 找不到 JSON 时抛错而不是返回空结果', () => {
  /**
   * 返回空结果会让 precision 与 recall 双双变成 0，
   * 看起来像"质量极差"，而实际是评测坏了 —— 那种误导比报错更糟。
   */
  assert.throws(() => parseJudgeResponse('我觉得都挺好的', 2, 2), /找不到 JSON/);
});

// ============================================================
// 噪声识别
// ============================================================

test('looksLikeForbidden：改写后的句子仍能识别', () => {
  assert.equal(looksLikeForbidden('今天中午吃了个鸡腿饭', '用户今天中午吃了个鸡腿饭'), true);
  assert.equal(looksLikeForbidden('你刚才回答得有点慢啊', '用户抱怨助手回答速度慢'), false);
});

test('looksLikeForbidden：正常记忆不会被误判为噪声', () => {
  /**
   * 误判方向必须选对：把正常记忆当噪声会让指标偏悲观，
   * 并把人引向错误的调优方向（去改一个本来没问题的东西）。
   */
  assert.equal(looksLikeForbidden('今天中午吃了个鸡腿饭', '用户住在北京'), false);
  assert.equal(looksLikeForbidden('你好', '用户的名字是陈默'), false);
});

test('looksLikeForbidden：极短句子要求包含匹配', () => {
  assert.equal(looksLikeForbidden('还行', '用户觉得还行'), true);
  assert.equal(looksLikeForbidden('还行', '用户住在北京'), false);
});
