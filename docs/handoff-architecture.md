# AI 数字分身 1v1 实时视频对话 — 架构与组件交接文档

> 目的：把本项目完整交给另一个 AI 编码工具，从零一次性搭建成功。
> 所有平台名、接口契约、实测过的坑都写在里面；按文档顺序实现即可。

## 0. 项目是什么

浏览器里和一个 AI 数字人（杨幂 / 安妮·海瑟薇 / John Wick 等）1v1 实时视频通话：
数字人有形象、有口型、有动作，能听（ASR）、能想（LLM + 知识库 + 记忆）、能说（TTS），
用户可以随时打字或说话打断。支持录像回放。

授权背景：非商业授权技术测试，已取得人物肖像/声音授权。

## 1. 架构总览

有两种运行模式，同一个代码库、同一个进程（Node 单进程，无外部服务依赖除云 API）：

```
【标准版】（MODE=standard，端口 8443）— "代理"架构
  浏览器 ──ws(/ws)──> 本服务（鉴权/动作注入/日志） ──ws──> Vidu 平台
  LLM/ASR/TTS/知识库/记忆 全部在 Vidu 平台内部完成。
  本服务只负责：持有 API Key、创建会话、把浏览器 WS 透传给平台、注入动作指令。

【组件版】（MODE=component，端口 8444）— "自建大脑"架构（重点，本项目核心）
  ┌─────────── 本服务（Node）───────────┐
  │ LLM 流式(自建) → 分句 → TTS 流式(自建) │
  │        ↓ PCM 24kHz                    │
  │   控制WS → Vidu S2-Avatar（只做渲染）  │ ──RTC音视频──> 浏览器
  │   知识库检索(自建) / 长期记忆(平台API)  │
  └──────────────────────────────────────┘
  浏览器不持有控制 WS：ASR 用浏览器 Web Speech，文字/字幕通过轮询 REST 拿。
```

选择建议：标准版依赖平台全栈能力（音色受限）；组件版 LLM/TTS/KB 全部可控，是本项目的
主推模式。安妮、John Wick 等非默认音色人设强制走组件版。

## 2. 技术栈与组件清单

| 组件 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js ≥ 20 | 用到原生 `fetch`、`--env-file` |
| HTTP | 原生 `node:http/https` | 无 Express，一个 `handler` 函数路由 |
| WS | `ws` | 服务端同时当 server（浏览器）和 client（Vidu） |
| 前端 | 原生 HTML/JS/CSS | 无框架；RTC SDK 用 `<script>` 引入 |
| RTC 下行 | Agora SDK 或 TRTC SDK | 组件版用 TRTC（见坑 7.1），浏览器订阅数字人流 |
| LLM | OpenAI 兼容接口，deepseek-v4-flash | `stream:true, thinking:{type:'disabled'}`（必须关，否则输出 reasoning） |
| TTS | MiniMax `speech-2.8-turbo` | 流式 SSE，PCM 24kHz s16le mono，支持语气音标签 |
| ASR | 浏览器 Web Speech API | 组件版没有服务端 ASR，识别在浏览器做 |
| 向量/精排 | 腾讯云 LKE：`lke-textembedding-v1`（1024 维，批量 7）+ `lke-reranker-base` | 知识库检索 |
| 渲染 | Vidu S2-Avatar 组件版 API | 只负责把文字/动作指令/PCM 渲染成带口型的视频流 |
| 录像 | 平台录制 + ffmpeg 裁剪 | 见 §6 |
| HTTPS | 自签证书 | 浏览器摄像头/麦克风要求 HTTPS 或 localhost |

## 3. Vidu 组件版 API 契约（照抄可用）

### 3.1 创建会话
`POST https://api.vidu.com/live/s_avatar/component`，Header：`Authorization: Token <VIDU_API_KEY>`

```json
{
  "model": "vidu-s2",
  "avatar_id": "平台形象ID",              // 或 image_uri: "https://...png"，二选一
  "resolution": "720p",
  "moderation": "disabled",               // 海外站必带，否则 400 AuditSubmitIllegal
  "managed_rtc": { "provider": "trtc", "enable_recording": true },
  "action": { "enabled": true, "library_id": "0" },
  "idle_motion": {                        // 必须显式传！不传则数字人说完就完全静止
    "source": "custom",
    "recommend": "random",
    "motions": [ { "name": "...", "content": "动作描述", "weight": 2 } ],
    "scheduling": { "motion_interval": 6, "rest_after_motion": 3 }
  }
}
```
响应：`{ live_id, client_secret, rtc: {app_id, channel_id, user_id, token} }`。
rtc 四元组下发给浏览器加入频道订阅画面；client_secret 给控制 WS 用。

