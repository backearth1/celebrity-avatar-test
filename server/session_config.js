// 创建 Live 会话的请求体。人设 / 知识库 / 记忆相关的可调参数集中在这里。
import fs from 'node:fs';
import path from 'node:path';
import { loadSharedMemories, read, DEFAULT_PERSONA, getPersona } from './personas.js';

const env = process.env;

// 记忆分区：按人设隔离（见 personas.js）
export { DEFAULT_PERSONA };

const KNOWLEDGE_TOOL_INSTRUCTION = `
当用户问到“我”（杨幂）的作品、角色、上映/播出时间、奖项、代言、经历、公益、综艺、歌曲等具体事实时，先检索知识库再回答。
查到后用第一人称、口语化地自然说出来，像在回忆自己的事，不要说“根据资料/知识库显示”。
知识库里“获得/入围”混在一起的奖项，不确定是获奖还是提名时说“入围了”或“提名了”，不要夸大。
没查到就坦白说记不太清了，不要编造具体日期、数字、片名、角色名。
感情、婚姻、孩子、绯闻、争议事件不要检索，按人设里的边界处理。
`.trim();

const MEMORY_TOOL_INSTRUCTION = `
用户提到自己的事（名字、喜好、经历、心情），或者对话涉及“上次”“之前说过”时，先检索记忆。
开场时如果能想起这位用户，就自然地叫出名字或接上次的话题，像老朋友，而不是复述档案。
提起记忆要自然，比如“你上次说……后来怎么样了”，绝不说“我的记忆库显示”。
记忆不确定时用提问去确认，不要硬说。
`.trim();

function memorySection(memories, personaKey) {
  if (!memories.length) {
    return personaKey === 'girlfriend'
      ? '\n\n# 他最近的情况\n你们是恋人，但你还不知道他最近发生了什么。开场自然地问问他今天过得怎么样。'
      : '\n\n# 这位朋友\n第一次见面。开场打完招呼，问问怎么称呼对方。';
  }
  const joined = memories.map((m) => `- ${m}`).join('\n');
  return personaKey === 'girlfriend'
    ? `\n\n# 他最近的情况（你们聊天时提过的，你记得）\n${joined}\n`
      + '自然地带出来，像女朋友记得男朋友的事，不要像在复述档案。'
    : `\n\n# 这位朋友（你们聊过，你记得这些）\n${joined}\n`
      + '开场就像老朋友：叫对方的名字，挑一件上次聊到的事自然地问问近况。不要一次把记得的全说出来，也不要说"我记得你的资料"。';
}

// 女友人设：预设共同记忆注入 persona 的占位符
function applySharedMemories(persona, personaKey) {
  const shared = loadSharedMemories(personaKey);
  if (!shared) return persona;
  const block = shared.map((m) => `- ${m}`).join('\n');
  return persona.replace('{shared_memories}', block);
}

const GIRLFRIEND_KB_INSTRUCTION = `
聊到“我”的作品、角色、奖项、经历时，先检索知识库再用第一人称口语说出来，像随口提起自己的事。
剧情、台词、对手戏、幕后细节这类知识库里没有的，不要展开，说“我记不太清了”，然后让他讲给你听。
感情、婚姻、绯闻、争议不检索，按人设的边界处理。
`.trim();

export function buildSessionBody({ userId, callMode = 'video', persona = DEFAULT_PERSONA, memories = [] }) {
  const cfg = getPersona(persona);
  const avatar = {
    persona: applySharedMemories(read(persona, cfg.personaFile), persona) + memorySection(memories, persona),
    greeting_instruction: read(persona, 'greeting.txt'),
    action_prompt: read(persona, 'action_prompt.txt'),
    voice: env.AVATAR_VOICE || 'Maia',
    farewell_enabled: true,
    persona_enhance: false, // 精品人设：人工打磨，不让平台扩写
  };
  if (env.AVATAR_ID) avatar.id = env.AVATAR_ID;
  else if (env.AVATAR_IMAGE_URI) avatar.image_uri = env.AVATAR_IMAGE_URI;
  else throw new Error('请在 .env 设置 AVATAR_ID（scripts/upload_avatar.mjs 上传后获得）或 AVATAR_IMAGE_URI');

  const body = {
    model: 'vidu-s2',
    call_mode: callMode,
    resolution: env.RESOLUTION || '720p',
    rtc: { provider: 'agora' },
    avatar,
    voice_model: { provider: 'qwen_omni' }, // qwen_omni 支持用户视频画面输入（能“看见”用户），doubao 不支持
    audio: { enable_transcription: true },
    vad: { type: 'server', threshold: 0.5, silence_duration_ms: 500, idle_timeout_ms: 12000 },
    llm: {
      temperature: 0.8,
      top_p: 0.85,
      presence_penalty: 0.5,
      frequency_penalty: 1.1,
      max_tokens: 150, // 默认 50 太短，讲作品时会被截断；长度由人设约束
    },
    idle_motion: {
      source: 'custom', // 平台默认库动作幅度偏小，正面半身像里看不出来，只用自定义
      recommend: 'intelligent',
      motions: JSON.parse(read(persona, 'idle_motions.json')),
      scheduling: { motion_interval: 6, rest_after_motion: 3 },
    },
    action: { enabled: env.ACTION_MATCH === 'true' }, // Layer 1：按用户发言匹配动作，默认关闭，改由 Layer 2 text_action 驱动
    idle_timeout_seconds: Number(env.IDLE_TIMEOUT_SECONDS || 600),
    enable_recording: env.ENABLE_RECORDING === 'true',
    knowledge_retrieval: {
      enabled: true,
      provider: 'vidu',
      knowledge_base_id: env.VIDU_KB_ID,
      force_search: env.KB_FORCE_SEARCH === 'true', // 每轮强制检索：更准，但每轮多一次检索延迟
      tool_instruction: persona === 'girlfriend' ? GIRLFRIEND_KB_INSTRUCTION : KNOWLEDGE_TOOL_INSTRUCTION,
    },
    memory_retrieval: {
      enabled: true,
      provider: 'vidu',
      user_id: userId,
      agent_id: cfg.agentId,
      enable_write: true,
      tool_instruction: MEMORY_TOOL_INSTRUCTION,
    },
  };
  // 文档未公开的一级参数，按 .env 配置透传
  if (env.MODERATION) body.moderation = env.MODERATION;
  if (env.EXTRA_MOTION) body.extra_motion = env.EXTRA_MOTION === 'true';

  if (!env.VIDU_KB_ID) throw new Error('VIDU_KB_ID 未设置，先运行 python3 scripts/kb_sync.py');
  return body;
}
