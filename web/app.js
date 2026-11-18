/* global AgoraRTC */
// 1v1 视频通话客户端：RTC（Agora）承载音视频，App WebSocket（经本地服务代理）承载控制信令。

const $ = (id) => document.getElementById(id);
const ui = {
  start: $('btn-start'), mic: $('btn-mic'), cam: $('btn-cam'), interrupt: $('btn-interrupt'), hangup: $('btn-hangup'),
  status: $('status'), transcript: $('transcript'), form: $('text-form'), input: $('text-input'),
  avatar: $('avatar-video'), self: $('self-video'), placeholder: $('placeholder'),
  rec: $('btn-rec'), recState: $('rec-state'), recListBtn: $('btn-rec-list'),
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
// 标签页标题跟着人设走：选了安妮还写着"杨幂"会让人以为没切过去
function paintTitle() {
  const label = personaSelect.selectedOptions?.[0]?.textContent || '';
  const short = label.split('·')[0].trim();
  document.title = short ? `${short} · AI 数字分身（技术测试）` : 'AI 数字分身（技术测试）';
}
(async () => {
  const d = await (await fetch('/api/personas')).json();
  personaSelect.innerHTML = d.items.map((p) => `<option value="${p.key}">${p.label}</option>`).join('');
  personaSelect.value = d.items.some((p) => p.key === PERSONA) ? PERSONA : d.default;
  PERSONA = personaSelect.value;
  $('current-persona').textContent = PERSONA;
  paintTitle();
})();
personaSelect.onchange = () => {
  PERSONA = personaSelect.value;
  localStorage.setItem('yangmi_persona', PERSONA);
  $('current-persona').textContent = PERSONA;
  paintTitle();
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
  for (const b of [ui.interrupt, ui.hangup]) b.disabled = !on;
  // 本地预览可能被浏览器拒绝（没有摄像头/麦克风），没有轨道就别让按钮可点
  ui.mic.disabled = !on || !state?.mic;
  ui.cam.disabled = !on || !state?.cam;
  // 录像目前只对组件版生效（标准版没有时间窗打点）
  ui.rec.disabled = !on || state?.mode !== 'component';
  ui.input.disabled = !on;
  ui.form.querySelector('button').disabled = !on;
  paintRec(false, 0);
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
  // 组件版优先 TRTC：平台录制只有 managed_rtc.provider=trtc 能稳定出片。
  // 标准版仍然用 Agora（rtc.provider 为 artc/agora 或未下发）。
  if (rtc.provider === 'trtc') {
    if (!window.TRTC) throw new Error('TRTC SDK 未加载，请刷新页面');
    return joinTrtc(rtc);
  }
  return joinAgora(rtc);
}

async function joinAgora(rtc) {
  const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
  state.client = client;
  const playedAudio = new Set();   // 已播放过音频的远端 uid，防止重复 play() 叠音
  client.on('user-published', async (user, mediaType) => {
    await client.subscribe(user, mediaType);
    if (mediaType === 'video') {
      ui.placeholder.style.display = 'none';
      user.videoTrack.play(ui.avatar, { fit: 'contain' });
    } else if (user.audioTrack && !playedAudio.has(user.uid)) {
      // 她的声音来自 audioTrack（实测：不播它就完全没声，说明视频元素本身不带音频）。
      // 用 uid 去重：user-published 可能对同一个远端用户重复触发，
      // 重复调用 play() 会叠出多路音频元素 → 听感就是"同一句说了两遍"。
      playedAudio.add(user.uid);
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

// TRTC Web SDK v5：组件版只需要"看/听"数字人，不推流。
// 浏览器自己的摄像头只做本地预览（组件版数字人不用用户画面，语音识别走浏览器 ASR）。
async function joinTrtc(rtc) {
  const trtc = window.TRTC.create();
  state.trtc = trtc;
  trtc.on(window.TRTC.EVENT.REMOTE_VIDEO_AVAILABLE, async ({ userId, streamType }) => {
    try {
      await trtc.startRemoteVideo({ userId, streamType, view: ui.avatar, option: { fillMode: 'contain' } });
      ui.placeholder.style.display = 'none';
    } catch (e) { console.error('startRemoteVideo', e); }
  });
  trtc.on(window.TRTC.EVENT.REMOTE_USER_LEAVE, () => setStatus('数字人已离开'));
  trtc.on(window.TRTC.EVENT.ERROR, (e) => console.error('TRTC', e));
  // 远端音频默认自动播放；四个参数原样取自 rtc，userId/strRoomId 不能改写
  await trtc.enterRoom({
    sdkAppId: Number(rtc.app_id),
    userId: rtc.user_id,
    userSig: rtc.token,
    strRoomId: rtc.channel_id,
  });
  await localPreview();
}

// 本地摄像头预览（不发布）。包一层 setMuted/close，和 Agora track 的接口保持一致，
// 这样"静音/关摄像头"两个按钮不用改。
async function localPreview() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360 }, audio: true });
    const v = document.createElement('video');
    v.autoplay = true; v.muted = true; v.playsInline = true; v.srcObject = stream;
    v.style.width = '100%'; v.style.height = '100%'; v.style.objectFit = 'cover';
    ui.self.innerHTML = '';
    ui.self.appendChild(v);
    const at = stream.getAudioTracks()[0];
    const vt = stream.getVideoTracks()[0];
    state.mic = at ? { setMuted: (m) => { at.enabled = !m; }, close: () => at.stop() } : null;
    state.cam = vt ? { setMuted: (m) => { vt.enabled = !m; }, close: () => vt.stop() } : null;
    ui.mic.disabled = !at;
    ui.cam.disabled = !vt;
  } catch (e) {
    console.warn('local preview unavailable', e);
    ui.mic.disabled = true;
    ui.cam.disabled = true;
  }
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
    state = { liveId: data.live_id, connId: `web-${Date.now()}`, seq: 0, mode: data.mode || 'standard', localUserEcho: [] };
    addMsg('sys', `会话 ${data.live_id} 已创建`);

    setStatus('连接中…');
    if (state.mode === 'component') {
      // 组件版：控制 WS 在服务端，浏览器只订阅画面 + 轮询字幕 + 本地语音识别
      await joinRtc(data.rtc);
      startEventPolling();
      startSpeech();
    } else {
      // 标准版：WebSocket 与 RTC 并行建立，缺一不可
      await Promise.all([connectWs(), joinRtc(data.rtc)]);
    }
    setInCall(true);
    startCountdown(data.ends_at);
  } catch (e) {
    console.error(e);
    addMsg('sys', e.message);
    setStatus('连接失败');
    await teardown();
  }
}

