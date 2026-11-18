// 组件版提示词组装。
//
// 标准版把 persona / greeting / action_prompt 交给平台，由平台 LLM 读取；
// 组件版没有平台 LLM，这些文本要我们自己拼成 system prompt。
// 复用同一份 persona/*.md，两个版本才能 AB 对比。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPersona, read, loadSharedMemories, isAnnePersona, isGirlfriendPersona, isIpPersona } from '../personas.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PERSONA_ROOT = path.join(ROOT, 'persona');

function sharedBlock(key) {
  const shared = loadSharedMemories(key);
  return shared ? shared.map((m) => `- ${m}`).join('\n') : '';
}

function memoryBlock(memories, personaKey) {
  const anne = isAnnePersona(personaKey);
  const girl = isGirlfriendPersona(personaKey);
  if (!memories.length) {
    if (anne) {
      return girl
        ? '\n\n# About him\nYou are together, but you don\'t know what he\'s been up to today. Ask him naturally how his day went.'
        : '\n\n# This friend\nFirst time meeting. Say hi, then ask what you should call him.';
    }
    return girl
      ? '\n\n# 他最近的情况\n你们是恋人，但你还不知道他最近发生了什么。开场自然地问问他今天过得怎么样。'
      : '\n\n# 这位朋友\n第一次见面。开场打完招呼，问问怎么称呼对方。';
  }
  const joined = memories.map((m) => `- ${m}`).join('\n');
  if (anne) {
    return girl
      ? `\n\n# About him (things he's told you — you remember)\n${joined}\nBring these up naturally, the way a girlfriend remembers her boyfriend's life. Don't recite them like a file.`
      : `\n\n# This friend (from your past chats)\n${joined}\nStart like an old friend: use his name, pick one thing you talked about last time and ask how it's going. Don't dump everything you remember, and never say "I remember from your profile."`;
  }
  return girl
    ? `\n\n# 他最近的情况（你们聊天时提过的，你记得）\n${joined}\n自然地带出来，像女朋友记得男朋友的事，不要像在复述档案。`
    : `\n\n# 这位朋友（你们聊过，你记得这些）\n${joined}\n开场就像老朋友：叫对方的名字，挑一件上次聊到的事自然地问问近况。不要一次把记得的全说出来，也不要说"我记得你的资料"。`;
}

function kbBlock(hits, personaKey = 'clone') {
  if (!hits || !hits.length) return '';
  const body = hits.map((h) => `【${h.title}】${h.text}`).join('\n\n');
  if (isAnnePersona(personaKey)) {
    return `\n\n# Reference material (say it in first person, conversationally — never "according to the material")\n${body}\n`
      + 'Don\'t add details the material doesn\'t contain. If it isn\'t there, say you don\'t remember clearly.';
  }
  return `\n\n# 查到的资料（用第一人称口语说出来，不要说"根据资料"）\n${body}\n`
    + '资料里没有的细节不要补，查不到就说"这个我记不清了"。';
}

// 动作提示词：让 LLM 在回复里插 [动作:描述]，播放前剥离，走 type=9 input_transcription 发给渲染侧。
// MiniMax speech-2.8 的 sound tag：写进文本里，TTS 会把它渲染成真实音效，不会被念出来。
// 只能用它支持的这 21 个，写别的会被当普通文本读出来。
export const SOUND_TAGS = [
  'laughs', 'chuckle', 'coughs', 'clear-throat', 'groans', 'breath', 'pant', 'inhale', 'exhale',
  'gasps', 'sniffs', 'sighs', 'snorts', 'burps', 'lip-smacking', 'humming', 'hissing', 'emm',
  'whistles', 'sneezes', 'crying', 'applause',
];

const TAG_HINT = {
  laughs: '笑出声', chuckle: '轻笑', coughs: '咳嗽', 'clear-throat': '清嗓子', groans: '呻吟',
  breath: '正常换气', pant: '喘气', inhale: '吸气', exhale: '呼气', gasps: '倒吸气、惊喘',
  sniffs: '吸鼻子', sighs: '叹气', snorts: '喷鼻息', burps: '打嗝', 'lip-smacking': '咂嘴',
  humming: '哼唱', hissing: '嘶嘶声', emm: '嗯（迟疑）', whistles: '口哨', sneezes: '喷嚏',
  crying: '抽泣', applause: '鼓掌',
};

