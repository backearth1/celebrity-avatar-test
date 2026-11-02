/* global AgoraRTC */
// 1v1 视频通话客户端：RTC（Agora）承载音视频，App WebSocket（经本地服务代理）承载控制信令。

const $ = (id) => document.getElementById(id);
const ui = {
  start: $('btn-start'), mic: $('btn-mic'), cam: $('btn-cam'), interrupt: $('btn-interrupt'), hangup: $('btn-hangup'),
  status: $('status'), transcript: $('transcript'), form: $('text-form'), input: $('text-input'),
  avatar: $('avatar-video'), self: $('self-video'), placeholder: $('placeholder'),
};

// 身份由服务端签发（HttpOnly cookie），记忆和会话都只认它。
// 旧版本存在 localStorage 的 user_id 作为 legacy 带上，服务端会尽量沿用，保住已有记忆。
let USER_ID = '';
let MAX_SECONDS = 300;
const identityReady = (async () => {
  const legacy = localStorage.getItem('yangmi_demo_uid') || '';
  const d = await (await fetch(`/api/me?legacy=${encodeURIComponent(legacy)}`)).json();
  USER_ID = d.user_id;
  MAX_SECONDS = d.max_seconds || MAX_SECONDS;
  localStorage.setItem('yangmi_demo_uid', USER_ID);
  $('uid').textContent = USER_ID;
  setStatus(`未连接 · 当前在线 ${d.active}/${d.max}`);
})();

// 人设选择：开始通话前切换，选中项存本地，下次默认还是它
let PERSONA = localStorage.getItem('yangmi_persona') || '';
const personaSelect = $('persona-select');
(async () => {
  const d = await (await fetch('/api/personas')).json();
  personaSelect.innerHTML = d.items.map((p) => `<option value="${p.key}">${p.label}</option>`).join('');
  personaSelect.value = d.items.some((p) => p.key === PERSONA) ? PERSONA : d.default;
  PERSONA = personaSelect.value;
  $('current-persona').textContent = PERSONA;
})();
personaSelect.onchange = () => {
  PERSONA = personaSelect.value;
  localStorage.setItem('yangmi_persona', PERSONA);
  $('current-persona').textContent = PERSONA;
  // 记忆按人设分区，切换后要把已显示的旧记忆清掉
  $('mem-out').textContent = '';
};

AgoraRTC.setLogLevel(2);

let state = null; // { liveId, connId, ws, client, mic, cam, seq }

const setStatus = (t) => { ui.status.textContent = t; };

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  ui.transcript.appendChild(div);
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
  return div;
}

function setInCall(on) {
  ui.start.disabled = on;
  for (const b of [ui.mic, ui.cam, ui.interrupt, ui.hangup]) b.disabled = !on;
  ui.input.disabled = !on;
  ui.form.querySelector('button').disabled = !on;
}

function sendSignal(type, payload = {}) {
  if (!state?.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ type, live_id: state.liveId, conn_id: state.connId, seq_id: ++state.seq, payload }));
}

// 转写事件（type 9/10）：payload 形如 { text_msg: { content } }，每帧是一句完整的话
function onTranscript(role, payload) {
  clearTimeout(state?.echoTimer);
  const text = payload?.text_msg?.content;
  if (text) addMsg(role, text);
}

// 卡死检测：服务端会话偶发卡住（画面还在，但不再处理语音和文字）。
// 正常情况下发出的文字会在 1~2 秒内以 type=9 回显；10 秒没回显就判定卡死，
// 主动挂断（卡住的会话仍在计费）并提示重连。
const ECHO_TIMEOUT_MS = 10000;
async function onStuck() {
  if (!state) return;
  console.warn('session unresponsive', state.liveId);
  addMsg('sys', `数字人没有响应，会话 ${state.liveId} 可能卡住了，已自动挂断。请点「开始视频通话」重新连接。`);
  await hangup();
}

const HANGUP_TEXT = {
  max_duration: () => `单次体验时长已到（${Math.round(MAX_SECONDS / 60)} 分钟），通话已结束。可以再点「开始视频通话」继续。`,
  no_client: () => '连接超时，通话已结束。',
  user_end: () => '通话结束。',
  credit_insufficient: () => '平台积分不足，通话已结束。',
  timeout: () => '长时间无输入，通话已结束。',
};
const hangupText = (r) => (HANGUP_TEXT[r] ? HANGUP_TEXT[r]() : `通话结束（${r || 'unknown'}）`);

// 通话倒计时：服务端到点会主动挂断，这里只负责显示
function startCountdown(endsAt) {
  const tick = () => {
    if (!state) return;
    const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    setStatus(`通话中 · 剩余 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);
    if (left === 60) addMsg('sys', '还剩 1 分钟，到点会自动结束。');
  };
  tick();
  state.countdown = setInterval(tick, 1000);
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?live_id=${state.liveId}&conn_id=${state.connId}`);
    state.ws = ws;
    let attempts = 0;
    const init = () => sendSignal(1, { conn_init: { version: 1 } });

    ws.onopen = init;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      switch (msg.type) {
        case 2: {
          const ack = msg.payload.conn_init_ack;
          if (ack.success) return resolve();
          if (ack.error_code === 'NOT_READY' && attempts++ < 15) {
            setStatus('数字人准备中…');
            return setTimeout(init, Math.min(1000 * 1.5 ** attempts, 5000));
          }
          return reject(new Error(`conn_init 失败：${ack.error_code} ${ack.error_msg}`));
        }
        case 6:
          addMsg('sys', hangupText(msg.payload?.hangup?.hangup_reason));
          return teardown();
        case 9: return onTranscript('user', msg.payload);
        case 10: return onTranscript('ai', msg.payload);
        case 103: return addMsg('sys', `错误：${JSON.stringify(msg.payload)}`);
        default: console.debug('ws', msg);
      }
    };
    ws.onerror = () => reject(new Error('WebSocket 连接失败'));
    ws.onclose = () => { if (state) { addMsg('sys', '控制连接已断开'); teardown(); } };
  });
}