// ---- 组件版：字幕来自服务端事件队列（浏览器不持有控制 WS）----
const COMPONENT = () => state?.mode === 'component';

function startEventPolling() {
  let since = 0;
  const tick = async () => {
    if (!state || !COMPONENT()) return;
    try {
      const r = await fetch(`/api/component/events?live_id=${state.liveId}&since=${since}`);
      if (r.ok) {
        const d = await r.json();
        for (const e of d.events || []) {
          since = e.i + 1;
          if (e.kind === 'user') {
            // 用户消息在发送时已经本地上屏（sendUserText），服务端这条只是回显。
            // 抵消掉对应的一条本地记录，否则同一句话会显示两遍。
            const i = state.localUserEcho.indexOf(e.text);
            if (i >= 0) state.localUserEcho.splice(i, 1);
            else addMsg('user', e.text);
          } else if (e.kind === 'assistant') {
            // 直接显示模型原样输出（含 [动作:...] 标记和语气音），动作内容也就一起看到了
            addMsg('ai', e.raw || e.text);
          } else if (e.kind === 'error') addMsg('sys', `错误：${e.error}`);
          else if (e.kind === 'first_audio') setStatus(`通话中 · 首字 ${e.ms}ms`);
        }
      } else if (r.status === 404) {
        addMsg('sys', '会话已结束');
        return teardown();
      }
    } catch { /* 网络抖动，下一轮再试 */ }
    state.poll = setTimeout(tick, 700);
  };
  tick();
}

// ---- 组件版：浏览器语音识别（Web Speech）。组件版没有平台 ASR ----
let recognition = null;
function startSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { addMsg('sys', '这个浏览器不支持语音识别，请用 Chrome/Edge，或直接打字。'); return; }
  recognition = new SR();
  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      if (!ev.results[i].isFinal) continue;
      const text = ev.results[i][0].transcript.trim();
      if (text) sendUserText(text);
    }
  };
  // 识别会自己停，停了就重启（直到挂断）
  recognition.onend = () => { if (state && COMPONENT()) { try { recognition.start(); } catch { /* ignore */ } } };
  recognition.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') console.warn('speech', e.error); };
  try { recognition.start(); } catch { /* ignore */ }
}

