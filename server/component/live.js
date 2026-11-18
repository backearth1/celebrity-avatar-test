// 组件版会话连接：WS + conn_init + 播放管线
//
// 与标准版的三个差异：
//   - WS 地址是 /live/v1/external-lives/{live_id}/stream（不是 /live/ws/live/connect）
//   - 上行可以发二进制裸 PCM 帧（24k/s16le/mono）——这是她出声的唯一通道
//   - 下行只有 type=2 / 6 / 103，没有转写事件（没有平台 ASR，就没有 type=9 回显）
import { WebSocket } from 'ws';
import crypto from 'node:crypto';
import { componentWsUrl } from './create.js';
import { createPlayer } from './pipeline.js';

const RETRYABLE = new Set(['NOT_READY']);

export function connectComponentLive({ liveId, connId, clientSecret, onLog = () => {}, onHangup = () => {}, trace = null, voice = null }) {
  const url = componentWsUrl(liveId, connId) + (clientSecret ? `&client_secret=${encodeURIComponent(clientSecret)}` : '');
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${process.env.VIDU_API_KEY}` } });
  let seq = 0;

  const sendSignal = (type, payload = {}) => {
    if (ws.readyState !== WebSocket.OPEN) throw new Error('组件版 WS 未连接');
    ws.send(JSON.stringify({ type, live_id: liveId, conn_id: connId, seq_id: ++seq, payload }));
  };
  const sendBinary = (buf) => {
    // WS 断开（远端挂断/网络抖动）后异步管线里可能还残留待发帧，这里抛错会把
    // 整个进程打崩（实测 emitPcm 的未 await 链路里裸抛 → uncaughtException）。
    // 对调用方来说"连接没了"和"该轮已打断"是同一件事，返回 false 让管线自行退出。
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(buf);
    return true;
  };

  const stats = { pcmBytes: 0, audioSeconds: 0, frames: 0 };
  // 每个上行帧都记一次会导致事件爆炸（一段话几十帧），这里只累计 + 记首帧/里程碑
  // 发帧时间探针（诊断用，PCM_PROBE=true 才开）：记录每帧发出的时刻，
  // 用来量"实际推给渲染侧的音频有没有空档"。只在本地累加，不参与主链路。
  const probeOn = process.env.PCM_PROBE === 'true';

  const probe = { gaps: [], last: 0, maxGap: 0, over: 0, dup: [], hashes: new Map() };
  const countedBinary = (buf) => {
    stats.pcmBytes += buf.length;
    stats.audioSeconds = stats.pcmBytes / 48000;
    stats.frames += 1;
    if (probeOn) {
      // 重复帧检测：同一段 100ms 音频如果在短时间内又发了一次，就是"说了两遍"
      const h = crypto.createHash('md5').update(buf).digest('hex').slice(0, 8);
      const prev = probe.hashes.get(h);
      const nowT = Date.now();
      if (prev && nowT - prev < 30000) probe.dup.push({ t: nowT, lag: nowT - prev, bytes: buf.length });
      probe.hashes.set(h, nowT);
      if (probe.hashes.size > 4000) probe.hashes.delete(probe.hashes.keys().next().value);
      const t = nowT;
      if (probe.last) {
        const expect = (buf.length / 48);            // 这一帧应该间隔多久（100ms 帧 = 100）
        const gap = t - probe.last - expect;
        if (probe.last) probe.gaps.push(gap);
        if (gap > probe.maxGap) probe.maxGap = gap;
        if (gap > 150) probe.over += 1;
      }
      probe.last = t;
    }
    sendBinary(buf);
  };

  // trace 包装：把 5/7/9/10/15/16 等信令的真实 payload 记进链路
  const SIGNAL_NAME = { 5: 'call_hangup', 7: 'audio_interrupted', 9: 'input_transcription', 10: 'output_transcription', 15: 'baseline_reset', 16: 'switch_avatar' };
  const tracedSignal = (type, payload = {}) => {
    sendSignal(type, payload);           // 主链路：先发，发失败照常抛给调用方
    if (!trace) return;
    try {                                 // 旁路：记录失败只丢这一条，不外溢
      // 字幕单独成节点（页面上有独立的"字幕 type=10"），其余信令归 ws 节点
      trace.push(type === 10 ? 'subtitle' : 'ws', {
        output: { type, seq_id: seq, payload },
        note: `上行 type=${type} ${SIGNAL_NAME[type] || ''}`,
      });
    } catch { /* 旁路 */ }
  };
  const player = createPlayer({ sendSignal: tracedSignal, sendBinary: countedBinary, log: onLog, voice,
    resetProbe: () => { probe.gaps = []; probe.maxGap = 0; probe.over = 0; probe.last = 0; } });

  const ready = new Promise((resolve, reject) => {
    let attempts = 0;
    const init = () => sendSignal(1, { conn_init: { version: 1 } });

    ws.on('open', () => { onLog(`WS 已连接 ${url.replace(/client_secret=[^&]+/, 'client_secret=***')}`); init(); });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 2) {
        const ack = msg.payload?.conn_init_ack || {};
        if (ack.success) { onLog('conn_init_ack 成功，渲染侧就绪'); return resolve(); }
        if (RETRYABLE.has(ack.error_code) && attempts++ < 15) {
          onLog(`NOT_READY，重试 conn_init（第 ${attempts} 次）`);
          return setTimeout(init, Math.min(1500 * attempts, 5000));
        }
        return reject(new Error(`conn_init 失败：${ack.error_code} ${ack.error_msg || ''}`));
      }
      if (msg.type === 6) { onLog(`服务端强制挂断：${msg.payload?.hangup?.hangup_reason}`); onHangup(msg.payload?.hangup?.hangup_reason); return; }
      if (msg.type === 103) { onLog(`错误：${JSON.stringify(msg.payload).slice(0, 200)}`); return; }
      onLog(`下行 ${msg.type}: ${JSON.stringify(msg.payload).slice(0, 160)}`);
    });
    ws.on('error', (e) => { onLog(`WS 错误：${e.message}`); reject(e); });
    ws.on('close', (code, reason) => onLog(`WS 关闭 ${code} ${reason.toString().slice(0, 80)}`));
  });

  return {
    ws,
    ready,
    player,
    stats,
    sendSignal,
    probe,
    resetProbe: () => { probe.gaps = []; probe.maxGap = 0; probe.over = 0; probe.last = 0; probe.dup = []; probe.hashes.clear(); },
    // 打字/LLM 出来的文本 → 让渲染侧知道她要说什么（字幕），口型仍由 PCM 驱动
    say: (text) => player.say(text),
    interrupt: () => player.interrupt(),
    hangup: (reason = 'user_end') => { try { sendSignal(5, { hangup: { hangup_reason: reason } }); } catch { /* 已断开 */ } },
    close: () => { try { ws.close(); } catch { /* ignore */ } },
  };
}
