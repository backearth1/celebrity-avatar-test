// 组件版会话池：一次组件版通话 = 一条服务端持有的 WS + 一个对话引擎。
//
// 架构差异（和标准版代理模式的关键区别）：
//   标准版：浏览器 ←ws→ 本服务 ←ws→ Vidu（本服务只做鉴权代理和动作注入）
//   组件版：本服务 ←ws→ Vidu（PCM 音频必须由服务端实时喂，浏览器不再持有控制 WS）
// 所以组件版前端只需要 RTC 订阅画面 + 几个 REST 接口。
import { buildComponentBody, createComponentSession } from './create.js';
import { connectComponentLive } from './live.js';
import { createChatEngine } from './chat.js';
import { greetingFor } from './prompt.js';
import { createTrace } from './trace.js';
import { listMemories } from '../component_memory.js';
import { getPersona, loadIdleMotions, isIpPersona } from '../personas.js';
import { voiceFor } from './tts.js';
import { retrieve, getIndex } from './kb.js';
import { shouldRetrieve } from './kb_gate.js';
import { queueRecording } from '../recording.js';

// 知识库可用性：有索引文件 + 配了腾讯云密钥，才走检索；否则静默跳过，不影响对话
// 每个人设在知识库里对应哪个分区：杨幂两个分身共用 yangmi，安妮用 anne
const KB_KEY = { clone: 'yangmi', girlfriend: 'yangmi', anne: 'anne', anne_girlfriend: 'anne' };
const KB_READY = Boolean(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY);
// John Wick 人设里写了三个任务（血契 / 内鬼 / 护送）。每场轮换一个，
// 不让模型自己挑（实测它总选"血契"），三种任务都能被体验到。
const IP_MISSIONS = ['A', 'B', 'C'];
let ipMissionSeq = 0;

const sessions = new Map(); // liveId -> entry