async function sendUserText(text) {
  if (!state) return;
  if (!COMPONENT()) {
    // 标准版：走控制 WS 的 type=99
    sendSignal(99, { text_msg: { msg_id: `m-${Date.now()}`, content: text, timestamp: Date.now() } });
    clearTimeout(state.echoTimer);
    state.echoTimer = setTimeout(onStuck, ECHO_TIMEOUT_MS);
    return;
  }
  addMsg('user', text);
  state.localUserEcho.push(text);   // 等轮询拿到服务端的同一条回显后再抵消
  try {
    await fetch('/api/component/say', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ live_id: state.liveId, text }),
    });
  } catch (e) { addMsg('sys', `发送失败：${e.message}`); }
}

async function teardown() {
  const s = state;
  state = null;
  setInCall(false);
  if (!s) return;
  clearTimeout(s.echoTimer);
  clearTimeout(s.poll);
  clearInterval(s.countdown);
  clearInterval(s.recTimer);
  // 组件版：停掉语音识别（否则 onend 会无限重启）
  if (recognition) { try { recognition.onend = null; recognition.stop(); } catch { /* ignore */ } recognition = null; }
  try { s.ws?.close(); } catch { /* ignore */ }
  for (const t of [s.mic, s.cam]) { try { t?.close(); } catch { /* ignore */ } }
  try { await s.client?.leave(); } catch { /* ignore */ }
  try { await s.trtc?.exitRoom(); } catch { /* ignore */ }
  ui.placeholder.style.display = '';
  ui.self.innerHTML = '';
  setStatus('未连接');
}

// ---- 服务端录像 ----
// 平台只能在建会话时决定"整场录制"，不能中途开关。这里的开始/停止只是记时间窗：
// 通话结束后服务端把整段 MP4 拿下来，裁掉窗口之外的部分再存到本地。
let recordingOn = false;

function paintRec(on, startedAt) {
  recordingOn = on;
  ui.rec.textContent = on ? '停止录像' : '开始录像';
  ui.rec.classList.toggle('live', on);
  ui.recState.classList.toggle('live', on);
  clearInterval(state?.recTimer);
  if (state) state.recTimer = null;
  if (!on) {
    ui.recState.textContent = startedAt ? '已停止 · 结束后生成' : '未开始';
    return;
  }
  const tick = () => {
    const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    ui.recState.textContent = `录制中 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  if (state) state.recTimer = setInterval(tick, 1000);
}

ui.rec.onclick = async () => {
  if (!state) return;
  const starting = !recordingOn;
  ui.rec.disabled = true;
  try {
    const r = await fetch(`/api/record/${starting ? 'start' : 'stop'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ live_id: state.liveId }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    paintRec(d.recording, d.started_at);
    if (!d.recording) addMsg('sys', '录像已停止。通话结束后会在「历史录像」里生成。');
  } catch (e) {
    addMsg('sys', `录像操作失败：${e.message}`);
  } finally {
    ui.rec.disabled = !state;
  }
};

// ---- 历史录像：列表 / 播放 / 下载 / 删除 ----
const recModal = $('rec-modal');
const recVideo = $('rec-video');
const recMetaEl = $('rec-meta');
const recDownload = $('rec-download');
const recDelete = $('rec-delete');
let recItems = [];
let recSelected = '';
let recListTimer = null;

