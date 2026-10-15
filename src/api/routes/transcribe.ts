/**
 * 语音转文字路由（docs/17 §3）
 *
 *   POST /api/v1/transcribe        音频 → 文字
 *   GET  /api/v1/transcribe/status 服务是否可用（前端据此决定显不显示麦克风）
 *
 * 【职责边界】
 *   只做「音频字节 → 文字」这一件事，而且：
 *     · **不落库**：转写结果是输入草稿，不是内容。
 *       要经过用户确认才会变成一条消息（走现有的 POST /chat/stream），
 *       「记住什么」仍然由抽取流水线按原有规则决定。
 *     · **不自动发送**：本端点只返回文本，发不发由前端与用户决定。
 *
 *   ⚠️ 「不自动发送」不是出于礼貌 —— 它是**防止垃圾进记忆**的机制：
 *      Whisper 对非语音会编造内容（静音会被写成一句电视剧台词，
 *      实测见 llm/stt.ts 的文件头）。用户确认那一步是最后一道闸。
 *
 * 【为什么用 @fastify/multipart（本项目第二个 Fastify 官方插件）】
 *   最初为了不加依赖，设计成「正文直接是音频字节 + Content-Type」，
 *   但**实测发现上游要求 multipart**：
 *      POST /asr 用原始字节 → HTTP 422 {"loc":["body","audio_file"],
 *                                        "msg":"Field required"}
 *   于是要么自己解析 multipart（容易写错、而且是安全敏感的代码），
 *   要么用官方插件。选了后者：
 *     · 与 @fastify/static 同一世代（v10，Fastify 5 时代）
 *     · 它管住了文件大小上限与流式读取，那些自己写更容易出错
 *   代价是多一个依赖 —— 但这次是**实测逼出来的**，不是图省事。
 *
 * 【安全口径】
 *   · 大小与时长都有上限，且**明确拒绝并告知**，不截断后假装完整
 *   · §29.1 禁止记录正文：转写出的文字绝不进日志，只记数字
 *   · 音频不出本机（STT_BASE_URL 指向本地容器）
 */
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';

import { transcribeAudio, SttError, probeStt } from '../../llm/stt.js';
import { env } from '../../shared/env.js';
import { parseWav, WavParseError } from '../../shared/wav.js';
import { logError, logInfo } from '../../shared/app-logger.js';
import { badRequest, ok, payloadTooLarge, serviceUnavailable } from '../errors.js';

/** 表单字段名。与前端 public/app.js 约定 */
const AUDIO_FIELD = 'audio';

