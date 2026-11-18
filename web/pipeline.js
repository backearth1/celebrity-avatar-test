/* 组件版实时链路页：所有节点数据来自 /api/component/trace 的真实事件，不是预设脚本。 */
(function () {
const $ = (s) => document.querySelector(s);
const LANES = [[85, '输入'], [275, '接入'], [465, '理解'], [655, '决策'], [845, '表达'], [1035, '渲染'], [1215, '输出']];
const OC = { v: '#8b7bff', c: '#ffb02e', x: '#3da9ff' };
const OWN = { v: 'Vidu 平台', c: '客户自建', x: '外部系统' };

// 节点坐标对齐 1290x470 画布。数据流是左→右单向：
//   用户说话 → ASR ─┐
//                    ├→ LLM ─┬→ TTS → PCM ─┐
//   记忆 → System Prompt ────┘        ├→ 动作描述 ─┼→ S2 渲染 → RTC 下行
//                                     └→ 字幕 ─────┘
// owner：v=平台 / c=我们自建 / x=外部。组件版里 LLM、ASR、TTS 全是我们自建，这是和标准版最大的差异。
const NODES = {
  mic: { x: 85, y: 210, o: 'x', n: '用户说话', d: '麦克风采集。组件版没有平台 ASR，由浏览器 Web Speech 直接识别成文字。' },
  greeting: { x: 85, y: 390, o: 'c', n: '开场白', d: '会话建立后直接进 TTS 合成，不经过 LLM，省一次模型往返。' },
  vidu_create: { x: 275, y: 80, o: 'v', n: '建会话', d: 'POST /live/s_avatar/component。组件版只负责渲染，不带 LLM/ASR/TTS/知识库。' },
  ws: { x: 275, y: 300, o: 'v', n: 'WS 通道', d: 'wss://…/external-lives/{id}/stream。类型 5 挂断 / 7 打断 / 9 动作描述 / 10 字幕，以及 PCM 二进制帧，都经这条通道送到渲染侧。' },
  memory_read: { x: 465, y: 80, o: 'c', n: '记忆读取', d: '平台 /live/v1/memories/list 拉长期记忆，交给 System Prompt 拼接。组件版没有自动检索。' },
  asr: { x: 465, y: 210, o: 'c', n: 'ASR 文字', d: '这一轮用户原话。组件版自己负责语音转文字，不走平台。' },
  kb: { x: 465, y: 330, o: 'c', n: '知识库检索', d: '拿用户原话查本地知识库（腾讯云 Embedding 向量召回 + 关键词召回，再 rerank 精排），命中片段拼进 system prompt。先过门控：只有问到她本人的作品、经历、奖项，或带年份、书名号、去年/N年前这类时间词时才查；寒暄闲聊直接跳过（节点保持暗色）。' },
  prompt: { x: 655, y: 80, o: 'c', n: 'System Prompt', d: '人设 + 预设共同记忆 + 长期记忆 + 动作规则，拼成这一次真正发给模型的 system prompt。' },
  llm: { x: 655, y: 210, h: 90, o: 'c', n: 'LLM 生成', d: '输入 System Prompt + ASR 文字 + 对话历史，流式生成回复。输出分三路：送 TTS 念出来、剥出动作描述、发字幕。' },
  tts: { x: 845, y: 80, o: 'c', n: 'TTS 合成', d: 'MiniMax speech-2.8-turbo，克隆音色，输出 24kHz s16le mono PCM。' },
  pcm: { x: 845, y: 175, o: 'c', n: 'PCM 喂流', d: '按 100ms 分片、合成多快发多快（最多领先 2s），渲染侧自行缓冲。她出声的唯一通道，同时驱动口型。' },
  action: { x: 845, y: 285, o: 'c', n: '动作描述', d: '回复里的 [动作:x] 被剥离，走 type=9 input_transcription 发给渲染侧，驱动表情和手势；说话期间距上一条 ≥5s 会补发一次连续手势，避免姿势僵住。' },
  subtitle: { x: 845, y: 380, o: 'c', n: '字幕 type=10', d: '每句文本作为字幕上行，渲染侧用来对齐字幕显示。' },
  s2: { x: 1035, y: 230, h: 320, o: 'v', n: 'S2 渲染', d: 'PCM 驱动口型，动作描述驱动表情手势，字幕对齐文本，三者合成同一路数字人视频。' },
  rtc_down: { x: 1215, y: 230, w: 140, o: 'v', n: 'RTC 下行', d: 'managed_rtc（默认 trtc，录像需要）推流，浏览器订阅画面。' },
};

// 旧 id → 新 id。trace 里 ws_connect 与 ws 现在合成一个"WS 通道"节点。
const ALIAS = { ws_connect: 'ws' };

// 连线：从 → 到。第三项是自定义路径（顶部/底部绕行，避免长边横穿节点）。
const EDGES = [
  ['mic', 'asr'],           // 用户原话进识别
  ['asr', 'llm'],           // 识别结果直接进 LLM
  ['asr', 'kb'],            // 同一句拿去查知识库
  ['kb', 'prompt'],         // 命中的片段拼进 system prompt
  ['memory_read', 'prompt'], // 长期记忆进 System Prompt
  ['prompt', 'llm'],        // 人设+记忆 → LLM
  ['llm', 'tts'],           // 输出①：文本 → 语音
  ['tts', 'pcm'],
  ['pcm', 's2'],
  ['llm', 'action'],        // 输出②：直接给渲染侧的动作描述
  ['action', 's2'],
  ['llm', 'subtitle'],      // 输出③：字幕
  ['subtitle', 's2'],
  ['greeting', 'tts', 'M85 416 L85 440 L830 440 L830 106'],
  ['vidu_create', 'ws'],
  ['ws', 's2', 'M275 326 L275 458 L1035 458 L1035 390'],
  ['s2', 'rtc_down'],
];

const W = (n) => n.w || 150, H = (n) => n.h || 52;
const N = (id) => NODES[ALIAS[id] || id];

function path(a, b, custom) {
  if (custom) return custom;
  const A = N(a), B = N(b);
  if (!A || !B) return '';
  if (Math.abs(A.x - B.x) < 5) {
    const x = A.x + W(A) / 2;
    return `M${x} ${A.y} C${x + 48} ${A.y},${x + 48} ${B.y},${x} ${B.y}`;
  }
  const fwd = B.x > A.x;
  const x1 = A.x + (fwd ? 1 : -1) * W(A) / 2, x2 = B.x - (fwd ? 1 : -1) * W(B) / 2;
  const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (fwd ? 1 : -1);
  return `M${x1} ${A.y} C${x1 + dx} ${A.y},${x2 - dx} ${B.y},${x2} ${B.y}`;
}

let selected = null;
let counts = {};   // node -> 这次会话里出现过的次数

function drawSvg() {
  let h = '';
  // 箭头：每条边按自己的描边色画指向，默认暗色，亮起时跟着变色
  h += `<defs>
    <marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#4a5270"/></marker>
    <marker id="arw-done" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#8b93b3"/></marker>
    <marker id="arw-cur" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#ffffff"/></marker>
  </defs>`;
  LANES.forEach(([x, label]) => {
    h += `<rect class="lanebg" x="${x - 88}" y="36" width="176" height="420" rx="12"/>`;
    h += `<text class="lane" x="${x}" y="22" text-anchor="middle">${label}</text>`;
  });
  EDGES.forEach(([a, b, custom]) => { h += `<path class="edge" id="e-${a}-${b}" d="${path(a, b, custom)}" marker-end="url(#arw)"/>`; });
  Object.entries(NODES).forEach(([id, n]) => {
    const w = W(n), hh = H(n);
    h += `<g class="node dim" id="n-${id}" data-n="${id}" style="--oc:${OC[n.o]}">`
      + `<rect x="${n.x - w / 2}" y="${n.y - hh / 2}" width="${w}" height="${hh}" rx="10"/>`
      + `<text x="${n.x}" y="${n.y - (n.h ? 12 : 7)}">${n.n}</text>`
      + `<text class="ow" x="${n.x}" y="${n.y + (n.h ? 10 : 12)}">${OWN[n.o]}</text>`
      + `<text class="cnt" id="c-${id}" x="${n.x}" y="${n.y + (n.h ? 30 : 26)}"></text></g>`;
  });
  $('#svg').innerHTML = h;
}

// 每轮的起点：mic（用户开口）。用它切分轮次，图只反映"当前这一轮"的流转。
const TURN_START = 'mic';
// 建会话/通道/推流这些是一次性的底座，不属于任何一轮，始终算"在"。
const BASE_NODES = new Set(['vidu_create', 'ws', 'rtc_down', 'greeting']);

// 从事件流里取出"当前轮"的节点集合，以及最新事件的节点（用于高亮）。
function currentTurn(events) {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const key = ALIAS[events[i].node] || events[i].node;
    if (key === TURN_START) { start = i; break; }
  }
  const nodes = {};
  for (const e of events.slice(start)) {
    const key = ALIAS[e.node] || e.node;
    // 门控判定"不查库"的那一轮：知识库节点保持暗色，表示这一轮没走这条路
    if (key === 'kb' && e.output?.skipped) continue;
    nodes[key] = (nodes[key] || 0) + 1;
  }
  const lastKey = events.length ? (ALIAS[events[events.length - 1].node] || events[events.length - 1].node) : null;
  return { nodes, last: lastKey };
}

function paint(events = []) {
  const { nodes, last } = currentTurn(events);
  document.querySelectorAll('.node').forEach((g) => g.classList.remove('done', 'cur', 'dim', 'sel'));
  document.querySelectorAll('.edge').forEach((e) => e.classList.remove('done', 'cur'));

  Object.keys(NODES).forEach((id) => {
    const g = $('#n-' + id);
    if (!g) return;
    const c = nodes[id];
    if (!c && !BASE_NODES.has(id)) { g.classList.add('dim'); return; }
    g.classList.add('done');
    const el = $('#c-' + id);
    if (el) el.textContent = c > 1 ? `×${c}` : '';
  });

  // 高亮 = 最新那条事件所在的节点（不是"最后遍历到的节点"）
  if (last && NODES[last]) {
    $('#n-' + last)?.classList.add('cur');
    EDGES.forEach(([a, b]) => {
      const live = (id) => nodes[id] || BASE_NODES.has(id);
      if (b === last && live(a)) $(`#e-${a}-${b}`)?.classList.add('cur');
      else if (live(a) && live(b)) $(`#e-${a}-${b}`)?.classList.add('done');
    });
  }
  if (selected) $('#n-' + selected)?.classList.add('sel');
}

// ---------- 会话状态 ----------
let liveId = null, maxSeconds = 300, client = null, trtc = null, timer = null, since = 0, allEvents = [], endsAt = 0;
let recognition = null, listening = false;

// 身份：服务端签发的 HttpOnly cookie。首次加载必须领一次，否则 /api/session 会 401。
const identityReady = (async () => {
  const legacy = localStorage.getItem('yangmi_demo_uid') || '';
  const r = await fetch(`/api/me?legacy=${encodeURIComponent(legacy)}`);
  const d = await r.json();
  if (d.user_id) localStorage.setItem('yangmi_demo_uid', d.user_id);
  return d;
})();

const setConn = (text, cls) => { const el = $('#conn'); el.textContent = text; el.className = `pill ${cls || ''}`; };

async function api(pathname, opts) {
  const r = await fetch(pathname, opts);
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}

// 人设：切换后记忆分区、system prompt、开场白都跟着变（同一套链路，两个人设）
let PERSONA = localStorage.getItem('yangmi_persona')
  || new URLSearchParams(location.search).get('persona') || 'clone';
(async () => {
  try {
    const d = await (await fetch('/api/personas')).json();
    const sel = $('#persona-sel');
    sel.innerHTML = d.items.map((p) => `<option value="${p.key}">${p.label}</option>`).join('');
    sel.value = d.items.some((p) => p.key === PERSONA) ? PERSONA : d.default;
    PERSONA = sel.value;
    paintBrand();
  } catch { /* 列表拉不到就沿用默认 */ }
})();
// 页头品牌跟着人设走，别选了安妮还写着"幂幂"
function paintBrand() {
  const opt = $('#persona-sel').selectedOptions?.[0];
  const short = opt ? opt.textContent.split('·')[0].trim() : '';
  const el = $('#brand-name');
  if (el && short) el.textContent = short;
}
$('#persona-sel').onchange = (e) => {
  PERSONA = e.target.value;
  localStorage.setItem('yangmi_persona', PERSONA);
  paintBrand();
  if (liveId) { setConn('人设已切换，下次会话生效'); }
};

async function startSession() {
  $('#btn-start').disabled = true;
  setConn('创建中…');
  await identityReady; // 先拿到签名 cookie，否则 401
  const { ok, d } = await api('/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona: PERSONA }),
  }).catch((e) => ({ ok: false, d: { error: e.message } }));
  if (!ok) { setConn('创建失败', 'bad'); $('#btn-start').disabled = false; alert(`创建会话失败：${JSON.stringify(d)}`); return; }
  liveId = d.live_id; maxSeconds = d.max_seconds || 300; endsAt = d.ends_at || Date.now() + maxSeconds * 1000;
  since = 0; allEvents = []; counts = {};
  paint([]);
  $('#steps').innerHTML = '';
  setConn(`已连接 ${liveId}`, 'on');
  $('#btn-hangup').disabled = false;
  $('#btn-send').disabled = false;
  $('#btn-mic').disabled = false;
  await joinRtc(d.rtc);
  poll();
  startCountdown();
  $('#btn-start').disabled = false;
}

