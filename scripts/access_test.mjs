// 多人访问回归：身份隔离、并发上限、时长上限
// 用法：BASE=https://127.0.0.1:8444 node scripts/access_test.mjs <user:password>
// 需要服务以较小的上限启动：MAX_CONCURRENT_SESSIONS=2 MAX_SESSION_SECONDS=25
const BASE = process.env.BASE || 'https://127.0.0.1:8444';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { default: WebSocket } = await import('ws');
const auth = 'Basic ' + Buffer.from(process.argv[2]).toString('base64');
const t0 = Date.now();
const T = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

async function identity(legacy) {
  const r = await fetch(`${BASE}/api/me?legacy=${legacy}`, { headers: { Authorization: auth } });
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], ...(await r.json()) };
}
const call = (path, cookie, opts = {}) => fetch(`${BASE}${path}`, {
  ...opts, headers: { 'Content-Type': 'application/json', Authorization: auth, ...(cookie ? { Cookie: cookie } : {}) },
});
const createSession = async (cookie) => {
  const r = await call('/api/session', cookie, { method: 'POST', body: JSON.stringify({ persona: 'clone' }) });
  return { status: r.status, ...(await r.json()) };
};
function openWs(liveId, cookie) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${BASE.replace('https', 'wss')}/ws?live_id=${liveId}&conn_id=acc`, { headers: { Authorization: auth, ...(cookie ? { Cookie: cookie } : {}) } });
    const events = [];
    ws.on('message', (m) => events.push(JSON.parse(m)));
    ws.on('open', () => ws.send(JSON.stringify({ type: 1, live_id: liveId, conn_id: 'acc', seq_id: 1, payload: { conn_init: { version: 1 } } })));
    ws.on('close', (code, reason) => resolve({ ws, events, closed: { code, reason: reason.toString() } }));
    ws.on('error', () => {});
    setTimeout(() => resolve({ ws, events, closed: null }), 4000);
  });
}

// ---- 1. 身份
const A = await identity('acc-user-a');
const B = await identity('acc-user-b');
const A2 = await identity('acc-user-a'); // 别人想认领 A 的旧 ID
check('A 拿到签名 cookie', A.cookie.startsWith('vuid='));
check('已被认领的旧 ID 不能被别人再领', A2.user_id !== A.user_id, `A=${A.user_id} 第二次=${A2.user_id}`);
check('无 cookie 建会话被拒', (await createSession('')).status === 401);
const memNoCookie = await call('/api/memory?persona=clone', '');
check('无 cookie 查记忆被拒', memNoCookie.status === 401);
const memB = await (await call(`/api/memory?persona=clone&user_id=${A.user_id}`, B.cookie)).json();
check('B 传 A 的 user_id 查记忆，只能查到 B 自己的', JSON.stringify(memB).indexOf(A.user_id) === -1 && (memB.results || []).every((m) => m.user_id !== A.user_id));
check('/api/lives 已移除', (await call('/api/lives', A.cookie)).status === 404);

// ---- 2. 会话归属 + 并发上限（测试实例上限 2）
const sA = await createSession(A.cookie);
check('A 建会话', sA.status === 200, `live=${sA.live_id} max_seconds=${sA.max_seconds}`);
const swB = await call('/api/clip/switch', B.cookie, { method: 'POST', body: JSON.stringify({ live_id: sA.live_id, video_url: 'https://example.com/a.mp4' }) });
check('B 切 A 的视频 → 404', swB.status === 404);
const wsB = await openWs(sA.live_id, B.cookie);
check('B 连 A 的 WS 被拒（1008）', wsB.closed?.code === 1008);
const sB = await createSession(B.cookie);
check('第 2 路建会话成功', sB.status === 200);
const s3 = await createSession(B.cookie);
check('第 3 路被拒（429）', s3.status === 429, JSON.stringify({ active: s3.active, max: s3.max }));

// B 的会话没连 WS：60 秒后回收；这里手动不连，留给 no_client 回收验证（不阻塞本测试）
// ---- 3. 时长上限（测试实例 25 秒）：A 连上 WS，等服务端到点挂断
const ev = await new Promise((resolve) => {
  const ws = new WebSocket(`${BASE.replace('https', 'wss')}/ws?live_id=${sA.live_id}&conn_id=acc`, { headers: { Authorization: auth, Cookie: A.cookie } });
  const events = [];
  ws.on('open', () => ws.send(JSON.stringify({ type: 1, live_id: sA.live_id, conn_id: 'acc', seq_id: 1, payload: { conn_init: { version: 1 } } })));
  ws.on('message', (m) => { const x = JSON.parse(m); events.push({ t: T(), type: x.type, reason: x.payload?.hangup?.hangup_reason }); });
  ws.on('close', () => resolve(events));
  setTimeout(() => resolve(events), 40000);
});
const hang = ev.find((e) => e.type === 6);
check('到点服务端下发 max_duration 挂断', hang?.reason === 'max_duration', JSON.stringify(ev.filter((e) => e.type !== 10 && e.type !== 9)));

// 到点后名额释放：B 的未连接会话还占着 1 个，此时应能再建 1 个
const s4 = await createSession(A.cookie);
check('到点释放名额后可再建会话', s4.status === 200, `status=${s4.status}`);
const me = await identity('');
console.log(T(), '当前在线', me.active, '/', me.max);
console.log(`\n${pass} passed, ${fail} failed`);
console.log(JSON.stringify({ liveA: sA.live_id, liveB: sB.live_id, live4: s4.live_id }));
process.exit(fail ? 1 : 0);