export async function registerTranscribeRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 只接受一个文件字段，并设好大小上限。
   *
   * ⚠️ limits.fileSize 是对**单个文件**的限制，超了插件会抛
   *    FST_REQ_FILE_TOO_LARGE。下面把它翻译成人话。
   */
  await app.register(multipart, {
    limits: { fileSize: env.STT_MAX_BYTES, files: 1, fields: 0 },
  });

  app.post('/transcribe', async (request) => {
    if (!request.isMultipart()) {
      throw badRequest(
        `这个接口要 multipart/form-data，字段名 ${AUDIO_FIELD}。浏览器录音后会自动按这个格式上传。`
      );
    }

    let part;
    try {
      part = await request.file();
    } catch (err) {
      if (isFileTooLarge(err)) throw tooLargeError();
      throw err;
    }

    if (!part) throw badRequest(`没有收到音频（表单里缺少 ${AUDIO_FIELD} 字段）`);

    /**
     * 读完整段音频。
     * ⚠️ toBuffer() 在超过 fileSize 时也会抛 —— 它同时是第二道大小检查。
     */
    let audio: Buffer;
    try {
      audio = await part.toBuffer();
    } catch (err) {
      if (isFileTooLarge(err)) throw tooLargeError();
      throw err;
    }

    if (audio.length === 0) throw badRequest('没有收到音频内容');

    /**
     * 解析 WAV 头：既确认格式可用，也拿到**真实时长**。
     *
     * ⚠️ 时长必须来自我们自己解析的结果，不能信服务返回的 ——
     *    溢出的那个值正是可能被编造出来的（见 llm/stt.ts 的实测表）。
     */
    let info;
    try {
      info = parseWav(audio);
    } catch (err) {
      if (err instanceof WavParseError) throw badRequest(`音频无法识别：${err.message}`);
      throw err;
    }

    /**
     * 时长上限：**拒绝**而不是截断。
     *
     * 截断后 Whisper 会对着半句话输出一段看似合理的文本，
     * 而用户以为那就是自己说的全部。
     */
    if (info.durationSeconds > env.STT_MAX_SECONDS) {
      throw payloadTooLarge(
        `这段录音 ${Math.round(info.durationSeconds)} 秒，超过了 ${env.STT_MAX_SECONDS} 秒的上限。` +
          `分几次说吧 —— 那样转错了也容易改。`
      );
    }

    try {
      const result = await transcribeAudio({ audio, audioSeconds: info.durationSeconds });

      /**
       * 只记数字，不记文本（§29.1）。
       * textChars 是有用的信号：为 0 说明真的没人说话。
       */
      logInfo(
        {
          durationSeconds: Number(info.durationSeconds.toFixed(1)),
          bytes: audio.length,
          elapsedMs: result.elapsedMs,
          textChars: result.text.length,
          language: result.language,
          suspicious: result.suspicious,
          requestId: request.id,
        },
        '语音转写完成'
      );

      return ok({
        text: result.text,
        /** 音频真实时长（我们自己解析的），前端用来显示「你说了多久」 */
        duration_seconds: Number(info.durationSeconds.toFixed(2)),
        elapsed_ms: result.elapsedMs,
        language: result.language,
        /** 实际使用的模型标识（仅用于显示与日志） */
        model: result.model,
        /** 空文本是合法结果（没人说话），前端要区别对待 */
        empty: result.text.length === 0,
        /**
         * 疑似编造。前端据此提示用户仔细核对，但**不阻止使用**。
         * 只给原因，不含正文。
         */
        suspicious: result.suspicious,
        suspicion_reason: result.suspicionReason,
      });
    } catch (err) {
      if (err instanceof SttError) {
        logError(
          {
            kind: err.options.kind,
            ...(err.options.status !== undefined ? { upstreamStatus: err.options.status } : {}),
            requestId: request.id,
          },
          '语音转文字失败'
        );

        /**
         * 按**失败种类**映射状态码。
         *
         * ⚠️ 这里最初写错了：把所有没有上游状态码的错误都当成 503（服务不可用）。
         *    于是「录音只有 0.2 秒，太短了」也返回 503 ——
         *    用户看到「服务暂不可用，稍后再试」，而重试一百次都一样。
         *    输入问题必须与故障分开，否则用户会去查一个根本不存在的故障。
         */
        if (err.options.kind === 'input') throw badRequest(err.message);
        throw serviceUnavailable(err.message);
      }
      throw err;
    }
  });

  // ==========================================================
  // GET /api/v1/transcribe/status
  // ==========================================================
  /**
   * 前端用它决定要不要显示麦克风按钮。
   *
   * 【为什么需要它】语音是**可选的输入方式**。STT 容器没起来时，
   *   界面应该干脆不显示麦克风，而不是让用户点一下、等半天、再报错。
   *
   * ⚠️ 这个端点**永远返回 200**，可用性放在 available 字段里 ——
   *    它不该因为下游没起来而自己也变成错误。
   */
  app.get('/transcribe/status', async () => {
    const available = await probeStt();
    return ok({ available, model: env.STT_MODEL, max_seconds: env.STT_MAX_SECONDS });
  });
}

function tooLargeError() {
  return payloadTooLarge(
    `录音太大了（上限 ${formatMb(env.STT_MAX_BYTES)}）。说短一点，或者分几次说。`
  );
}

/** 判断是不是「文件太大」（插件把错误码放在 message 里） */
function isFileTooLarge(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.message.includes('FST_REQ_FILE_TOO_LARGE') ||
    err.message.toLowerCase().includes('file too large') ||
    (err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE'
  );
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
