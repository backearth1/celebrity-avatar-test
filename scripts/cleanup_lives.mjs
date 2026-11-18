import { WebSocket } from 'ws';
const ids = process.argv.slice(2);
for (const id of ids) {
  await new Promise((res) => {
    const ws = new WebSocket(`wss://api.vidu.com/live/v1/external-lives/${id}/stream?conn_id=cleanup-${Date.now()}`,
      { headers: { Authorization: `Token ${process.env.VIDU_API_KEY}` } });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 1, live_id: id, conn_id: `cleanup-${Date.now()}`, seq_id: 1, payload: { conn_init: { version: 1 } } }));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 5, live_id: id, conn_id: 'cleanup', seq_id: 2, payload: { hangup: { hangup_reason: 'user_end' } } }));
        setTimeout(() => { ws.close(); res(); }, 800);
      }, 2500);
    });
    ws.on('message', (m) => { try { const x = JSON.parse(m); console.log(id, 'ack', x.type, JSON.stringify(x.payload).slice(0,80)); } catch {} });
    ws.on('error', (e) => { console.log(id, 'err', e.message); res(); });
    setTimeout(res, 9000);
  });
}
process.exit(0);
