/**
 * Settings 读写（docs/03 §8.4、§16.3；docs/04 §34–§36）
 *
 * 【存储位置】users.settings JSONB
 *   §8.4 决定静态配置暂存这里，不新增独立 profile 表。
 *   §16.3 要求：写入前 Zod 校验 + **白名单模式**（只允许已知键）。
 *   因此本文件的 schema 用 `.strict()`：多传一个键就报错，
 *   而不是静默丢弃 —— 静默丢弃会让调用方以为设置生效了。
 *
 * 【为什么单独一个模块】
 *   ① 设置要先读→合并→校验→写回，不是单表 update 能表达的
 *   ② auto_extract 需要被抽取触发器读到，属于跨模块的配置读取点
 *   ③ 缺省值与白名单集中在一处，避免各处自己写 `settings.auto_extract ?? true`
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import { db } from '../database/client.js';
import { users, type User } from '../database/schema/users.js';
import type { ExecutorOption } from '../database/repository/types.js';

/**
 * users.settings 的白名单（docs/03 §8.4）。
 *
 * ⚠️ 枚举值以文档为准，不要自行发明：
 *    response_style 文档给的是 direct | gentle | detailed
 *    response_length 文档给的是 short | medium | long
 *  本文件第一版把 response_style 写成了 concise | detailed —— 那是错的，
 *  会让前端按文档传 direct 时被拒。
 */
export const userSettingsSchema = z
  .object({
    display_name: z.string().min(1).max(100).optional(),
    locale: z.string().min(1).max(20).optional(),
    response_style: z.enum(['direct', 'gentle', 'detailed']).optional(),
    response_length: z.enum(['short', 'medium', 'long']).optional(),
    /** 是否自动抽取记忆。缺省 true（docs/04 §36） */
    auto_extract: z.boolean().optional(),
    /** 敏感记忆是否禁止出网（§20）。V1.0 尚未实现出网判断，先允许存 */
    sensitive_memory_local_only: z.boolean().optional(),
  })
  .strict();

export type UserSettings = z.infer<typeof userSettingsSchema>;

/**
 * 设置的缺省值。
 *
 * ⚠️ 只有 auto_extract 有明确缺省（true，docs/04 §36）。
 *    其余键**不给缺省**：未设置就是未设置，前端据此区分
 *    「用户主动选了 gentle」与「还没选过」。
 *    给所有键都塞一个缺省值会让设置页显示一堆用户从未选择过的偏好。
 */
export const DEFAULT_SETTINGS = {
  auto_extract: true,
} as const;

/**
 * 解析用户设置，对损坏/未知的键做容错。
 *
 * 为什么不直接 parse 后抛错：settings 是用户数据，
 * 一个历史遗留的未知键不该让整个应用起不来。
 * 但**写入路径**（updateSettings）必须严格 —— 那里拒绝非法输入。
 */
export function resolveSettings(user: Pick<User, 'settings'>): UserSettings {
  const parsed = userSettingsSchema.safeParse(user.settings ?? {});
  if (!parsed.success) {
    // 只记录问题条数，不打印内容（settings 可能有 display_name 等个人信息）
    console.warn(
      `[settings] users.settings 中存在非法内容（${parsed.error.issues.length} 处），已忽略非法部分`
    );
    return {};
  }
  return parsed.data;
}

/** auto_extract 的当前取值（含缺省） */
export function isAutoExtractEnabled(user: Pick<User, 'settings'>): boolean {
  return resolveSettings(user).auto_extract ?? DEFAULT_SETTINGS.auto_extract;
}

/**
 * 合并式更新设置。
 *
 * 【为什么是合并而不是整体替换】
 *   PATCH 的语义是部分更新。若做整体替换，前端只想改 auto_extract
 *   也必须把 display_name、locale 等全部回传 —— 漏传一个就会把它清掉。
 *   那是很容易造成「设置莫名丢失」的接口设计。
 *
 * `null` 表示**显式清除**某个键；`undefined`（未传）表示不动它。
 * 这个区分让用户能"取消选择"而不是被迫留着一个值。
 */
export async function updateSettings(
  userId: string,
  patch: Record<string, unknown>,
  options: ExecutorOption = {}
): Promise<User> {
  const exec = options.executor ?? db;

  const current = await exec.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = current[0];
  if (!user) throw new Error(`用户不存在：${userId}`);

  const existing = resolveSettings(user);

  // 先校验补丁本身（拒绝未知键）
  const validatedPatch = userSettingsSchema.partial().safeParse(patch);
  if (!validatedPatch.success) {
    throw new SettingsValidationError(validatedPatch.error.issues);
  }

  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(validatedPatch.data)) {
    if (value === undefined) continue;
    if (value === null) {
      delete merged[key]; // 显式清除
    } else {
      merged[key] = value;
    }
  }

  /**
   * 合并后再校验一次：防止「existing 里的脏值 + 合法补丁」产生
   * 一个整体非法的对象。写回去的数据必须整体合法。
   */
  const finalCheck = userSettingsSchema.safeParse(merged);
  if (!finalCheck.success) {
    throw new SettingsValidationError(finalCheck.error.issues);
  }

  const rows = await exec
    .update(users)
    .set({ settings: finalCheck.data, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();

  const updated = rows[0];
  if (!updated) throw new Error(`更新设置失败，用户不存在：${userId}`);
  return updated;
}

/** 设置校验失败。由 API 层映射为 422 */
export class SettingsValidationError extends Error {
  constructor(
    readonly issues: { path: PropertyKey[]; message: string }[]
  ) {
    super('设置内容不合法');
    this.name = 'SettingsValidationError';
  }
}

/** 更新用户的时区（users.timezone 是独立列，不在 settings 里） */
export async function updateTimezone(
  userId: string,
  timezone: string,
  options: ExecutorOption = {}
): Promise<User> {
  const exec = options.executor ?? db;

  const rows = await exec
    .update(users)
    .set({ timezone, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();

  const updated = rows[0];
  if (!updated) throw new Error(`用户不存在：${userId}`);
  return updated;
}
