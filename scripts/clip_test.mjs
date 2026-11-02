// 离线视频切换测试：建会话 → conn_init → 让她说一句话 → 调 /api/clip/switch → 观察下行
// 用法：node scripts/clip_test.mjs <user:password> <user_id> <video_url> [delay_ms]
const BASE = process.env.BASE || 'https://127.0.0.1:8443';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { default: WebSocket } = await import('ws');

const [cred, uid, video, delay] = process.argv.slice(2);
if (!video) { console.error('用法：node scripts/clip_test.mjs <user:password> <user_id> <video_url> [delay_ms]'); process.exit(1); }
const auth = 'Basic ' + Buffer.from(cred).toString('base64');
const t0 = Date.now();
const T = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);

const me = await fetch(`${BASE}/api/me?legacy=${encodeURIComponent(uid)}`, { headers: { Authorization: auth } });
const cookie = (me.headers.get('set-cookie') || '').split(';')[0];
const r = await fetch(`${BASE}/api/session`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: auth, Cookie: cookie },
  body: JSON.stringify({ call_mode: 'video', persona: process.env.PERSONA || 'clone' }),
});
const d = await r.json();
if (!r.ok) { console.log('session failed', JSON.stringify(d)); process.exit(1); }
const id = d.live_id;
console.log('live', id);

let seq = 0, tries = 0, switched = false;
const ws = new WebSocket(`${BASE.replace('https', 'wss')}/ws?live_id=${id}&conn_id=cliptest`, { headers: { Authorization: auth, Cookie: cookie } });
const S = (type, payload) => ws.send(JSON.stringify({ type, live_id: id, conn_id: 'cliptest', seq_id: ++seq, payload }));
const init = () => S(1, { conn_init: { version: 1 } });

const doSwitch = async () => {
  switched = true;
  console.log(T(), '切换前先让她说句话');
  S(99, { text_msg: { msg_id: 'q1', content: '你好呀，今天过得怎么样？', timestamp: Date.now() } });
  setTimeout(async () => {
    const body = { live_id: id, video_url: video };
    if (delay) body.delay_ms = Number(delay);
    const res = await fetch(`${BASE}/api/clip/switch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth, Cookie: cookie }, body: JSON.stringify(body),
    });
    console.log(T(), 'POST /api/clip/switch ->', res.status, await res.text());
  }, 6000);
};

ws.on('open', init);
ws.on('message', (m) => {
  const x = JSON.parse(m);
  if (x.type === 2) {
    const a = x.payload.conn_init_ack;
    if (!a.success && a.error_code === 'NOT_READY' && tries++ < 20) return setTimeout(init, 3000);
    if (a.success) setTimeout(doSwitch, 3000);
    return;
  }
  if (x.type === 6) { console.log(T(), 'HANGUP', x.payload.hangup?.hangup_reason); process.exit(); }
  if (x.type === 103) { console.log(T(), 'ERROR', JSON.stringify(x.payload)); return; }
  if (x.type === 9) { console.log(T(), '用户:', x.payload.text_msg?.content); return; }
  if (x.type === 10) { console.log(T(), '幂幂:', x.payload.text_msg?.content?.slice(0, 40)); return; }
  console.log(T(), 'other', x.type, JSON.stringify(x.payload).slice(0, 160));
});
setTimeout(() => { S(5, { hangup: { hangup_reason: 'user_end' } }); setTimeout(() => process.exit(), 1500); }, 40000);
