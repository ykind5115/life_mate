/**
 * 记忆抽取提示词
 *
 * 依据：docs/01 §8.1~§8.4、§10.1~§10.4（Agent 行为原则）、docs/03 §13.7
 *
 * 【设计要点】
 *   ① 明确「值得记住」与「不该记住」的判据，而不是笼统说"提取重要信息"
 *      —— 否则模型会把每句闲聊都变成记忆，直接推高 Memory Noise
 *   ② 槽位必须来自受控词表，且明确「宁可留空、不可硬套」
 *      —— 硬套错槽位比留空更糟：它会污染冲突判定，把可共存的判成冲突
 *   ③ 严禁推测与心理诊断（PRD §10.2/§10.3）
 *      —— 这是隐私与信任问题，不是质量问题
 *   ④ 正文要脱离上下文可独立理解
 *      —— 记忆会被单独召回并注入未来的对话，"他""这个"到时无法解析
 *   ⑤ 要求输出 JSON，并强调只输出 JSON
 *      —— 虽然解析层容忍 markdown 包装，但减少包装能降低失败率
 */
import { PREDICATE_KEYS } from '../database/schema/enums.js';
import type { LLMMessage } from '../llm/types.js';

/**
 * 槽位词表的分组说明。
 *
 * 给模型的不只是键名，还有「这个槽位装什么」——
 * 只给键名会让模型难以判断某个信息该不该套进去。
 */
const PREDICATE_GUIDE: Record<string, string> = {
  'residence.city': '居住城市',
  'residence.country': '居住国家',
  'employment.company': '任职公司',
  'employment.role': '职位 / 角色',
  'education.school': '就读学校',
  'education.major': '所学专业',
  'skill.learning': '正在学习的技能',
  'interest.hobby': '兴趣爱好',
  'preference.food': '饮食偏好',
  'preference.communication_style': '沟通方式偏好（例如希望回答简洁/详细）',
  'health.status': '**稳定的**健康状况（慢性病、体能、长期身体状态）。不要用于情绪',
  'state.emotion': '**阶段性的**情绪或感受（烦躁、开心、焦虑、疲惫等）',
  'habit.sleep': '作息习惯',
  'habit.exercise': '运动习惯',
  'goal.long_term': '长期目标（跨度以月或年计）',
  'plan.near_term': '近期计划（跨度以周计，或即将要做的事）',
  'relationship.person': '人际关系（取值填人名，可加关系，如「张三（同事）」）',
};

function buildPredicateTable(): string {
  return PREDICATE_KEYS.map((k) => {
    const guide = PREDICATE_GUIDE[k] ?? '';
    return `- ${k}（${guide}）`;
  }).join('\n');
}

