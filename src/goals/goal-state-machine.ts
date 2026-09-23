/**
 * Goal 生命周期状态机（docs/03 §21.3）
 *
 * 【文档状态 —— 需要说明】
 *   §21.3 只列出了五个状态：
 *     active / paused / completed / cancelled / archived
 *   **没有给状态转移表**。而 §13.10 明确说 Goal 有「完整生命周期状态机」，
 *   因此转移规则必须有人定义。
 *
 *   本文件是**首个实现稿**，规则由以下几处依据推出，不是凭空发明：
 *     · 五个状态本身来自 §21.3
 *     · completed_at 字段的存在暗示 completed 需要记录完成时间
 *     · C24 规定删除 Goal 时要失效投影记忆 → 删除与状态是两件事
 *     · PRD §3.4「用户拥有最终记忆控制权」→ 用户可改任何状态，
 *       状态机只用来提示「这个转移是否正常」，而不是硬拒绝
 *
 * 【为什么状态机不硬拒绝非法转移】
 *   这是刻意的选择，与「约束下沉到数据库」的原则**不冲突**：
 *   库层的 CHECK 拦的是**非法取值**（不存在的状态），那是数据完整性问题。
 *   而「completed → active」这类是**业务语义**问题：
 *   用户完全可能「标记完成了，后来发现没完成，改回进行中」。
 *   硬拒绝会让他只能删掉重建，那更糟（丢失历史）。
 *
 *   因此：非法转移**允许但会告警**，由 API 返回里带上 warning 让前端提示。
 *   若将来发现某些转移确实不该允许（例如 archived → active 会污染统计），
 *   再收紧。
 *
 * ⚠️ 这份规则需要产品确认。已记在交付说明里。
 */
import type { GoalStatus } from '../database/schema/enums.js';

/** 允许的转移。key 是当前状态，value 是可达状态集合 */
const ALLOWED_TRANSITIONS: Record<GoalStatus, GoalStatus[]> = {
  /**
   * active 是起点与枢纽。
   *
   * 注意 archived → active：用户把归档的目标重新捡起来是常见需求
   * （「又想学吉他了」）。不加这条会逼用户删掉重建。
   */
  active: ['paused', 'completed', 'cancelled', 'archived'],

  /** paused 是「暂时搁置」，可回到 active，也可直接终结 */
  paused: ['active', 'completed', 'cancelled', 'archived'],

  /**
   * completed 只允许 archive。
   *
   * ⚠️ 不允许 completed → active：那会让 completed_at 与 status 不自洽
   *    （已完成的目标又变成进行中，但完成时间还留着）。
   *    用户若确实想重新开始，应该新建一个目标 ——
   *    「去年完成过一次、今年重新开始」本来就是两件事。
   *
   *    这是本状态机里唯一一处可能引起争议的收紧，需要确认。
   */
  completed: ['archived'],

  /** cancelled（放弃）与 completed 对称：只能归档 */
  cancelled: ['archived'],

  /** archived 是终态，但允许「重新启用」——见 active 的说明 */
  archived: ['active'],
};

export interface TransitionCheck {
  allowed: boolean;
  from: GoalStatus;
  to: GoalStatus;
  /** 不允许时的说明，供前端提示 */
  reason?: string;
}

/**
 * 检查一次状态转移是否在允许集合内。
 *
 * 同状态转移（active → active）视为 allowed：
 * 那是「更新其他字段时顺手带上 status」，不该报错。
 */
export function checkTransition(from: GoalStatus, to: GoalStatus): TransitionCheck {
  if (from === to) return { allowed: true, from, to };

  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (allowed.includes(to)) return { allowed: true, from, to };

  return {
    allowed: false,
    from,
    to,
    reason: describeIllegalTransition(from, to),
  };
}

function describeIllegalTransition(from: GoalStatus, to: GoalStatus): string {
  if (from === 'completed' && to === 'active') {
    return (
      '已完成的目标不能直接改回进行中 —— 那会让完成时间与状态不自洽。' +
      '若确实要重新开始，建议新建一个目标（「去年完成过一次」本身就是一段有价值的记录）。'
    );
  }
  if (from === 'cancelled' && to === 'active') {
    return '已放弃的目标不能直接改回进行中，请先归档再重新启用，或新建一个目标。';
  }
  return `不允许从 ${from} 直接转到 ${to}。`;
}

/**
 * 根据状态推导 completed_at 应有的值。
 *
 * 规则：
 *   · 进入 completed → 若未提供完成时间，用当前时间
 *   · 离开 completed → 清空完成时间
 *   · 其他情况不动
 *
 * 为什么不让调用方自己填：忘记清空会让「已完成时间」残留在一个
 * 进行中的目标上，那是明显的数据不一致，且很难被用户理解为「数据问题」。
 */
export function resolveCompletedAt(
  to: GoalStatus,
  current: Date | null,
  provided?: Date | null
): Date | null | undefined {
  if (to === 'completed') {
    if (provided !== undefined) return provided;
    return current ?? new Date();
  }
  // 离开 completed（或本来就不是）→ 清空
  if (current !== null) return null;
  return undefined;
}

/** 该状态是否视为「还在进行」 */
export function isOngoing(status: GoalStatus): boolean {
  return status === 'active' || status === 'paused';
}
