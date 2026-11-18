// 组件版播放管线：把文字变成"她说出来的话"
//
// 组件版没有平台 TTS —— type=10 只是字幕，不会出声；真正驱动口型和声音的是
// 喂进 WS 的 PCM 二进制帧。这个文件负责：
//   1) 一轮回复按句合成，边合成边喂（首句不等整段）
//   2) 按 100ms 一片推送：合成多快就发多快，最多领先渲染侧 AHEAD_MS（默认 2s）
//   3) 打断（type=7）时立刻停发并清空本地队列
//
// 为什么去掉实时节拍：接口文档只规定音频帧的格式（24k/s16le/mono，建议 20ms 或
// 100ms 一帧），没有要求按实时速率发送；渲染侧自己有播放队列（type=7 的语义就是
// "打断当前回复"）。之前我们按 1x 节拍发、只留 200ms 缓冲，TTS 在句间多等半秒，
// 渲染侧就断粮，听感是每句话之间轻微卡一下。现在发帧只受合成速度约束（攒到 2s
// 缓冲后按 1x 跟上），句间/网络抖动都被缓冲吸收。
// 播放时钟 playEndAt 同时用于发帧的缓冲上限和回合收尾（手势、busy、字幕对齐）。
import { WebSocket } from 'ws';
import { synthStream, chunks, AUDIO } from './tts.js';
import { SOUND_TAGS } from './prompt.js';

const CHUNK_MS = 100;      // 单帧 100ms（4800 字节），文档建议值
// 最多领先渲染侧多少毫秒的音频。TTS 是 3~5 倍速，完全不限的话一轮回复会一次性
// 全堆进渲染侧（打断时也要多丢一段旧音频）。攒够这个量就歇一下，攒不够就接着发。
const AHEAD_MS = Number(process.env.PCM_AHEAD_MS || 2000);
// 注意：这里刻意不做静音裁剪、不补句间停顿。TTS 自带的气口就是最自然的节奏。