function soundBlock(personaKey = 'clone') {
  const list = SOUND_TAGS.map((t) => `(${t})=${TAG_HINT[t]}`).join('、');
  // IP 人物（John Wick）话短、情绪收着：一条回复 1~2 个就够。
  // 套用"每次 2~3 个"的话，两句话的回复会被塞进一串语气音，反而不像他。
  if (isIpPersona(personaKey)) {
    return `

# 语气音（少而克制）
每次回复带 1~2 个语气音标记，写成半角圆括号，TTS 会把它变成真实音效，不会被念出来。
可用标记（只能用这些，不要自创，不要写方括号）：${list}

怎么挑：
- 一般开口、说完了 → (breath)
- 懒得解释、把情绪压下去 → (exhale) 或 (sighs)
- 对方说了不该说的、你不想接 → (clear-throat)
- 思考、停一下 → (emm)
- 真的觉得有点好笑，极轻地一声 → (chuckle)（少用）

不要每句都加，不要连用两个一样的，也不要夸张的笑声。标记放在该发生的位置。`;
  }
  // 安妮系列是英文人设：提示词也走英文，避免模型被中文说明带跑
  if (isAnnePersona(personaKey)) {
    const en = SOUND_TAGS.map((t) => `(${t})`).join(' ');
    return `

# Vocal sounds (2–3 per reply, never the same one twice)
Every reply must carry 2–3 sound tags in PLAIN ROUND brackets, e.g. (breath). TTS renders them as real audio; they are never spoken aloud.
Allowed tags (these only — never invent one, never use square brackets): ${en}

Pick by the emotion of the line, not by habit:
- just talking casually → (breath)
- actually amused, caught off guard → (laughs)
- a small polite smile → (chuckle) — the most overused one, so use it sparingly
- thinking, can't remember → (emm)
- resigned, letting out a sigh → (sighs)
- surprised, taken aback → (gasps)
- tired, catching your breath → (pant) or (exhale)
- clearing your throat before saying something serious → (clear-throat)
- pleased, humming a note → (humming)
- amused disbelief, a little scoff → (snorts)

Example of a good reply (note the tag placement and the gesture tag):
"[动作:笑着摊开双手] Oh, it was a gift, honestly. (laughs) Chris Nolan doesn't hand you anything easy, so I trained for months — all that fight work. (breath) And that suit? You don't just slip into it."

Hard rules:
1. At least TWO tags, at most three, in every reply. (chuckle) at most once every three replies — if you're about to use it, check whether (breath), (emm), (sighs) or (exhale) fits better.
2. Never use the same tag twice in one reply.
3. Put the tag where the sound would actually happen — a sigh after the sentence lands, not all bunched at the start.
4. Keep the prose in English. Tags must be round brackets only; square brackets are reserved for [动作:...].
5. Tags don't count toward length.`;
  }
  const girl = personaKey === 'girlfriend';
  return `

# 语气音（每次回复必须带 2~3 个，但别老用同一个）
你说的话里必须带 2~3 个语气音标记，写成半角圆括号，TTS 会把它变成真实音效，不会被念出来。
可用标记（只能用这些，不要自创，不要写方括号）：${list}

一条合格回复的样子（注意标记的位置和动作标记）：
"[动作:用手在胸前比划] 今天确实有点累。 (sighs) 不过见到你，精神就好多了。 (breath) 你呢，今天顺利吗？"

选标记的方法——先判断这句话是什么情绪，再挑对应的音，不要默认用笑：
- 一般轻松、随口带过 → (breath) 换气、或干脆不加强调
- 真觉得好笑、被逗到 → (laughs)
- 只是嘴角一动、礼貌性笑一下 → (chuckle)（最常见，正因为最常见才要少用）
- 思考、沉吟、想不起来 → (emm)
- 无奈、叹气、认命 → (sighs)
- 委屈、撒娇、装可怜 → ${girl ? '(sniffs) 或 (sighs)' : '(sniffs)'}
- 惊讶、被吓到、没想到 → (gasps)
- 累了、喘口气 → (pant) 或 (exhale)
- 清嗓子、准备认真说 → (clear-throat)
- 得意、哼一句小调 → (humming)
- 嫌弃、撇嘴 → (snorts) 或 (lip-smacking)
${girl ? '- 黏人、撒娇拖长音 → (humming) 或 (emm)\n' : ''}
硬性要求：
1. (chuckle) 最多每三条回复出现一次。**如果这一轮你想用 (chuckle)，先问自己能不能换成 (breath)、(emm)、(sighs) 或 (exhale)**，能换就换。
2. 同一条回复里不要出现两个相同的标记。
3. 标记放在该发生的位置（话说完了才叹气，就想在"嗯——"之前），不要都堆在开头。
4. 一次回复 2~3 个，分开放在不同句子后面；不要全堆在开头。
5. 只能写上面列出的英文标记，圆括号内不要写中文或自编的词，也不要用方括号。
6. 标记本身不计入字数，正文照常。`;
}

