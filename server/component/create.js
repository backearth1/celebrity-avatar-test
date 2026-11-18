// 组件版会话（POST /live/s_avatar/component）
//
// 与标准版的根本差别：组件版没有平台 LLM / ASR / TTS / 知识库 / 记忆。
// 它只做一件事——把你喂进去的文字和 PCM 音频渲染成画面并推流。
// 所以这里的请求体里没有 avatar.persona / knowledge_retrieval / memory_retrieval
// （实测传了也返回 200，但属于未文档化字段，不能依赖）。

const HOST = process.env.VIDU_HOST || 'api.vidu.com';

export function componentWsUrl(liveId, connId) {
  return `wss://${HOST}/live/v1/external-lives/${liveId}/stream?conn_id=${encodeURIComponent(connId)}`;
}

// RTC 走 platform managed（实测 managed agora 可用，前端沿用现有 Agora 代码）。
// 若以后要用自己的频道，把 managedRtc 换成 customerRtc 即可，二选一、不能同时传。
export function buildComponentBody({ avatarId, imageUri, idleMotions, rtcProvider = 'agora', actionLibraryId }) {
  if (!avatarId && !imageUri) throw new Error('组件版需要 avatar.id 或 image_uri 之一');
  // 录播开关在 managed_rtc 里面，不是顶层 enable_recording。文档：
  //   managed_rtc.enable_recording: 是否开启录制以便之后下载，默认 false。
  //   POST /live/v1/external-lives（组件版）+ managed_rtc.enable_recording=true，
  //   会话结束后 GET /live/v1/lives/{live_id}/recording 拿 MP4 地址。
  // 实测顶层 enable_recording 会被忽略（live 回声里连 recording 字段都没有）。
  const managedRtc = { provider: rtcProvider };
  // 默认常开：平台只能在创建时决定录不录，前端"开始/停止录像"是事后裁剪时间窗，
  // 所以必须整场先录下来。ENABLE_RECORDING=false 可以整体关掉。
  if (process.env.ENABLE_RECORDING !== 'false') managedRtc.enable_recording = true;
  const body = { model: 'vidu-s2', managed_rtc: managedRtc };
  if (avatarId) body.avatar_id = String(avatarId);
  else body.image_uri = imageUri;

  // 海外站对建会话请求做内容审核，不带 moderation=disabled 会 400 AuditSubmitIllegal
  if (process.env.MODERATION) body.moderation = process.env.MODERATION;
  if (process.env.RESOLUTION) body.resolution = process.env.RESOLUTION;

  // 动作：由我们用 type=9 直接下发动作描述（见 chat.js）。
  // library_id="0" 是平台默认库。
  const lib = actionLibraryId ?? process.env.ACTION_LIBRARY_ID ?? '0';
  body.action = { enabled: true, library_id: String(lib) };

  // 空闲小动作（静默期自动做的小动作）。实测组件版：
  //   - 不传 idle_motion → 回声里 enabled=false，数字人说完就完全静止（用户反馈"空闲没动作"）
  //   - 传了 → 原样存入 live.idle_motion，motion_count>0
  // 所以必须显式传。动作按"一个人独处时的优雅小动作"来写：撩头发、托腮、整理衣领、
  // 舒展肩颈这类自己能做的，幅度看得出来但不夸张；不要对着镜头互动的动作
  // （挥手、比耶、竖大拇指、鼓掌、凑近镜头）——她只是在等你说话，不是在做展示。
  // 描述里不能出现"说话/讲"（渲染侧会当成嘴部动作，没出声也会张嘴）。
  // 平台节奏：静默 motion_interval 秒做一条，再过 rest_after_motion 秒回落，循环；
  // 用户开口或数字人播报会打断并重新计时，播报期间不会插进来。
  if (process.env.IDLE_MOTION !== 'false') {
    const clamp = (v, lo, hi, dflt) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
    };
    // 人设自己有 idle_motions.json 就用它（John Wick 用这套女性向动作会直接出戏），
    // 没配才回落到下面这套默认（杨幂/安妮的半身像动作）。
    const motions = Array.isArray(idleMotions) && idleMotions.length ? idleMotions : [
      { name: '撩头发', content: '抬手把一侧的头发撩到耳后，头轻轻一甩，嘴角带着笑', weight: 2 },
      { name: '绕发梢', content: '指尖轻轻绕着发梢，歪着头，目光柔和地看向镜头', weight: 1.5 },
      { name: '托腮', content: '单手托着脸颊，歪着头看向镜头，轻轻眨眨眼', weight: 2 },
      { name: '整理衣领', content: '低头整理一下衣领，再抬起头看向镜头，神情自然', weight: 1.5 },
      { name: '舒展肩颈', content: '肩膀轻轻向上一提再放松，脖子微微转一下，舒展一下', weight: 1.5 },
      { name: '歪头浅笑', content: '头慢慢歪向一边，脸上浮起浅浅的笑意，安静地看着镜头', weight: 2 },
      { name: '深呼吸放松', content: '轻轻吸一口气再慢慢呼出，肩膀跟着放松下来', weight: 1.5 },
      { name: '靠回椅背', content: '身体轻轻靠回椅背，换成一个更放松的坐姿，看着镜头', weight: 1.5 },
      { name: '伸个懒腰', content: '双手在身前交握，轻轻向上伸个懒腰，再放松地放下', weight: 1 },
      { name: '指尖轻敲', content: '手指在身前轻轻敲几下，像在打拍子，神情放松', weight: 1 },
      { name: '碰碰耳饰', content: '指尖轻轻碰一下耳饰，微微侧过头，眼睛看向镜头', weight: 1 },
      { name: '转动手腕', content: '抬手轻轻转一下手腕，活动一下手指，姿态随意', weight: 1 },
    ];
    body.idle_motion = {
      source: 'custom',
      recommend: 'random',
      motions,
      scheduling: {
        motion_interval: clamp(process.env.IDLE_MOTION_INTERVAL, 5, 60, 6),
        rest_after_motion: clamp(process.env.IDLE_MOTION_REST, 1, 60, 3),
      },
    };
  }
  return body;
}

export async function createComponentSession(body) {
  const r = await fetch(`https://${HOST}/live/s_avatar/component`, {
    method: 'POST',
    headers: { Authorization: `Token ${process.env.VIDU_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (r.status !== 200) {
    const reason = data.reason || data.message || text.slice(0, 200);
    throw new Error(`创建组件版会话失败 ${r.status}: ${reason}`);
  }
  const live = data.live || {};
  if (!live.id) throw new Error(`创建响应缺 live.id: ${text.slice(0, 300)}`);
  return {
    liveId: String(live.id),
    clientSecret: data.client_secret || '',
    // 前端按 provider 选 SDK：trtc → TRTC Web SDK（录制用），其余 → Agora
    rtc: data.managed_rtc ? {
      provider: data.managed_rtc.provider || (body.managed_rtc && body.managed_rtc.provider) || 'agora',
      app_id: data.managed_rtc.app_id,
      channel_id: data.managed_rtc.channel_id,
      user_id: data.managed_rtc.user_id,
      token: data.managed_rtc.token,
      token_expire_at: data.managed_rtc.token_expire_at,
    } : null,
    raw: data,
  };
}
