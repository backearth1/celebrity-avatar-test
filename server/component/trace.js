// 链路追踪（旁路）：把组件版一次对话经过的每个环节的真实输入/输出记下来，
// 供 /pipeline 页面按节点回放。
//
// 硬约束：这是旁路展示，绝不能影响主链路（建会话 → LLM → TTS → 喂流）的正确性和时延。
//   1. 主链路上只做一次 O(1) 入队：不拷贝、不截断、不序列化。
//      截断/序列化挪到页面来拉的时候（since/getBlob）才做——没人看就永远不做。
//   2. 任何方法都不抛错：内部全部 try/catch，出错只丢这一条记录。
//   3. 有界内存：事件环形缓冲 + blob 上限，长会话不会无限增长。
//   4. 可整体关闭：PIPELINE_TRACE=false 时返回空实现，主链路零开销。
//
// 注意：入队时保存的是对象引用。调用方传进来的都是每轮新建的字面量
//（不会再被改写），messages 数组也是 buildMessages 每轮新建的，所以引用安全。

const MAX_EVENTS = 1200;
const MAX_BLOBS = 200;
const ENABLED = process.env.PIPELINE_TRACE !== 'false';

// 截断：只在出队（页面拉取）时调用
// 跳过的字段：vec 是 1024 维向量（知识库命中块自带），展示没意义还很重
const SKIP_KEYS = new Set(['vec', '_view', '_viewAt']);
function clip(v, n = 600, depth = 0) {
  if (v == null) return v;
  if (depth > 6) return '‹…›';
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `‹${v.length} 字节 PCM›`;
  if (typeof v === 'string') return v.length > n ? `${v.slice(0, n)}…（共 ${v.length} 字）` : v;
  if (typeof v === 'number') return Number.isFinite(v) ? +v.toFixed(4) : String(v);
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => clip(x, n, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) if (!SKIP_KEYS.has(k)) out[k] = clip(val, n, depth + 1);
    return out;
  }
  return v;
}

// 关闭时的空实现：方法签名一致，什么都不做
const NOOP = {
  enabled: false,
  startedAt: Date.now(),
  blob: () => null,
  getBlob: () => undefined,
  push: () => null,
  update: () => null,
  since: () => [],
  updatedSince: () => [],
  last: (i = 0) => i,
};

export function createTrace() {
  if (!ENABLED) return { ...NOOP, startedAt: Date.now() };

  const startedAt = Date.now();
  // 环形缓冲：raw[i % MAX] 存第 i 条；head 是下一条的序号
  const ring = new Array(MAX_EVENTS);
  let head = 0;
  const blobs = new Map();
  let blobSeq = 0;
  // 记录被 update 过的事件序号，避免出队时全量扫描
  const touched = new Map(); // i -> updatedAt

  const get = (i) => {
    if (i < head - MAX_EVENTS || i >= head) return null;
    const e = ring[i % MAX_EVENTS];
    return e && e.i === i ? e : null;
  };
  // 出队时才做截断，且结果缓存在事件上（同一条被多次拉取只算一次）
  const view = (e) => {
    try {
      if (!e._view || e._viewAt !== (e.updatedAt || 0)) {
        e._view = {
          i: e.i, node: e.node, at: e.at, rel: e.rel,
          ...(e.input !== undefined ? { input: clip(e.input) } : {}),
          ...(e.output !== undefined ? { output: clip(e.output) } : {}),
          ...(e.note ? { note: e.note } : {}),
          ...(e.ms != null ? { ms: Math.round(e.ms) } : {}),
          ...(e.turn != null ? { turn: e.turn } : {}),
          ...(e.updatedAt ? { updatedAt: e.updatedAt } : {}),
        };
        e._viewAt = e.updatedAt || 0;
      }
      return e._view;
    } catch {
      return { i: e.i, node: e.node, at: e.at, rel: e.rel, note: '（记录序列化失败）' };
    }
  };

  return {
    enabled: true,
    startedAt,

    // 存一份完整原文，返回引用 id。只存引用，不拷贝。
    blob(value) {
      try {
        const id = `b${++blobSeq}`;
        blobs.set(id, value);
        if (blobs.size > MAX_BLOBS) blobs.delete(blobs.keys().next().value);
        return id;
      } catch { return null; }
    },
    getBlob: (id) => blobs.get(id),

    // 主链路调用：O(1) 入队，不拷贝不截断，绝不抛错
    push(node, { input, output, note, ms, turn } = {}) {
      try {
        const now = Date.now();
        const e = { i: head, node, at: now, rel: now - startedAt, input, output, note, ms, turn };
        ring[head % MAX_EVENTS] = e;
        head += 1;
        return e;
      } catch { return null; }
    },

    // 补写已入队的事件（LLM 先记"已发出"，生成完再补 output）
    update(event, patch) {
      try {
        if (!event) return null;
        Object.assign(event, patch);
        event.updatedAt = Date.now();
        touched.set(event.i, event.updatedAt);
        if (touched.size > MAX_EVENTS) touched.delete(touched.keys().next().value);
        return event;
      } catch { return null; }
    },

    // ---- 以下只在页面拉取时调用（旁路）----
    since(i) {
      const out = [];
      for (let k = Math.max(i, head - MAX_EVENTS); k < head; k += 1) {
        const e = get(k);
        if (e) out.push(view(e));
      }
      return out;
    },
    updatedSince(i, sinceTs) {
      const out = [];
      for (const [k, at] of touched) {
        if (k < i && at > sinceTs) { const e = get(k); if (e) out.push(view(e)); }
      }
      return out;
    },
    last(i = 0) { return head ? head - 1 : i; },
  };
}

export { clip };
