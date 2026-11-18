// 一轮对话的编排：用户文字 → LLM 流式 → 逐句 TTS → PCM 喂给渲染侧
//
// 与标准版的关键差异：这些原本全在 Vidu 平台内部完成，现在由我们按轮次调度。
// 打断语义也变了 —— 组件版没有平台 VAD，什么时候算"用户开始说话"由我们判断。
import { streamReply } from './llm.js';
import { buildMessages, extractActions, SOUND_TAGS } from './prompt.js';
import { splitSentences, stripSoundTags, sanitizeSoundTags } from './pipeline.js';
import { isAnnePersona, isIpPersona } from '../personas.js';

const HISTORY_TURNS = Number(process.env.LLM_HISTORY_TURNS || 8);
// 只认白名单里的语气音（(smile)、(stretches) 这种模型自造的会被 TTS 清洗掉，不算数）
const VALID_TAG_RE = new RegExp(`\\(\\s*(?:${SOUND_TAGS.join('|')})\\s*\\)`, 'i');

export function createChatEngine({ live, persona, voice = null, memories = [], kbHits = [], retrieve = null, onEvent = () => {}, trace = null, mission = null }) {
  // 链路页展示的 TTS 音色：按人设走（安妮 anne001test），不能写死全局音色
  const ttsVoice = voice || process.env.MINIMAX_VOICE || 'yangmitest1';
  const history = [];
  let abort = null;
  let turn = 0;
  // 返回事件对象本身，方便后续 trace.update 补写（LLM 先记"已发出"，生成完再补输出）
  // 旁路：trace 任何异常都不能冒泡到主链路（会打断 TTS 喂流、让检索结果变空）
  const tr = (node, payload) => {
    if (!trace) return null;
    try { return trace.push(node, { turn: turn || undefined, ...payload }); } catch { return null; }
  };
  const trUpdate = (ev, patch) => { if (!trace || !ev) return; try { trace.update(ev, patch); } catch { /* 旁路 */ } };
  const trBlob = (v) => { if (!trace) return null; try { return trace.blob(v); } catch { return null; } };

  // 动作指令：组件版的 type=9 input_transcription 就是直接的动作指令（不经过动作库匹配），
  // 描述原样放进 text_msg.content。
  const actionMsg = (desc) => ({ text_msg: { msg_id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, content: desc, timestamp: Date.now() } });

  // 收尾动作：Vidu 的动作会一直保持到下一条指令，最后一句说完不能就这么把手举在半空。
  // 但不能等她说完了再补一条 —— 那样看起来就是"说完之后又莫名其妙动一下"（用户反馈）。
  // 所以改成在她还在说最后一句时、闸门一开就发"把手放下"，动作被这句话盖住；
  // 如果最后一句太短、闸门没来得及开，就保持上一个姿势，说完不再补任何动作。
  const SETTLE_DESC = process.env.ACTION_SETTLE_DESC || process.env.ACTION_RESET_DESC || '双手自然放下，看着镜头';
  let turnSettling = false;   // 正在说最后一句：下一次发动作时改成收尾
  let turnSettled = false;    // 这一轮已经收尾，不再补手势

  // 连续手势：动作描述发一次只驱动一小段动作，之后渲染侧就停了。
  // 只在 LLM 主动写 [动作:...] 时才发的话，大多数轮次整轮只有一个姿势。
  // 这里定时补一条"持续型"手势（不是挥手/点头这种一次性动作），让她在说话期间也有肢体动作。
  // 但动作太频繁会显得抽：任意两条动作之间强制最小间隔 ACTION_MIN_GAP_MS（默认 5s），
  // LLM 的动作和这里补发的动作共用同一个闸门，超频的直接丢弃。
  const HOLD_MS = Number(process.env.ACTION_HOLD_MS || 5000);        // 补发检查间隔
  const MIN_GAP_MS = Number(process.env.ACTION_MIN_GAP_MS || 5000);  // 任意两条动作的最小间隔
  // 描述里不能出现"说话/讲"这类的词：渲染侧会把"说话时……"理解成嘴部动作，
  // 她没出声的时候也会莫名张嘴。只写手、肩、头、表情怎么动。
  // IP 人设（John Wick）话少、动作也少：定时补的手势换成克制、慢的那几个，
  // 不然每 5 秒来一次"双手比划"会直接出戏。
  const HOLD_MOTIONS = isIpPersona(persona) ? [
    '双手交叠放在身前，安静地看着镜头',
    '抬起一只手，掌心向下轻轻一压',
    '慢慢整理西装袖口',
    '身体微微前倾，下颌微收',
    '双肩缓缓下沉，目光不动',
  ] : [
    '双手在胸前自然比划',
    '身体微微前倾，双手摊开',
    '头轻轻侧着，手掌摊开',
    '双手在胸前小幅比划',
    '双手摊开，顺着语气轻轻点头',
  ];
  let holdTimer = null;
  let holdSeq = 0;     // 每次 start/stop 都递增：旧代码路径的 stop 不能停掉新一轮的定时器
  let holdIdx = 0;
  let lastActionAt = 0;
  let pendingAction = null;  // 被 5s 闸门挡下的 LLM 动作：闸门一开就补发，优先于通用手势
  function sendAction(desc, source = 'llm') {
    if (!desc) return false;
    const t = Date.now();
    // 太频繁：这一条先不发。LLM 写的动作跟着这句话走，比定时补的通用手势更贴内容，
    // 直接丢掉的话整轮就只剩"比划着讲"，所以留到下一个空档补发。
    if (t - lastActionAt < MIN_GAP_MS) {
      if (source === 'llm') pendingAction = desc;
      return false;
    }
    lastActionAt = t;
    try {
      live.sendSignal(9, actionMsg(desc));
      onEvent({ kind: 'action', text: desc, source });
      const what = source === 'hold' ? '持续手势（定时补发）'
        : source === 'settle' ? '收尾：说最后一句时把手放下'
        : `回复里标注的动作：${desc}`;
      tr('action', { input: what, output: { type: 9, ...actionMsg(desc) }, note: 'type=9 input_transcription，直接驱动动作/表情' });
      return true;
    } catch { return false; /* 连接已断 */ }
  }
  // 返回 token：调用方在收尾时用 stopHold(token) 只停自己这一轮的定时器。
  // 开场白的 finally 可能晚于下一轮的 startHold 执行，不带 token 会把新定时器误停。
  function startHold() {
    stopHold();
    if (!HOLD_MS) return null;
    const token = holdSeq;
    // 每 500ms 查一次，够 MIN_GAP_MS 才发下一条；LLM 刚发过动作时会自动跳过。
    const tick = () => {
      if (token !== holdSeq) return;
      if (turnSettled) return;             // 已经收尾：说完不再有任何动作
      if (turnSettling) {
        // 正在说最后一句：闸门一开就收手，不再补新手势（pending 也作废，结尾不该再挥手）
        pendingAction = null;
        if (sendAction(SETTLE_DESC, 'settle')) { turnSettled = true; turnSettling = false; }
        return;
      }
      // 有被闸门挡下的 LLM 动作就先补它（和这句话内容对得上），没有才用通用手势
      const desc = pendingAction || HOLD_MOTIONS[holdIdx % HOLD_MOTIONS.length];
      const src = pendingAction ? 'llm' : 'hold';
      if (sendAction(desc, src)) {
        if (src === 'llm') pendingAction = null;
        else holdIdx += 1;
      }
    };
    tick();                                  // 用户说完先给一个，别等她开口才动
    holdTimer = setInterval(tick, Math.min(500, HOLD_MS));
    return token;
  }
  function stopHold(token) {
    if (token !== undefined && token !== holdSeq) return;
    if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
    pendingAction = null;   // 这一轮结束：没来得及补发的动作作废，别带到下一轮
    turnSettling = false;
    turnSettled = false;    // 说完了就停手，不再补任何动作
    holdSeq += 1;
  }

  function busy() { return abort !== null; }

  // 打断当前这一轮：停 TTS 喂流 + 让上游丢弃还在渲染的音频
  function interrupt() {
    stopHold();
    if (abort) { try { abort.abort(); } catch { /* ignore */ } abort = null; }
    live.interrupt();
    onEvent({ kind: 'interrupt' });
  }

  // 用户说了一句（浏览器 ASR 的结果，或打字）
  async function handleUserText(text) {
    const t = (text || '').trim();
    if (!t) return null;
    // 用户开口：先把她还在说的话打断（等价标准版的 VAD 打断）
    if (busy()) interrupt();

    const t0 = Date.now();
    const ac = new AbortController();
    abort = ac;
    turn += 1;
    const myTurn = turn;
    history.push({ role: 'user', content: t });
    onEvent({ kind: 'user', text: t });
    tr('mic', { input: '麦克风 / 打字输入', output: { text: t }, note: '用户这一轮说的话' });
    tr('asr', { input: '（浏览器 Web Speech 识别结果）', output: { text: t, chars: t.length }, note: '组件版没有平台 ASR，识别在浏览器完成' });
    // 她开口前先动起来：等待 LLM/TTS 的这一两秒里也有连续手势，不是一张静止图
    const holdToken = startHold();

    // 句子上游先攒起来：LLM 每凑出一句就并行合成，播放在 feedQueue 里顺序进行
    const sentences = [];
    let wake = null;
    let waiting = false;   // 播放器正空着等下一句（true 时新句子马上会被说，不预合成）
    const push = (s) => {
      sentences.push(s);
      if (waiting) {
        // 下一句就是它：保持流式合成，首块到了就出声（预合成要等整句，反而更慢）
        waiting = false;
      } else {
        // 正在说别的句子：提前合成这一句，说完时直接命中，句间不用空等 TTS
        const clean = extractActions(s).clean;
        if (clean && clean.replace(/\(\s*[a-z-]{2,20}\s*\)/g, '').trim()) live.player.prefetch(clean);
      }
      if (wake) { wake(); wake = null; }
    };
    let streamDone = false;

    const runner = (async () => {
      let played = 0;
      let idx = 0;
      let firstAudioAt = 0;
      let renderedThisTurn = false;   // S2 渲染每轮只记一次
      const lastActions = [];         // 本轮发出去的动作描述
      let pendingTag = '';            // 暂存纯语气音片段，拼到下一句
      let firstTagged = false;        // 是否已经处理过带正文的第一句（用于兜底补语气音）
      const ep = live.player.beginTurn();   // 整轮共用一个节拍起点；ep 用于让旧播放自行退出
      while (true) {
        if (ac.signal.aborted) break;
        if (idx >= sentences.length) {
          if (streamDone) break;
          waiting = true;
          await new Promise((r) => { wake = r; });
          waiting = false;
          continue;
        }
        const raw = sentences[idx];
        idx += 1;
        let { clean, actions } = extractActions(raw);
        // 纯语气音片段（如 "(chuckle)"）不单独合成：并到下一句去。
        // 单独合成要多一次 TTS 往返，还会切出一段很短的怪音。
        if (clean && !clean.replace(/\(\s*[a-z-]{2,20}\s*\)/g, '').trim()) {
          pendingTag = (pendingTag || '') + clean;
          continue;
        }
        if (pendingTag) { clean = pendingTag + clean; pendingTag = ''; }
        if (!clean) continue;
        // 兜底：模型偶尔整条回复一个语气音都不写。第一句正文末尾补一个 (breath)，
        // 保证至少有一个（breath 最不挑情绪，落在句尾就像换气）。
        if (!firstTagged) {
          firstTagged = true;
          if (!VALID_TAG_RE.test(clean)) clean = `${clean} (breath)`;
        }
        // 动作：组件版走 type=9 input_transcription —— 直接的动作指令，
        // 描述直接写进去，渲染侧据此产生表情手势（不经过动作库匹配）。
        for (const a of actions) {
          lastActions.push(a);
          sendAction(a, 'llm');
        }
        // 下一句先挂着预合成：当前句播放时它就并行合成好了，句间不空等。
        // 跳过纯语气音片段（会和后面那句拼在一起，按原文预合成必然不命中）。
        if (idx < sentences.length) {
          let next = '';
          for (let k = idx; k < sentences.length && k < idx + 3; k += 1) {
            const c = extractActions(sentences[k]).clean;
            if (!c) continue;
            next += c;
            if (c.replace(/\(\s*[a-z-]{2,20}\s*\)/g, '').trim()) break; // 拼到第一句有正文的为止
          }
          if (next) live.player.prefetch(next);
        }
        // 最后一句（后面没有排队的、LLM 也已收尾）：说到这一句时把手放下收尾。
        // 闸门允许就在这句话里发；不允许就保持上一个姿势，说完不再补。
        if (streamDone && idx >= sentences.length) turnSettling = true;
        // 流式合成：边收边喂，首块到达即出声（不再整句等合成完）
        const ttsAt = Date.now();
        const before = live.player.stats().fedMs;
        try {
          await live.player.speakOne(clean, ep);
        } catch (e) {
          onEvent({ kind: 'error', error: `TTS: ${e.message}` });
          tr('tts', { input: clean, note: `TTS 失败：${e.message}` });
          continue;
        }
        if (ac.signal.aborted) break;
        const st = live.player.stats();
        const sentMs = st.fedMs - before;
        if (!firstAudioAt) {
          firstAudioAt = Date.now();
          onEvent({ kind: 'first_audio', ms: st.firstChunkMs || (firstAudioAt - t0) });
        }
        tr('tts', {
          input: clean,
          output: { voice: ttsVoice, format: 'pcm s16le 24kHz mono（流式）', duration_ms: sentMs },
          ms: Date.now() - ttsAt,
          note: '流式合成，首块即喂',
        });
        tr('pcm', {
          input: { chunk_ms: 100 },
          output: { sent_seconds: +(sentMs / 1000).toFixed(2), frames: Math.ceil(sentMs / 100) },
          note: '二进制帧上行，口型由它驱动',
        });
        const ok = !ac.signal.aborted;
        // S2 渲染：每轮第一次喂流时记一次（平台侧不可观测，记的是我们喂进去的驱动源）
        if (!renderedThisTurn) {
          renderedThisTurn = true;
          tr('s2', {
            input: { audio: `PCM ${sentMs}ms/句，流式喂`, action: lastActions.length ? lastActions : '（本轮无动作）' },
            output: { model: 'vidu-s2', resolution: process.env.RESOLUTION || '720p', stream: 'managed_rtc → agora' },
            note: '口型由 PCM 驱动，表情手势由动作描述驱动',
          });
        }
        played += sentMs / 1000;
        if (!ok) break;
        // 句间不再人工补静音：TTS 原始输出自带气口，原样连续喂。
      }
      return { played, ep };
    })();

    let full = '';
    // 知识库检索：跟 LLM 并行发起，命中片段拼进 system prompt。
    // 检索要 300~700ms，串行会白白加在首字延迟上。
    const kbAt = Date.now();
    const kbPromise = retrieve
      ? retrieve(t).then((r) => {
          if (r.skipped) {
            // 门控判定不查：也记一条，链路图上能看到"为什么这一轮没查库"
            tr('kb', { input: { query: t }, output: { skipped: true, reason: r.reason }, ms: 0, note: `跳过检索：${r.reason}` });
            return [];
          }
          tr('kb', {
            input: { query: r.query || t, gate: r.reason },
            // 只存引用，展示时再截断（不在主链路上做 map/slice）
            output: { hits: r.hits },
            ms: Date.now() - kbAt,
            note: `${r.reason} → 召回 ${r.recall} 块，rerank 取前 ${r.hits.length}`,
          });
          return r.hits;
        }).catch((e) => { tr('kb', { note: `检索失败：${e.message}` }); return []; })
      : Promise.resolve([]);
    const retrieved = await kbPromise;
    const messages = buildMessages({ persona, memories, kbHits: retrieved.length ? retrieved : kbHits, history, mission });
    // 把这一次真正发给模型的 system prompt 记下来（截断在 trace.js 里做）
    // 完整原文存成 blob，事件里只放引用，前端点开节点时再拉全文
    const promptBlob = trBlob(messages[0].content);
    tr('prompt', {
      input: { persona, mission: mission || undefined, memory_hits: memories.length, kb_hits: retrieved.length, history_turns: (history.length - 1) / 2 },
      output: { system_prompt: { blob: promptBlob, chars: messages[0].content.length } },
      note: `system prompt 全文 ${messages[0].content.length} 字`,
    });
    const llmAt = Date.now();
    // 先记一条"请求已发出"：LLM 是这一轮最早开始的环节，事件必须在时间轴上排在 TTS 前面，
    // 否则图上看不出 asr → llm 的先后。生成完成后再把 output 补进同一个事件（trace 按 i 合并）。
    const msgBlob = trBlob(messages);
    const llmEvent = tr('llm', {
      input: {
        model: process.env.LLM_MODEL, messages: messages.length,
        system_chars: messages[0].content.length,
        memory_hits: memories.length, kb_hits: retrieved.length,
        // 完整请求：system + 历史 + 本轮用户话（点开节点时按 blob 拉全文）
        full_messages: { blob: msgBlob, count: messages.length },
      },
      note: '请求已发出，流式生成中…',
    });
    try {
      full = await streamReply({
        messages,
        onSentence: push,
        signal: ac.signal,
        // 英文人设（安妮、John Wick）：按英文标点分句，且不启用思考泄漏拦截
        english: isAnnePersona(persona) || isIpPersona(persona),
      });
    } catch (e) {
      if (!ac.signal.aborted) onEvent({ kind: 'error', error: `LLM: ${e.message}` });
      trUpdate(llmEvent, { note: `LLM 失败：${e.message}` });
    } finally {
      streamDone = true;
      if (wake) { wake(); wake = null; }
    }

    const { played, ep } = await runner.catch(() => ({ played: 0, ep: undefined }));
    // 音频早就发完了，但渲染侧还在按 1x 播前面攒下的缓冲。等它播完再收尾，
    // 否则手势定时器和 busy 状态会提前结束，她还在说话就不动了。
    await live.player.drain(ep);
    stopHold(holdToken);
    if (myTurn === turn) abort = null;

    if (full) {
      const { clean } = extractActions(full);
      history.push({ role: 'assistant', content: clean });
      while (history.length > HISTORY_TURNS * 2) history.shift();
      // raw 是模型原样输出（含 [动作:...] 与 (sound tag)），前端"LLM 完整返回"用；
      // text 是剥掉动作标记后真正送去 TTS/字幕的文本。
      onEvent({ kind: 'assistant', text: clean, raw: full, ms: Date.now() - t0 });
      // 生成完成：把结果补回同一条 LLM 事件（不新增，事件仍停留在它开始的位置上）
      if (trace) {
        trUpdate(llmEvent, {
          output: {
            // reply_raw = 模型原样输出（含 [动作:x] 和 (sound tag)），先看这个
            reply_raw: full, raw_chars: full.length,
            // reply = 剥离动作标记后的文本，也就是真正送去 TTS / 字幕的
            reply: clean, chars: clean.length,
            // 完整原文另存一份（超长时前端可展开），一般不用看
            raw: full.length > 600 ? { blob: trBlob(full), chars: full.length } : undefined,
            stripped: {
              actions: (full.match(/[\[【]\s*动作\s*[:：][^\]】]+[\]】]/g) || []),
              sound_tags: (full.match(/\(\s*[a-z-]{2,20}\s*\)/g) || []),
            },
          },
          ms: Date.now() - llmAt,
          note: '流式生成，边到边分句送 TTS',
        });
      }
    }
    onEvent({ kind: 'turn_end', playedMs: Math.round(played * 1000), totalMs: Date.now() - t0, aborted: ac.signal.aborted });
    return full;
  }

  // 开场白：不走 LLM，直接说现成的一句（省一次 LLM 往返，开场更快）
  async function speak(text) {
    const { clean, actions } = extractActions(text);
    for (const a of actions) sendAction(a, 'llm');
    const holdToken = startHold();   // 开场白期间也要有连续手势
    tr('greeting', { input: '人设目录里的 greeting', output: { text: clean }, note: '开场白，直接走 TTS' });
    // 开场白也要能被用户打断：登记 aborter 后 busy() 才认识它，
    // 否则用户一开口，开场白会继续播完，和新回复叠在一起（听感=同一句说两遍）。
    const ac = new AbortController();
    abort = ac;
    const ep = live.player.beginTurn();
    const parts = splitSentences(clean);
    // 开场白很短：第一句保持流式（首字最快），其余先预合成，句间不用空等 TTS。
    for (const s of parts.slice(1)) live.player.prefetch(s);
    try {
    for (const [i, s] of parts.entries()) {
      if (ac.signal.aborted) break;
      // 开场白最后一句同样在句内收尾，说完不再补动作
      if (i === parts.length - 1) turnSettling = true;
      const sentBefore = live.player.stats().fedMs;
      await live.player.speakOne(s, ep);
      const sentMs = live.player.stats().fedMs - sentBefore;
      if (!sentMs) continue;
      tr('tts', {
        input: s,
        output: { voice: ttsVoice, format: 'pcm s16le 24kHz mono（流式）', duration_ms: sentMs },
        note: '开场白流式合成',
      });
      tr('pcm', { input: { chunk_ms: 100 }, output: { sent_seconds: +(sentMs / 1000).toFixed(2) }, note: '开场白喂流' });
    }
    await live.player.drain(ep);   // 开场白同样等渲染侧播完再放开 busy
    } finally {
      stopHold(holdToken);
      if (abort === ac) abort = null;
    }
  }

  return { handleUserText, interrupt, speak, busy, history, clearReset: () => { stopHold(); } };
}