async function joinRtc(info) {
  if (!info) return;
  // 实际生效的 provider 以创建会话响应为准：组件版默认 trtc（录像只有 trtc 出片），
  // 标准版仍是 artc/agora。用错 SDK 的表现就是入会"成功"但永远没有画面。
  if (info.provider === 'trtc') return joinTrtc(info);
  return joinAgora(info);
}

async function joinAgora(info) {
  client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
  const playedAudio = new Set();
  client.on('user-published', async (user, mediaType) => {
    await client.subscribe(user, mediaType);
    if (mediaType === 'video') {
      $('#ph').style.display = 'none';
      const s = $('#rtc'); if (s) s.textContent = '已订阅';
      user.videoTrack.play($('#avatar-video'), { fit: 'contain' });
    }
    // 她的声音来自 audioTrack（实测：不播它就完全没声）。
    // 用 uid 去重，避免 user-published 重复触发时叠出多路音频 → "同一句说两遍"。
    else if (user.audioTrack && !playedAudio.has(user.uid)) { playedAudio.add(user.uid); user.audioTrack.play(); }
  });
  await client.join(info.app_id, info.channel_id, info.token, info.user_id);
}

// TRTC Web SDK v5：远端音频默认自动播放，只需要手动把远端视频挂到视图上。
async function joinTrtc(info) {
  if (!window.TRTC) throw new Error('TRTC SDK 未加载，请刷新页面');
  trtc = window.TRTC.create();
  trtc.on(window.TRTC.EVENT.REMOTE_VIDEO_AVAILABLE, async ({ userId, streamType }) => {
    try {
      await trtc.startRemoteVideo({ userId, streamType, view: $('#avatar-video'), option: { fillMode: 'contain' } });
      $('#ph').style.display = 'none';
      const s = $('#rtc'); if (s) s.textContent = '已订阅';
    } catch (e) { console.error('startRemoteVideo', e); }
  });
  trtc.on(window.TRTC.EVENT.REMOTE_USER_LEAVE, () => setConn('数字人已离开', 'bad'));
  trtc.on(window.TRTC.EVENT.ERROR, (e) => console.error('TRTC', e));
  // 四个参数原样取自创建响应，userId / strRoomId 不能改写
  await trtc.enterRoom({
    sdkAppId: Number(info.app_id),
    userId: info.user_id,
    userSig: info.token,
    strRoomId: info.channel_id,
  });
}

