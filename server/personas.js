// 人设注册表：每个人设一个目录，记忆分区（agent_id）各用各的，避免串戏。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PERSONA_ROOT = path.join(ROOT, 'persona');

export const PERSONAS = {
  clone: {
    dir: 'clone',
    label: '杨幂 · AI 数字分身（官方口吻）',
    agentId: 'yangmi_clone_v1',
    personaFile: 'yangmi_persona.md',
  },
  girlfriend: {
    dir: 'girlfriend',
    label: '杨幂 · 女友（角色扮演）',
    agentId: 'yangmi_girlfriend_v1',
    personaFile: 'persona.md',
  },
  anne: {
    dir: 'anne',
    label: '安妮·海瑟薇 · AI 数字分身',
    agentId: 'anne_hathaway_v1',
    personaFile: 'anne_persona.md',
    // 形象/音色可单独指定；没配就沿用全局 AVATAR_ID / AVATAR_VOICE
    avatarIdEnv: 'ANNE_AVATAR_ID',
    voiceEnv: 'ANNE_VOICE',
  },
  anne_girlfriend: {
    dir: 'anne_girlfriend',
    label: '安妮·海瑟薇 · 女友（角色扮演）',
    agentId: 'anne_hathaway_girlfriend_v1',
    personaFile: 'anne_girlfriend_persona.md',
    avatarIdEnv: 'ANNE_AVATAR_ID',
    voiceEnv: 'ANNE_VOICE',
  },
  johnwick: {
    dir: 'johnwick',
    label: 'John Wick · IP 分身（角色扮演）',
    agentId: 'john_wick_v1',
    personaFile: 'johnwick_persona.md',
    // IP 人物没有知识库：背景全部写在 persona 文件里，检索直接跳过（noKb）
    avatarIdEnv: 'JOHN_AVATAR_ID',
    imageUriEnv: 'JOHN_IMAGE_URI',
    voiceEnv: 'JOHN_VOICE',
    noKb: true,
  },
};

export const DEFAULT_PERSONA = 'clone';

// 安妮系列（英文人设）：共用同一个形象/音色、同一套知识库
export const isAnnePersona = (key) => key === 'anne' || key === 'anne_girlfriend';
// 女友向人设：记忆注入和相处口吻都走"恋人"那套
export const isGirlfriendPersona = (key) => key === 'girlfriend' || key === 'anne_girlfriend';
// IP 人物（没有知识库，背景全在提示词里；必须走组件版，平台 LLM 不认识这个设定）
export const isIpPersona = (key) => PERSONAS[key]?.noKb === true;
// 该人设是否查知识库
export const hasKnowledgeBase = (key) => !PERSONAS[key]?.noKb;

export function getPersona(key) {
  const p = PERSONAS[key];
  if (!p) throw new Error(`unknown persona: ${key}`);
  return p;
}

export const read = (key, file) =>
  fs.readFileSync(path.join(PERSONA_ROOT, getPersona(key).dir, file), 'utf-8').trim();

// 人设自己的静默小动作。组件版以前在 create.js 里写死了一套女性向动作（撩头发、碰耳饰），
// 换人设就会出戏，所以改成优先读 persona/<dir>/idle_motions.json。
export function loadIdleMotions(key) {
  const file = path.join(PERSONA_ROOT, getPersona(key).dir, 'idle_motions.json');
  if (!fs.existsSync(file)) return null;
  try {
    const motions = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(motions) && motions.length ? motions : null;
  } catch {
    return null;
  }
}

// 预设共同记忆：人设目录里若有 shared_memories.md，就注入到 persona 的 {{shared_memories}} 占位符
export function loadSharedMemories(key) {
  const file = path.join(PERSONA_ROOT, getPersona(key).dir, 'shared_memories.md');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  return lines.map((l) => l.replace(/^\d+[.、]\s*/, '').trim()).filter(Boolean);
}
