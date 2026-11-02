// 杨幂数字分身 1v1 视频对话 —— 本地服务端
// 职责：持有 Vidu API Key（不下发浏览器）、创建 Live 会话、代理 App WebSocket、记录对话日志。
import 'dotenv/config';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { buildSessionBody, DEFAULT_PERSONA } from './session_config.js';
import { PERSONAS, getPersona } from './personas.js';
import { createActionPicker } from './text_action.js';
import { createIdentity, createSessionLimiter } from './access.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  VIDU_API_KEY, VIDU_HOST = 'api.vidu.cn', PORT = 8443, HOST = '0.0.0.0', TLS_CERT, TLS_KEY,
  ACCESS_USER = 'demo', ACCESS_PASSWORD,
} = process.env;
if (!VIDU_API_KEY) throw new Error('VIDU_API_KEY missing in .env');

const AUTH = { Authorization: `Token ${VIDU_API_KEY}` };
const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const STATIC = {
  '/': ['web/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['web/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['web/style.css', 'text/css; charset=utf-8'],
  '/vendor/agora.js': ['node_modules/agora-rtc-sdk-ng/AgoraRTC_N-production.js', 'text/javascript'],
};

function logEvent(liveId, event) {
  fs.appendFileSync(path.join(LOG_DIR, `${liveId}.jsonl`), JSON.stringify({ ts: Date.now(), ...event }) + '\n');
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function vidu(method, urlPath, body) {
  const r = await fetch(`https://${VIDU_HOST}${urlPath}`, {
    method,
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: r.status, data };
}

// 公网暴露时用 Basic Auth 保护，避免他人消耗积分
const EXPECTED_AUTH = ACCESS_PASSWORD && `Basic ${Buffer.from(`${ACCESS_USER}:${ACCESS_PASSWORD}`).toString('base64')}`;
// 身份：签名 cookie，记忆 / 会话 / 切视频都只认它
const identity = createIdentity({ dataDir: path.join(ROOT, 'data'), secret: process.env.COOKIE_SECRET });

// 会话配额：同时最多 N 路、单次最长 M 秒；到点或无人连接由 endSession 回收
const limiter = createSessionLimiter({
  maxConcurrent: Number(process.env.MAX_CONCURRENT_SESSIONS || 10),
  maxSeconds: Number(process.env.MAX_SESSION_SECONDS || 300),
  onExpire: (liveId, reason) => endSession(liveId, reason),
});

// 结束会话并让出名额。连着 WS 就经它挂断；没连就临时开一条 WS 发挂断，避免会话空跑计费
function endSession(liveId, reason) {
  const s = limiter.remove(liveId);
  if (!s) return;
  console.log(`live ${liveId} ended: ${reason} (active ${limiter.active()}/${limiter.maxConcurrent})`);
  logEvent(liveId, { kind: 'session_end', reason });
  if (s.sock) return s.sock.hangup(reason);
  // 浏览器掉线时代理已补发挂断、上游已关闭时无需再挂；只有超时 / 一直没连上才另开连接去挂断
  if (reason !== 'max_duration' && reason !== 'no_client') return;
  const ws = new WebSocket(`wss://${VIDU_HOST}/live/ws/live/connect?live_id=${liveId}&conn_id=server-reaper`, { headers: AUTH });
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 5, live_id: liveId, conn_id: 'server-reaper', seq_id: 1, payload: { hangup: { hangup_reason: 'user_end' } } }));
    setTimeout(() => ws.close(), 1000);
  });
  ws.on('error', (e) => console.error(`reaper ${liveId}`, e.message));
}

// 需要身份的接口：没有有效 cookie 直接 401，提示刷新页面领取
function requireUid(req, res) {
  const uid = identity.fromRequest(req);
  if (!uid) send(res, 401, { error: 'no identity, reload the page' });
  return uid;
}

// 浏览器只在 HTTPS（或 localhost）下开放摄像头/麦克风，配置了证书就走 HTTPS
const tls = TLS_CERT && TLS_KEY
  ? { cert: fs.readFileSync(path.resolve(ROOT, TLS_CERT)), key: fs.readFileSync(path.resolve(ROOT, TLS_KEY)) }
  : null;