// sendSignal(type, payload) 发 JSON 文本帧；sendBinary(buf) 发裸 PCM 帧。
// 信封（live_id / conn_id / seq_id）由服务端统一组装，这里不掺和。
export function createPlayer({ sendSignal, sendBinary, log = () => {}, resetProbe = null, voice = null }) {
  let speaking = false;
  let interrupted = false;
  let waiters = [];
  let epoch = 0;       // 播放代际：新一轮开始就 +1，旧的播放循环看到代际变了立刻退出
  let turnStart = 0;   // 本轮开始（用于统计首字延迟）
  let playEndAt = 0;   // 播放时钟：已发出的音频在渲染侧播完的时刻（估算，只用于收尾）
  let fedMs = 0;       // 本轮已发出的音频时长
  let firstChunkAt = 0;

  const now = () => Date.now();
  const release = () => { const w = waiters; waiters = []; w.forEach((f) => f()); };
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); waiters.push(() => { clearTimeout(t); r(); }); });

  // 字幕：type=10，组件版把它当"她正在说的话"渲染（口型由 PCM 决定）
  function subtitle(text) {
    sendSignal(10, { text_msg: { msg_id: `out-${now()}`, content: text, timestamp: now() } });
  }

  // 字幕按"这句话开始播放"的时刻发，而不是一合成完就发。
  // 发帧最多领先渲染侧 2s，字幕跟着音频排队的时间走，否则会比声音早出来一截。
  const subTimers = new Set();
  function subtitleAt(text, atMs) {
    const fire = () => { if (!interrupted) { try { subtitle(text); } catch { /* 已断开 */ } } };
    const delay = atMs - now();
    if (delay <= 50) { fire(); return; }
    const t = setTimeout(() => { subTimers.delete(t); fire(); }, delay);
    subTimers.add(t);
  }
  function clearSubtitleTimers() {
    for (const t of subTimers) clearTimeout(t);
    subTimers.clear();
  }

  // 喂一段 PCM：切帧后直接发，不等实时节拍（见文件头注释）。返回 false 表示被中断。
  function feed(pcm) {
    if (!pcm || !pcm.length) return !interrupted;
    for (const piece of chunks(pcm, CHUNK_MS)) {
      if (interrupted) return false;
      // WS 已断开：sendBinary 返回 false，按打断处理，让整轮安静退出
      if (sendBinary(piece) === false) { interrupted = true; return false; }
    }
    return !interrupted;
  }

  // 说一段话。逐句流式：每句一收到音频就开始喂，不等整句合成完（首字差 600ms 以上）。
  // chat.js 走的是 beginTurn + speakOne（LLM 边生成边给句子），这里供开场白使用。
  async function say(text) {
    const t = (text || '').trim();
    if (!t) return;
    const ep = beginTurn();
    try {
      // 逐句合成（为了首字快），但 PCM 原样连续喂：句间的气口用 TTS 自带的静音，不再人工补。
      for (const s of splitSentences(t)) {
        if (interrupted || ep !== epoch) break;
        await speakOne(s, ep);
      }
      await drain(ep);   // 音频已经发完，等渲染侧播完再算这一轮结束
    } finally {
      speaking = false;
      if (turnStart) log(`本轮首字音频 ${firstChunkAt - turnStart}ms，共喂 ${Math.round(fedMs)}ms`);
    }
  }

  // 一轮开始：代际 +1，重置播放账本。句子之间共用同一个播放时钟，
  // 换句时接着上一句的排队位置算。
  // 返回本轮代际号：调用方把它传给 speakOne，旧代际的发送会自行退出。
  // 之前没有这个，开场白还在后台播时用户一说话，新一轮把 fedMs/时钟清零，
  // 两路音频同时往渲染侧发 —— 听感就是"同一句说了两遍"（日志里 fedMs 差值为负）。
  function beginTurn() {
    // 上一轮如果还有音频排在渲染侧（正常流程会先 interrupt() 用 type=7 冲掉），
    // 这里兜底再冲一次：宁可多发一条打断，也不能让两轮的声音叠在一起。
    if (playEndAt > now() + 50) { try { sendSignal(7, {}); } catch { /* 已断开 */ } }
    epoch += 1;
    interrupted = false;
    speaking = true;
    turnStart = now();
    prefetched.clear();
    clearSubtitleTimers();
    playEndAt = 0;
    resetProbe?.();   // 探针按轮清零
    fedMs = 0;
    firstChunkAt = 0;
    return epoch;
  }

  // 发一块 PCM：按 100ms 切帧后发。只有领先渲染侧超过 AHEAD_MS 时才等，
  // 平时不做任何节拍控制（TTS 合成多快就发多快）。
  // 播放时钟 playEndAt 只是账本：新一帧的"播放完成时刻" =
  // max(之前排队的完成时刻, 现在) + 帧长。缓冲充足时它一直领先于 now；
  // 万一真的断流，这段空档会如实反映成播放结束时间往后推。
  async function emitPcm(buf, ep) {
    if (interrupted || !buf || !buf.length) return;
    // 旧代际：这一轮已经被新的对话取代了，立刻停。
    // 必须逐片检查 —— beginTurn() 会把共享的 interrupted 清成 false，
    // 只靠 interrupted 的话，旧的开场白会在用户开口后"复活"继续播，和新回复叠音。
    if (ep !== undefined && ep !== epoch) return;
    // 诊断开关：只发字幕(type=10)不发 PCM，用来验证"声音到底是谁产生的"
    if (process.env.PCM_MUTE === 'true') return;
    for (const piece of chunks(buf, CHUNK_MS)) {
      if (interrupted) return;
      if (ep !== undefined && ep !== epoch) return;
      const pieceMs = piece.length / AUDIO.bytesPerMs;
      playEndAt = Math.max(playEndAt, now()) + pieceMs;
      fedMs += pieceMs;
      // WS 已断开（远端挂断）：按打断处理，让消费循环/收尾安静退出
      if (sendBinary(piece) === false) { interrupted = true; playEndAt = 0; return; }
      const ahead = playEndAt - now();
      if (ahead > AHEAD_MS) await sleep(ahead - AHEAD_MS);
    }
  }

  // 等这一轮的音频在渲染侧播完。只给回合收尾用（手势定时器、busy 状态、turn_end），
  // 不参与发帧：发帧早就完成了，这里只是让状态机别在声音还没播完时提前收尾。
  // 被打断或换轮立即返回。
  async function drain(ep) {
    for (;;) {
      if (interrupted || (ep !== undefined && ep !== epoch)) return;
      const left = playEndAt - now();
      if (left <= 40) return;
      await sleep(left);
    }
  }

  // ---------- 预合成 ----------
  // 句间空档的根因是串行：第 1 句播完才开始合成第 2 句，中间空 900ms（实测）。
  // 这里让"下一句"在当前句还在播的时候就并行合成好，播放时直接取。
  // 只保留最近几份，避免长回复把内存堆满。
  const prefetched = new Map();   // 文本 -> Promise<Buffer>
  const PREFETCH_MAX = Number(process.env.TTS_PREFETCH_MAX || 4);

  function prefetch(sentence) {
    const key = sanitizeSoundTags(sentence);
    if (!key.trim() || interrupted) return null;
    if (prefetched.has(key)) return prefetched.get(key);
    if (prefetched.size >= PREFETCH_MAX) {
      // 丢掉最早的一份（Map 保证插入顺序）
      const oldest = prefetched.keys().next().value;
      prefetched.delete(oldest);
    }
    const p = collect(key).catch((e) => { log(`预合成失败：${e.message}`); return null; });
    prefetched.set(key, p);
    log(`预合成开始「${key.slice(0, 14)}」队列=${prefetched.size}`);
    return p;
  }

  // 合成整句（预合成用；不涉及播放节拍）。原样保留，不裁静音。
  async function collect(s) {
    const parts = [];
    await synthStream(s, { voice, onAudio: async (b) => { parts.push(Buffer.from(b)); } });
    return parts.length ? Buffer.concat(parts) : null;
  }

  // 说一句：流式合成，边收边喂。音频原样保留（不裁静音、不补停顿）。
  async function speakOne(sentence, ep) {
    if (interrupted) return;
    if (ep !== undefined && ep !== epoch) return;   // 旧代际
    const s = sanitizeSoundTags(sentence);
    if (!s.trim()) return;
    const __t0 = now();
    let __fed = 0;                 // 本次实际喂出去的毫秒数（不受 fedMs 重置影响）
    let __recvBytes = 0;           // TTS 这一句总共交给我们多少字节（诊断重复发送）

    // 已经有预合成结果：直接按节拍喂，省掉整句合成的等待
    const ready = prefetched.get(s);
    if (ready) {
      prefetched.delete(s);
      const pcm = await ready;
      log(`预合成${pcm && pcm.length ? '命中' : '为空'}「${s.slice(0, 14)}」`);
      if (pcm && pcm.length && !interrupted) {
        if (!firstChunkAt) { firstChunkAt = now(); log(`TTS 命中预合成 「${s.slice(0, 16)}」`); }
        subtitleAt(stripSoundTags(sentence), Math.max(now(), playEndAt));
        const before = fedMs;
        await emitPcm(pcm, ep);
        __fed = fedMs - before;
        log(`▶发送[预合成] 音频${Math.round(__fed)}ms 发完${now() - __t0}ms 「${s.slice(0, 18)}」`);
        return;
      }
      // 预合成失败就回退到流式
    }

    // ---------- 合成与发送解耦 ----------
    // onAudio 只负责入队（全速读 SSE），另一个循环把队首切帧发出去。
    // 发送本身不再等实时节拍，所以这里只是把"网络抖动导致读流停顿"和"发帧"隔开，
    // 不让上游 SSE 的节奏影响已合成音频的发送。
    // 音频原样入队：不裁静音、不补停顿、不做任何波形处理。
    const queue = [];
    let producerDone = false;
    let wakeConsumer = null;
    let subtitleSent = false;
    let __sent = 0;
    const wakeUp = () => { const w = wakeConsumer; wakeConsumer = null; w?.(); };
    const enqueue = (buf) => {
      if (!buf || !buf.length) return;
      queue.push(buf);
      wakeUp();
    };
    const consume = (async () => {
      for (;;) {
        if (interrupted || (ep !== undefined && ep !== epoch)) return;
        if (!queue.length) {
          if (producerDone) return;
          // 200ms 轮询兜底：打断时 producer 可能还卡在网络上，不能让消费循环永远等
          await Promise.race([
            new Promise((r) => { wakeConsumer = r; }),
            sleep(200),
          ]);
          continue;
        }
        const buf = queue.shift();
        if (!subtitleSent) {
          subtitleSent = true;
          subtitleAt(stripSoundTags(sentence), Math.max(now(), playEndAt));
        }
        __sent += buf.length / AUDIO.bytesPerMs;
        __fed = __sent;
        await emitPcm(buf, ep);
      }
    })();

    const push = (buf) => {
      if (ep !== undefined && ep !== epoch) return;
      enqueue(buf);
    };

    let prodErr = null;
    try {
      await synthStream(s, {
        voice,
        onAudio: async (chunk) => {
          if (interrupted || (ep !== undefined && ep !== epoch)) return;
          if (!firstChunkAt) {
            firstChunkAt = now();
            log(`TTS 首块 ${firstChunkAt - turnStart}ms 「${s.slice(0, 16)}」`);
          }
          __recvBytes += chunk.length;
          push(chunk);
        },
      });
    } catch (e) {
      prodErr = e;
    }
    const prodMs = now() - __t0;
    producerDone = true;
    wakeUp();
    await consume;
    if (prodErr) { log(`TTS 失败：${prodErr.message}`); return; }
    const sentBytes = Math.round(__fed * AUDIO.bytesPerMs);
    log(`▶发送[流式] 收${__recvBytes}B 发${sentBytes}B 比${(__recvBytes ? sentBytes / __recvBytes : 0).toFixed(2)} `
      + `合成${prodMs}ms 发完${now() - __t0}ms 音频${Math.round(__recvBytes / AUDIO.bytesPerMs)}ms `
      + `「${s.slice(0, 18)}」${ep !== undefined && ep !== epoch ? '（已被打断，残留）' : ''}`);
  }

  // 打断：立刻停发，通知上游丢弃她还在渲染的音频
  function interrupt() {
    interrupted = true;
    clearSubtitleTimers();
    playEndAt = 0;
    release();
    try { sendSignal(7, {}); } catch { /* 已断开 */ }
  }

  return { say, speakOne, prefetch, beginTurn, emitPcm, drain, interrupt, feed, subtitle, isSpeaking: () => speaking,
    stats: () => ({ fedMs: Math.round(fedMs), firstChunkMs: firstChunkAt ? firstChunkAt - turnStart : 0 }) };
}

