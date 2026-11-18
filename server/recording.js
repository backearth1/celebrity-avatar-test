// 服务端录像：平台录制 → 本地落盘 → 按"开始/停止录像"的时间窗裁剪。
//
// 组件版平台录制：创建会话时传 managed_rtc.enable_recording=true（见 component/create.js）。
// 录制文件由平台异步生成，会话结束后通常 1 分钟内可查到下载地址，地址 24 小时有效。
// 实测：
//   - provider=trtc 正常出片（720x960 H.264 + AAC，时长≈通话时长）
//   - provider=agora 查询一直返回 query_failed（poll recording files timeout），不出片
// 所以组件版默认走 trtc（见 service.js 的 RTC_PROVIDER）。
//
// 平台只能整场录制，不能中途开关。前端"开始/停止录像"记的是时间窗：
// 会话结束后把整段 MP4 下载下来，用 ffmpeg 裁掉时间窗之外的部分。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PERSONAS, getPersona } from './personas.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.resolve(ROOT, process.env.RECORDING_DIR || 'recordings');
fs.mkdirSync(DIR, { recursive: true });

const HOST = process.env.VIDU_HOST || 'api.vidu.com';
const KEY = process.env.VIDU_API_KEY;
const POLL_MS = Number(process.env.RECORDING_POLL_MS || 10000);
const TIMEOUT_MS = Number(process.env.RECORDING_TIMEOUT_MS || 15 * 60 * 1000);
const KEEP_RAW = process.env.RECORDING_KEEP_RAW === 'true';

const jobs = new Map();      // liveId -> { cancelled: false }
const asyncs = new Set();    // 进行中的 promise，进程退出前可等（测试用）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idOk = (id) => /^\d+$/.test(String(id || ''));
const mp4Path = (id) => path.join(DIR, `${id}.mp4`);
const jsonPath = (id) => path.join(DIR, `${id}.json`);

function log(...a) { console.log('[rec]', ...a); }

async function viduGet(urlPath) {
  const r = await fetch(`https://${HOST}${urlPath}`, { headers: { Authorization: `Token ${KEY}` } });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: r.status, data };
}

function writeMeta(meta) {
  const tmp = `${jsonPath(meta.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, jsonPath(meta.id));
}

function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(jsonPath(id), 'utf-8')); } catch { return null; }
}

function updateMeta(id, patch) {
  const m = readMeta(id);
  if (!m) return null;
  Object.assign(m, patch);
  writeMeta(m);
  return m;
}

function personaLabel(key) {
  try { return getPersona(key).label || key; } catch { return key; }
}

// 对外展示的元数据：加上人设名、播放地址，不暴露本地路径
function publicMeta(m) {
  if (!m) return null;
  return {
    id: m.id,
    live_id: m.live_id,
    persona: m.persona,
    persona_label: personaLabel(m.persona),
    created_at: m.created_at,
    record_start: m.record_start,
    record_stop: m.record_stop,
    duration_ms: m.duration_ms,
    size: m.size,
    status: m.status,
    error: m.error || '',
    url: m.status === 'ready' ? `/api/recordings/${m.id}/file` : '',
    download_url: m.status === 'ready' ? `/api/recordings/${m.id}/file?download=1` : '',
  };
}

export function listRecordings(owner) {
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf-8'));
      if (owner && m.owner && m.owner !== owner) continue;
      if (m.status === 'deleted') continue;
      out.push(publicMeta(m));
    } catch { /* 坏文件跳过 */ }
  }
  return out.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

export function getRecording(id, owner) {
  if (!idOk(id)) return null;
  const m = readMeta(id);
  if (!m || m.status === 'deleted') return null;
  if (owner && m.owner && m.owner !== owner) return null;
  return m;
}

export function recordingFile(id, owner) {
  const m = getRecording(id, owner);
  if (!m || m.status !== 'ready') return null;
  const f = mp4Path(id);
  try { fs.accessSync(f); } catch { return null; }
  return f;
}

// 删除：先打标记（正在跑的任务看到标记就收手），再删文件
export function deleteRecording(id, owner) {
  const m = getRecording(id, owner);
  if (!m) return false;
  const job = jobs.get(String(id));
  if (job) job.cancelled = true;
  for (const f of [mp4Path(id), `${id}.download.mp4`, `${id}.raw.mp4`,
    `${mp4Path(id)}.part`, `${id}.raw.mp4.part`, jsonPath(id)]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  log(`deleted ${id}`);
  return true;
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`下载录播失败 HTTP ${r.status}`);
  const part = `${dest}.part`;
  await fsp.rm(part, { force: true });
  const fh = await fsp.open(part, 'w');
  try {
    for await (const chunk of r.body) await fh.write(chunk);
  } finally { await fh.close(); }
  await fsp.rename(part, dest);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { if (err.length < 8000) err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}: ${err.slice(-400)}`))));
  });
}

