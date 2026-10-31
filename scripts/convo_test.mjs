// 人设回归测试：对本地服务建一次视频会话，按顺序发文本问题，打印双方转写。
// 用法：node scripts/convo_test.mjs <user:password> <user_id> "问题1" "问题2" ...
const BASE = process.env.BASE || 'https://127.0.0.1:8443';
process.env.NODE_TLS_REJECT_UNAUTHORIZED='0';
const {default:WebSocket}=await import('ws');
const [cred, uid, ...qs]=process.argv.slice(2);
const auth='Basic '+Buffer.from(cred).toString('base64');
const t0=Date.now(); const T=()=>((Date.now()-t0)/1000).toFixed(1).padStart(5);
const r=await fetch(`${BASE}/api/session`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:auth},body:JSON.stringify({user_id:uid,call_mode:'video',persona:process.env.PERSONA||'clone'})});
const d=await r.json(); if(!r.ok){console.log('session failed',JSON.stringify(d));process.exit(1)}
const id=d.live_id; console.log('live',id); let seq=0, tries=0, qi=0, timer;
const ws=new WebSocket(`${BASE.replace('https','wss')}/ws?live_id=${id}&conn_id=t`);
const S=(type,payload)=>ws.send(JSON.stringify({type,live_id:id,conn_id:'t',seq_id:++seq,payload}));
const init=()=>S(1,{conn_init:{version:1}});
const end=()=>{S(5,{hangup:{hangup_reason:'user_end'}});setTimeout(()=>process.exit(),1500)};
const next=()=>{clearTimeout(timer); if(qi>=qs.length) return setTimeout(end,4000);
  timer=setTimeout(()=>{S(99,{text_msg:{msg_id:'q'+qi,content:qs[qi++],timestamp:Date.now()}}); timer=setTimeout(next,25000);},6000);};
ws.on('open',init);
ws.on('message',m=>{const x=JSON.parse(m);
  if(x.type===2){const a=x.payload.conn_init_ack; if(!a.success&&a.error_code==='NOT_READY'&&tries++<20) setTimeout(init,3000); else if(a.success) next(); return;}
  if(x.type===9) console.log(T(),'用户:',x.payload.text_msg?.content);
  else if(x.type===10){console.log(T(),'幂幂:',x.payload.text_msg?.content); if(qi>0) next();}
  else if(x.type===6){console.log(T(),'HANGUP',x.payload.hangup?.hangup_reason); process.exit();}
  else console.log(T(),'other',x.type,JSON.stringify(x.payload).slice(0,150));});
setTimeout(end,240000);
