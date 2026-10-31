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
};

export const DEFAULT_PERSONA = 'clone';

export function getPersona(key) {
  const p = PERSONAS[key];
  if (!p) throw new Error(`unknown persona: ${key}`);
  return p;
}

export const read = (key, file) =>
  fs.readFileSync(path.join(PERSONA_ROOT, getPersona(key).dir, file), 'utf-8').trim();

// 预设共同记忆：人设目录里若有 shared_memories.md，就注入到 persona 的 {{shared_memories}} 占位符
export function loadSharedMemories(key) {
  const file = path.join(PERSONA_ROOT, getPersona(key).dir, 'shared_memories.md');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  return lines.map((l) => l.replace(/^\d+[.、]\s*/, '').trim()).filter(Boolean);
}
