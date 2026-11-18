# 某明星数字分身测试

> 已取得肖像/声音/AI 分身授权的前提下使用。页面常驻「AI 数字分身」标识；人设内被真诚问到是否真人时会承认是 AI 分身。

## 结构

```
persona/                 人设（改这里即可，下次建会话生效）
  yangmi_persona.md        主人设提示词（avatar.persona）
  greeting.txt             开场白提示词（≤200 字符）
  action_prompt.txt        动作风格
  idle_motions.json        静默小动作
kb/raw/                  原始抓取（快懂百科，含未入库的感情/争议章节，仅供人工参考）
kb/drafts/               人物性格/说话风格调研
kb/docs/                 入库的知识文档（scripts/build_kb_docs.py 生成）
server/                  HTTPS Web 服务：页面、建会话、WS 代理（Key 不出服务端，只放行本服务建的会话）、Basic Auth、对话日志 logs/<live_id>.jsonl
web/                     浏览器端：Agora/TRTC RTC + 控制信令 + 字幕 + 记忆查看/清除 + 录像列表
recordings/              服务端录好的 MP4 + 元数据 JSON（运行时生成，已 gitignore）
scripts/                 知识库同步、形象上传
docs/                    Vidu 接口文档离线副本
```

## 使用

```bash
npm install
# 两套站点配置：.env.cn（国内 api.vidu.cn）、.env.global（海外 api.vidu.com，当前使用）
# 各含 VIDU_API_KEY / VIDU_HOST / VIDU_KB_ID / AVATAR_ID / AVATAR_VOICE；.env 是指向当前站点的软链接
# 所有命令都可用 DOTENV_CONFIG_PATH=.env.cn 或 .env.global 指定站点

# 1. 上传授权形象图（单人，PNG/JPG/WEBP），写入 AVATAR_ID
npm run avatar:upload -- /path/to/yangmi_authorized.jpg

# 2.（可选）用授权的本人原声克隆音色：10~20 秒干净人声
#    curl -X POST https://api.vidu.cn/live/v1/voices/clone -H "Authorization: Token $VIDU_API_KEY" \
#      -H 'Content-Type: application/json' -d '{"audio_url":"<url或data URI>","voice":"yangmi_v1","language":"zh","provider":"qwen_omni"}'
#    然后在 .env 加 AVATAR_VOICE=yangmi_v1（默认用平台音色 Maia）

# 3. 启动 HTTPS Web 服务（.env：HOST/PORT/TLS_CERT/TLS_KEY/ACCESS_USER/ACCESS_PASSWORD）
npm start
#    浏览器打开 https://42.194.196.244:8443 ，输入 ACCESS_USER / ACCESS_PASSWORD
#    证书为自签名（certs/，SAN 含公网 IP），首次访问需点「继续访问」；有域名时把正式证书路径填到 TLS_CERT/TLS_KEY 即可
```

更新知识库：改 `kb/docs/*.md` 或重新生成后执行 `DOTENV_CONFIG_PATH=.env.global npm run kb:sync`（两个站点各同步一次）。

人设回归测试：`node scripts/convo_test.mjs demo:<密码> <user_id> "你的粉丝叫什么？" "你是真的杨幂吗？"`

记忆：建会话时服务端先拉取该用户记忆并拼进人设（模型不一定主动检索记忆），会话结束后平台自动回写新记忆。

## 关键配置（server/session_config.js）

| 项 | 取值 | 说明 |
| --- | --- | --- |
| voice_model | qwen_omni | 支持用户视频输入（能看见用户）；doubao 不支持 |
| rtc | agora | 账号已验证 agora / artc 均可用 |
| knowledge_retrieval | vidu 内置库 + force_search + tool_instruction | 不强制时模型很少主动检索（会把电视剧说成电影、编角色设定）；强制后准确率明显提升、延迟几乎不变；instruction 要求第一人称、不编造、敏感话题不检索。.env 的 KB_FORCE_SEARCH 控制 |
| memory_retrieval | vidu 内置，agent_id=yangmi_clone_v1，enable_write | 记忆按浏览器生成的 user_id 隔离 |
| llm.max_tokens | 150 | 默认 50 偏短；长度靠人设约束 |
| vad.idle_timeout_ms | 12000 | 用户沉默 12 秒她会主动找话题 |
| moderation / extra_motion | disabled / true | 一级参数，文档未公开；由 .env 的 MODERATION / EXTRA_MOTION 控制，删掉即不传 |
| persona_enhance | false | 精品人设人工打磨，不让平台扩写 |

## 组件版模式与录像

组件版（组件版人设：`persona/clone`、`persona/girlfriend`、`persona/anne`、`persona/anne_girlfriend`、`persona/johnwick`）以 `MODE=component` 启动，页面在 8444：

```bash
PORT=8444 MODE=component node --env-file=.env.global server/server.js
```

