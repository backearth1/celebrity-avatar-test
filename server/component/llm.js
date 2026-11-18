// 组件版 LLM：流式产出她的回复，边到边分句。
//
// 组件版没有平台 LLM，"她怎么说话"完全由这里决定。所以：
//   - 人设直接从现有 persona/*.md 读取（和标准版同一份，保证两个版本可 AB 对比）
//   - 分句后才送去 TTS，首句不必等整段生成完
//   - 关掉 thinking，并拦掉思考泄漏（模型偶尔会把内部独白写进正文，被念出来就露馅）
const BASE = process.env.LLM_BASE_URL || 'https://ai-gateway.prod.shu.team/v1';
const MODEL = process.env.LLM_MODEL || 'deepseek-v4-flash';

function key() {
  const k = process.env.LLM_API_KEY;
  if (!k) throw new Error('LLM_API_KEY 未设置');
  return k;
}

const STRONG = '。！？!?；;\n';
const SOFT = '，,、';
// 英文：句号/问号/感叹号/分号断句。中文的 STRONG 里没有 "."，英文整段会被 hardMax 从单词中间切断
// （实测 "I'm Anne's AI doub|le" 被 TTS 念成两个词）。英文阈值按字符算，约 7 个词、80 字符。
const STRONG_EN = '.!?;\n';
const SOFT_EN = ',';
const CJK_RE = /[一-鿿]/;

// 增量分句：强标点立即切；弱标点满 softMin 字才切；超 hardMax 强制切。
// lang='en' 时按英文标点与阈值，硬切优先落在空格上，不劈开单词。
export class SentenceStream {
  constructor({ softMin = 12, hardMax = 40, lang = 'zh' } = {}) {
    this.buf = '';
    this.lang = lang;
    this.softMin = lang === 'en' ? 40 : softMin;
    this.hardMax = lang === 'en' ? 80 : hardMax;
  }

  feed(delta) {
    this.buf += delta || '';
    const en = this.lang === 'en';
    const STRONG_SET = en ? STRONG_EN : STRONG;
    const SOFT_SET = en ? SOFT_EN : SOFT;
    const out = [];
    for (;;) {
      let cut = -1;
      for (let i = 0; i < this.buf.length; i += 1) {
        const ch = this.buf[i];
        if (STRONG_SET.includes(ch)) { cut = i; break; }
        if (SOFT_SET.includes(ch) && i + 1 >= this.softMin) { cut = i; break; }
      }
      if (cut < 0) {
        if (this.buf.length > this.hardMax) {
          // 英文硬切：退到最后一个空格，避免把单词劈成两半
          let at = this.hardMax;
          if (en) {
            const sp = this.buf.lastIndexOf(' ', this.hardMax);
            if (sp > this.softMin) at = sp;
          }
          out.push(this.buf.slice(0, at).trim());
          this.buf = this.buf.slice(at).trimStart();
          continue;
        }
        break;
      }
      const piece = this.buf.slice(0, cut + 1).trim();
      this.buf = this.buf.slice(cut + 1);
      if (piece) out.push(piece);
    }
    return out;
  }

  flush() {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }
}

// 思考泄漏拦截：命中英文独白/长英文串就把后面整段丢掉（前面已说的保留）。
const LEAK = /(?:\b(?:Wait|Hmm|Let me|Actually|Okay so|I need|I should|The user)\b)|[A-Za-z]{12,}/;
export class LeakGuard {
  constructor() { this.held = ''; this.tripped = false; }
  feed(delta) {
    if (this.tripped) return '';
    const buf = this.held + (delta || '');
    const m = buf.match(LEAK);
    if (m) { this.tripped = true; this.held = ''; return buf.slice(0, m.index); }
    this.held = '';
    return buf;
  }
  flush() { const h = this.tripped ? '' : this.held; this.held = ''; return h; }
}

// 流式对话。onSentence(句子) 每凑齐一句就回调，调用方据此并行合成 TTS。
// leakGuard / lang：中文人设才需要拦"思考泄漏"。英文人设（安妮）正常回复里全是英文单词，
// LeakGuard 的 [A-Za-z]{12,} 会把 "extraordinary" 这种词当成独白，后面整段被丢掉。
export async function streamReply({ messages, onSentence, signal, maxTokens = 150, temperature = 0.8, english = false }) {
  const leakGuard = !english;
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: true,
      max_tokens: maxTokens,
      temperature,
      top_p: 0.85,
      presence_penalty: 0.5,
      frequency_penalty: 1.1,
      thinking: { type: 'disabled' }, // deepseek-v4 默认带 reasoning_content，必须关
    }),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const sentences = new SentenceStream({ lang: english ? 'en' : 'zh' });
  const leak = leakGuard ? new LeakGuard() : null;
  const all = [];
  const decoder = new TextDecoder();
  let buf = '';

  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch { continue; }
      const delta = j.choices?.[0]?.delta?.content;
      if (!delta) continue;
      const clean = leak ? leak.feed(delta) : delta;
      if (!clean) continue;
      all.push(clean);
      for (const s of sentences.feed(clean)) onSentence(s);
    }
  }
  const tail = leak ? leak.flush() : '';
  if (tail) all.push(tail);
  for (const s of sentences.feed(tail)) onSentence(s);
  for (const s of sentences.flush()) onSentence(s);
  return all.join('');
}