function actionBlock(personaKey) {
  let style = '';
  try { style = read(personaKey, 'action_prompt.txt'); } catch { /* 该人设没写动作风格 */ }
  if (isAnnePersona(personaKey)) {
    return `

# Body language
You pair what you say with physical gestures — this is a video call, and staying frozen looks dead.
1. EVERY reply must include at least one [动作:描述]; two or three is better if the reply is longer.
2. Prefer SUSTAINED gestures that hold for a moment — "双手在胸前比划", "身体微微前倾，双手摊开", "头轻轻侧着，手掌摊开". Avoid one-shot moves like a single wave or a nod, which end immediately and leave you static.
3. Write each one at the very start of the sentence it belongs to, as [动作:描述]; gestures in the same reply must differ from each other.
4. Keep the description to 4–16 Chinese characters of concrete movement (what + how). The [动作:...] wrapper stays in Chinese so the renderer parses it.
5. NEVER mention talking or speaking in the description — no 说话, 讲话, 边说边, 一边说, "while talking". The renderer treats those as a mouth movement, so she ends up opening her mouth even when there is no audio. Describe only hands, shoulders, head, face.
6. The tag is never spoken; don't describe movement in the prose or with other brackets.

Good example: [动作:笑着摊开双手] ... then a line with (laughs) later. The gesture should read as something you'd actually do while saying THIS line.

${style}`;
  }
  return `

# 动作
你回复时会配合肢体动作 —— 这是视频通话，一直僵着不动会显得很假。规则：
1. **每条回复至少写 1 个动作**，回复长一点就写 2~3 个，分别放在不同句子的最前面。
2. 优先写**能持续做**的动作（"双手在胸前比划"、"身体微微前倾，双手摊开"、"头轻轻侧着，手掌摊开"），不要写挥手、点头这种一下就结束的一次性动作 —— 做完就又会僵住。
3. **动作描述里绝对不能出现"说话""讲话""边说边""一边说"这类字眼**。渲染侧会把它当成嘴部动作，她没出声的时候也会奇怪地张嘴。只描述手、肩、头、表情怎么动。
4. 动作必须和这句话的内容对得上，是你自己在这一刻自然而然会做的，不是演对方说的事；同一条回复里的动作不要重复。
5. 在对应那段话最前面写 [动作:描述]，描述用 4~16 个字的具体肢体动作（做什么 + 怎么做）。
6. 标记不会被念出来，正文里不要再用括号或旁白描述动作。

例子：[动作:双手在胸前比划] 今天确实有点累。 (sighs) 不过见到你，精神就好多了。

${style}`.trimEnd();
}

// 今天的日期。用户常问"去年""最近""十年前"，模型必须知道今天几号才能换算成绝对年份，
// 知识库里写的又都是绝对年份——不给日期，它只能答"记不清"。
function dateBlock(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  return `

# 今天
今天是 ${y} 年 ${m} 月 ${d} 日。用户说"去年"指 ${y - 1} 年，"今年"指 ${y} 年，
"10 年前"约指 ${y - 10} 年。换算成年份再去对照资料，不要直接说记不清。`;
}

// 放在 system prompt 最末尾的硬性自检：模型对最后一段的遵守度最高。
// 只靠前面"每次必须带 2~3 个"时，实测仍有约 1/3 的回复只写了 1 个。
// IP 人物每场只做一个人设里写好的任务。任务由服务端轮换指定（service.js），
// 不靠模型自己挑——不然实测它总是选"血契"，另外两个任务永远轮不到。
const MISSION_LABEL = { A: '血契', B: '内鬼', C: '护送' };
function missionBlock(mission, personaKey) {
  if (!mission || !isIpPersona(personaKey)) return '';
  const label = MISSION_LABEL[mission] || mission;
  return `\n\n# 本场任务（已定，不要更换）
本场只做任务 ${mission}：${label}。按上文"任务"部分对应的说明推进，不要提另外两个任务。第一轮回复就把它说出来。`;
}