function startCountdown() {
  clearInterval(timer);
  timer = setInterval(() => {
    const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    if (liveId) setConn(`通话中 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`, 'on');
    if (left === 0) hangup();
  }, 1000);
}

let lastTs = 0;
async function poll() {
  if (!liveId) return;
  const { ok, d } = await api(`/api/component/trace?live_id=${liveId}&since=${since}&ts=${lastTs}`).catch(() => ({ ok: false }));
  if (ok && d.events) {
    lastTs = d.now || lastTs;
    // 已拉过的事件被服务端补写（LLM 生成完补 output）：原地替换
    let touched = new Set();
    for (const u of d.updated || []) {
      const k = allEvents.findIndex((e) => e.i === u.i);
      if (k >= 0) { allEvents[k] = u; touched.add(ALIAS[u.node] || u.node); }
    }
    if (d.events.length) {
      d.events.forEach((e) => { allEvents.push(e); const key = ALIAS[e.node] || e.node; counts[key] = (counts[key] || 0) + 1; touched.add(key); });
      since = d.last + 1;
    }
    if (touched.size) {
      renderSteps();
      paint(allEvents);
      // 选中节点时：只有它自己有新数据才重绘，否则长文面板每秒闪一次、滚动位置丢失
      if (selected) { if (touched.has(selected)) showNode(selected); }
      else showLatest();
    }
  }
  setTimeout(poll, 900);
}