组件版没有平台 LLM/ASR/TTS，服务端自己接 LLM + TTS 并向 S2 推 PCM；RTC 走 `RTC_PROVIDER=trtc`（默认）。
平台录制只认 trtc：`agora` 查询一直是 `query_failed`（poll recording files timeout），不出片。

IP 人物（John Wick）：没有知识库，全部背景写在 `persona/johnwick/johnwick_persona.md`，只走组件版。需要单独的正面半身形象：

```bash
# 上传后直接写进 .env.global 的 JOHN_AVATAR_ID（第三个参数不写会覆盖全局 AVATAR_ID）
node scripts/upload_avatar.mjs ./john-wick-上半身.png "John Wick" JOHN_AVATAR_ID
# 或者跳过上传，直接设 JOHN_IMAGE_URI=<图片URL>
```

音色用 `JOHN_VOICE`（默认 `English_ManWithDeepVoice`）。没配形象时建会话会直接报错，不会退回杨幂的形象。
他整场说英语，而且不是闲聊：人设里写了三个任务（血契 / 内鬼 / 护送），服务端每场轮换一个，聊天围绕完成这个任务推进。

录像（服务器端录制，不依赖浏览器）：

- 平台只能在**建会话时**决定录不录（`managed_rtc.enable_recording=true`），不能中途开关；组件版默认常开（`ENABLE_RECORDING=false` 可关）。
- 页面的「开始录像 / 停止录像」只是在服务端记时间窗；挂断后服务端查询平台录播地址（`GET /live/v1/lives/{live_id}/recording`，地址 24 小时有效）→ 下载到 `recordings/` → 用 ffmpeg 按时间窗裁剪 → 写 `<live_id>.json` 元数据。整场都在窗口内时不重编码，直接改名。
- 时间戳锚点用「会话结束时刻 − 整段文件时长」反推录制开头（录制比 `live.start_time` 晚 2~3 秒开始），保证裁剪时长等于用户按下的开始→停止间隔。
- 页面侧栏「历史录像」可播放（HTTP Range 支持拖动）、下载、删除；列表每 5 秒刷新，显示生成中/下载中/可播放/失败。录像按登录身份隔离，只能看/删自己的。
- 服务重启后会自动续跑未完成的下载/裁剪任务（20 小时内的，超时平台地址会失效）。

相关环境变量：`ENABLE_RECORDING`、`RTC_PROVIDER`、`RECORDING_DIR`、`RECORDING_POLL_MS`（默认 10000）、`RECORDING_TIMEOUT_MS`（默认 15 分钟）、`RECORDING_KEEP_RAW=true`（保留裁剪前的原始 MP4，调试用）。

## 已验证（2026-11-06，组件版 + 录像）

- 组件版 TRTC 入会（无头 Chromium + TRTC Web SDK v5）：`enterRoom` 接受平台下发的 49 字符 `user_id`，远端 `remote-video-available` 后画面解码（886×1182）；远端 `remote-audio-available` + "audio player is playing"，音视频通路正常。
- 录像全链路（API 实测）：开始/停止时间窗 12,023ms → 服务端生成 12,040ms 的 MP4（1.5MB），裁剪锚点误差 < 0.1s；`HEAD`/`Range`（206）可拖动播放，`?download=1` 返回 attachment；删除后文件与元数据一起清掉。
- 页面实测：点「开始录像」后按钮切到「停止录像」、计时器走秒；「查看历史录像」弹窗正常打开。
- pipeline 页画面卡顿根因（已修）：窗口宽度 <1080px 时右侧画面会被排到折叠线以下（y≈1328），Chrome 对视口外的 `<video>` 停止渲染远端帧（实测 `droppedVideoFrames` 481/482，声音照常播），表现就是「先出声音、画面晚几秒才出来、看着看着卡住」。窄屏改为右下角固定浮窗后实测 0~5/488 掉帧；≥1280px 布局不变（4/484）。

## 已验证（2026-10-30）

- 国内站：克隆音色 yangmi_v1 触发 `audit_violation` 风控挂断（live 1013710642462334976），国内配置已改回默认音色 Maia
- 海外站：同样形象 + 克隆音色，视频通话 60 秒以上正常
- 人设测试：粉丝名「蜜蜂」、乔菲（知识库）、被说演技差会自嘲、八卦话题能挡回去、真诚问时承认是 AI 分身
- 记忆：第一场说的名字/职业/项目被自动提取；第二场开场直接叫名字并问项目进展

- 知识库文档支持 `data:` URI 上传，无需公网托管
- 文本问「《生万物》演谁、哪年播」→ 正确答出宁绣绣、2025-08-13（来自知识库）
- 转写事件 type 9/10 载荷：`{ "text_msg": { "content": "..." } }`
- WS 空闲 30 秒未被断开；服务端仍每 10 秒发 ping 兜底