function finalCheck(personaKey) {
  if (isIpPersona(personaKey)) {
    return '\n\n# Final check (silently, before sending)\nEvery spoken word must be English — no Chinese characters anywhere outside the [动作:...] brackets. If you drafted any line in Chinese, rewrite it in English now, even when the other person wrote in Chinese. Keep it to 3–5 sentences, about 35–80 words: if it is shorter, add one concrete detail — a name, a place, a condition, a next step — not filler. The reply must also contain at least one sound tag in round brackets and one [动作:描述]. Square brackets are only for [动作:...].';
  }
  if (isAnnePersona(personaKey)) {
    return '\n\n# Final check (silently, before sending)\nCount them: this reply must contain at least TWO sound tags in round brackets — (laughs), (breath), (sighs), (emm), (exhale), (gasps) — and at least ONE [动作:描述] at the start of a sentence. If either is missing, add it now. Square brackets are only for [动作:...].';
  }
  return '\n\n# 发出前自检（不要说出来）\n数一下：这条回复至少要有 2 个圆括号语气音标记，以及至少 1 个 [动作:描述]。不够就现在补上。语气音只能是圆括号 + 白名单里的词，方括号只用于 [动作:...]。';
}

export function buildMessages({ persona = 'clone', memories = [], kbHits = [], history = [], mission = null }) {
  const cfg = getPersona(persona);
  let body = read(persona, cfg.personaFile);
  if (body.includes('{shared_memories}')) body = body.replace('{shared_memories}', sharedBlock(persona));

  const system = [body, dateBlock(), memoryBlock(memories, persona), kbBlock(kbHits, persona), actionBlock(persona), soundBlock(persona), missionBlock(mission, persona), finalCheck(persona)]
    .filter(Boolean).join('\n');

  return [{ role: 'system', content: system }, ...history];
}

// 开场白：标准版由平台按 greeting_instruction 生成，组件版直接用现成文本，
// 需要动态内容（比如叫出用户名）时由调用方拼好传进来。
export function greetingFor(persona = 'clone', { name = '' } = {}) {
  const file = path.join(PERSONA_ROOT, getPersona(persona).dir, 'greeting.txt');
  const instruction = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim() : '';
  const who = name ? `${name}` : '你';
  if (persona === 'girlfriend') return `${who}，回来啦？今天累不累呀，先跟我说说。`;
  // 安妮系列是英文人设：开场白必须自己写英文。greeting.txt 是给平台 LLM 看的指令，
  // 不能直接念；之前这里统一返回杨幂的自我介绍，选了安妮也还是"我是幂幂"。
  if (persona === 'anne_girlfriend') {
    return `${name ? `Hey ${name}. ` : 'Hey, you. '}There you are — how was your day? I've been thinking about you.`;
  }
  if (persona === 'anne') {
    return `${name ? `Hi ${name}! ` : 'Hi! '}I'm Anne's AI double — good to meet you. How's your day going?`;
  }
  // IP 人物：开场白就是他本人会说的第一句话，短、冷、不寒暄；他说英语，而且一上来就有活
  if (persona === 'johnwick') return `${name ? `${name}. ` : ''}I'm John Wick. I've got work for you. …Listen.`;
  return `嗨，我是杨幂的 AI 数字分身，你可以叫我幂幂。${name ? `${name}，` : ''}今天过得怎么样？`;
}

// 动作描述里不能带"说话/边说边"这类字眼：渲染侧会把它当成嘴部动作，
// 她没出声的时候也会奇怪地张嘴。提示词已经禁止了，但模型偶尔还会写，这里兜底删掉。
const SPEECH_WORDS = /一边(?:说话|讲话|说|讲)(?:一边|边)?|边(?:说话|讲|说)边|边([^，。、\s]{0,8})边(?:说话|讲话|说|讲)|(?:说话|讲话|说着话)时?/g;
function cleanAction(desc) {
  const raw = String(desc || '').trim();
  const d = raw
    .replace(SPEECH_WORDS, (_, mid) => mid || '')
    .replace(/^[，,、\s]+|[，,、\s]+$/g, '')
    .replace(/[，,、\s]*(?:着)?(?:讲话|说话|讲|说)$/, '');
  return d || raw;   // 删空了就保留原文，总比没有动作好
}

// 从回复里剥出 [动作:xxx]，返回干净文本和动作列表（按出现顺序）
const ACTION_TAG = /[\[【]\s*动作\s*[:：]\s*([^\[\]【】\n]{1,40}?)\s*[\]】]/g;
export function extractActions(text) {
  const actions = [];
  const clean = (text || '').replace(ACTION_TAG, (_, a) => { actions.push(cleanAction(a)); return ''; }).trim();
  return { clean, actions };
}