// 强标点立即切；弱标点满 12 字才切；超 40 字无标点强制切（TTS 单次不要太长）。
// 圆括号里是 sound tag（如 (lip-smacking)），括号内绝不切，否则标签会被拆坏、TTS 会念出半截。
// 纯标签片段（"(laughs)" 单独成句）并入相邻句子：否则它会被当成一段独立文本去合成，
// 字幕上还会多出一个只有标签的空行。
export function splitSentences(text) {
  const out = [];
  let buf = '';
  let depth = 0;
  const push = () => {
    const t = buf.trim();
    buf = '';
    if (!t) return;
    // 整段只有标签 → 黏到上一句；没有上一句就先存着，等下一句来拼
    if (isTagOnly(t)) {
      if (out.length) out[out.length - 1] += t;
      else buf = t;
      return;
    }
    if (out.length && isTagOnly(out[out.length - 1])) {
      out[out.length - 1] += t;
      return;
    }
    out.push(t);
  };
  // 英文（安妮）按英文标点断句，硬切退到空格，避免把单词劈成两半念出来
  const en = !CJK_RE.test(text);
  const STRONG_SET = en ? '.!?;' : '。！？!?；;\n';
  const SOFT_SET = en ? ',' : '，,、';
  const SOFT_MIN = en ? 40 : 12;
  const HARD_MAX = en ? 80 : 40;
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')' && depth > 0) depth -= 1;
    buf += ch;
    if (depth > 0) continue;            // 标签内部不切分
    if (STRONG_SET.includes(ch)) { push(); }
    else if (SOFT_SET.includes(ch) && buf.length >= SOFT_MIN) { push(); }
    else if (buf.length >= HARD_MAX) {
      if (en) {
        const sp = buf.lastIndexOf(' ');
        if (sp > SOFT_MIN) { const head = buf.slice(0, sp); buf = buf.slice(sp + 1); out.push(head.trim()); continue; }
      }
      push();
    }
  }
  push();
  return out.length ? out : [text];
}