async function probeDuration(file) {
  const out = await new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', file]);
    let s = '';
    p.stdout.on('data', (d) => { s += d; });
    p.on('error', reject);
    p.on('close', () => resolve(s.trim()));
  });
  const n = Number(out);
  return Number.isFinite(n) ? n : 0;
}

// 等平台把录播文件生成好。query_failed 是平台侧的生成超时，继续等一会儿；
// start/stop/transfer_failed 是确定的失败，直接放弃。
async function waitForUrl(liveId, job) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    if (job.cancelled) throw new Error('cancelled');
    const { status, data } = await viduGet(`/live/v1/lives/${liveId}/recording`);
    if (status === 200) {
      const rec = data.recording || {};
      if (rec.video_url) return rec.video_url;
      if (rec.enabled === false) throw new Error('平台没有开启录制（enable_recording=false）');
      const code = rec.error_code || 'unspecified';
      if (['start_failed', 'stop_failed', 'transfer_failed'].includes(code)) {
        throw new Error(`平台录制失败：${code} ${rec.error_message || ''}`.trim());
      }
      if (code !== last) { log(`${liveId} 等待录播：${code} ${rec.error_message || ''}`); last = code; }
    } else {
      log(`${liveId} 查询录播 HTTP ${status}`);
    }
    await sleep(POLL_MS);
  }
  throw new Error('等待平台生成录播超时');
}

// 把墙钟时间换算成录制文件里的偏移。锚点选择很重要：
//   - 用 live.start_time 做锚点会偏：实测录制并不是从 start_time 就开始，
//     渲染侧要等 2~3 秒才开始推流，整段录下来比 [start_time, end_time] 短。
//     按 start_time 换算，开头会被多裁掉几秒（用户反馈"录少了"）。
//   - 改成"录制结束 ≈ 会话结束"来反推开头：anchor = ended_at - 文件时长。
//     这样裁剪窗口的时长精确等于用户按下的 开始→停止 间隔（录不到的部分会被 clamp）。
// 拿不到 ended_at 时才退回 live.start_time。
async function trimWindow(meta, fullSec = 0) {
  let anchorMs = null;
  if (meta.ended_at && fullSec > 0) anchorMs = meta.ended_at - fullSec * 1000;
  if (!anchorMs) {
    try {
      const { status, data } = await viduGet(`/live/v1/lives/${meta.live_id}`);
      const st = Number(data?.live?.start_time);
      if (status === 200 && st > 0) anchorMs = st * 1000;
    } catch { /* 用兜底锚点 */ }
  }
  if (!anchorMs) anchorMs = meta.started_at || meta.record_start;
  const startSec = Math.max(0, (meta.record_start - anchorMs) / 1000);
  // 停止点：用户按过"停止录像"就用那个时刻，否则用会话结束时刻（排队时记的 ended_at）。
  // 不能用 Date.now()：下载可能要等一两分钟，会把窗口拉长到下载时刻。
  const stopMs = meta.record_stop || meta.ended_at || Date.now();
  const stopSec = Math.max(startSec + 1, (stopMs - anchorMs) / 1000);
  return { startSec, stopSec };
}

