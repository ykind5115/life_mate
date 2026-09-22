/**
 * LLM Provider 工厂（架构 §34）
 *
 * 业务代码只依赖 LLMProvider 接口，通过本工厂获取实例。
 * 更换厂商时只改配置（.env），不改 Agent Core。
 */
import { env } from '../shared/env.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { LLMProvider } from './provider.js';

let cached: LLMProvider | undefined;

export function getLLMProvider(): LLMProvider {
  if (cached) return cached;

  // 目前所有受支持的厂商都走 OpenAI 兼容协议，
  // 因此只有配置差异，没有实现差异。
  cached = new OpenAICompatibleProvider({
    providerName: env.LLM_PROVIDER,
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    defaultModel: env.LLM_MODEL,
    timeoutMs: env.LLM_TIMEOUT_MS,
  });

  return cached;
}

/** 仅供测试使用：清空缓存以便换配置重建 */
export function resetLLMProvider(): void {
  cached = undefined;
}
