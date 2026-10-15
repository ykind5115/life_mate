/**
 * 端到端验证：合成中文语音 → 我们的 /api/v1/transcribe → 看返回
 *
 * 【为什么这一步不能省】
 *   前面所有测试用的都是「合法 WAV + 假内容」，只证明校验逻辑对。
 *   真正的问题是「一条真人说的话走完整链路能不能变成正确的文字」——
 *   那需要真语音。
 *
 *   做法与 audit/probe-asr3.ts 相同（Windows TTS 合成中文），
 *   但这次打的是**我们自己的接口**，因此同时覆盖：
 *     multipart 上传 → WAV 解析 → 时长校验 → 调 Whisper → 溢出比判据 → 响应
 *
 * 运行（服务需已启动）：npx tsx audit/verify-stt-e2e.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = process.env['LIFEMATE_API'] ?? 'http://127.0.0.1:2003';

function synthesize(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lm-e2e-'));
  const out = join(dir, 'tts.wav');
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$s.SelectVoice('Microsoft Huihui Desktop')",
    `$s.SetOutputToWaveFile('${out.replace(/\\/g, '\\\\')}')`,
    `$s.Speak('${text}')`,
    '$s.Dispose()',
  ].join('; ');
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'pipe' });
  return out;
}

/** 转成 16kHz 单声道 16bit WAV —— 与浏览器 recorder.js 做的事一致 */
function toWav16kMono(path: string): Buffer {
  const src = readFileSync(path);
  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  let dataStart = 0;
  let dataLen = 0;
  while (offset + 8 <= src.length) {
    const id = src.toString('ascii', offset, offset + 4);
    const size = src.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: src.readUInt16LE(body + 2),
        sampleRate: src.readUInt32LE(body + 4),
        bits: src.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataStart = body;
      dataLen = Math.min(size, src.length - body);
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || fmt.bits !== 16) throw new Error('TTS 输出格式不符合预期');

  const srcFrames = Math.floor(dataLen / 2 / fmt.channels);
  const ratio = fmt.sampleRate / 16_000;
  const outFrames = Math.floor(srcFrames / ratio);
  const out = Buffer.alloc(44 + outFrames * 2);

  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + outFrames * 2, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16_000, 24);
  out.writeUInt32LE(32_000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(outFrames * 2, 40);

  for (let i = 0; i < outFrames; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(srcFrames - 1, i0 + 1);
    const frac = srcPos - i0;
    const s0 = src.readInt16LE(dataStart + i0 * 2 * fmt.channels);
    const s1 = src.readInt16LE(dataStart + i1 * 2 * fmt.channels);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), 44 + i * 2);
  }
  return out;
}

/** 造静音 WAV，用来验证「编造检测」在真实链路上生效 */
function silenceWav(seconds: number): Buffer {
  const n = Math.round(seconds * 16_000);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16_000, 24);
  buf.writeUInt32LE(32_000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  return buf;
}

async function send(wav: Buffer, label: string): Promise<void> {
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');

  const started = Date.now();
  const res = await fetch(`${API}/api/v1/transcribe`, { method: 'POST', body: form });
  const body = await res.text();
  const ms = Date.now() - started;

  console.log(`\n═══ ${label} ═══`);
  console.log(`HTTP ${res.status}   ${ms}ms`);

  let json: { data?: Record<string, unknown>; error?: { message?: string } };
  try {
    json = JSON.parse(body) as typeof json;
  } catch {
    console.log(`非 JSON：${body.slice(0, 200)}`);
    return;
  }

  if (res.status !== 200) {
    console.log(`错误：${json.error?.message}`);
    return;
  }

  const d = json.data!;
  console.log(`text        = ${JSON.stringify(d['text'])}`);
  console.log(`时长        = ${d['duration_seconds']}s（我们自己解析的）`);
  console.log(`耗时        = ${d['elapsed_ms']}ms`);
  console.log(`语种        = ${d['language']}`);
  console.log(`empty       = ${d['empty']}`);
  console.log(`suspicious  = ${d['suspicious']}`);
  if (d['suspicion_reason']) console.log(`原因        = ${d['suspicion_reason']}`);
  if (d['模型'] === undefined) console.log(`model       = ${d['model'] ?? '(未返回)'}`);
}

// 先确认服务在
try {
  const h = await fetch(`${API}/health`);
  if (!h.ok) throw new Error(`HTTP ${h.status}`);
} catch (err) {
  console.error(`连不上 ${API} —— 先起服务（pnpm dev）。${err instanceof Error ? err.message : ''}`);
  process.exit(1);
}

const st = (await (await fetch(`${API}/api/v1/transcribe/status`)).json()) as {
  data: { available: boolean; model: string; max_seconds: number };
};
console.log(`STT 状态：available=${st.data.available}  model=${st.data.model}  上限=${st.data.max_seconds}s`);
if (!st.data.available) {
  console.error('STT 服务不可用 —— 先 docker compose up -d stt');
  process.exit(1);
}

// ============================================================
// ① 真实中文语音（最重要的一条）
// ============================================================
const sentences = [
  '今天加班到很晚，回到家已经十一点了',
  '我终于把那个问题解决了，特别开心',
];
const temps: string[] = [];
for (const [i, text] of sentences.entries()) {
  console.log(`\n${'─'.repeat(66)}`);
  console.log(`合成语音 ${i + 1}：${text}`);
  const p = synthesize(text);
  temps.push(p);
  await send(toWav16kMono(p), `真实中文语音 ${i + 1}`);
}

// ============================================================
// ② 静音 —— 验证编造检测在真实链路上生效
// ============================================================
console.log(`\n${'─'.repeat(66)}`);
console.log('这一条是安全检查：静音不该变成一句「看起来像人话」的文本而不被标记');
await send(silenceWav(2), '静音 2 秒');

// ============================================================
// ③ 太短 —— 验证输入问题返回 400 而不是 503
// ============================================================
console.log(`\n${'─'.repeat(66)}`);
await send(silenceWav(0.3), '过短录音 0.3 秒（应当 400 且说「太短」）');

for (const p of temps) {
  try {
    unlinkSync(p);
  } catch {
    /* 忽略 */
  }
}
process.exit(0);