async function joinRtc(rtc) {
  const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
  state.client = client;
  client.on('user-published', async (user, mediaType) => {
    await client.subscribe(user, mediaType);
    if (mediaType === 'video') {
      ui.placeholder.style.display = 'none';
      user.videoTrack.play(ui.avatar, { fit: 'contain' });
    } else {
      user.audioTrack.play();
    }
  });
  client.on('user-left', () => setStatus('数字人已离开'));

  // 文档要求：四个参数原样取自 rtc 对象，user_id 不能改写
  await client.join(rtc.app_id, rtc.channel_id, rtc.token, rtc.user_id);
  state.mic = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true });
  state.cam = await AgoraRTC.createCameraVideoTrack({ encoderConfig: '480p_1' });
  state.cam.play(ui.self);
  await client.publish([state.mic, state.cam]);
}

async function start() {
  ui.start.disabled = true;
  setStatus('创建会话…');
  try {
    await identityReady;
    const r = await fetch('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_mode: 'video', persona: PERSONA }),
    });
    const data = await r.json();
    if (r.status === 429) throw new Error(`当前体验人数已满（${data.active}/${data.max}），请稍后再试。`);
    if (r.status === 401) throw new Error('身份已失效，请刷新页面后再试。');
    if (!r.ok) throw new Error(`创建会话失败：${JSON.stringify(data.error)}`);
    state = { liveId: data.live_id, connId: `web-${Date.now()}`, seq: 0 };
    addMsg('sys', `会话 ${data.live_id} 已创建`);

    setStatus('连接中…');
    // WebSocket 与 RTC 并行建立，缺一不可
    await Promise.all([connectWs(), joinRtc(data.rtc)]);
    setInCall(true);
    startCountdown(data.ends_at);
  } catch (e) {
    console.error(e);
    addMsg('sys', e.message);
    setStatus('连接失败');
    await teardown();
  }
}

async function teardown() {
  const s = state;
  state = null;
  setInCall(false);
  if (!s) return;
  clearTimeout(s.echoTimer);
  clearInterval(s.countdown);
  try { s.ws?.close(); } catch { /* ignore */ }
  for (const t of [s.mic, s.cam]) { try { t?.close(); } catch { /* ignore */ } }
  try { await s.client?.leave(); } catch { /* ignore */ }
  ui.placeholder.style.display = '';
  ui.self.innerHTML = '';
  setStatus('未连接');
}

async function hangup() {
  sendSignal(5, { hangup: { hangup_reason: 'user_end' } });
  // 文档建议：先关 WebSocket，再离开 RTC 频道。留一点时间给可能的告别视频
  await new Promise((r) => setTimeout(r, 300));
  await teardown();
}

ui.start.onclick = start;
ui.hangup.onclick = hangup;
ui.interrupt.onclick = () => sendSignal(7);
ui.mic.onclick = async () => {
  const muted = ui.mic.textContent === '取消静音';
  await state.mic.setMuted(!muted);
  ui.mic.textContent = muted ? '静音' : '取消静音';
};
ui.cam.onclick = async () => {
  const off = ui.cam.textContent === '开摄像头';
  await state.cam.setMuted(!off);
  ui.cam.textContent = off ? '关摄像头' : '开摄像头';
};
ui.form.onsubmit = (e) => {
  e.preventDefault();
  const content = ui.input.value.trim();
  if (!content) return;
  // 不在本地回显：服务端会以 type=9 把这条文本回传，统一由转写渲染
  sendSignal(99, { text_msg: { msg_id: `m-${Date.now()}`, content, timestamp: Date.now() } });
  clearTimeout(state.echoTimer);
  state.echoTimer = setTimeout(onStuck, ECHO_TIMEOUT_MS);
  ui.input.value = '';
};

$('btn-clip-switch').onclick = async () => {
  const video = ($('clip-url').value || '').trim();
  if (!video) { $('clip-out').textContent = '请先填离线视频 URL'; return; }
  if (!state) { $('clip-out').textContent = '还没有进行中的会话，先点开始视频通话'; return; }
  $('btn-clip-switch').disabled = true;
  try {
    const r = await fetch('/api/clip/switch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ live_id: state.liveId, video_url: video }),
    });
    const d = await r.json();
    $('clip-out').textContent = r.ok
      ? `已发送：动作「${d.exit_action}」，${d.delay_ms / 1000} 秒后切换视频\n时刻 ${new Date().toLocaleTimeString()}`
      : `失败：${JSON.stringify(d)}`;
  } catch (e) {
    $('clip-out').textContent = `失败：${e.message}`;
  } finally {
    $('btn-clip-switch').disabled = false;
  }
};

$('btn-mem-list').onclick = async () => {
  const r = await fetch(`/api/memory?persona=${PERSONA}`);
  const d = await r.json();
  $('mem-out').textContent = (d.results || []).map((m) => `· ${m.memory}`).join('\n') || JSON.stringify(d, null, 1);
};
$('btn-mem-clear').onclick = async () => {
  if (!confirm('确定让她忘记关于你的所有记忆吗？')) return;
  const r = await fetch(`/api/memory?persona=${PERSONA}`, { method: 'DELETE' });
  $('mem-out').textContent = r.ok ? '已清空' : `失败：${await r.text()}`;
};

window.addEventListener('beforeunload', () => { if (state) sendSignal(5, { hangup: { hangup_reason: 'user_end' } }); });
