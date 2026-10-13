/**
 * 语音转文字路由（docs/17 §3）
 *
 *   POST /api/v1/transcribe
 *
 * 【职责边界】
 *   只做「音频字节 → 文字」这一件事，而且：
 *     · **不落库**：转写结果是输入草稿，不是内容。
 *       要经过用户确认才会变成一条消息（走现有的 POST /chat/stream），
 *       「记住什么」仍然由抽取流水线按原有规则决定。
 *       用户要的「不需要改造现有记忆系统」就是靠这一点成立的。
 *     · **不自动发送**：本端点只返回文本，发不发由前端与用户决定。
 *
 * 【为什么不引 @fastify/multipart】
 *   只用 multipart 传一个音频文件是杀鸡用牛刀，而本项目对依赖很克制。
 *   改成：正文直接是音频字节，Content-Type 表明格式。
 *   Fastify 的 addContentTypeParser 原生支持，零新增依赖。
 *   代价是不能同时传多个字段 —— 但我们只需要一个音频。
 *
 * 【安全口径】
 *   · 大小与时长都有上限，且**明确拒绝并告知**，不截断后假装完整
 *   · §29.1 禁止记录正文：转写出的文字绝不进日志，只记数字
 *   · 音频不出本机（STT_BASE_URL 指向本地容器）
 */
import type { FastifyInstance } from 'fastify';

import { transcribeAudio, SttError } from '../../llm/stt.js';
import { env } from '../../shared/env.js';
import { parseWav, WavParseError } from '../../shared/wav.js';
import { logError, logInfo } from '../../shared/app-logger.js';
import { badRequest, ok, payloadTooLarge, serviceUnavailable } from '../errors.js';

/** 我们接受的音频类型。目前只有前端自己产出的 WAV */
const ACCEPTED = ['audio/wav', 'audio/wave', 'audio/x-wav'];

export async function registerTranscribeRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 把 audio/* 的正文当原始字节收下来。
   *
   * ⚠️ 必须显式注册，否则 Fastify 会因为不认识这个 Content-Type 而返回 415。
   *    parseAs: 'buffer' 是关键 —— 默认会给字符串，而二进制音频
   *    经字符串转换会损坏（UTF-8 解码会把非法字节替换成 U+FFFD）。
   */
  app.addContentTypeParser(
    ACCEPTED,
    { parseAs: 'buffer', bodyLimit: env.STT_MAX_BYTES },
    (_req, body, done) => {
      done(null, body);
    }
  );

  app.post('/transcribe', async (request) => {
    const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';

    if (!ACCEPTED.includes(contentType)) {
      throw badRequest(
        `不支持的音频格式「${contentType || '(未提供)'}」。` +
          `目前只接受 WAV —— 浏览器录音后会自动转成 16kHz 单声道 WAV。`
      );
    }

    const audio = request.body;
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      throw badRequest('没有收到音频内容');
    }

    /**
     * 大小上限。
     *
     * Fastify 的 bodyLimit 已经会在更早的地方拒绝超大请求，
     * 这里再查一次是为了给出**说人话**的错误 ——
     * bodyLimit 触发时返回的是框架自己的 413 文案。
     */
    if (audio.length > env.STT_MAX_BYTES) {
      throw payloadTooLarge(
        `录音太大了（${formatMb(audio.length)}，上限 ${formatMb(env.STT_MAX_BYTES)}）。说短一点，或者分几次说。`
      );
    }

    // 解析 WAV 头：既确认格式可用，也拿到时长
    let info;
    try {
      info = parseWav(audio);
    } catch (err) {
      if (err instanceof WavParseError) throw badRequest(`音频无法识别：${err.message}`);
      throw err;
    }

    /**
     * 时长上限。
     *
     * ⚠️ 超限时**拒绝**而不是截断 ——
     *    截断后 Whisper 会对着半句话输出一段看似合理的文本，
     *    而用户以为那就是自己说的全部。
     */
    if (info.durationSeconds > env.STT_MAX_SECONDS) {
      throw payloadTooLarge(
        `这段录音 ${Math.round(info.durationSeconds)} 秒，超过了 ${env.STT_MAX_SECONDS} 秒的上限。` +
          `分几次说吧 —— 那样转错了也容易改。`
      );
    }

    try {
      const result = await transcribeAudio({ audio, filename: 'speech.wav' });

      /**
       * 只记数字，不记文本（§29.1）。
       * 这些数字是排查「怎么转得这么慢 / 怎么没听清」的唯一线索。
       */
      logInfo(
        {
          durationSeconds: Number(info.durationSeconds.toFixed(1)),
          sampleRate: info.sampleRate,
          bytes: audio.length,
          elapsedMs: result.elapsedMs,
          textChars: result.text.length,
          model: result.model,
          requestId: request.id,
        },
        '语音转写完成'
      );

      return ok({
        text: result.text,
        /**
         * 让前端知道「这段录音多长时间、转写花了多久」。
         * 用户据此判断「是不是我话说太长了导致漏字」。
         */
        duration_seconds: Number(info.durationSeconds.toFixed(2)),
        elapsed_ms: result.elapsedMs,
        model: result.model,
        /** 空文本是一个合法结果（没人说话 / 只有环境噪音），前端要区别对待 */
        empty: result.text.length === 0,
      });
    } catch (err) {
      if (err instanceof SttError) {
        logError(
          { status: err.options.status, retryable: err.options.retryable, requestId: request.id },
          '语音转写失败'
        );
        // 服务不可达是 503（可重试），其余按 400 处理（这次的音频不行）
        if (err.options.status === undefined) throw serviceUnavailable(err.message);
        throw badRequest(err.message);
      }
      throw err;
    }
  });

  /**
   * GET /transcribe/status —— 前端用它决定要不要显示麦克风按钮。
   *
   * 【为什么需要它】语音是**可选的输入方式**。
   *   STT 容器没起来时，界面应该干脆不显示麦克风，
   *   而不是让用户点一下、等半天、再报错。
   */
  app.get('/transcribe/status', async () => {
    try {
      const res = await fetch(`${env.STT_BASE_URL}/docs`, {
        signal: AbortSignal.timeout(3000),
      });
      return ok({ available: res.ok, model: env.STT_MODEL, max_seconds: env.STT_MAX_SECONDS });
    } catch {
      return ok({ available: false, model: env.STT_MODEL, max_seconds: env.STT_MAX_SECONDS });
    }
  });
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