### 3.2 控制 WS（服务端持有）
`wss://api.vidu.com/live/v1/external-lives/{live_id}/stream?conn_id=x&client_secret=y`

- 连上先发 JSON：`{"type":1,"conn_id":"..."}`（conn_init），回 `type:2` 才算就绪。
  **ack 之前发的二进制音频会被丢弃。**
- JSON 信号帧（发送）：`{"type":<n>,"payload":{...}}`
  - type 9 `input_transcription`：驱动动作/口型文本。动作描述直接放
    `payload.text_msg.content`（`{msg_id, content, timestamp}`），**不经过动作库匹配**。
  - type 7：打断当前播放（清渲染侧音频队列）。
  - type 5：挂断。
- 二进制帧：**裸 PCM，s16le / 24kHz / 单声道，48 字节/毫秒**，单帧上限 16MiB，
  建议每帧 20~100ms。**没有实时节奏要求**（见坑 7.2），渲染侧自己缓冲。
- 心跳 ping/pong ~5s/15s；断开码 1006 常见于远端挂断。

## 4. 对话管线（组件版核心，严格按此实现）

```
用户文字(打字/浏览器ASR) 
  → 若正在播：interrupt（abort LLM+TTS、发 type=7、清字幕定时器）
  → LLM 流式（system prompt 组装见 §5）
      输出里的 [动作:描述] 剥离 → type=9 发给渲染侧
      输出里的 (laughs) 等语气音保留 → TTS 渲染成音效
  → 按标点分句（中文强标点立切/弱标点满字数切/硬切上限；英文另配阈值）
  → 每句：MiniMax 流式 TTS → PCM 块 → 控制 WS 二进制帧
  → 全部发完 ≠ 说完：等渲染侧按 1x 播完（drain）再收尾
```

PCM 发送节奏（实测调优结果，不要自己发明）：
- 不做实时 pacer。TTS 合成是 3~5 倍速，攒够 100ms 就发；
- 唯一限制：最多领先渲染侧 2000ms（`playEndAt = max(playEndAt, now) + pieceMs`，
  超过就 sleep），减少打断时要丢的旧音频；
- 每句 TTS 自带 ~220ms 前导 + ~250ms 尾部静音，要做静音裁剪（阈值 300/32768），
  否则句间"卡一下"。流式裁剪用逐块吞前导的方式，不能等整句（伤首字延迟）。

动作系统（三层，全部走 type=9）：
1. LLM 标注：回复里写 `[动作:双手在胸前比划]`，放句首，剥离后发送；
2. 持续手势：说话期间每 5s（可配）补一条通用手势，同一闸门限频；
3. 收尾：最后一句说到时发"双手自然放下，看着镜头"，避免说完手悬在半空。
硬规则：动作描述 4~16 字、只能写手/肩/头/表情、**绝不能出现"说话/讲话/边说边"**
（渲染侧会当成嘴部动作，没声音也张嘴）、不能提到画面外物体（椅子杯子等）。

打断：用户开口 → abort 上游 + 发 type=7 + 清字幕定时器 + 清播放时钟。
字幕：每句 TTS 首块发出时，按 `playEndAt` 估算播放开始时刻，定时下发 type=10。

## 5. Prompt 组装（每轮请求的 system prompt）

拼接顺序（一个 system 消息 + 最近 8 轮 history）：

1. **人设正文** `persona/<dir>/<personaFile>`（.md，全部人设背景写在这里）
2. **今天日期**（相对时间→绝对年份换算用）
3. **记忆块**：平台记忆 API 按 `user_id + agent_id` 拉取的长期记忆；没有记忆时给
   "第一次见面"引导，有则给"叫出名字、接上次话题"的指令
4. **知识库块**：命中片段 `【标题】正文`，要求第一人称口语说出、查不到就承认
5. **动作块**：`[动作:...]` 格式规则 + `action_prompt.txt`（每人设一份风格）
6. **语气音块**：MiniMax 语气音白名单（21 个：laughs/chuckle/breath/sighs/...），
   每条回复 2~3 个（IP 人设 1~2 个）、同回复不重复、别堆开头、(chuckle) 限频
7. **任务块**（仅 IP 人设）：本场任务注入
8. **末尾自检**：模型对最后一段遵守度最高，把"至少 N 个语气音 + 1 个动作"再强调一遍

英文人设（安妮/John Wick）：整份规则强制"永远说英语"；LLM 按英文标点分句；
关闭"思考泄漏"拦截（英文长单词会误伤）。

## 6. 知识库（RAG）与记忆

- 文档放 `kb/personas/<key>/docs/*.md`（无则回落 `kb/docs/`）。
- 切片：420 字上限、12 字下限，按标题保留层级；每 persona 一份索引 JSON
  （`data/kb_index_<persona>.json`，含向量），首次启动/文档变更时重建。
