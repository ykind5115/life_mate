/**
 * WAV 解析与编码的测试（docs/17 §3）
 *
 * 【为什么这段逻辑值得单独测】
 *   它是「浏览器录的音频」与「Whisper 期望的输入」之间唯一的校验点。
 *   解析错了的后果不是报错，而是**静默的坏结果**：
 *     · 时长算错 → 要么误拒一段合法录音，要么放过 20 分钟的录音
 *     · 格式判断漏了 → 把非 PCM 的字节喂给 Whisper，
 *       它会对着噪音吐出一段**看着像文本的幻觉**
 *
 *   而且这两份编码实现（浏览器侧、Node 侧）必须产出**字节一致**的布局，
 *   否则服务端解析不了前端上传的音频 —— 那是最难查的一类故障：
 *   两边各自单测都过，合起来不通。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeWav16kMono, parseWav, WavParseError } from './wav.js';

/** 造一段静音，时长由采样数决定 */
function silence(seconds: number, sampleRate = 16_000): Float32Array {
  return new Float32Array(Math.round(seconds * sampleRate));
}

/** 造一段正弦波，用来验证量化没写反 */
function tone(seconds: number, freq = 440, sampleRate = 16_000): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.5;
  return out;
}

// ============================================================
// 正常路径
// ============================================================

