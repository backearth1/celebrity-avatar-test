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
web/                     浏览器端：Agora RTC + 控制信令 + 字幕 + 记忆查看/清除
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

## 已验证（2026-10-30）

- 国内站：克隆音色 yangmi_v1 触发 `audit_violation` 风控挂断（live 1013710642462334976），国内配置已改回默认音色 Maia
- 海外站：同样形象 + 克隆音色，视频通话 60 秒以上正常
- 人设测试：粉丝名「蜜蜂」、乔菲（知识库）、被说演技差会自嘲、八卦话题能挡回去、真诚问时承认是 AI 分身
- 记忆：第一场说的名字/职业/项目被自动提取；第二场开场直接叫名字并问项目进展

- 知识库文档支持 `data:` URI 上传，无需公网托管
- 文本问「《生万物》演谁、哪年播」→ 正确答出宁绣绣、2025-08-13（来自知识库）
- 转写事件 type 9/10 载荷：`{ "text_msg": { "content": "..." } }`
- WS 空闲 30 秒未被断开；服务端仍每 10 秒发 ping 兜底
