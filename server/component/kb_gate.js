// 知识库检索门控：决定这一轮要不要查库。
//
// 为什么不每轮都查：闲聊（"一点也不累""现在好多了""想你了"）查库没意义，
// 白白多 300~700ms，还可能把无关片段塞进 prompt 让她答偏。
// 为什么不让 LLM 自己判断：那要多一次模型往返；本地规则零延迟、可解释，
// 每次放行/拦截的理由都能显示在链路图上。
//
// 规则（命中任意一条就查；都不命中就跳过）：
//   1. 问的是她本人的事实：作品、角色、奖项、经历、代言、家庭……（领域词）
//   2. 带具体实体：书名号《》、年份、相对时间（去年 / N年前 / 最近）
//   3. 是对她的提问句，且问的是事实型疑问（演过/拍过/什么时候/哪部……）
//   4. 上一轮查过库、这一轮是追问（"再想想""那后来呢""还有呢"）——话题延续
// 强制跳过：纯寒暄、纯情绪、太短（<3 字）。

const DOMAIN = [
  // 作品与表演
  '戏', '剧', '电影', '电视', '片子', '角色', '演', '拍', '饰演', '主演', '配角', '导演', '剧组', '上映', '播出', '开机', '杀青', '综艺', '节目', '春晚',
  // 荣誉与商业
  '奖', '提名', '影后', '视后', '代言', '品牌', '杂志', '封面', '广告',
  // 音乐
  '歌', '唱', '专辑', '单曲',
  // 经历与个人
  '出道', '童星', '小时候', '童年', '长大', '学校', '北影', '电影学院', '毕业', '家乡', '老家', '胡同', '名字', '昵称', '外号', '粉丝', '蜜蜂', '公益', '慈善', '出生', '生日', '星座', '经历', '工作室', '公司',
];

const ENTITY_RE = [
  /《[^》]{1,20}》/,                          // 书名号：作品名
  /(19|20)\d{2}\s*年?/,                       // 绝对年份
  /(去年|前年|今年|明年|\d+\s*年前|[一二两三四五六七八九十]{1,3}年前|这几年|最近|近期|前段时间)/,
];

// 事实型疑问：问"是什么/哪个/什么时候"，而不是"你还好吗"这种关心
const FACT_Q_RE = /(哪部|哪个|哪些|哪年|什么时候|什么戏|什么剧|什么角色|演过|拍过|唱过|得过|拿过|获过|参加过|演的谁|演谁|是谁|叫什么|多少|几部|第一部|最早|最新|代表作)/;

// 追问：沿用上一轮的话题（"再想想呢""那后来呢""还有呢"）
const FOLLOW_RE = /^(再想想|再说说|再想一下|还有|那后来|然后|那之后|那之前|具体点|详细说|展开说|真的吗|确定吗|是吗|那.{0,6})[呢吗呀啊吧？?。！!～~\s]*$/;

// 纯寒暄 / 纯情绪：直接跳过
const SMALLTALK_RE = /^(嗯+|哦+|啊+|哈+|好的?|行|可以|是的?|对|没事|谢谢|晚安|早安|拜拜|再见|想你了?|我也是|累了|好累|不累|一点也不累|现在好多了|还行|还好)[呀啊吧呢嘛哈～~。！!？?\s]*$/;

// ---------- 英文（安妮）----------
// 中文规则一个字都命中不了英文问题，之前她问 "What was it like playing Catwoman?"
// 会被当闲聊跳过，知识库永远查不到。
const DOMAIN_EN = [
  'movie', 'film', 'role', 'character', 'act', 'acting', 'actor', 'actress', 'director', 'cast',
  'scene', 'script', 'series', 'show', 'tv', 'stage', 'theatre', 'theater', 'musical',
  'award', 'oscar', 'nomination', 'nominated', 'golden globe', 'bafta', 'sag', 'win', 'won',
  'brand', 'campaign', 'magazine', 'cover', 'song', 'sing', 'singing', 'album', 'debut', 'career',
  'childhood', 'school', 'born', 'birthday', 'unicef', 'charity', 'ambassador', 'premiere',
  'red carpet', 'catwoman', 'fantine', 'princess', 'prada', 'interstellar', 'brooklyn', 'millburn',
];
const ENTITY_EN = [
  /\b(?:19|20)\d{2}\b/,                                                   // 绝对年份
  /\b(?:last year|this year|next year|\d+\s+years?\s+ago|recently|a while ago)\b/i,
];
const FACT_Q_EN = /\b(?:when|which|what year|how many|did you|do you|have you|were you|tell me about|your (?:role|movie|film|character|favorite|favourite)|what was it like)\b/i;
const FOLLOW_EN = /^(?:more|go on|and then|really|are you sure|what else|tell me more)[.!?\s]*$/i;
const SMALLTALK_EN = /^(?:hi|hello|hey|ok|okay|thanks|thank you|good night|good morning|bye|yes|no|i'?m tired|i am tired|not tired|i'?m fine|i'?m good|how are you)[!?.,\s]*$/i;

const CJK_RE = /[一-鿿]/;

function gateEn(t, lastRetrieved) {
  if (SMALLTALK_EN.test(t)) return { go: false, reason: '寒暄/情绪，不涉及事实' };
  if (lastRetrieved && FOLLOW_EN.test(t)) return { go: true, reason: '追问，延续上一轮检索话题' };
  for (const re of ENTITY_EN) {
    const m = t.match(re);
    if (m) return { go: true, reason: `含实体「${m[0]}」` };
  }
  const lower = t.toLowerCase();
  const word = DOMAIN_EN.find((w) => lower.includes(w));
  if (word) return { go: true, reason: `涉及她本人的事实（「${word}」）` };
  if (FACT_Q_EN.test(t)) return { go: true, reason: `事实型提问（「${t.match(FACT_Q_EN)[0]}」）` };
  return { go: false, reason: '闲聊，未命中检索规则' };
}

export function shouldRetrieve(text, { lastRetrieved = false } = {}) {
  const t = (text || '').trim();
  if (t.length < 3) return { go: false, reason: '太短' };
  // 不含中文 → 走英文规则（安妮的对话基本都是英文）
  if (!CJK_RE.test(t)) return gateEn(t, lastRetrieved);
  if (SMALLTALK_RE.test(t)) return { go: false, reason: '寒暄/情绪，不涉及事实' };

  if (lastRetrieved && FOLLOW_RE.test(t)) return { go: true, reason: '追问，延续上一轮检索话题' };

  for (const re of ENTITY_RE) {
    const m = t.match(re);
    if (m) return { go: true, reason: `含实体「${m[0]}」` };
  }
  const word = DOMAIN.find((w) => t.includes(w));
  if (word) return { go: true, reason: `涉及她本人的事实（「${word}」）` };
  if (FACT_Q_RE.test(t)) return { go: true, reason: `事实型提问（「${t.match(FACT_Q_RE)[0]}」）` };

  return { go: false, reason: '闲聊，未命中检索规则' };
}