- 检索：向量 top12 ∪ 关键词 n-gram top12（2~4 字片段撞文本，标题加权）
  → rerank 精排 → 年份硬信号加成 +6（"去年/10年前/2016年"都要换算或识别，
  资料里的 `（2016）` 也要能命中）→ 分数 ≥ -6 过阈值 → top3 进 prompt。
- 门控：闲聊不检索（正则判断是否问本人事实/追问）；追问沿用上一轮查询原文。
- 长期记忆：会话结束把要点写回平台记忆 API（`user_id + agent_id` 维度，
  agent_id 按人设隔离），下次建会话时拉出来注入 prompt。

## 7. 实测的坑（每条都付过学费，直接遵守）

1. **平台录制只认 TRTC**：`managed_rtc.provider=agora` 时录像查询一直
   `query_failed`。组件版一律 `trtc`。
2. **不要做 PCM 实时 pacer**：按 1x 推流会让渲染侧饥饿、声音卡顿。
   只留 2s 发送上限；文档只规定格式，不规定节奏。
3. **MiniMax 流式 SSE 有陷阱**：`status=1` 是增量分片，`status=2` 是整段完整重复，
   两批都收会"同一句话说两遍"。只取 1，没收到分片才兜底用 2。
4. **idle_motion 必须显式传**，否则数字人静默期完全静止。
5. **动作描述出现"说话/讲"会让数字人无声张嘴**；人设和 prompt 里要双重禁止。
6. **`node --env-file` 不覆盖已存在的环境变量**：`.env` 里写了 `PORT=8443` 时，
   命令行 `PORT=8444` 无效。多端口跑两个实例时把端口从 .env 里去掉。
7. **标准版→组件版模式切换后**，浏览器不要持有控制 WS；会话 60s 无人连 WS 会被
   误杀，组件版要在服务端登记假连接规避。
8. **组件版响应体里不要传平台私有字段**（persona/knowledge_retrieval 等），
   返回 200 但属未文档化行为。
9. **英文文本不能按中文标点分句**（句号不切），要单独一套阈值并按空格硬切。
10. **首帧 conn_init ack 前发音频会被静默丢弃**，握手完成前不要开始喂 PCM。

## 8. 服务端 REST 接口（组件版）

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/me` | GET | 身份（legacy uid 或 cookie），返回 user_id |
| `/api/session` | POST | 建会话 `{persona}`；按人设自动选模式；并发/时长限额，超限 429 |
| `/api/component/say` | POST | `{live_id, text}` 用户说话/打字 |
| `/api/component/interrupt` | POST | 打断当前回复 |
| `/api/component/hangup` | POST | 挂断 |
| `/api/component/events` | GET | `?live_id&since` 增量事件轮询（700ms 一次） |
| `/api/component/blob` / `trace` | GET | 链路调试页用的大字段/时间线 |
| `/api/personas` | GET | 人设列表 |
| `/api/memory` | GET/DELETE | 查看/清除当前用户在该人设下的长期记忆 |
| `/api/record/start|stop|status` `/api/recordings` | | 录像时间窗打点、列表/播放/删除 |

事件队列（服务端每会话一个数组，浏览器增量拉取），事件类型：
`user`（回显）、`assistant`（`text`=剥离动作后的正文，`raw`=模型原样输出——
前端聊天框直接显示 raw，动作内容自然可见）、`action`（`source: llm|hold|settle`）、
`first_audio`（首字延迟 ms）、`turn_end`、`interrupt`、`error`。

## 9. 人设系统

`persona/<dir>/` 每个人设一个目录：

| 文件 | 用途 |
|---|---|
| `<name>_persona.md` | 人设正文（§5 第 1 块） |
| `action_prompt.txt` | 动作风格（半身像约束、常用手势） |
| `idle_motions.json` | 静默期小动作（IP 人设用自己那份，避免女性动作穿帮） |
| `greeting.txt` | 开场白指令（组件版直接给现成文本） |
| `shared_memories.md` | 女友类人设的预设共同记忆 |

注册表 `server/personas.js`：`dir / label / agentId（记忆分区） / personaFile /
avatarIdEnv / imageUriEnv / voiceEnv / noKb`。
- 每人设独立形象/音色：`avatarIdEnv` 等指向 `.env` 变量名（如 `JOHN_AVATAR_ID`），
  配了就只认它、不回落全局形象；都没配直接报错拒绝建会话。
- `noKb: true`（IP 人物）：背景全写人设里，跳过检索、强制组件版。
- 形象上传：`POST /live/v1/avatars {image_uri, name}` → 轮询到 success 拿 id
  （90 天过期需重传）。

John Wick（IP 人设示例，可直接照抄思路）：全英文回复（对方说中文也回英文）；
三个任务（血契谈判 / 找内鬼 / 护送方案）服务端每场轮换注入，聊天围绕任务推进，
有明确完成条件与收尾句；语气音降到 1~2 个；动作克制（整理袖口、双手交叠等）。

## 10. 前端（单页，无框架）

- 布局：左视频区（数字人全屏 + 本地摄像头小窗 + AI 标识 + 状态条 + 控制栏），
  右侧栏（人设选择、文字输入、记忆管理、录像）。
- RTC：按创建会话返回的 provider 加载 Agora 或 TRTC SDK，用下发的
  app_id/channel_id/token/user_id 入会，只订阅数字人（不推流）。
- ASR：Web Speech `webkitSpeechRecognition`，`lang` 按人设选 zh-CN/en-US，
  连续识别，结果 POST `/api/component/say`。
- 字幕/聊天：轮询 `/api/component/events` 增量渲染；用户消息本地先上屏并用
  `localUserEcho` 抵消服务端回显，防止显示两遍；assistant 直接显示 raw。
- 麦克风说话即打断（ASR 收到结果就调 say，服务端负责打断）。
- `/pipeline`：链路可视化页，读 trace 接口展示 每个环节的输入输出与耗时（调试用，可选）。

## 11. 目录结构

```
server/
  server.js          # 入口：路由、静态文件、鉴权、限额、标准版 WS 代理
  personas.js        # 人设注册表（见 §9）
  session_config.js  # 标准版会话体
  text_action.js     # 标准版动作注入
  access.js          # Basic auth + 身份 + 并发/时长限额
  recording.js       # 录像下载/裁剪/元数据
  component_memory.js# 长期记忆读写
  component/         # 组件版全部逻辑
    create.js        #   建会话请求体（§3.1）
    live.js          #   控制 WS：握手/信号帧/二进制帧/统计
    pipeline.js      #   PCM 发送/播放时钟/字幕调度/drain
    tts.js           #   MiniMax 流式/静音裁剪/预合成
    llm.js           #   LLM 流式/分句/思考泄漏拦截
    prompt.js        #   §5 的 prompt 组装
    chat.js          #   一轮对话编排 + 动作系统
    kb.js / kb_index.js / kb_gate.js / tc_embed.js  # RAG
    service.js       #   会话池：串起以上所有 + 事件队列
