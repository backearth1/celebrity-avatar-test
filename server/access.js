// 多人访问的两道防线：
// 1) 身份：服务端签发 HttpOnly 签名 cookie（vuid），记忆、会话、切视频都只认 cookie 里的 user_id，
//    不再信任前端传来的 user_id —— 别人拿到你的 ID 也读不到、删不掉你的记忆，动不了你的通话。
// 2) 会话配额：同时最多 MAX_CONCURRENT_SESSIONS 路，单次最长 MAX_SESSION_SECONDS 秒，到点服务端主动挂断。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function createIdentity({ dataDir, secret }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const secretFile = path.join(dataDir, 'cookie_secret');
  const claimsFile = path.join(dataDir, 'uid_claims.json');
  const key = secret || (fs.existsSync(secretFile)
    ? fs.readFileSync(secretFile, 'utf-8').trim()
    : (() => { const k = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(secretFile, k, { mode: 0o600 }); return k; })());
  // 已被某个浏览器认领过的旧 user_id（迁移用：先到先得，之后别人不能再认领）
  const claims = new Set(fs.existsSync(claimsFile) ? JSON.parse(fs.readFileSync(claimsFile, 'utf-8')) : []);
  const saveClaims = () => fs.writeFileSync(claimsFile, JSON.stringify([...claims]));

  const mac = (uid) => crypto.createHmac('sha256', key).update(uid).digest('base64url').slice(0, 32);
  const uidOk = (id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);

  function parseCookie(header = '') {
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === 'vuid') return decodeURIComponent(v.join('='));
    }
    return null;
  }

  // 从请求里取已验证的 user_id；cookie 缺失或签名不对返回 null
  function fromRequest(req) {
    const raw = parseCookie(req.headers.cookie);
    if (!raw) return null;
    const i = raw.lastIndexOf('.');
    if (i <= 0) return null;
    const uid = raw.slice(0, i);
    const sig = raw.slice(i + 1);
    if (!uidOk(uid)) return null;
    const expected = mac(uid);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return uid;
  }

  // 没有有效 cookie 时签发一个。legacyUid 是浏览器 localStorage 里的旧 ID：
  // 没被认领过就沿用它（保住已有记忆），否则生成新的。
  function issue(legacyUid) {
    let uid;
    if (uidOk(legacyUid) && !claims.has(legacyUid)) uid = legacyUid;
    else uid = `u-${crypto.randomUUID().slice(0, 18)}`;
    claims.add(uid);
    saveClaims();
    const cookie = `vuid=${encodeURIComponent(`${uid}.${mac(uid)}`)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`;
    return { uid, cookie };
  }

  return { fromRequest, issue };
}

export function createSessionLimiter({ maxConcurrent, maxSeconds, onExpire }) {
  const sessions = new Map(); // liveId -> { owner, createdAt, endsAt, timer, sock }
  let reserving = 0;          // 正在向 Vidu 建会话、还没拿到 live_id 的名额

  return {
    maxConcurrent,
    maxSeconds,
    active: () => sessions.size + reserving,
    // 占一个名额；满了返回 false
    reserve() {
      if (sessions.size + reserving >= maxConcurrent) return false;
      reserving += 1;
      return true;
    },
    release() { reserving = Math.max(0, reserving - 1); },
    // 建会话成功：名额转正，开始计时
    commit(liveId, owner) {
      reserving = Math.max(0, reserving - 1);
      const createdAt = Date.now();
      const s = { owner, createdAt, endsAt: createdAt + maxSeconds * 1000, sock: null };
      s.timer = setTimeout(() => onExpire(liveId, 'max_duration'), maxSeconds * 1000);
      // 建了会话却一直没连 WS（页面关了、网络断了），60 秒后回收
      s.noWsTimer = setTimeout(() => { if (!s.sock) onExpire(liveId, 'no_client'); }, 60_000);
      sessions.set(liveId, s);
      return s;
    },
    get: (liveId) => sessions.get(liveId),
    // 结束会话：清计时器、让出名额。返回被移除的会话（已移除则 null）
    remove(liveId) {
      const s = sessions.get(liveId);
      if (!s) return null;
      clearTimeout(s.timer);
      clearTimeout(s.noWsTimer);
      sessions.delete(liveId);
      return s;
    },
  };
}
