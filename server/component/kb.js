// 知识库检索：向量召回 topK → Rerank 精排 → 取前 N 块拼进 prompt。
//
// 只用向量召回时实测质量不够：问"《生万物》演的谁"，召回的是台词引用而不是"饰演宁绣绣"。
// 加上 rerank 精排后明显改善（它按 Query 与切片的真实相关性打分，不再只靠向量距离）。
import { embedOne, cosine, rerank } from './tc_embed.js';
import { loadIndex } from './kb_index.js';

const RECALL_K = Number(process.env.KB_RECALL_K || 12);
const TOP_N = Number(process.env.KB_TOP_N || 3);
const MIN_SCORE = Number(process.env.KB_MIN_SCORE || -6); // rerank 分数低于此值视为不相关

// 按人设各缓存一份索引
const caches = new Map(); // persona -> { builtAt, items }

export function getIndex({ persona = 'yangmi', reload = false } = {}) {
  if (!reload && caches.has(persona)) return caches.get(persona);
  const items = loadIndex(persona);
  if (!items || !items.length) return null;
  const c = { builtAt: Date.now(), items };
  caches.set(persona, c);
  return c;
}

// 关键词打分：这个库里剧名、角色名、年份这类实体特别密，纯向量会漏。
// 用"查询里的连续 2~4 字片段"去撞文本，撞中越多分越高，命中标题/小节再加权。
// 相对时间 → 绝对年份。知识库里写的全是"2016年""2025年"这种绝对年份，
// 而用户问的是"10年前""去年"。实测：问"你10年前在拍哪部戏"召回全是无关内容（-3.97），
// 问"2016年在拍什么戏"直接命中正确段落（0.07）。所以检索前先把相对时间补成年份。
const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function cnToNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0);
  return CN_NUM[s] ?? NaN;
}

// 返回 { query: 扩展后的查询, years: [换算出的年份] }
export function expandTimeQuery(query, now = new Date()) {
  const y = now.getFullYear();
  const years = [];
  let q = query;

  const add = (year, phrase) => {
    if (!Number.isFinite(year) || year < 1990 || year > y + 1) return;
    years.push(year);
    q += ` ${year}年`;                     // 追加到查询里，向量和关键词都能用上
  };

  // 去年 / 前年 / 今年 / 明年
  for (const [re, offset] of [[/前年/g, -2], [/去年/g, -1], [/今年/g, 0], [/明年/g, 1]]) {
    if (re.test(q)) add(y + offset, re.source);
  }
  // N年前 / N 年前 / 十年前 / 十几年前
  for (const m of query.matchAll(/(\d+|[一二两三四五六七八九十]{1,3})\s*年前/g)) {
    const n = cnToNum(m[1]);
    if (Number.isFinite(n) && n > 0 && n <= 50) add(y - n, m[0]);
  }
  // 最近 / 这几年 / 前段时间 → 近两年都算（资料里可能只有其中一年）
  if (/最近|这几年|近期|前段时间/.test(query)) {
    add(y, '最近'); add(y - 1, '最近');
  }
  // 查询里直接写了绝对年份（"2016年" / "in 2016"）：不用换算，但同样要当硬信号。
  // 之前只收集相对时间，问"2016 年拍了什么"反而拿不到年份加成（实测 0 命中）。
  for (const m of query.matchAll(/(?:^|[^0-9])((?:19|20)\d{2})(?![0-9])/g)) {
    const year = Number(m[1]);
    if (year >= 1990 && year <= y + 1) years.push(year);
  }

  return { query: q.trim(), years: [...new Set(years)] };
}

function keywordScore(query, item) {
  const q = query.replace(/[《》""''，。？！?!/、\s]/g, '');
  const text = `${item.title}${item.section || ''}${item.text}`;
  if (!q) return 0;
  let score = 0;
  for (let n = 4; n >= 2; n -= 1) {
    for (let i = 0; i + n <= q.length; i += 1) {
      const gram = q.slice(i, i + n);
      if (!text.includes(gram)) continue;
      score += n * n;                              // 长片段权重更高
      if (item.title.includes(gram)) score += 8;    // 命中标题
      if ((item.section || '').includes(gram)) score += 5;
    }
  }
  // 单字只在标题/小节里认（正文里单字太泛，"奖""戏"到处都有）。
  // "你拿过什么奖" 这类口语问法只有单字能对上 09_荣誉奖项 的标题。
  const head = `${item.title}${item.section || ''}`;
  for (const ch of new Set(q)) {
    if (head.includes(ch)) score += 3;
  }
  return score;
}

// 返回 { hits:[{title,section,text,file,score}], recall, ms }
export async function retrieve(query, { persona = 'yangmi', topN = TOP_N, withRerank = process.env.KB_RERANK !== 'false' } = {}) {
  const t0 = Date.now();
  const idx = getIndex({ persona });
  if (!idx || !query?.trim()) return { hits: [], recall: 0, ms: 0 };

  // 相对时间换算成绝对年份（"10年前" → 2016年），否则资料里的年份一条都撞不上
  const { query: expanded, years } = expandTimeQuery(query);

  // ① 向量召回
  const qv = await embedOne(expanded);
  const byVec = idx.items
    .map((it) => ({ s: cosine(qv, it.vec), it }))
    .sort((a, b) => b.s - a.s)
    .slice(0, RECALL_K);

  // ② 关键词召回：取分数最高的若干块，和向量结果取并集
  const byKw = idx.items
    .map((it) => ({ s: keywordScore(expanded, it), it }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, RECALL_K);

  const merged = [];
  const seen = new Set();
  for (const { it } of [...byKw, ...byVec]) {
    const key = `${it.file}|${it.text.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(it);
  }

  if (!withRerank) {
    return {
      hits: merged.slice(0, topN).map((it) => ({ ...it, score: keywordScore(expanded, it) })),
      recall: merged.length, ms: Date.now() - t0, reranked: false,
    };
  }

  // ③ Rerank 精排（用正文，标题前缀会稀释信号）
  // rerank 的分数对"时间型问题"很不敏感：实测问"10年前在拍哪部戏"，含 2016 年的正确块
  // 向量排第 3，rerank 后掉到第 9，而它给出的前几名全是无关年份。所以把年份当成硬信号加成。
  const docs = merged.map((it) => it.text);
  const ranked = await rerank(query, docs, Math.min(20, docs.length));
  const YEAR_BONUS = Number(process.env.KB_YEAR_BONUS || 6);
  // 年份不一定写成"2016年"：安妮资料里是"《镜中奇遇记》（2016）"。
  // 只认 `${y}年` 会漏掉这类块，年份加成失效（实测问"10年前拍的戏"答不上来）。
  const hasYear = (doc, y) => new RegExp(`(^|[^0-9])${y}([^0-9]|$)`).test(doc);
  const hits = ranked
    .map(({ doc, score }) => {
      const i = docs.indexOf(doc);
      if (i < 0) return null;
      const it = merged[i];
      const hitYears = years.filter((y) => hasYear(doc, y));
      const bonus = hitYears.length ? YEAR_BONUS : 0;
      return { ...it, score: score + bonus, baseScore: score, years: hitYears };
    })
    .filter(Boolean)
    // 用加成后的分数过阈值：年份是硬信号，命中年份的块即使 rerank 分低也该留下
    // （实测"去年拍的戏"正确块 baseScore=-6.6，被旧逻辑直接丢掉，导致 0 命中）
    .filter((h) => h.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
  return { hits, recall: merged.length, years, ms: Date.now() - t0, reranked: true };
}