web/  index.html app.js style.css pipeline.html pipeline.js pipeline.css
persona/  <每人设一目录>（§9）
kb/  docs/ + personas/<key>/docs/    # 知识库原文（索引可重建）
scripts/  upload_avatar.mjs 等工具
```

## 12. 环境变量与启动

```
# Vidu
VIDU_API_KEY=...            VIDU_HOST=api.vidu.com
AVATAR_ID=...               # 全局默认形象
ANNE_AVATAR_ID=...  ANNE_VOICE=anne001test
JOHN_IMAGE_URI=https://...  JOHN_VOICE=johnwick001
RESOLUTION=720p             MODERATION=disabled        RTC_PROVIDER=trtc
# LLM（OpenAI 兼容）
LLM_BASE_URL=...  LLM_API_KEY=...  LLM_MODEL=deepseek-v4-flash  LLM_HISTORY_TURNS=8
# TTS
MINIMAX_API_KEY=...  MINIMAX_MODEL=speech-2.8-turbo  MINIMAX_VOICE=yangmitest1
# KB（腾讯云 LKE）
TENCENT_SECRET_ID=...  TENCENT_SECRET_KEY=...
# 访问与服务
ACCESS_USER=demo  ACCESS_PASSWORD=...  TLS_CERT=certs/cert.pem  TLS_KEY=certs/key.pem
MAX_CONCURRENT_SESSIONS=10  MAX_SESSION_SECONDS=600  ENABLE_RECORDING=true
```

```bash
npm install
# 组件版（主推）
MODE=component PORT=8444 node --env-file=.env.global server/server.js
# 标准版
node --env-file=.env.global server/server.js   # 默认 8443
```

## 13. 验收清单（搭完逐项打勾）

1. 建会话 <3s，浏览器 5s 内看到数字人画面并听到开场白；
2. 打字一句 → 首字音频 ≤2s，字幕与语音同步，口型对上；
3. 说话/连打两句能打断，旧音频立即停、新回复接上；
4. 数字人说话期间有持续手势，说完手放下，静默期有 idle 小动作；
5. 问知识库内事实（含"去年/某年"）能答，闲聊不触发检索；查不到承认不知道；
6. 第二次会话能叫出你上次说的名字；
7. 录像：挂断后自动下载裁剪，时长 = 按下开始到停止的间隔，页面可播放/删除；
8. 多人同时访问互不串台（身份隔离、人设记忆按 agent_id 分区）。