const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
const fmtDur = (ms) => {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const fmtSize = (b) => (!b ? '' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const STATUS_TEXT = { processing: '生成中…', downloading: '下载中…', ready: '可播放', failed: '失败' };

function renderRecList() {
  const box = $('rec-list');
  box.innerHTML = '';
  if (!recItems.length) {
    const d = document.createElement('div');
    d.className = 'rec-empty';
    d.textContent = '还没有录像';
    box.appendChild(d);
    return;
  }
  for (const m of recItems) {
    const b = document.createElement('button');
    b.className = `rec-item${m.id === recSelected ? ' sel' : ''}`;
    b.dataset.id = m.id;
    const t = document.createElement('div');
    t.className = 'rec-item-time';
    t.textContent = fmtTime(m.created_at);
    const sub = document.createElement('div');
    sub.className = 'rec-item-sub';
    sub.textContent = `${m.persona_label || m.persona || ''} · ${STATUS_TEXT[m.status] || m.status}${m.status === 'ready' ? ` · ${fmtDur(m.duration_ms)} · ${fmtSize(m.size)}` : ''}`;
    b.append(t, sub);
    if (m.status === 'failed' && m.error) b.title = m.error;
    b.onclick = () => selectRec(m);
    box.appendChild(b);
  }
}

function selectRec(m) {
  recSelected = m.id;
  renderRecList();
  if (m.status !== 'ready') {
    recVideo.removeAttribute('src');
    recVideo.load();
    recMetaEl.textContent = m.status === 'failed'
      ? `生成失败：${m.error || '未知原因'}`
      : '服务端正在生成/下载这段录像，稍等一下…';
    recDownload.hidden = true;
    recDelete.disabled = false;
    return;
  }
  recVideo.src = m.url;
  recMetaEl.textContent = `${fmtTime(m.created_at)} · ${m.persona_label || ''} · ${fmtDur(m.duration_ms)} · ${fmtSize(m.size)}`;
  recDownload.href = m.download_url;
  recDownload.download = `avatar-${m.id}.mp4`;
  recDownload.hidden = false;
  recDelete.disabled = false;
}

async function loadRecordings() {
  try {
    const r = await fetch('/api/recordings');
    if (!r.ok) return;
    const d = await r.json();
    recItems = d.items || [];
    renderRecList();
    // 选中的那条状态变了（生成中 → 可播放）就自动刷新播放器
    const sel = recItems.find((x) => x.id === recSelected);
    if (sel && sel.status === 'ready' && recVideo.getAttribute('src') !== sel.url) selectRec(sel);
  } catch { /* 网络抖动，下次再拉 */ }
}

function openRecModal() {
  recModal.hidden = false;
  loadRecordings();
  clearInterval(recListTimer);
  recListTimer = setInterval(loadRecordings, 5000);
}
function closeRecModal() {
  recModal.hidden = true;
  clearInterval(recListTimer);
  recListTimer = null;
}

ui.recListBtn.onclick = openRecModal;
$('rec-close').onclick = closeRecModal;
recModal.onclick = (e) => { if (e.target === recModal) closeRecModal(); };

recDelete.onclick = async () => {
  if (!recSelected) return;
  if (!confirm('确定删除这条录像吗？文件会从服务器上删掉。')) return;
  const r = await fetch(`/api/recordings/${recSelected}`, { method: 'DELETE' });
  if (!r.ok) { recMetaEl.textContent = `删除失败：HTTP ${r.status}`; return; }
  recVideo.removeAttribute('src');
  recVideo.load();
  recMetaEl.textContent = '已删除';
  recDownload.hidden = true;
  recDelete.disabled = true;
  recSelected = '';
  await loadRecordings();
};

async function hangup() {
  if (recordingOn) addMsg('sys', '录像已停止，服务端会在通话结束后生成文件，稍后可在「历史录像」查看。');
  if (COMPONENT()) {
    try {
      await fetch('/api/component/hangup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ live_id: state.liveId }),
      });
    } catch { /* 已断开 */ }
    await new Promise((r) => setTimeout(r, 300));
    return teardown();
  }
  sendSignal(5, { hangup: { hangup_reason: 'user_end' } });
  // 文档建议：先关 WebSocket，再离开 RTC 频道。留一点时间给可能的告别视频
  await new Promise((r) => setTimeout(r, 300));
  await teardown();
}

async function interrupt() {
  if (!state) return;
  if (COMPONENT()) {
    await fetch('/api/component/interrupt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ live_id: state.liveId }),
    }).catch(() => {});
    return;
  }
  sendSignal(7);
}

ui.start.onclick = start;
ui.hangup.onclick = hangup;
ui.interrupt.onclick = interrupt;
ui.mic.onclick = async () => {
  if (!state?.mic) return;
  const muted = ui.mic.textContent === '取消静音';
  await state.mic.setMuted(!muted);
  ui.mic.textContent = muted ? '静音' : '取消静音';
};
ui.cam.onclick = async () => {
  if (!state?.cam) return;
  const off = ui.cam.textContent === '开摄像头';
  await state.cam.setMuted(!off);
  ui.cam.textContent = off ? '关摄像头' : '开摄像头';
};
ui.form.onsubmit = (e) => {
  e.preventDefault();
  const content = ui.input.value.trim();
  if (!content || !state) return;
  ui.input.value = '';
  if (state.mode === 'component') { sendUserText(content); return; }
  // 标准版不在本地回显：服务端会以 type=9 把这条文本回传，统一由转写渲染
  sendSignal(99, { text_msg: { msg_id: `m-${Date.now()}`, content, timestamp: Date.now() } });
  clearTimeout(state.echoTimer);
  state.echoTimer = setTimeout(onStuck, ECHO_TIMEOUT_MS);
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