const NODE_NAME = (id) => { const n = N(id); return n ? n.n : id; };

function brief(e) {
  const v = e.output ?? e.input;
  if (v == null) return e.note || '';
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').slice(0, 90);
  try { return JSON.stringify(v).slice(0, 90); } catch { return ''; }
}

function renderSteps() {
  const box = $('#steps');
  const follow = $('#follow').checked;
  box.innerHTML = allEvents.map((e, i) => `<li data-i="${i}" style="--oc:${OC[N(e.node).o]}">`
    + `<em>${(e.rel / 1000).toFixed(2)}s</em>`
    + `<div><small>${NODE_NAME(e.node)}</small><span class="out">${brief(e)}</span></div></li>`).join('');
  $('#cnt').textContent = allEvents.length;
  if (follow) box.scrollTop = box.scrollHeight;
}

function fmtJSON(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

// 右侧面板内部滚动，不再重写 #art 本身（否则会把 .art-inner 容器冲掉）
const artEl = () => $('#art .art-inner');

// ---------- 大字段全文：事件里只放 {blob:id}，这里按需拉取并缓存 ----------
const blobCache = new Map();
async function fetchBlob(id) {
  if (blobCache.has(id)) return blobCache.get(id);
  const r = await fetch(`/api/component/blob?live_id=${liveId}&id=${encodeURIComponent(id)}`);
  const v = r.ok ? (await r.json()).value : `（拉取失败：${r.status}）`;
  blobCache.set(id, v);
  return v;
}
// 找出对象里所有 {blob} 引用，返回 [{path, id}]
function findBlobs(v, path = []) {
  if (!v || typeof v !== 'object') return [];
  if (typeof v.blob === 'string') return [{ path: path.join('.'), id: v.blob }];
  return Object.entries(v).flatMap(([k, x]) => findBlobs(x, [...path, k]));
}
const BLOB_LABEL = {
  'input.full_messages': '完整请求 messages（system + 历史 + 本轮）',
  'output.system_prompt': '完整 system prompt',
  'output.raw': '模型原始输出（剥离动作 / 语气音标记之前）',
};
function renderFull(v) {
  if (Array.isArray(v) && v.every((m) => m && m.role)) {
    return v.map((m, i) => `━━ [${i}] ${m.role} ━━（${String(m.content).length} 字）\n${m.content}`).join('\n\n');
  }
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}
// 把一个事件的所有全文挂到面板末尾（container 是要追加到的元素）
async function attachBlobs(e, container) {
  const refs = [...findBlobs(e.input, ['input']), ...findBlobs(e.output, ['output'])];
  for (const { path, id } of refs) {
    const box = document.createElement('div');
    box.innerHTML = `<div class="lbl">${BLOB_LABEL[path] || path} · 全文</div><pre class="full">加载中…</pre>`;
    container.appendChild(box);
    const v = await fetchBlob(id);
    box.querySelector('pre').textContent = renderFull(v);
  }
}
const setArt = (html, owner) => {
  $('#art').style.setProperty('--oc', OC[owner]);
  artEl().innerHTML = html;
};

function showLatest() {
  const e = allEvents[allEvents.length - 1];
  if (!e) return;
  const n = N(e.node);
  setArt(`<div class="h"><h3>${NODE_NAME(e.node)}</h3>`
    + `<span class="tag">${OWN[n.o]}</span>`
    + `<span class="t">t+${(e.rel / 1000).toFixed(2)}s</span>`
    + `${e.ms != null ? `<span class="ms">耗时 ${e.ms}ms</span>` : ''}</div>`
    + `${e.note ? `<p class="no">${e.note}</p>` : ''}`
    + `${e.input !== undefined ? `<div class="lbl">输入</div><pre></pre>` : ''}`
    + `${e.output !== undefined ? `<div class="lbl">输出</div><pre></pre>` : ''}`
    + `<div class="lbl">这个节点做什么</div><p class="desc">${n.d}</p>`, n.o);
  const pres = document.querySelectorAll('#art pre');
  let k = 0;
  if (e.input !== undefined) pres[k++].textContent = fmtJSON(e.input);
  if (e.output !== undefined) pres[k].textContent = fmtJSON(e.output);
  attachBlobs(e, artEl());
}

function showNode(id) {
  const n = NODES[id];
  if (!n) return;
  const hits = allEvents.filter((e) => (ALIAS[e.node] || e.node) === id);
  // 最新的排最前面：按时间正序排的话，面板顶部永远是最旧的那一条，
  // 后面几轮的动作被挤到下方滚动区外，看起来就像"一直没更新"。
  const recent = hits.slice().reverse();
  const shown = recent.slice(0, 6);
  const art = $('#art .art-inner');
  const keepScroll = art ? art.scrollTop : 0;
  setArt(`<div class="h"><h3>${n.n}</h3><span class="tag">${OWN[n.o]}</span>`
    + `<span class="t">本次会话 ${hits.length} 次${hits.length > shown.length ? ` · 显示最近 ${shown.length} 次` : ''}</span></div>`
    + `<p class="no">${n.d}</p>`
    + (shown.length
      ? shown.map((e, i) => `<div class="lbl">${i === 0 ? '<b style="color:#46d39a">最新</b> · ' : ''}`
        + `t+${(e.rel / 1000).toFixed(2)}s · ${e.note || ''}${e.ms != null ? ` · ${e.ms}ms` : ''}</div>`
        + `<pre>${escapeHtml([e.input !== undefined ? `输入：\n${fmtJSON(e.input)}` : '', e.output !== undefined ? `输出：\n${fmtJSON(e.output)}` : ''].filter(Boolean).join('\n\n'))}</pre>`
        + `<div class="fulls" data-ev="${e.i}"></div>`).join('')
      : '<p class="desc">这次会话还没有经过这个节点。</p>'), n.o);
  // 每条记录下面挂全文（只展开最新那条；其余点"展开"再拉，避免一次拉 6 份几千字）
  document.querySelectorAll('#art .fulls').forEach((box, i) => {
    const e = shown[i];
    if (!findBlobs(e.input, ['input']).length && !findBlobs(e.output, ['output']).length) return;
    if (i === 0) { attachBlobs(e, box); return; }
    box.innerHTML = '<button class="btn mini-btn">展开全文</button>';
    box.firstChild.onclick = (ev) => { ev.stopPropagation(); box.innerHTML = ''; attachBlobs(e, box); };
  });
  // 刷新时保留用户的滚动位置，别每次都跳回顶部
  if (art && keepScroll) art.scrollTop = keepScroll;
}

function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// ---------- 输入 ----------
async function say(text) {
  if (!liveId) { alert('先点「开始会话」'); return; }
  const t = (text || '').trim();
  if (!t) return;
  await api('/api/component/say', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ live_id: liveId, text: t }),
  });
}

