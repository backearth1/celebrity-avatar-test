// P1 端到端：建组件版会话 → 打字进去 → 观察 LLM/TTS/喂流时间线
// 用法：BASE=https://127.0.0.1:8444 node scripts/component_chat_test.mjs <user:password> "话1" "话2" ...
const BASE = process.env.BASE || 'https://127.0.0.1:8444';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const auth = 'Basic ' + Buffer.from(process.argv[2]).toString('base64');
const lines = process.argv.slice(3);
const t0 = Date.now();
const T = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

const me = await fetch(`${BASE}/api/me?legacy=${encodeURIComponent('comp-test-user')}`, { headers: { Authorization: auth } });
const cookie = (me.headers.get('set-cookie') || '').split(';')[0];
const H = { 'Content-Type': 'application/json', Authorization: auth, Cookie: cookie };

const r = await fetch(`${BASE}/api/session`, { method: 'POST', headers: H, body: JSON.stringify({ persona: 'clone' }) });
const d = await r.json();
if (!r.ok) { console.log('建会话失败', r.status, JSON.stringify(d)); process.exit(1); }
console.log(T(), `live=${d.live_id} mode=${d.mode} rtc=${d.rtc?.channel_id}`);

// 开场白有 3~5 秒，等它说完再开始打字，避免一上来就打断
await new Promise((res) => setTimeout(res, 7000));

for (const line of lines) {
  const s = Date.now();
  const rr = await fetch(`${BASE}/api/component/say`, { method: 'POST', headers: H, body: JSON.stringify({ live_id: d.live_id, text: line }) });
  console.log(T(), `发送「${line}」→ ${rr.status}（HTTP 往返 ${Date.now() - s}ms）`);
  await new Promise((res) => setTimeout(res, 9000));
}

await fetch(`${BASE}/api/component/hangup`, { method: 'POST', headers: H, body: JSON.stringify({ live_id: d.live_id }) });
console.log(T(), '已挂断');
process.exit(0);
