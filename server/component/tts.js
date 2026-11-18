// MiniMax 流式 TTS → 组件版要求的 PCM（24000Hz / s16le / mono）
//
// 组件版没有平台 TTS，声音完全由我们合成后切帧喂给 WS 二进制帧。
// 音色用 yangmitest1（cyber 项目里已验证的克隆音色）。

import { getPersona } from '../personas.js';

const BASE = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com';
const MODEL = process.env.MINIMAX_MODEL || 'speech-2.8-turbo';
const DEFAULT_VOICE = process.env.MINIMAX_VOICE || 'yangmitest1';
const VOICE = DEFAULT_VOICE;
// 音色按人设取 personas.js 里登记的 voiceEnv（安妮两个分身共用 ANNE_VOICE），
// 不再用 persona.toUpperCase() 拼——anne_girlfriend 会拼成 ANNE_GIRLFRIEND_VOICE，
// 结果女友版又变回杨幂的音色。
export function voiceFor(persona) {
  let key = '';
  try { key = getPersona(persona).voiceEnv || ''; } catch { /* 未知人设走默认 */ }
  const v = key ? process.env[key] : '';
  return v && v.trim() ? v.trim() : DEFAULT_VOICE;
}
const SAMPLE_RATE = 24000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000; // 48

export const AUDIO = { sampleRate: SAMPLE_RATE, bytesPerMs: BYTES_PER_MS };

function key() {
  const k = process.env.MINIMAX_API_KEY;
  if (!k) throw new Error('MINIMAX_API_KEY 未设置');
  return k;
}

function pcmBuffer(hex) {
  // MiniMax 返回 hex 编码的音频；按 24k/s16le/mono 直接可用
  return Buffer.from(hex || '', 'hex');
}

// 合成一句话，返回整段 PCM。带重试：TTS 偶发超时会拖垮整轮回复。
export async function synth(text, { speed, voice, timeoutMs = 20000 } = {}) {
  const body = {
    model: MODEL,
    text,
    stream: false,
    voice_setting: { voice_id: voice || VOICE, speed: Number(speed ?? process.env.MINIMAX_SPEED ?? 1.0), vol: 1.0, pitch: 0 },
    audio_setting: { sample_rate: SAMPLE_RATE, format: 'pcm', channel: 1, bitrate: 128000 },
  };
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const r = await fetch(`${BASE}/v1/t2a_v2`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      clearTimeout(timer);
      const json = await r.json();
      if (json?.base_resp?.status_code && json.base_resp.status_code !== 0) {
        throw new Error(`MiniMax ${json.base_resp.status_code}: ${json.base_resp.status_msg}`);
      }
      const pcm = pcmBuffer(json?.data?.audio);
      if (!pcm.length) throw new Error('MiniMax 返回空音频');
      return pcm;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

export const durationOf = (pcm) => Math.round(pcm.length / BYTES_PER_MS);

// 按 chunkMs 切片。切完直接发，节奏由 TTS 合成速度决定，这里只负责切。
export function* chunks(pcm, chunkMs = 100) {
  const step = Math.max(BYTES_PER_MS * 10, BYTES_PER_MS * chunkMs);
  for (let i = 0; i < pcm.length; i += step) {
    yield pcm.subarray(i, Math.min(i + step, pcm.length));
  }
}

// ---------- 流式合成 ----------
// 非流式要等整句合成完（实测首句 1129ms），流式首块只要 484ms。
// MiniMax 用 SSE 返回，每帧 data.audio 是一段 hex 编码的 PCM。
// onAudio 会被 await：读 SSE 的节奏由消费方决定（现在是入队即返回，全速读）。
export async function synthStream(text, { onAudio, speed, voice, timeoutMs = 20000 } = {}) {
  const body = {
    model: MODEL,
    text,
    stream: true,
    voice_setting: { voice_id: voice || VOICE, speed: Number(speed ?? process.env.MINIMAX_SPEED ?? 1.0), vol: 1.0, pitch: 0 },
    audio_setting: { sample_rate: SAMPLE_RATE, format: 'pcm', channel: 1, bitrate: 128000 },
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let total = 0;
  let gotDelta = false;          // 是否收到过 status=1 的增量分片
  let finalChunk = null;         // status=2 的完整音频（仅在没有分片时兜底）
  try {
    const r = await fetch(`${BASE}/v1/t2a_v2`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }
        const code = j.base_resp?.status_code;
        if (code && code !== 0) throw new Error(`MiniMax ${code}: ${j.base_resp.status_msg}`);
        const hex = j.data?.audio;
        if (!hex) continue;
        const b = Buffer.from(hex, 'hex');
        if (!b.length) continue;
        // ⚠ 关键：MiniMax 流式返回里，status=1 是增量分片，status=2 是"整段音频的
        // 完整重复"（实测两者字节数完全相等）。两批都追加 = 同一句话被说两遍。
        // 所以只取 status=1 的增量；只有在压根没收到分片时才退回用 status=2。
        const status = j.data?.status;
        if (status === 2) { finalChunk = b; continue; }
        gotDelta = true;
        total += b.length;
        if (onAudio) await onAudio(b);
      }
    }
  } finally {
    clearTimeout(timer);
  }
  // 一个分片都没收到：退回用 status=2 的完整音频，保证有声音
  if (!gotDelta && finalChunk && finalChunk.length) {
    total += finalChunk.length;
    if (onAudio) await onAudio(finalChunk);
  }
  if (!total) throw new Error('TTS 返回空音频');
  return total;
}

// ---------- 静音裁剪 ----------
// 实测每句 TTS 自带 ~220ms 前导静音和 ~250ms 尾部静音。
// 句子直接拼接 → 句间约 450ms 空白，听感就是"卡一下"。
const SILENCE = Number(process.env.TTS_SILENCE_LEVEL || 300); // 约满量程的 0.9%

function firstLoud(pcm, threshold = SILENCE, from = 0) {
  const n = pcm.length >> 1;
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, n);
  for (let i = from; i < n; i += 1) if (Math.abs(s[i]) >= threshold) return i;
  return -1;
}