$('#btn-start').onclick = startSession;
$('#btn-send').onclick = () => { const v = $('#say').value; $('#say').value = ''; say(v); };
$('#say').onkeydown = (e) => { if (e.key === 'Enter') $('#btn-send').click(); };

$('#btn-mic').onclick = () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { alert('这个浏览器不支持语音识别，请用 Chrome / Edge，或直接打字。'); return; }
  if (listening) { recognition.onend = null; recognition.stop(); listening = false; $('#btn-mic').classList.remove('on'); $('#btn-mic').textContent = '🎤 说话'; return; }
  recognition = new SR();
  recognition.lang = 'zh-CN'; recognition.continuous = true; recognition.interimResults = true;
  recognition.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      if (!ev.results[i].isFinal) continue;
      const text = ev.results[i][0].transcript.trim();
      if (text) say(text);
    }
  };
  recognition.onend = () => { if (listening) { try { recognition.start(); } catch { /* ignore */ } } };
  recognition.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') $('#say').placeholder = `识别出错：${e.error}`; };
  listening = true;
  $('#btn-mic').classList.add('on'); $('#btn-mic').textContent = '● 录音中（点停）';
  recognition.start();
};

async function hangup() {
  if (!liveId) return;
  const id = liveId; liveId = null;
  clearInterval(timer);
  if (listening && recognition) { recognition.onend = null; recognition.stop(); listening = false; }
  await api('/api/component/hangup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ live_id: id }),
  }).catch(() => {});
  if (client) { try { await client.leave(); } catch { /* ignore */ } client = null; }
  if (trtc) { try { await trtc.exitRoom(); } catch { /* ignore */ } trtc = null; }
  $('#avatar-video').innerHTML = ''; $('#ph').style.display = '';
  setConn('已挂断');
  $('#btn-hangup').disabled = true; $('#btn-send').disabled = true; $('#btn-mic').disabled = true;
  $('#btn-mic').classList.remove('on'); $('#btn-mic').textContent = '🎤 说话';
}
$('#btn-hangup').onclick = hangup;

document.addEventListener('click', (e) => {
  const li = e.target.closest('.steps li');
  if (li) { const ev = allEvents[+li.dataset.i]; selected = ev.node; paint(allEvents); showNode(selected); return; }
  const g = e.target.closest('.node');
  if (g) { selected = g.dataset.n; paint(allEvents); showNode(selected); return; }
  // 点面板空白处：回到"最新事件"
  if (e.target.closest('#art') || e.target.closest('.steps li.empty')) { selected = null; showLatest(); paint(allEvents); }
});

drawSvg();
paint([]);
// 调试钩子：自动化测试和排查用
window.__pl = { liveId: () => liveId, events: () => allEvents, counts: () => counts, selected: () => selected };
$('#legend').innerHTML = Object.entries(OWN).map(([k, v]) => `<span><i style="background:${OC[k]}"></i>${v}</span>`).join('');
$('#btn-send').disabled = true; $('#btn-mic').disabled = true; $('#btn-hangup').disabled = true;
})();