test('解析自己编出来的 WAV：格式与时长都对', () => {
  const wav = encodeWav16kMono(silence(2));
  const info = parseWav(wav);

  assert.equal(info.sampleRate, 16_000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  // 2 秒 × 16000 × 2 字节
  assert.equal(info.dataBytes, 64_000);
  assert.equal(Math.round(info.durationSeconds), 2);
});

test('时长按实际采样数算，不是按文件大小猜', () => {
  for (const seconds of [0.5, 1, 3.25, 10]) {
    const info = parseWav(encodeWav16kMono(silence(seconds)));
    assert.ok(
      Math.abs(info.durationSeconds - seconds) < 0.05,
      `${seconds} 秒的录音算出来是 ${info.durationSeconds} 秒`
    );
  }
});

test('量化方向正确：正弦波解出来还是正弦波（不是静音也不是噪音）', () => {
  /**
   * 量化写反（比如用 setUint16 而不是 setInt16）的后果是
   * 波形变成全正或全负 —— 单看时长和格式都发现不了，
   * 但 Whisper 拿到之后会输出垃圾。
   */
  const wav = encodeWav16kMono(tone(0.1));
  const info = parseWav(wav);
  assert.equal(info.dataBytes, Math.round(0.1 * 16_000) * 2);

  // 直接读回 PCM 采样，确认有正有负
  let min = 0;
  let max = 0;
  for (let offset = 44; offset + 1 < wav.length; offset += 2) {
    const s = wav.readInt16LE(offset);
    if (s < min) min = s;
    if (s > max) max = s;
  }
  assert.ok(min < 0, `应当有负采样值，实际最小 ${min}`);
  assert.ok(max > 0, `应当有正采样值，实际最大 ${max}`);

  /**
   * 振幅 0.5 → 0.5 × 32767 ≈ 16383.5，四舍五入到 16384。
   * 断言范围要容下这个取整，不能写死 16383。
   */
  assert.ok(max >= 16_300 && max <= 16_400, `振幅应当在 0.5 附近，实际 ${max}`);
  assert.ok(min <= -16_300 && min >= -16_400, `负半周振幅应当在 0.5 附近，实际 ${min}`);
});

test('不同采样率下时长都算对（夹具要按该采样率造采样）', () => {
  /**
   * ⚠️ 这条第一版写错了：用 silence(1) 造样本，
   *    而 silence() 固定按 16kHz 生成 16000 个采样 ——
   *    却在 8kHz 下编码，于是得到的是 **2 秒**音频。
   *    夹具与断言必须用同一个采样率，否则测的是别的东西。
   */
  for (const rate of [8000, 44_100, 48_000]) {
    const samples = new Float32Array(rate); // 该采样率下的 1 秒
    const info = parseWav(encodeWav16kMono(samples, rate));

    assert.equal(info.sampleRate, rate);
    assert.ok(
      Math.abs(info.durationSeconds - 1) < 0.01,
      `${rate}Hz 下 1 秒被算成 ${info.durationSeconds} 秒`
    );
  }
});

// ============================================================
// 拒收路径 —— 这些是「宁可拒绝，也不要喂给 Whisper 猜」
// ============================================================

test('不是 RIFF/WAVE 的字节被拒绝', () => {
  const notWav = Buffer.from('这不是音频，只是一段文字内容而已，长度够长够长够长够长够长');
  assert.throws(() => parseWav(notWav), WavParseError);
});

test('太短的输入被拒绝（而不是读到越界）', () => {
  assert.throws(() => parseWav(Buffer.alloc(10)), /太短/);
  assert.throws(() => parseWav(Buffer.alloc(0)), WavParseError);
});

test('非 PCM 格式被拒绝', () => {
  /**
   * 格式码 3 = IEEE float。我们自己的编码器不会产出它，
   * 但别的工具会 —— 放过去就等于把「没预期的输入」交给 Whisper。
   */
  const wav = encodeWav16kMono(silence(0.1));
  wav.writeUInt16LE(3, 20); // audioFormat 改成 float
  assert.throws(() => parseWav(wav), /PCM/);
});

test('声道数异常被拒绝', () => {
  const wav = encodeWav16kMono(silence(0.1));
  wav.writeUInt16LE(6, 22); // 6 声道
  assert.throws(() => parseWav(wav), /声道/);
});

test('采样率异常被拒绝', () => {
  const wav = encodeWav16kMono(silence(0.1));
  wav.writeUInt32LE(200, 24); // 200Hz
  assert.throws(() => parseWav(wav), /采样率/);
});

test('位深异常被拒绝', () => {
  const wav = encodeWav16kMono(silence(0.1));
  wav.writeUInt16LE(24, 34); // 24 位
  assert.throws(() => parseWav(wav), /位深/);
});

test('缺 fmt 块被拒绝', () => {
  const wav = encodeWav16kMono(silence(0.1));
  // 把 fmt 的 chunk id 改掉，让它找不到
  wav.write('junk', 12, 'ascii');
  assert.throws(() => parseWav(wav), /fmt/);
});

test('缺 data 块被拒绝', () => {
  const wav = encodeWav16kMono(silence(0.1));
  wav.write('junk', 36, 'ascii');
  assert.throws(() => parseWav(wav), /data/);
});

test('被截断的 WAV：时长按实际剩下的字节算，不按声明值', () => {
  /**
   * 录音被中途打断时就是这个形状：data 块声明的长度大于实际内容。
   *
   * ⚠️ 若按声明值算时长，会报告一个比实际更长的时长 ——
   *    那会误导「这段录音到底说了多久」，也可能让一段其实很短的
   *    录音被误判成超过上限。
   */
  const full = encodeWav16kMono(silence(4));
  const truncated = full.subarray(0, 44 + 16_000); // 只留 0.5 秒的数据

  const info = parseWav(Buffer.from(truncated));
  assert.ok(
    Math.abs(info.durationSeconds - 0.5) < 0.05,
    `截断后应当算出约 0.5 秒，实际 ${info.durationSeconds}`
  );
});

test('钳位生效：超出 [-1,1] 的采样不会溢出成噪音', () => {
  /**
   * Float32 里出现 >1 的值是可能的（增益处理之后）。
   * 不钳位的话 Math.round(s * 32767) 会溢出 int16，
   * 回绕成反相的尖峰 —— 听起来是刺耳的噪音。
   */
  const loud = new Float32Array([2.0, -2.0, 1.5, -1.5, 0]);
  const wav = encodeWav16kMono(loud);

  const values: number[] = [];
  for (let offset = 44; offset + 1 < wav.length; offset += 2) {
    values.push(wav.readInt16LE(offset));
  }

  assert.deepEqual(values.slice(0, 2), [32767, -32767], '超界值应当被钳到极值，而不是回绕');
  assert.ok(
    values.every((v) => v >= -32768 && v <= 32767),
    '所有采样都必须在 int16 范围内'
  );
});

test('空音频（0 采样）也能解析，时长是 0 而不是 NaN', () => {
  const info = parseWav(encodeWav16kMono(new Float32Array(0)));
  assert.equal(info.dataBytes, 0);
  assert.ok(Number.isFinite(info.durationSeconds));
  assert.equal(info.durationSeconds, 0);
});