export async function startComponentSession({ userId, persona, onLog = () => {}, onEnd = () => {} }) {
  const trace = createTrace();
  // 旁路记录：任何异常都吞掉，不影响建会话
  const tp = (node, payload) => { try { trace.push(node, payload); } catch { /* 旁路 */ } };
  // 形象/音色按人设覆盖：ANNE_AVATAR_ID / ANNE_VOICE 存在就优先用，否则沿用全局配置。
  // 人设自己登记了形象（安妮、John Wick）就只认它，不回落到全局形象——
  // 否则选了别人，画面上还是杨幂。
  const cfg = getPersona(persona);
  const ownAvatar = Boolean(cfg.avatarIdEnv || cfg.imageUriEnv);
  const avatarId = ownAvatar ? (process.env[cfg.avatarIdEnv] || '') : process.env.AVATAR_ID;
  const imageUri = process.env[cfg.imageUriEnv] || (ownAvatar ? '' : process.env.AVATAR_IMAGE_URI);
  if (ownAvatar && !avatarId && !imageUri) {
    const hints = [cfg.avatarIdEnv, cfg.imageUriEnv].filter(Boolean).join(' 或 ');
    throw new Error(`${cfg.label} 还没有配置形象：请设置 ${hints}（正面半身形象图）`);
  }
  const body = buildComponentBody({
    avatarId: avatarId || undefined,
    imageUri: imageUri || undefined,
    // 只有 IP 人设读自己的小动作文件：杨幂/安妮沿用 create.js 里调好的那套，
    // 不因为这次改动顺带改掉她们的表现。
    idleMotions: isIpPersona(persona) ? loadIdleMotions(persona) : null,
    // 组件版默认 trtc：平台录制只有 trtc 能稳定出片（agora 实测 query_failed）。
    // 浏览器端按 rtc.provider 选 SDK。
    rtcProvider: process.env.RTC_PROVIDER || 'trtc',
  });
  tp('vidu_create', { input: body, note: 'POST /live/s_avatar/component' });
  const sess = await createComponentSession(body);
  tp('vidu_create', {
    output: {
      live_id: sess.liveId, rtc: sess.rtc, client_secret: sess.clientSecret ? '‹已下发，24h 有效›' : '‹无›',
      idle_motion: sess.raw?.live?.idle_motion,
    },
    note: '平台只负责渲染，不含 LLM/ASR/TTS',
  });

  // 长期记忆沿用平台接口，只是改由我们自己注入 prompt（没有平台的自动检索）
  let memories = [];
  const memAt = Date.now();
  try { memories = await listMemories({ userId, persona }); } catch (e) { onLog(`记忆读取失败：${e.message}`); }
  tp('memory_read', {
    input: { user_id: userId, agent_id: getPersona(persona).agentId },
    output: { hits: memories },
    ms: Date.now() - memAt,
    note: '注入 system prompt，替代平台的自动检索',
  });

  const connId = `comp-${Date.now()}`;
  const live = connectComponentLive({
    liveId: sess.liveId,
    connId,
    clientSecret: sess.clientSecret,
    trace,
    voice: voiceFor(persona),   // 音色按人设：ANNE_VOICE=anne001test，其余用 MINIMAX_VOICE
    onLog: (m) => onLog(m),
    onHangup: (reason) => { endComponentSession(sess.liveId, reason || 'server_hangup'); onEnd(reason || 'server_hangup'); },
  });
  tp('ws_connect', { input: { live_id: sess.liveId, conn_id: connId }, note: 'wss://…/live/v1/external-lives/{live_id}/stream' });
  await live.ready;
  tp('ws_connect', { output: { conn_init_ack: { success: true } }, note: '渲染侧就绪' });
  // RTC 下行：浏览器拿这四个字段订阅画面（managed_rtc，agora）
  tp('rtc_down', {
    input: { provider: sess.raw?.managed_rtc?.provider || 'agora' },
    output: { app_id: sess.rtc?.app_id, channel_id: sess.rtc?.channel_id, user_id: sess.rtc?.user_id, token: sess.rtc?.token ? '‹已下发›' : '' },
    note: '浏览器 join 后订阅数字人音视频',
  });

  // 浏览器不持有控制 WS，字幕/状态靠事件队列轮询（GET /api/component/events）
  const events = [];
  const pushEvent = (e) => {
    events.push({ ts: Date.now(), ...e });
    if (events.length > 400) events.splice(0, events.length - 400);
  };

  let lastKbQuery = null; // 上一轮真正查过库的问题，供追问沿用
  const mission = isIpPersona(persona) ? IP_MISSIONS[ipMissionSeq++ % IP_MISSIONS.length] : null;
  const chat = createChatEngine({
    live,
    persona,
    voice: voiceFor(persona),
    memories,
    mission,
    trace,
    // 知识库检索：先过门控（kb_gate.js），只有涉及她本人事实的问题才查库。
    // 追问（"再想想呢"）时，沿用上一轮的查询，否则拿"再想想呢"去查只会查到一堆无关内容。
    retrieve: async (query) => {
      // IP 人物（John Wick）没有知识库：背景全写在 persona 提示词里，检索直接跳过
      const kbKey = KB_KEY[persona];
      if (!kbKey) return { hits: [], recall: 0, ms: 0, skipped: true, reason: '该人设不用知识库（背景全在提示词里）' };
      if (!KB_READY) return { hits: [], recall: 0, ms: 0, skipped: true, reason: '知识库未就绪' };
      const gate = shouldRetrieve(query, { lastRetrieved: Boolean(lastKbQuery) });
      if (!gate.go) {
        lastKbQuery = null;
        onLog(`[kb] 跳过：${query} （${gate.reason}）`);
        return { hits: [], recall: 0, ms: 0, skipped: true, reason: gate.reason };
      }
      const isFollow = gate.reason.startsWith('追问');
      // 追问直接复用上一轮的问题。不要拼接——实测"那去年你在拍什么戏 再想想呢"
      // 会让 rerank 把"再想想呢"当噪声，召回从 3 条掉到 1 条（-5.27）。
      const q = isFollow && lastKbQuery ? lastKbQuery : query;
      const r = await retrieve(q, { persona: kbKey });
      lastKbQuery = isFollow ? lastKbQuery : query;
      onLog(`[kb] ${q} → ${r.hits.length} 命中 / 召回 ${r.recall}（${gate.reason}）`);
      return { ...r, reason: gate.reason, query: q };
    },
    onEvent: (e) => {
      pushEvent(e);
      onLog(`[${e.kind}] ${e.text || e.error || e.ms || ''}`);
    },
  });

  const entry = {
    liveId: sess.liveId, userId, persona, live, chat, events, trace, rtc: sess.rtc, startedAt: Date.now(),
    // 录像时间窗（前端"开始/停止录像"打点）。平台只能整场录，结束后按这个窗口裁剪。
    recordStart: null, recordStop: null,
  };
  sessions.set(sess.liveId, entry);

  // 开场白：后台播放，不阻塞建会话返回（前端拿到 rtc 就能开始订阅画面）
  // 有记忆时用现成开场，具体内容在她说话时自然会带出来
  const greeting = greetingFor(persona);
  chat.speak(greeting).catch((e) => onLog(`开场白失败：${e.message}`));

  return entry;
}

export const getComponentSession = (liveId) => sessions.get(liveId);

export function endComponentSession(liveId, reason = 'user_end') {
  const s = sessions.get(liveId);
  if (!s) return null;
  sessions.delete(liveId);
  try { s.chat.interrupt(); } catch { /* ignore */ }
  try { s.live.hangup(reason); } catch { /* ignore */ }
  setTimeout(() => s.live.close(), 500);
  // 有录像窗口才建任务：平台那侧常开录制，没按过"开始录像"就整场丢弃。
  // 排队失败不能影响挂断，所以吞掉异常。
  try { queueRecording(s); } catch (e) { onLogSafe(liveId, `录像任务创建失败：${e.message}`); }
  return s;
}

function onLogSafe(liveId, msg) {
  try { console.error(`[comp ${liveId}] ${msg}`); } catch { /* ignore */ }
}

export const activeComponentSessions = () => sessions.size;
