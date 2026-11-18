// 本地知识库索引：把 kb/docs/*.md 切块、向量化、缓存到磁盘。
//
// 为什么切块：Embedding 对长文本会稀释语义。按段落切（列表行逐条切），
// 每块 200~500 字，既能命中"《生万物》演的谁"这种细粒度问题，也够放进 prompt。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embed } from './tc_embed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// 按人设隔离：kb/personas/<key>/docs 存文档，data/kb_index_<key>.json 存索引。
// 没有人设专属目录时回落到共享的 kb/docs（杨幂两个分身共用同一套资料）。
function pathsFor(persona = 'yangmi') {
  const own = path.join(ROOT, 'kb', 'personas', persona, 'docs');
  const docsDir = fs.existsSync(own) ? own : path.join(ROOT, 'kb', 'docs');
  const indexFile = path.join(ROOT, 'data', `kb_index_${persona}.json`);
  return { docsDir, indexFile };
}
const MAX_CHARS = 420;   // 单块上限
const MIN_CHARS = 12;    // 太短的碎片不要

// 切块：按标题分节，节内按行切；行太长再按句号切
function chunkDoc(file, raw) {
  const title = (raw.match(/^#\s+(.+)$/m) || [, path.basename(file, '.md')])[1].trim();
  const chunks = [];
  let section = '';
  let buf = [];

  const flush = () => {
    const text = buf.join('\n').trim();
    if (text.length >= MIN_CHARS) chunks.push({ file, title, section, text: text.slice(0, MAX_CHARS * 2) });
    buf = [];
  };

  for (const line of raw.split('\n')) {
    const h = line.match(/^#{2,3}\s+(.+)$/);
    if (h) { flush(); section = h[1].trim(); continue; }
    if (!line.trim()) { flush(); continue; }
    // 单行过长（比如长段落）按句号拆
    if (line.length > MAX_CHARS) {
      flush();
      let rest = line.trim();
      while (rest.length > MAX_CHARS) {
        const cut = rest.lastIndexOf('。', MAX_CHARS);
        const at = cut > MIN_CHARS ? cut + 1 : MAX_CHARS;
        chunks.push({ file, title, section, text: rest.slice(0, at).trim() });
        rest = rest.slice(at).trim();
      }
      if (rest.length >= MIN_CHARS) buf.push(rest);
      continue;
    }
    // 当前块 + 这行超过上限就切开
    if (buf.join('\n').length + line.length > MAX_CHARS) flush();
    buf.push(line.trim());
  }
  flush();
  return chunks;
}

export function buildChunks(persona = 'yangmi') {
  const { docsDir } = pathsFor(persona);
  const chunks = [];
  if (!fs.existsSync(docsDir)) return chunks;
  for (const f of fs.readdirSync(docsDir).filter((x) => x.endsWith('.md')).sort()) {
    const raw = fs.readFileSync(path.join(docsDir, f), 'utf-8');
    chunks.push(...chunkDoc(f, raw));
  }
  return chunks;
}

// 建索引：返回 { built, chunks, sec }
export async function buildIndex({ persona = 'yangmi', force = false, onProgress = () => {} } = {}) {
  const t0 = Date.now();
  const { indexFile } = pathsFor(persona);
  const chunks = buildChunks(persona);
  if (!chunks.length) return { cached: false, items: [], ms: 0, empty: true };
  const sig = chunks.map((c) => c.text).join('\u0000');
  const sigHash = `${chunks.length}:${sig.length}`;

  if (!force && fs.existsSync(indexFile)) {
    const cached = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
    if (cached.sig === sigHash && cached.items?.length === chunks.length) {
      return { cached: true, items: cached.items, ms: Date.now() - t0 };
    }
  }

  onProgress(`切出 ${chunks.length} 块，开始向量化…`);
  const vectors = await embed(chunks.map((c) => `【${c.title}】${c.section ? c.section + '：' : ''}${c.text}`));
  const items = chunks.map((c, i) => ({ ...c, vec: vectors[i] }));

  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.writeFileSync(indexFile, JSON.stringify({ sig: sigHash, persona, built_at: new Date().toISOString(), items }));
  onProgress(`索引完成：${items.length} 块，${Math.round((Date.now() - t0) / 1000)}s`);
  return { cached: false, items, ms: Date.now() - t0 };
}

export function loadIndex(persona = 'yangmi') {
  const { indexFile } = pathsFor(persona);
  if (!fs.existsSync(indexFile)) return null;
  return JSON.parse(fs.readFileSync(indexFile, 'utf-8')).items || null;
}
