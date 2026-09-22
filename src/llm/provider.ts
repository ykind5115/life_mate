/**
 * LLM Provider 抽象（架构 §34）
 *
 * 设计目标：业务代码不绑定任何一家模型厂商。
 *
 *   Agent Core
 *        │
 *        ▼
 *   LLMProvider 接口   ← 本文件
 *        │
 *        ├── DeepSeekProvider            （V1.0 使用）
 *        └── OpenAICompatibleProvider    （其他兼容厂商）
 *
 * ⚠️ 接口刻意保持最小：只暴露 Agent Loop 真正需要的两件事（生成 / 流式生成）。
 *    不把厂商特有的参数（reasoning_effort、top_k 等）泄漏进来，
 *    否则换厂商时 Agent Core 就要改。
 */
import type { LLMMessage, LLMGenerateResult, LLMStreamChunk } from './types.js';

export interface GenerateInput {
  /** 完整对话历史（含 system），由 Context Builder 组装 */
  messages: LLMMessage[];
  /** 可选工具定义（OpenAI function-calling 格式） */
  tools?: LLMToolDefinition[];
  /** 覆盖默认模型（用于实验对比） */
  model?: string;
  /**
   * ⚠️ 采样温度。
   *
   * 【实测警告】DeepSeek 的**思考模式不支持 temperature**
   * （官方文档：「思考模式不支持 temperature、presence_penalty、
   *   frequency_penalty 参数。为了兼容已有软件，设置参数不会报错，
   *   但也不会生效。」）。
   *
   * 由于思考模式默认开启（effort=high），默认情况下传这个参数是**无效**的。
   * 若确实需要 temperature 生效，必须显式设置 thinking: { type: 'disabled' }。
   */
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * 思考模式控制（实测：2026-09-22，与官方文档一致）。
   *
   * - { type: 'enabled' }  默认行为，先输出思维链再回答
   * - { type: 'disabled' } 直接回答，无 reasoning_content，reasoningTokens=0
   *
   * 何时该关：简单任务（如给标签分类、格式转换）不需要思考，
   * 关闭可省 token、降延迟；复杂任务（抽取判定、冲突裁决）保留思考更准。
   *
   * ⚠️ 不要用 enable_thinking / chat_template_kwargs 等参数名 ——
   *    实测这些会被静默忽略、思考照常发生（错误参数名不报错）。
   */
  thinking?: { type: 'enabled' | 'disabled' };
  /**
   * 思考强度。官方支持 'low' | 'high' | 'max'。
   * 亦可用 'none' 关闭思考（等价于 thinking.type='disabled'）。
   *
   * 默认 effort 为 high，因此不设置时推理开销较大。
   */
  reasoningEffort?: 'none' | 'low' | 'high' | 'max';
  /** 中止信号。用户断开 SSE 时必须能中止上游请求，避免白花钱 */
  signal?: AbortSignal;
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  /** JSON Schema */
  parameters: Record<string, unknown>;
}

export interface LLMProvider {
  /** 厂商标识，用于日志与调试（不参与业务判断） */
  readonly providerName: string;

  /** 默认模型标识 */
  readonly defaultModel: string;

  /** 一次性生成（Agent Loop 内部使用） */
  generate(input: GenerateInput): Promise<LLMGenerateResult>;

  /**
   * 流式生成。
   *
   * 逐个产出增量块，最后一块 type='done' 携带完整结果与用量。
   * 实现必须保证：
   *   ① 收到 abort 时尽快停止并向上游发起取消
   *   ② 中途错误以 type='error' 块产出，而不是抛异常穿透
   *      （SSE 已经发出 200 头，无法再改状态码）
   */
  stream(input: GenerateInput): AsyncIterable<LLMStreamChunk>;
}

/** 统一的 Provider 错误类型。区分「可重试」与「不可重试」 */
export class LLMError extends Error {
  constructor(
    message: string,
    readonly options: {
      /** 是否值得重试（超时/限流/5xx 为 true；参数错误/鉴权失败为 false） */
      retryable: boolean;
      /** HTTP 状态码，若有 */
      status?: number;
      /** 厂商原始错误码，仅用于日志，不暴露给用户（架构 §39） */
      providerCode?: string;
    }
  ) {
    super(message);
    this.name = 'LLMError';
  }
}