const handler = async (req, res) => {
  if (EXPECTED_AUTH && req.headers.authorization !== EXPECTED_AUTH) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="yangmi-demo", charset="UTF-8"' });
    return res.end('unauthorized');
  }
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'Content-Type': type });
      return fs.createReadStream(path.join(ROOT, file)).pipe(res);
    }

    // 领取身份：页面加载时调用。legacy 是浏览器里旧的 localStorage user_id，用于保住已有记忆
    if (req.method === 'GET' && url.pathname === '/api/me') {
      let uid = identity.fromRequest(req);
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (!uid) {
        const issued = identity.issue(url.searchParams.get('legacy'));
        uid = issued.uid;
        headers['Set-Cookie'] = issued.cookie;
      }
      res.writeHead(200, headers);
      return res.end(JSON.stringify({ user_id: uid, active: limiter.active(), max: limiter.maxConcurrent, max_seconds: limiter.maxSeconds }));
    }

    if (req.method === 'POST' && url.pathname === '/api/session') {
      const user_id = requireUid(req, res);
      if (!user_id) return;
      const { call_mode = 'video', persona = DEFAULT_PERSONA } = await readJson(req);
      if (!PERSONAS[persona]) return send(res, 400, { error: `unknown persona: ${persona}` });
      // 先占名额再建会话，避免并发请求同时越过上限
      if (!limiter.reserve()) {
        return send(res, 429, { error: 'too_many_sessions', active: limiter.active(), max: limiter.maxConcurrent });
      }
      let committed = false;
      try {
        // 预取这位用户的长期记忆注入人设：模型不一定主动调用记忆检索，开场就该认得人
        const mem = await vidu('POST', '/live/v1/memories/list', { user_id, agent_id: getPersona(persona).agentId, page: 1, page_size: 30 });
        const memories = mem.status === 200 ? (mem.data.results || []).map((m) => m.memory) : [];
        const body = buildSessionBody({ userId: user_id, callMode: call_mode, persona, memories });
        const { status, data } = await vidu('POST', '/live/s_avatar/realtime', body);
        if (status !== 200) {
          console.error('create live failed', status, data);
          return send(res, status, { error: data });
        }
        const s = limiter.commit(data.live.id, user_id);
        committed = true;
        logEvent(data.live.id, { kind: 'session', user_id, persona, request: { ...body, avatar: { ...body.avatar, persona: `<${body.avatar.persona.length} chars>` } } });
        console.log(`live ${data.live.id} created for ${user_id} persona=${persona} (active ${limiter.active()}/${limiter.maxConcurrent})`);
        return send(res, 200, { live_id: data.live.id, rtc: data.rtc, max_seconds: limiter.maxSeconds, ends_at: s.endsAt });
      } finally {
        if (!committed) limiter.release();
      }
    }

    // 记忆：查看 / 清空（“忘记我”）
    if (url.pathname === '/api/memory') {
      // 只操作自己的记忆：user_id 取自 cookie，忽略参数里传来的
      const userId = requireUid(req, res);
      if (!userId) return;
      const persona = url.searchParams.get('persona') || DEFAULT_PERSONA;
      if (!PERSONAS[persona]) return send(res, 400, { error: `unknown persona: ${persona}` });
      if (req.method === 'GET') {
        const r = await vidu('POST', '/live/v1/memories/list', { user_id: userId, agent_id: getPersona(persona).agentId, page: 1, page_size: 50 });
        return send(res, r.status, r.data);
      }
      if (req.method === 'DELETE') {
        const q = new URLSearchParams({ user_id: userId, agent_id: getPersona(persona).agentId });
        const r = await vidu('DELETE', `/live/v1/memories?${q}`);
        return send(res, r.status, r.data);
      }
    }

    // 离线视频切换：先下发"走出画面"动作，延迟后发 switch_avatar，期间不发 baseline_reset
    if (req.method === 'POST' && url.pathname === '/api/clip/switch') {
      const uid = requireUid(req, res);
      if (!uid) return;
      const { live_id, video_url, avatar_id, delay_ms } = await readJson(req);
      if (!/^\d+$/.test(live_id || '')) return send(res, 400, { error: 'invalid live_id' });
      if (!/^https?:\/\//.test(video_url || '')) return send(res, 400, { error: 'video_url must be http(s)' });
      const session = limiter.get(live_id);
      // 不是自己的会话一律当不存在，不泄露别人的 live_id 是否在线
      if (!session || session.owner !== uid) return send(res, 404, { error: 'live not found' });
      const sock = session.sock;
      if (!sock) return send(res, 409, { error: 'live not connected (no active ws)' });
      const delay = Number(delay_ms ?? process.env.SWITCH_DELAY_MS ?? 4000);
      const targetAvatar = String(avatar_id || process.env.AVATAR_ID || '');
      if (!targetAvatar) return send(res, 400, { error: 'missing avatar_id' });

      const seqBase = Date.now() % 100000;
      const exitText = process.env.SWITCH_EXIT_ACTION || '固定镜头，人物向左走出屏幕';
      try {
        sock.send({ type: 101, live_id, conn_id: sock.connId, seq_id: seqBase,
          payload: { text_action: { msg_id: `exit-${seqBase}`, content: exitText } } });
      } catch (e) { return send(res, 500, { error: String(e) }); }

      const at = Date.now() + delay;
      setTimeout(() => {
        try {
          sock.send({ type: 16, live_id, conn_id: sock.connId, seq_id: seqBase + 1,
            payload: { switch_avatar: { switch_videos: [video_url], avatar_id: targetAvatar } } });
          console.log(`clip switch sent live=${live_id} after ${delay}ms`);
        } catch (e) { console.error('clip switch failed', e.message); }
      }, delay);

      logEvent(live_id, { kind: 'clip_switch', video_url, avatar_id: targetAvatar, delay_ms: delay, exit_action: exitText });
      return send(res, 200, { ok: true, live_id, delay_ms: delay, avatar_id: targetAvatar, exit_action: exitText });
    }

    if (req.method === 'GET' && url.pathname === '/api/personas') {
      return send(res, 200, { default: DEFAULT_PERSONA, items: Object.entries(PERSONAS).map(([key, p]) => ({ key, label: p.label })) });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: String(e) });
  }
};
const server = tls ? https.createServer(tls, handler) : http.createServer(handler);

