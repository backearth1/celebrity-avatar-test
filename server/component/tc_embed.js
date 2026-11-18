// 腾讯云知识引擎：Embedding + Rerank。
// 实测：GetEmbedding 返回 1024 维；单次最多 7 条 Inputs（8 条起报 too many embedding inputs）；
// 单条约 300ms，批量摊薄后更快。
import { callTc } from './tc3.js';

const BASE = { host: 'lkeap.tencentcloudapi.com', service: 'lkeap', region: 'ap-guangzhou', version: '2024-05-22' };
const MODEL = process.env.TC_EMBED_MODEL || 'lke-text-embedding-v1';
const BATCH = 7; // 平台硬上限

function cred() {
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  if (!secretId || !secretKey) throw new Error('TENCENT_SECRET_ID / TENCENT_SECRET_KEY 未设置');
  return { secretId, secretKey };
}

export async function embed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const r = await callTc({ ...cred(), ...BASE, action: 'GetEmbedding', payload: { Model: MODEL, Inputs: slice } });
    if (r.data.Error) throw new Error(`GetEmbedding ${r.data.Error.Code}: ${r.data.Error.Message}`);
    const data = r.data.Data || [];
    if (data.length !== slice.length) throw new Error(`GetEmbedding 返回条数不符 ${data.length}/${slice.length}`);
    for (const d of data) out.push(d.Embedding);
  }
  return out;
}

export async function embedOne(text) {
  const [v] = await embed([text]);
  return v;
}

// 余弦相似度（向量已归一化时等价于点积，这里仍按通用式算，稳妥）
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Rerank：对召回结果按相关性重排。实测字段是 ScoreList（不是 Scores），
// 模型只支持 lke-reranker-base，large 会报 invalid model。
export async function rerank(query, docs, topN = 3) {
  if (!docs.length) return docs;
  const r = await callTc({
    ...cred(), ...BASE, action: 'RunRerank',
    payload: { Model: process.env.TC_RERANK_MODEL || 'lke-reranker-base', Query: query, Docs: docs.slice(0, 20) },
  });
  if (r.data.Error) throw new Error(`RunRerank ${r.data.Error.Code}: ${r.data.Error.Message}`);
  const scores = r.data.ScoreList || [];
  return docs.map((doc, i) => ({ doc, score: scores[i] ?? -Infinity }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}