function lastLoud(pcm, threshold = SILENCE) {
  const n = pcm.length >> 1;
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, n);
  for (let i = n - 1; i >= 0; i -= 1) if (Math.abs(s[i]) >= threshold) return i;
  return -1;
}

// 裁前导静音，保留 keepMs 余量避免削掉字头
export function trimLeading(pcm, { threshold = SILENCE, keepMs = 12, maxDropMs = 800 } = {}) {
  const idx = firstLoud(pcm, threshold);
  if (idx < 0) return Buffer.alloc(0);
  const keep = Math.round((keepMs * BYTES_PER_MS) / 2);
  const cut = Math.max(0, idx - keep);
  if (cut / BYTES_PER_MS > maxDropMs) return pcm; // 异常长的静音，别整段吞掉
  return pcm.subarray(cut * 2);
}

// 裁尾部静音，保留 keepMs 余量避免削掉尾音
export function trimTrailing(pcm, { threshold = SILENCE, keepMs = 12 } = {}) {
  const idx = lastLoud(pcm, threshold);
  if (idx < 0) return Buffer.alloc(0);
  const keep = Math.round((keepMs * BYTES_PER_MS) / 2);
  return pcm.subarray(0, Math.min(pcm.length, (idx + keep) * 2));
}

// 句首裁剪器：流式到达时逐块吞掉前导静音，找到第一个有声样点后放行。
// 不缓冲整句 —— 那样等于退化成非流式，首字延迟又回到 1 秒。
export function createLeadingTrimmer({ threshold = SILENCE, keepMs = 12, maxHoldMs = 800 } = {}) {
  let buf = Buffer.alloc(0);
  let done = false;
  const keepBytes = Math.round(keepMs * BYTES_PER_MS);
  const maxHold = Math.round(maxHoldMs * BYTES_PER_MS);
  return {
    push(b) {
      if (done || !b.length) return b;
      buf = buf.length ? Buffer.concat([buf, b]) : b;
      const idx = firstLoud(buf, threshold);
      if (idx >= 0) {
        done = true;
        const cut = Math.max(0, idx * 2 - keepBytes);
        const out = buf.subarray(cut);
        buf = Buffer.alloc(0);
        return out;
      }
      if (buf.length >= maxHold) { // 整段都没声音：原样放行，别把内容吞掉
        done = true;
        const out = buf; buf = Buffer.alloc(0); return out;
      }
      return null; // 全是静音，继续等
    },
    flush() { const b = buf; buf = Buffer.alloc(0); return b; },
    get pending() { return buf.length; },
  };
}

// 静音填充：句间留一点自然停顿
export function silence(ms) {
  const n = Math.max(0, Math.round(ms * BYTES_PER_MS));
  return Buffer.alloc(n - (n % 2));
}