async function processJob(meta, job) {
  const id = meta.id;
  try {
    log(`${id} 等待平台录播…`);
    const url = await waitForUrl(id, job);
    if (job.cancelled) return;
    updateMeta(id, { status: 'downloading' });
    log(`${id} 下载录播`);
    const raw = path.join(DIR, `${id}.raw.mp4`);
    await download(url, raw);
    if (job.cancelled) { await fsp.rm(raw, { force: true }); return; }

    const fullSec = await probeDuration(raw);
    const { startSec, stopSec } = await trimWindow(meta, fullSec);
    // 时间窗几乎覆盖整场：直接改名，不重编码（省时间、不损画质）
    const whole = startSec < 1.5 && (fullSec <= 0 || stopSec >= fullSec - 1.5);
    const dur = whole ? (fullSec || 0) : Math.max(1, Math.min(stopSec, fullSec || stopSec) - startSec);
    const out = mp4Path(id);
    if (whole) {
      await fsp.rename(raw, out);
    } else {
      log(`${id} 裁剪 ${startSec.toFixed(1)}s ~ ${(startSec + dur).toFixed(1)}s / ${fullSec.toFixed(1)}s`);
      // 重编码保证切点准（-c copy 只能切在关键帧上，前后会差好几秒）
      await run('ffmpeg', [
        '-y', '-ss', startSec.toFixed(2), '-i', raw, '-t', dur.toFixed(2),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out,
      ]);
      if (!KEEP_RAW) await fsp.rm(raw, { force: true });
    }
    if (job.cancelled) return;
    const sec = await probeDuration(out);
    const size = (await fsp.stat(out)).size;
    updateMeta(id, {
      status: 'ready', duration_ms: Math.round(sec * 1000), size,
      trimmed_start_s: whole ? 0 : +startSec.toFixed(2),
      trimmed_end_s: whole ? +(fullSec || sec).toFixed(2) : +(startSec + dur).toFixed(2),
      ready_at: Date.now(),
    });
    log(`${id} 完成 ${sec.toFixed(1)}s ${(size / 1048576).toFixed(1)}MB`);
  } catch (e) {
    if (job.cancelled || /cancelled/.test(e.message)) return;
    log(`${id} 失败：${e.message}`);
    updateMeta(id, { status: 'failed', error: e.message });
  } finally {
    jobs.delete(id);
    // 删除发生在裁剪过程中：元数据已被 deleteRecording 删掉，这里清掉写完的中间文件
    if (job.cancelled) {
      for (const f of [mp4Path(id), `${id}.raw.mp4`, `${id}.raw.mp4.part`]) {
        await fsp.rm(f, { force: true }).catch(() => {});
      }
    }
  }
}

// 会话结束时调用：有录像窗口才建任务
export function queueRecording(entry) {
  if (!entry?.recordStart) return null;
  const id = String(entry.liveId);
  if (!idOk(id)) return null;
  const exist = readMeta(id);
  if (exist && exist.status === 'ready') return exist;
  const meta = {
    id, live_id: id,
    owner: entry.userId || '',
    persona: entry.persona || '',
    created_at: Date.now(),
    started_at: entry.startedAt || null,
    ended_at: Date.now(),
    record_start: entry.recordStart,
    record_stop: entry.recordStop || null,
    status: 'processing',
    error: '',
    duration_ms: null,
    size: null,
  };
  writeMeta(meta);
  const job = { cancelled: false };
  jobs.set(id, job);
  log(`${id} 排队（人设 ${meta.persona}，窗口 ${new Date(meta.record_start).toISOString()} ~ ${meta.record_stop ? new Date(meta.record_stop).toISOString() : '通话结束'}）`);
  const p = processJob(meta, job).finally(() => asyncs.delete(p));
  asyncs.add(p);
  return meta;
}

// 服务重启后把还在 processing 的任务捡回来（平台录播地址 24 小时内有效）
export function resumePending() {
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf-8'));
      // 只捡最近 20 小时内结束的，太老的多半地址已失效
      if (m.status !== 'processing' && m.status !== 'downloading') continue;
      if (Date.now() - (m.created_at || 0) > 20 * 3600 * 1000) {
        updateMeta(m.id, { status: 'failed', error: '服务重启太久，平台录播地址可能已失效' });
        continue;
      }
      if (m.status === 'downloading') updateMeta(m.id, { status: 'processing' });
      const job = { cancelled: false };
      jobs.set(m.id, job);
      log(`${m.id} 恢复未完成的录制任务`);
      const p = processJob(readMeta(m.id), job).finally(() => asyncs.delete(p));
      asyncs.add(p);
    } catch { /* 坏文件跳过 */ }
  }
}

export function recordingTaskCount() { return jobs.size; }
export const RECORDING_DIR = DIR;