// App WebSocket 代理：浏览器 <-> 本服务 <-> Vidu（鉴权 Header 只在服务端添加）
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (client, req) => {
  const url = new URL(req.url, 'http://x');
  const liveId = url.searchParams.get('live_id');
  const connId = url.searchParams.get('conn_id') || `app-${Date.now()}`;
  const session = limiter.get(liveId);
  const uid = identity.fromRequest(req);
  // 只能连自己创建、且还没结束的会话
  if (!session || !uid || session.owner !== uid) return client.close(1008, 'unknown live_id');

  const upstream = new WebSocket(
    `wss://${VIDU_HOST}/live/ws/live/connect?live_id=${liveId}&conn_id=${encodeURIComponent(connId)}`,
    { headers: AUTH },
  );
  const pending = [];
  // Layer 2：按数字人自己的回复下发手势（.env TEXT_ACTION=true 开启）
  const actionPicker = process.env.TEXT_ACTION === 'true' ? createActionPicker() : null;
  const sendAction = (rule) => {
    if (!rule || upstream.readyState !== WebSocket.OPEN) return;
    const action = {
      type: 101, live_id: liveId, conn_id: connId, seq_id: ++actionSeq,
      payload: { text_action: { msg_id: `act-${actionSeq}`, content: rule.action } },
    };
    upstream.send(JSON.stringify(action));
    logEvent(liveId, { kind: 'action', rule: rule.name, msg: action });
  };
  let actionSeq = 1_000_000; // 与浏览器端 seq_id 错开
  let continueTimer; // 长回复中途补动作

  let heartbeat;
  upstream.on('open', () => {
    for (const m of pending.splice(0)) upstream.send(m);
    // 文档要求 15 秒内必须有消息；协议未定义心跳信令，这里用 WS ping 帧兜底
    heartbeat = setInterval(() => upstream.readyState === WebSocket.OPEN && upstream.ping(), 10000);
  });
  upstream.on('message', (data) => {
    const text = data.toString();
    try {
      const msg = JSON.parse(text);
      logEvent(liveId, { kind: 'down', msg });
      // 用户话一停（type=9 整句转写）就决定她这轮怎么比划：零延迟，赶在声音前面
      if (msg.type === 9 && actionPicker) {
        const rule = actionPicker.pickLeading(msg.payload?.text_msg?.content);
        sendAction(rule || actionPicker.fallbackAction);
      }
      if (msg.type === 10 && actionPicker) {
        const content = msg.payload?.text_msg?.content;
        // 回复文本到达时只做少数强匹配，避免又迟又和正在说的话错位
        const rule = actionPicker.pick(content);
        if (rule) sendAction(rule);
        // 长回复中途补一次，免得一句话到后面完全没动作
        const delay = actionPicker.continueAfter(content);
        if (delay) {
          clearTimeout(continueTimer);
          continueTimer = setTimeout(() => sendAction(actionPicker.continueAction), delay);
        }
      }
    } catch { /* non-JSON */ }
    if (client.readyState === WebSocket.OPEN) client.send(text);
  });
  client.on('message', (data) => {
    const text = data.toString();
    try {
      const msg = JSON.parse(text);
      logEvent(liveId, { kind: 'up', msg });
    } catch { /* non-JSON */ }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else pending.push(text);
  });

  // 挂到会话上：供 /api/clip/switch 主动下发，以及到点 / 掉线时由服务端挂断
  let ended = false;
  session.sock = {
    connId,
    send: (msg) => {
      if (upstream.readyState !== WebSocket.OPEN) throw new Error('upstream ws not open');
      upstream.send(JSON.stringify(msg));
      logEvent(liveId, { kind: 'up', msg });
    },
    hangup: (reason) => {
      if (ended) return;
      ended = true;
      // 先告诉浏览器为什么结束（复用 type=6 结构），再挂断上游
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 6, live_id: liveId, payload: { hangup: { hangup_reason: reason } } }));
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(JSON.stringify({ type: 5, live_id: liveId, conn_id: connId, seq_id: ++actionSeq, payload: { hangup: { hangup_reason: 'user_end' } } }));
      }
      setTimeout(() => closeBoth('server', 1000, reason), 500);
    },
  };

  const closeBoth = (who, code, reason) => {
    // 浏览器掉线 / 关页面：服务端补发挂断，名额立即释放，会话不空跑计费
    if (!ended) {
      ended = true;
      if (who === 'client' && upstream.readyState === WebSocket.OPEN) {
        upstream.send(JSON.stringify({ type: 5, live_id: liveId, conn_id: connId, seq_id: ++actionSeq, payload: { hangup: { hangup_reason: 'user_end' } } }));
      }
      session.sock = null;
      endSession(liveId, who === 'client' ? 'client_closed' : 'upstream_closed');
    }
    clearInterval(heartbeat);
    clearTimeout(continueTimer);
    console.log(`ws ${liveId} closed by ${who} ${code ?? ''} ${reason || ''}`);
    if (client.readyState === WebSocket.OPEN) client.close(1000, `${who} closed`);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) setTimeout(() => upstream.close(), 300);
  };
  upstream.on('close', (c, r) => closeBoth('upstream', c, r.toString()));
  upstream.on('error', (e) => { console.error('upstream error', e.message); closeBoth('upstream-error'); });
  client.on('close', (c, r) => closeBoth('client', c, r.toString()));
});

server.listen(PORT, HOST, () => console.log(`杨幂数字分身 demo: ${tls ? 'https' : 'http'}://${HOST}:${PORT}`));