const CJK_RE = /[一-鿿]/;
const TAG_ONLY_RE = /^(?:\s*\(\s*[a-z-]{2,20}\s*\))+\s*$/;
const isTagOnly = (t) => TAG_ONLY_RE.test(t);

// 只保留 MiniMax 支持的 sound tag：模型会自造 (stretches)、(smile) 之类，
// 这些不认识的括号内容会被 TTS 当普通文字念出来，必须清掉。
// 模型还会写常见变体（exhales / sigh / giggle）和方括号 [laughs]：
// 变体不在 MiniMax 列表里，方括号本身就是普通文字，都会被念出来 —— 先归一化再过滤。
const TAG_ALIASES = {
  laugh: 'laughs', laughing: 'laughs', giggle: 'chuckle', giggles: 'chuckle', giggling: 'chuckle',
  sigh: 'sighs', sighing: 'sighs', exhales: 'exhale', exhaling: 'exhale',
  inhales: 'inhale', inhaling: 'inhale', gasp: 'gasps', gasping: 'gasps',
  snort: 'snorts', hum: 'humming', hums: 'humming',
  whistle: 'whistles', cough: 'coughs', sneeze: 'sneezes', sob: 'crying', sobs: 'crying',
};
function normTag(tag, allowed) {
  const t = String(tag || '').toLowerCase().trim();
  const n = allowed.includes(t) ? t : TAG_ALIASES[t];
  return n && allowed.includes(n) ? n : '';
}

export function sanitizeSoundTags(text, allowed = null) {
  const ok = allowed || SOUND_TAGS;
  const square = (text || '').replace(/[\[【]\s*([a-zA-Z-]{2,20})\s*[\]】]/g, (m, tag) => {
    const n = normTag(tag, ok);
    return n ? `(${n})` : '';
  });
  return square.replace(/\(\s*([a-zA-Z-]{2,20})\s*\)/g, (m, tag) => {
    const n = normTag(tag, ok);
    return n ? `(${n})` : '';
  });
}

// 字幕展示用：去掉 sound tag（TTS 要保留，它是音效指令；字幕里不该出现英文标记）
export function stripSoundTags(text) {
  const s = (text || '').replace(/[\[【]\s*([a-zA-Z-]{2,20})\s*[\]】]/g, (m, tag) => (normTag(tag, SOUND_TAGS) ? '' : m));
  return s.replace(/\(\s*[a-zA-Z-]{2,20}\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
}
