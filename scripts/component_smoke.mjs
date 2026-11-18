// P0 连通性验证：建组件版会话 → 连 WS → conn_init → 合成一句开场白并按实时节奏喂 PCM
// 用法：node --env-file=.env.global scripts/component_smoke.mjs ["要说的话"]
import { buildComponentBody, createComponentSession } from '../server/component/create.js';
import { connectComponentLive } from '../server/component/live.js';
import { synth, durationOf } from '../server/component/tts.js';

const text = process.argv[2] || '嗨，我是幂幂。今天过得怎么样？';
const t0 = Date.now();
const T = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const log = (m) => console.log(T(), m);

const avatarId = process.env.AVATAR_ID;
if (!avatarId) throw new Error('AVATAR_ID 未设置');

log('① TTS 预检');
const probe = await synth('测试');
log(`   TTS 正常，${durationOf(probe)}ms 音频，${probe.length} 字节`);

log('② 创建组件版会话');
const body = buildComponentBody({ avatarId });
log(`   请求体：${JSON.stringify(body)}`);
const sess = await createComponentSession(body);
log(`   live_id=${sess.liveId} rtc=${sess.rtc ? sess.rtc.channel_id : 'none'}`);

log('③ 连接组件版 WS');
const live = connectComponentLive({
  liveId: sess.liveId,
  connId: `smoke-${Date.now()}`,
  clientSecret: sess.clientSecret,
  onLog: (m) => log(`   ${m}`),
  onHangup: () => process.exit(1),
});
await live.ready;
log('   conn_init 完成');

log('④ 开说（观察画面是否有口型、声音是否连续）');
const started = Date.now();
await live.say(text);
log(`   播放结束，用时 ${((Date.now() - started) / 1000).toFixed(1)}s，PCM ${live.stats.audioSeconds.toFixed(2)}s`);

await new Promise((r) => setTimeout(r, 2000));
live.hangup();
setTimeout(() => { live.close(); process.exit(0); }, 800);
