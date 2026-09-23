/**
 * LLM 实现的槽位判定器（三选一窄任务）
 *
 * 依据：docs/03 §13.7 —— 槽位确认相同、取值不同时，判断是
 *   「事实变化」还是「真正冲突」还是「其实可共存」。
 *
 * 【为什么这是一个独立的小任务而不是让抽取器顺手判断】
 *   ① 职责分离：抽取器负责「有什么信息」，判定器负责「与已有记忆什么关系」
 *   ② 可评测：这个任务足够窄，可以单独造金标集测准确率
 *   ③ 可换模型：窄任务可以用更便宜/更快的模型，而不影响抽取质量
 *
 * 【为什么必须给用例而不是只给两条文本】
 *   让模型只看「用户住在广州」和「用户已搬到深圳」两句，
 *   它可能判成共存（都是地理信息）。明确指出这是在判断
 *   「同一槽位（居住城市）上的两个取值」的关系，判断才可靠。
 */
import type { LLMProvider } from '../llm/provider.js';
import type { Memory } from '../database/schema/memories.js';
import type { NormalizedCandidate } from './extraction-schema.js';
import type { SlotAdjudicator } from './candidate-processor.js';

/** 判定结果的三个取值，与 §13.7 的判定树一致 */
export type SlotVerdict = 'state_change' | 'conflict' | 'coexist';

const SYSTEM_PROMPT = `你是记忆冲突判定器。系统已确认两条记忆属于**同一个属性槽位**，
但取值不同。请判断它们的关系属于以下哪一类。

## 三个类别

**state_change（事实变化）**
用户的情况发生了真实变化，新信息取代旧信息。时间上先后有序。
例：
  旧「用户住在广州」→ 新「用户已搬到深圳」
  旧「用户在 A 公司任职」→ 新「用户跳槽到 B 公司」
  旧「用户在学习 Python」→ 新「用户转向学习 TypeScript」

**conflict（真正冲突）**
两者不可能同时为真，但看不出哪个更新、也无法判断先后。
通常意味着其中一条是错的，或用户表述前后不一致。
例：
  旧「用户婚恋状态是单身」 vs 新「用户婚恋状态是已婚」——无法确定哪个更晚
  旧「用户是男性」 vs 新「用户是女性」

**coexist（可共存）**
表面同槽位，但实际可以同时成立，通常是抽取时把槽位归错了。
例：
  旧「用户在学习 Python」 vs 新「用户也在用 TypeScript」——两项技能可并存
  旧「用户偏好简洁回答」 vs 新「用户喜欢具体例子」——偏好可以多条并存

## 判断要点

1. **能否判断时间先后？** 能且合逻辑 → state_change
2. **是否互斥且无法判断先后？** → conflict
3. **是否本可同时成立？** → coexist
4. 拿不准时选 **conflict** —— 它会交给用户裁决，
   而误判为 state_change 会直接覆盖用户已有的事实，代价更大。

## 输出格式

只输出 JSON，不要解释文字，不要 markdown 代码块：

{"verdict":"state_change","reason":"一句话理由"}`;

/**
 * 基于 LLM 的判定器。
 *
 * 失败时的降级：抛错或返回非法值时按 'conflict' 处理 ——
 * 冲突会被交给用户裁决，而 state_change 会直接覆盖已有事实。
 * 两害相权，宁可多问用户一次。
 */
export class LlmSlotAdjudicator implements SlotAdjudicator {
  constructor(private readonly provider: LLMProvider) {}

  async adjudicate(input: {
    existing: Memory;
    candidate: NormalizedCandidate;
  }): Promise<SlotVerdict> {
    const userMessage = [
      `属性槽位：${input.candidate.predicateKey ?? '(未知)'}`,
      `主体：${input.candidate.subjectKey}`,
      '',
      `已有记忆：${input.existing.content}`,
      `  取值：${input.existing.objectValue ?? '(空)'}`,
      `  创建于：${input.existing.createdAt.toISOString()}`,
      '',
      `新信息：${input.candidate.content}`,
      `  取值：${input.candidate.objectValue ?? '(空)'}`,
      '',
      '请判断两者关系，按契约输出 JSON。',
    ].join('\n');

    let raw: string;
    try {
      const res = await this.provider.generate({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        // 窄任务不需要长输出；但仍要给足推理余量（推理模型思考与回答共享预算）
        maxOutputTokens: 1024,
      });
      raw = res.content;
    } catch {
      // LLM 不可用时降级为 conflict：交给用户裁决，不擅自覆盖事实
      return 'conflict';
    }

    return parseVerdict(raw);
  }
}

/**
 * 解析判定结果。无法解析时返回 'conflict'（保守降级）。
 *
 * 独立的导出便于单测，不必真的调 LLM。
 */
export function parseVerdict(raw: string): SlotVerdict {
  const text = raw.trim();

  // 尝试取 JSON；失败则退化为关键词匹配（模型偶尔会多说一句话）
  const jsonMatch = /\{[\s\S]*\}/.exec(text);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { verdict?: unknown };
      const v = parsed.verdict;
      if (v === 'state_change' || v === 'conflict' || v === 'coexist') return v;
    } catch {
      // 落到下面的关键词匹配
    }
  }

  // 关键词兜底。顺序重要：先匹配更具体的 state_change / coexist
  if (text.includes('state_change')) return 'state_change';
  if (text.includes('coexist')) return 'coexist';

  // 无法识别 → 保守降级
  return 'conflict';
}
