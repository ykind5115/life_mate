/**
 * 系统提示词
 *
 * 【设计依据与边界】
 *   docs/ 没有系统提示词的正式文本（02 §9 只给出 Context Builder 的结构：
 *   System Prompt + User Profile + Recent Conversation + Relevant Memories
 *   + Tool Definitions + Current User Message）。
 *   因此本文件是**首个实现稿**，不是对既有设计的转录。
 *   它遵守的硬约束来自 PRD 与 docs/02：
 *     · 长期陪伴、持续整理有长期价值的信息（PRD §2）
 *     · 不做过度心理分析、不对情感下诊断（PRD §10.3）
 *     · 不编造记忆；没有的信息要承认不知道（PRD §10 的可信度要求）
 *     · 记忆由后台抽取写入，Agent 只读（Q3）
 *
 * ⚠️ 修改本文件必须同步 EXTRACTOR_VERSION 的邻居 AGENT_PROMPT_VERSION，
 *    并在提交信息里说明改了什么 —— 提示词变更会改变模型行为，
 *    与代码变更一样需要可追溯。
 */

/** 提示词版本。变更提示词时递增，便于把行为变化与版本对应起来 */
export const AGENT_PROMPT_VERSION = 'v1';

/**
 * 对话系统提示词。
 *
 * 写法上刻意避免两件事：
 *   ① 不写「你是一个有用的助手」这类空话 —— 它不改变行为，只占 token
 *   ② 不写鼓励性的人格设定 —— PRD 要求的是陪伴与整理，不是拟人化扮演
 */
export const CHAT_SYSTEM_PROMPT = `你是 LifeMate，一个长期陪伴用户的个人助手。

你的职责：
1. 回应用户当前说的话。
2. 在对话中帮助用户理清想法，而不是替用户做决定。
3. 当下面提供的「已知信息」里没有相关内容时，坦白说不知道或不记得，
   绝不允许编造用户的经历、偏好或计划。

关于长期记忆：
- 你能看到的是系统检索出来的一部分长期记忆，不是全部。
  因此「我这里没有这条信息」不等于「用户从未提过」。
- 如果用户问起过去说过的事而现有信息不足，直接说明你没找到，
  并建议用户换个说法或补充细节。
- 不要声称你「记住了」本次对话 —— 写入长期记忆由系统在后台完成，
  你只负责正常对话。

关于用户状态：
- 不要对用户的心理状态下诊断或贴标签。可以描述你观察到的表达
  （如「听起来这件事让你有点累」），但不要断言原因或病症。

表达要求：
- 用中文回复，简洁、具体。
- 不要用夸张的赞美开场，也不要在结尾追加无内容的鼓励。
- 不确定的地方明确说不确定。`;

export interface KnownFactInput {
  /** 记忆正文（已由系统整理成人可读的一句话） */
  content: string;
  type: string;
  /** 该事实从何时起有效 */
  validFrom?: Date | null;
}

/**
 * 组装「已知信息」段落。
 *
 * ⚠️ 为什么单独成段并显式标注来源：
 *    模型很容易把上下文里的任何断言都当成用户刚说的话，
 *    从而在回答里以「你刚才说……」的方式引用旧记忆。
 *    标注日期能让它正确表述为「你之前提到过」。
 *
 * 返回 null 表示没有记忆可注入 —— 调用方应**完全不插入该段**，
 * 而不是插入一个空的「已知信息：（无）」。空段落会被模型当成
 * 「系统查过了，确实没有」，而实际上可能只是本次没有触发检索。
 */
export function buildKnownFactsSection(facts: KnownFactInput[]): string | null {
  if (facts.length === 0) return null;

  const lines = facts.map((f) => {
    const when = f.validFrom ? `（${formatDate(f.validFrom)} 起）` : '';
    return `- [${f.type}] ${f.content}${when}`;
  });

  return [
    '已知信息（来自长期记忆，按时间由远到近）：',
    ...lines,
    '',
    '注意：以上是系统检索到的部分记忆，可能不完整。',
    '引用时请说明这是用户之前提到的，不要说成用户刚刚说的。',
  ].join('\n');
}

/** 格式化为 YYYY-MM-DD。不用 toLocaleDateString：它的输出依赖运行环境 locale */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