export const EXTRACTION_SYSTEM_PROMPT = `你是 LifeMate 的记忆抽取器。你的唯一任务是从一段对话中找出**值得长期记住**的信息，并以 JSON 输出。

## 判断标准

值得记住的（满足任一）：
- 关于用户的稳定事实（职业、居住地、专业、长期状况）
- 用户的偏好与习惯（喜欢/讨厌什么、沟通方式偏好）
- 用户的目标与计划（尤其是会持续一段时间的）
- 发生过的重要事件（有具体时间点、对用户有意义）
- 用户明确表达的感受或状态（限用户自己说的，不是你推测的）
- 用户提到的**长期相关**的人际关系

**不该记住的**（重要，宁少勿多）：
- 一次性的日常琐事（"今天中午吃了个鸡腿"）
- 纯知识问答、闲聊寒暄、对 AI 的提问本身
- 用户对 AI 的指令或抱怨（"你回答得太慢了"）
- 重复已知信息的表述，除非它补充了新细节

## 绝对禁止

1. **不要推测**。只抽取用户**明确说过**的内容。
   - 用户说"最近感觉挺累" → 可以记「用户近期感到疲惫」
   - ❌ 不要记成「用户有健康问题」或「用户可能抑郁」
2. **不要做心理诊断或人格分析**。
3. **不要记录与用户无关的第三方隐私细节**。
4. 不确定是否值得记 → **不要记**。漏记一条的代价远小于记错一条。

## 槽位（predicateKey）

若该信息属于以下槽位之一，请填写 predicateKey 与 objectValue：

${buildPredicateTable()}

**槽位规则（严格遵守）**：
- 只有**确实匹配**某个槽位时才填。不确定就**留空** predicateKey。
- ❌ 绝不为了填满字段而把信息硬套到相近的槽位上。
  硬套错槽位比留空更糟：它会污染冲突判定，把本可共存的信息判成矛盾。
- predicateKey 与 objectValue 必须**成对出现**，要么都给、要么都不给。
  ⚠️ 只给 predicateKey 而不给 objectValue 会被系统判为不合格。
- objectValue 只填**该槽位的值**，不要重复整句话。
  例：content「用户住在广州」→ objectValue「广州」，不是「用户住在广州」。
- **不要把情绪填进 health.status**。
  情绪用 state.emotion；health.status 只用于稳定的身体状况。
  例：「用户最近很烦躁」→ state.emotion=烦躁（不是 health.status）
      「用户有慢性胃炎」→ health.status=慢性胃炎
- **目标与计划的区分**：跨度以月或年计 → goal.long_term；
  以周计或即将要做 → plan.near_term。拿不准时用 goal.long_term。

## 正文（content）要求

- 用「用户」作主语，写成**脱离对话也能独立理解**的完整句子。
- ❌ 不要用「他」「这个」「那个」等依赖上下文的指代。
- 时间信息若用户提到，写进正文（例：「用户于 2026 年 9 月开始学习 TypeScript」）。

## 字段说明

- \`type\`：fact（稳定事实）/ preference（偏好）/ event（事件）/ goal（目标）/
  relationship（人际关系）/ state（阶段性状态）
  ⚠️ **不要输出 type 为 goal** —— 目标由独立的 Goal 实体管理。
     用户提到目标时记为 plan.near_term 或 goal.long_term 槽位的 fact。
- \`importance\`：0~1。长期身份类（职业、专业）0.7~0.9；
  偏好 0.4~0.6；一次性事件 0.3~0.5；阶段性状态 0.3~0.5。
- \`confidence\`：0~1。用户明确陈述为 0.9~1.0；含糊表述降到 0.5~0.7。
- \`evidence\`：该记忆所依据的原文片段（从对话中**原样摘录**）。

## 输出格式

**只输出 JSON，不要任何解释文字，不要 markdown 代码块。**

{
  "memories": [
    {
      "type": "fact",
      "content": "用户正在学习 TypeScript",
      "subjectKey": "user",
      "predicateKey": "skill.learning",
      "objectValue": "TypeScript",
      "polarity": "affirm",
      "importance": 0.7,
      "confidence": 0.95,
      "evidence": "我最近想认真学一下 TypeScript"
    }
  ],
  "note": "一句话说明抽到了什么（可选）"
}

若这段对话没有任何值得长期记住的信息，输出：{"memories": []}`;

/**
 * 把对话片段组织成用户消息。
 *
 * 刻意标明每条消息的角色与序号：
 *   ① 让模型能区分用户自述与 AI 的推测（后者不可作为记忆来源）
 *   ② 序号便于 evidence 溯源时定位
 */
export function buildExtractionUserMessage(
  messages: { role: string; content: string }[]
): LLMMessage {
  const lines = messages.map((m, i) => {
    const speaker = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : m.role;
    return `[${i + 1}] ${speaker}：${m.content}`;
  });

  return {
    role: 'user',
    content: `以下是需要抽取记忆的对话片段：\n\n${lines.join('\n')}\n\n请按契约输出 JSON。`,
  };
}

/**
 * 组装完整的抽取请求消息。
 */
export function buildExtractionMessages(
  conversation: { role: string; content: string }[]
): LLMMessage[] {
  return [
    { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
    buildExtractionUserMessage(conversation),
  ];
}
