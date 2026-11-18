// 组件版的记忆：继续用平台的长期记忆资产接口，但检索与注入由我们自己控制。
//
// 标准版靠 memory_retrieval.enabled 让平台自动检索+自动回写；
// 组件版没有这个开关，所以：
//   - 读：建会话时拉一份注入 prompt（listMemories）
//   - 写：每轮结束把「用户说了什么」丢给 /live/v1/memories 提取（writeMemories）
//     —— 平台仍负责"从对话里提取记忆"，我们不自己写规则
import { getPersona } from './personas.js';

const HOST = process.env.VIDU_HOST || 'api.vidu.com';
const AUTH = () => ({ Authorization: `Token ${process.env.VIDU_API_KEY}`, 'Content-Type': 'application/json' });

async function call(method, pathname, body) {
  const r = await fetch(`https://${HOST}${pathname}`, {
    method, headers: AUTH(), body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: r.status, data };
}

// 拉取这位用户的长期记忆正文（最多 30 条，注入 prompt 用）
export async function listMemories({ userId, persona }) {
  const { status, data } = await call('POST', '/live/v1/memories/list', {
    user_id: userId, agent_id: getPersona(persona).agentId, page: 1, page_size: 30,
  });
  if (status !== 200) throw new Error(`memories/list ${status}`);
  return (data.results || []).map((m) => m.memory).filter(Boolean);
}

// 让平台从这一轮对话里提取并写入记忆（组件版没有 enable_write 自动回写）
export async function writeMemories({ userId, persona, runId, userText, assistantText }) {
  const messages = [{ role: 'user', content: userText }];
  if (assistantText) messages.push({ role: 'assistant', content: assistantText });
  return call('POST', '/live/v1/memories', {
    user_id: userId, agent_id: getPersona(persona).agentId, run_id: runId, messages,
  });
}

export async function clearMemories({ userId, persona }) {
  const q = new URLSearchParams({ user_id: userId, agent_id: getPersona(persona).agentId });
  return call('DELETE', `/live/v1/memories?${q}`);
}
