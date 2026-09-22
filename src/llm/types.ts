/**
 * LLM 相关的共享类型
 *
 * 用 OpenAI 的 message 结构作为内部统一表示 —— 它是事实标准，
 * DeepSeek / Qwen / OpenAI 都兼容，换厂商时不需要转换层。
 */

export type LLMRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LLMMessage {
  role: LLMRole;
  /** 文本内容。tool 角色时为工具执行结果 */
  content: string;
  /** assistant 请求调用工具时携带 */
  toolCalls?: LLMToolCall[];
  /** role='tool' 时，指明回应的是哪次工具调用 */
  toolCallId?: string;
}

export interface LLMToolCall {
  /** 厂商给出的调用 id，回传工具结果时必须带上 */
  id: string;
  name: string;
  /** 原始 JSON 字符串。解析失败必须显式报错，不得静默当作空对象 */
  arguments: string;
}

export interface LLMTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMGenerateResult {
  content: string;
  toolCalls: LLMToolCall[];
  usage: LLMTokenUsage;
  /** 实际使用的模型，用于日志与可观测性（架构 §38） */
  model: string;
  /**
   * 结束原因。'length' 表示被输出上限截断 —— 调用方必须区别对待，
   * 不能把截断的半句话当作完整回答。
   */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown';
}

export type LLMStreamChunk =
  | { type: 'token'; content: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'done'; result: LLMGenerateResult }
  | { type: 'error'; error: string; retryable: boolean };
