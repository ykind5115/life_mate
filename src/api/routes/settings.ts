/**
 * Settings 路由（docs/04 §34–§36）
 *
 *   GET   /api/v1/settings
 *   PATCH /api/v1/settings
 *
 * 【安全口径】（docs/04 §49「不返回敏感配置」）
 *   只返回 provider 与 model 这类非敏感标识。
 *   **绝不返回** LLM_API_KEY、DATABASE_URL、LLM_BASE_URL ——
 *   本端点是「读取系统配置」，而那几项是凭据与内部地址。
 */
import type { FastifyInstance } from 'fastify';

import { env } from '../../shared/env.js';
import { getOrCreateDefaultUser } from '../../database/repository/user-store.js';
import {
  DEFAULT_SETTINGS,
  resolveSettings,
  SettingsValidationError,
  updateSettings,
  updateTimezone,
} from '../../conversation/settings-service.js';
import { ok, validationError } from '../errors.js';
import { updateSettingsSchema } from '../schemas.js';

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  // ==========================================================
  // GET /api/v1/settings
  // ==========================================================
  app.get('/settings', async () => {
    const user = await getOrCreateDefaultUser();
    const settings = resolveSettings(user);

    return ok({
      /**
       * 模型标识。docs/04 §34 的响应里有这一项。
       * 只给 provider 名与模型名 —— 不含 base_url、不含 key。
       */
      model: {
        provider: env.LLM_PROVIDER,
        model: env.LLM_MODEL,
      },
      memory: {
        /**
         * 与 resolveSettings 的口径一致：未设置时给缺省值。
         * 这个键前端要用来显示开关状态，因此必须总是有值。
         */
        auto_extract: settings.auto_extract ?? DEFAULT_SETTINGS.auto_extract,
      },
      timezone: user.timezone,
      /**
       * 其余偏好原样返回（未设置的就是未设置，不补缺省）。
       * 前端据此区分「用户选了 gentle」与「还没选过」。
       */
      preferences: {
        ...(settings.display_name !== undefined
          ? { display_name: settings.display_name }
          : {}),
        ...(settings.locale !== undefined ? { locale: settings.locale } : {}),
        ...(settings.response_style !== undefined
          ? { response_style: settings.response_style }
          : {}),
        ...(settings.response_length !== undefined
          ? { response_length: settings.response_length }
          : {}),
        ...(settings.sensitive_memory_local_only !== undefined
          ? { sensitive_memory_local_only: settings.sensitive_memory_local_only }
          : {}),
      },
    });
  });

  // ==========================================================
  // PATCH /api/v1/settings
  // ==========================================================
  app.patch('/settings', async (request) => {
    const body = updateSettingsSchema.parse(request.body);
    let user = await getOrCreateDefaultUser();

    /**
     * 时区是 users 的独立列，不在 settings JSONB 里（§8.3），
     * 因此单独处理。放在同一个 PATCH 里是为了前端只发一次请求。
     *
     * ⚠️ 必须**接住返回值**：updateTimezone 返回更新后的行。
     *    早先这里丢掉了返回值，只传时区时 updated 仍是原始行，
     *    响应里回显的是旧时区（写成功了但告诉你没成功）。
     */
    if (body.timezone !== undefined) {
      user = await updateTimezone(user.id, body.timezone);
    }

    /**
     * 收集要写进 settings 的键。
     * ⚠️ 只有**显式传了**的键才进补丁 —— 没传的保持原值（PATCH 语义）。
     */
    const patch: Record<string, unknown> = {};
    if (body.memory?.auto_extract !== undefined) {
      patch['auto_extract'] = body.memory.auto_extract;
    }
    if (body.response_style !== undefined) patch['response_style'] = body.response_style;
    if (body.response_length !== undefined) patch['response_length'] = body.response_length;
    if (body.display_name !== undefined) patch['display_name'] = body.display_name;
    if (body.locale !== undefined) patch['locale'] = body.locale;

    let updated = user;
    if (Object.keys(patch).length > 0) {
      try {
        updated = await updateSettings(user.id, patch);
      } catch (err) {
        /**
         * 转成 422：这是「调用方传了不合法的设置」，不是服务端故障。
         *
         * 直接抛 HttpError 而不是伪造一个 ZodError ——
         * 后者靠 name/issues 的形状去骗 errorHandler，是脆弱的耦合。
         */
        if (err instanceof SettingsValidationError) {
          throw validationError(
            err.message,
            err.issues.map((i) => ({
              path: i.path.map(String).join('.') || '(root)',
              message: i.message,
            }))
          );
        }
        throw err;
      }
    }

    const settings = resolveSettings(updated);

    return ok({
      timezone: updated.timezone,
      memory: {
        auto_extract: settings.auto_extract ?? DEFAULT_SETTINGS.auto_extract,
      },
      updated_at: updated.updatedAt,
    });
  });
}
