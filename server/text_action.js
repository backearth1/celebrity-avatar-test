// 说话手势（text_action / type=101）。两条原则：
// 1) 手感靠"连续"：动作写成持续性的说话比划，而不是点头、挥手这种一次性动作。
//    一次性动作有明确的起止，渲染慢半拍就看得出来；连续动作从哪一刻开始都像"正在说话"。
// 2) 内容匹配尽量提前到"用户说完"这一刻决定：她接下来说什么由用户的话决定，
//    等她的回复文本（晚约 1.8 秒）再匹配，必然又迟又容易和正在说的话错位。

// 用户说完话、她准备开口：按用户的这句话选一个持续型手势
const LEADING = [
  { name: '回应问候', re: /^(嗨|哈喽|你好|在吗|hello)/i, action: '抬起右手轻轻挥两下，然后手放回胸前自然比划着说话' },
  { name: '接住情绪', re: /累|烦|难过|难受|不开心|焦虑|加班|气死|委屈|失眠/, action: '头微微前倾，一只手在胸前轻轻往下压，边说话边小幅比划，语气放软' },
  { name: '回答提问', re: /[吗呢呀吧？?]\s*$|什么|怎么|为什么|哪|谁|多少/, action: '头微微侧一点，手掌摊开轻轻比划着讲，像在回忆和解释' },
  { name: '接话继续', re: /./, action: '双手在胸前自然地小幅比划着说话，配合语气轻轻点头' },
];

// 回复文本到达时：只保留少数必须贴合内容的动作，其余交给上面的连续手势
const REPLY_RULES = [
  { name: '回应告别', re: /拜拜|再见|下次见|先这样/, action: '抬起右手轻轻挥两下' },
  { name: '安慰', re: /别难过|抱抱|会好的|别太累|有我在/, action: '头偏向一侧，手在胸前轻轻往下按一下' },
];

// 长回复中途补一次，避免一句话说到后面完全没动作
const CONTINUE = '继续双手在胸前小幅比划着说，语气自然地点头';
const FALLBACK = '说话时双手在胸前轻轻比划，顺着语气小幅点头';

export const COOLDOWN_MS = 3000;
const MIN_CHARS = 6;
const LONG_REPLY = 55; // 超过这个长度，中途补一次

export function createActionPicker() {
  let lastAt = 0;
  function allow() {
    const now = Date.now();
    if (now - lastAt < COOLDOWN_MS) return false;
    lastAt = now;
    return true;
  }
  return {
    // 用户整句转写到达时调用：零延迟，按用户的话决定她这轮怎么比划
    pickLeading(userText) {
      const t = (userText || '').trim();
      if (!t) return null;
      if (!allow()) return null;
      return LEADING.find((r) => r.re.test(t));
    },
    // 回复文本到达时调用：只处理少数强匹配，否则返回 null（不打断连续手势）
    pick(text) {
      if (!text || text.length < MIN_CHARS) return null;
      const rule = REPLY_RULES.find((r) => r.re.test(text.trim()));
      if (!rule || !allow()) return null;
      return rule;
    },
    // 长回复：返回需要在中途补动作的延迟毫秒数，否则 null
    continueAfter(text) {
      if (!text || text.length < LONG_REPLY) return null;
      return 2500;
    },
    continueAction: { name: '继续比划', action: CONTINUE },
    fallbackAction: { name: '通用手势', action: FALLBACK },
  };
}
