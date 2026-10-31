# 详细参数

> **版本记录** 2026-10-19：App WebSocket 控制协议新增 baseline_reset（type=15）上行信令，支持在对话过程中将数字人画面复位到闭口静息态。switch_avatar（type=16）上行信令，支持直播运行中播放转场视频并切换数字人形象。

## 1. 创建 Live 会话
创建一次实时数字人会话，返回后续 WebSocket 初始化和 AliRTC 入会所需的信息。

#### 请求```plaintext
POST https://{host}/live/s_avatar/realtime
Authorization: Token vda_xxx
Content-Type: application/json
```#### 请求体示例```json
{
  "model": "vidu-s2",
  "call_mode": "video",
  "resolution": "720p",
  "rtc": {
    "provider": "artc"
  },
  "avatar": {
    "persona": "你是甜甜 Tina，我的声音像温热的奶茶，甜甜的、暖暖的，但解决问题可一点都不含糊哦！",
    "image_uri": "https://scene.cf.vidu.studio/media-asset/070302-ZFkgvJxBTM0ZQJoO.png",
    "voice": "Tina"
  },
  "idle_motion": {
    "source": "custom",
    "motions": [
      { "name": "点头", "content": "轻轻点头", "weight": 2.0 }
    ],
    "scheduling": { "motion_interval": 12, "rest_after_motion": 4 }
  },
  "action": {
    "enabled": true,
    "library_id": "<action_library_id>"
  },
  "voice_model": {
    "provider": "doubao"
  },
  "enable_recording": true,
  "audio": {
    "enable_transcription": true
  },
  "vad": {
    "type": "semantic",
    "threshold": 0.5,
    "silence_duration_ms": 200,
    "idle_timeout_ms": 500
  },
  "llm": {
    "temperature": 0.7,
    "top_p": 0.8,
    "top_k": 20,
    "frequency_penalty": 1,
    "presence_penalty": 0.3,
    "seed": -1,
    "max_tokens": 50
  },
  "idle_timeout_seconds": 7200,
  "memory_retrieval": {
    "enabled": true,
    "provider": "vidu",
    "user_id": "customer-user-001",
    "enable_write": true
  },
  "knowledge_retrieval": {
    "enabled": true,
    "provider": "vidu",
    "knowledge_base_id": "<knowledge_base_id>"
  }
}
```#### 响应体示例```json
{
  "live": {
    "id": "123456789",
    "status": "waiting",
    "live_duration": 600,
    "call_mode": "video",
    "voice_model": { "provider": "doubao" }
  },
  "recording": {
    "enabled": true,
    "video_url": ""
  },
  "rtc": {
    "app_id": "xxxx",
    "channel_id": "live-user-123456789",
    "user_id": "live-user-1001-123456789",
    "token": "base64-token...",
    "token_expire_at": "1750003600",
    "provider": "artc"
  }
}
```### 基础字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | String | 模型版本，vidu-s2，最新模型 |
| `resolution` | String | 720p（默认）、1080p、2k |
| `call_mode` | String | 交互方式，video：音视频，默认值。audio：纯语音 |
| `avatar.persona` | String | 必填，数字人的人设，5万字以内 |
| `avatar.image_uri` | String | 选择必填，`avatar.image_uri`和`avatar.id`二选一
数字人形象图片地址，支持图片 URL 和 base64。仅支持 1 张【单人】图片，支持全身 / 半身、各种风格。格式：PNG / JPG / JPEG / WEBP；图片大小 ≤ 50MB；base64 decode 后字节长度 < 20M，且需包含内容类型前缀，例如 `data:image/png;base64,{base64_encode}` |
| `avatar.voice` | String | 音色，不填用默认。Vidu 支持音色克隆，见「音色克隆」章节。默认值：`Tina`，更多音色见[音色列表](/vidu-stream/doc/voice-list)。请注意音色要和`voice_model.provider`对应 |
| `avatar.id` | String | 选择必填，`avatar.image_uri`和`avatar.id`二选一，具体见[图片上传](/vidu-stream/doc/image-upload) |
| `avatar.greeting_instruction` | string | 开场问候语提示词， ≤ 200 字符 |
| `avatar.action_prompt` | string | 动作特色提示词，定义数字人交互期间的动作特色 |
| `avatar.farewell_enabled` | bool | 是否自动生成礼貌离开视频。默认false，用户选择了true，则在结束时，会有几秒的离开视频，用户通过rtc持续拉流，可以拉取到 |
| `avatar.persona_enhance` | bool | 是否对人设进行优化，默认false，true会对提示词进行扩写和优化 |
| `enable_recording` | bool | 是否开启录播下载回显，默认 `false`。为 `true` 时会话结束后可通过录播查询接口获取下载地址。 |
| `idle_timeout_seconds` | int | 无输入自动断开时间。默认 7200s，范围 `10 ~ 7200s`。 |

### rtc
创建会话时可指定 RTC 供应商。整个 rtc 对象不传时按默认供应商 artc 处理，客户端入会方式与返回结构与升级前完全一致，存量集成无需改动。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `rtc` | Object | RTC 供应商配置，可选。整个对象不传时使用默认供应商 |
| `rtc.provider` | String | RTC 供应商，枚举值见下表；不传时按 artc 处理 |

**rtc.provider 可选值：**

| 取值 | 供应商 |
| --- | --- |
| `artc` | 阿里云 RTC（默认） |
| `trtc` | 腾讯云 RTC |
| `agora` | Agora RTC |
| `volcengine` | 火山引擎 RTC |```json
{
  "call_mode": "audio",
  "rtc": {"provider": "trtc"}
}
```入会凭证的有效期以响应中的 rtc.token_expire_at 为准。
### voice_model
创建会话时可选择实时语音模型供应商。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `voice_model.provider` | String | 供应商，枚举值：`qwen_omni`（默认）/ `doubao` 。**创建后不可更换。doubao不支持用户视频画面输入。** |

### audio
开启后，通过 WebSocket 返回用户输入音频 / 数字人输出音频的文字内容。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `audio.enable_transcription` | bool | 默认，false。为 `true` 时，新增 signal_type 事件：`type=9`（返回用户音频对应的文本）、`type=10`（返回数字人输出音频对应的文本） |

### vad
用来控制打断相关参数，以便更好地获取用户一轮反馈的内容。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `vad.type` | String | 默认`server`：过滤附和 / 背景音。`semantic`：用户开口即打断当前响应 |
| `vad.threshold` | float | 拟声词、嘈杂声屏蔽力度，默认0.5，范围 `[0, 1.0]`，越低屏蔽越少。仅 `vad.type=server` 时生效 |
| `vad.silence_duration_ms` | int | 语音结束后静音多久触发响应，默认400，范围 `[200, 6000]`，单位 ms。仅 `vad.type=server` 时生效 |
| `vad.idle_timeout_ms` | int | 静默超时后模型多久主动发起对话，`0` 或 `[500, 30000]`，单位 ms。默认`0` 代表不主动发起对话 |

### idle_motion
用来控制数字人在非交互状态（静默期）自动做的小动作。创建时写入并生效，会话中不可热更新。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `idle_motion.enabled` | bool | true | 对象存在但省略本字段视为 `true`；显式 `false` 时忽略其余字段 |
| `idle_motion.source` | String | `default` | 枚举值：
`default`：平台默认小动作库
`custom`：只用请求列表
`mixed`：两者合并，同名保留自定义 |
| `idle_motion.recommend` | String | `random` | 枚举值：`random` 加权随机；`intelligent` 按人设与近两轮对话推荐 |
| `idle_motion.motions` | Array | — | `source` 为 `custom` / `mixed` 时必填且非空，最多 50 条；`default` 时忽略 |
| `idle_motion.motions[].content` | String | 必填 | 实际执行文本，1~200 字符 |
| `idle_motion.motions[].name` | String | 必填 | 展示名，≤ 200。`mixed` 下按最终 name 去重 |
| `idle_motion.motions[].weight` | float | 1 | 抽取权重，范围 `[0.1, 10]` |
| `idle_motion.motions[].description` | String | 空 | 适用场景，≤ 100，仅 `recommend=intelligent` 时起作用 |
| `idle_motion.scheduling.motion_interval` | int | 10 | 两次动作之间的等待秒数，范围 `[5, 60]` |
| `idle_motion.scheduling.rest_after_motion` | int | 5 | 动作后回落静止的等待秒数，范围 `[1, 60]` |
| `idle_motion.motion_count` | int | 仅响应 | 生效动作池条数，请求传入会被覆盖；关闭时为 0 |

> 节奏：静默期每 `motion_interval` 秒下发一条动作，再经 `rest_after_motion` 秒回落静止，循环。用户说话或数字人播报会打断并重新计时，不累计；播报期间不插入小动作。参数越界一律返回 400 且不创建会话。

### action
用来控制是否对用户发言做运行时动作匹配，以及使用平台默认动作库还是自建动作库。自建动作库的管理接口见「动作库」章节

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `action.enabled` | bool | false | 是否启用运行时动作匹配。省略整个 `action` 或为 `false` 则不匹配 |
| `action.library_id` | String | `"0"` | 自建动作库 ID；`"0"` 或不传表示平台默认库。库不存在或已删除返回 400，库不属于本账号返回 403，均不创建会话 |

### llm
用来控制语言模型的输出细节，以适配不同用户的需求。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `llm.temperature` | float | 创意度，默认0.7，范围 `[0.0, 2.0)` |
| `llm.top_p` | float | 质量下限，默认0.8，范围 `(0.0, 1.0]` |
| `llm.top_k` | int | 默认20，范围 `[0, 100]` |
| `llm.frequency_penalty` | float | 防嘴瓢，范围 > 0。默认 1.0 不惩罚；< 1 反向鼓励重复；> 1 惩罚重复，越大越不重复 |
| `llm.presence_penalty` | float | 话题广度，默认0.3，范围 `[0, 2]` |
| `llm.seed` | int | 范围 `0 ~ 2³¹−1`。默认 `-1`：随机 seed |
| `llm.max_tokens` | int | 模型最大输出长度，默认50，范围 `1 ~ 64K` |

### knowledge_retrieval
knowledge_retrieval 均为可选字段，可在对话中调用知识检索的能力。检索服务来源由 `provider` 决定：`self` 表示客户自有 HTTP 检索服务（协议详见「外调知识」章节）；`vidu` 表示使用平台内置的知识库，无需自建服务，资产通过「知识库管理」章节的接口维护。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `knowledge_retrieval.enabled` | bool | 是否启用该能力，默认为false |
| `knowledge_retrieval.provider` | String | 检索服务来源，`self`（默认，客户自有 HTTP 检索服务）/ `vidu`（平台内置能力）。不传或传 `unspecified` 等同 `self`，兼容旧接入 |
| `knowledge_retrieval.endpoint` | String | provider=self时必填。检索 API 地址。必须是 live 服务端可访问的 http(s) 绝对 URL。`provider=vidu` 时该字段被忽略 |
| `knowledge_retrieval.authorization` | String | provider=self时必填。会作为外部 API 的 Authorization header 转发，且校验非空。`provider=vidu` 时该字段被忽略 |
| `knowledge_retrieval.timeout_ms` | int | 请求超时，最大 `30000`（ms）；仅 `provider=self` 生效，不传默认 3000 |
| `knowledge_retrieval.tool_instruction` | String | 追加到内置工具说明后的自定义指令，最长 2000 个字符 |
| `knowledge_retrieval.knowledge_base_id` | String | provider=vidu 且启用时必填.当前账号下的知识库 ID。引用不存在或已删除的知识库，创建 Live 返回 404 |
| `knowledge_retrieval.force_search` | bool | 是否必然触发知识库检索(仅当 |

#### 请求示例```json
{
  "call_mode": "audio",
  "knowledge_retrieval": {
    "enabled": true,
    "provider": "vidu",
    "knowledge_base_id": "<knowledge_base_id>"
  }
}
```查询和列表 Live 接口不回显，不能用回显判断配置是否生效。
### memory_retrieval
可在对话中调用记忆检索的能力，检索服务来源由 `provider` 决定：`self` 表示客户自有 HTTP 检索服务（协议详见「外调记忆」章节）；`vidu` 表示使用平台内置的长期记忆，无需自建服务，资产通过「记忆管理」章节的接口维护。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `memory_retrieval.enabled` | bool | 否 | 是否启用该能力，默认为false |
| `memory_retrieval.provider` | String | 否 | 检索服务来源，`self`（默认，客户自有 HTTP 检索服务）/ `vidu`（平台内置能力）。不传或传 `unspecified` 等同 `self`，兼容旧接入 |
| `memory_retrieval.endpoint` | String | 启用时必填（仅 provider=self） | 检索 API 地址。必须是 live 服务端可访问的 http(s) 绝对 URL。`provider=vidu` 时该字段被忽略 |
| `memory_retrieval.authorization` | String | 启用时必填（仅 provider=self） | 会作为外部 API 的 Authorization header 转发，且校验非空。`provider=vidu` 时该字段被忽略 |
| `memory_retrieval.timeout_ms` | int | 否 | 请求超时，最大 `30000`（ms）；仅 `provider=self` 生效，不传默认 3000 |
| `memory_retrieval.tool_instruction` | String | 否 | 追加到内置工具说明后的自定义指令，最长 2000 个字符 |
| `memory_retrieval.user_id` | String | provider=vidu 且启用时必填 | 客户侧最终用户标识，去除首尾空格后长度 1～64。记忆按该标识隔离 |
| `memory_retrieval.agent_id` | String | 否 | 记忆分区标识，最长 64 字符。 |
| `memory_retrieval.enable_write` | bool | 否 | 仅 `provider=vidu` 有效；true 时将已完成的用户/助手对话自动回写为长期记忆 |

#### 请求示例```json
{
  "call_mode": "audio",
  "memory_retrieval": {
    "enabled": true,
    "provider": "vidu",
    "user_id": "customer-user-001",
    "enable_write": true
  }
}
```查询和列表 Live 接口不回显 ，不能用回显判断配置是否生效。
### 响应字段说明
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `live.id` | String | 房间 ID，后续所有步骤都要用，务必保存 |
| `live.status` | String | 此时是 waiting，说明数字人还没准备好 |
| `live.live_duration` | Int | 本次会话最大时长（秒），超时自动断开 |
| `rtc.token` | String | 进视频房间的凭证，默认 1 小时有效 |
| `rtc.user_id` | String | 你在 RTC 频道里的用户名 |
| `rtc.token_expire_at` | String | token 过期时间（Unix 时间戳），过期需重新创建会话 |
| `live.voice_model` | Object | 回显本次会话的实时语音模型配置 |
| `live.idle_motion` | Object | 回显静默小动作配置 |
| `live.action` | Object | 回显运行时动作匹配配置 |
| `recording.enabled` | Bool | 是否开启录播下载回显，当url不为空时，代表可以下载视频 |
| `rtc.provider` | String | 本次会话实际使用的 RTC 供应商，取值同请求参数：artc / trtc / agora / volcengine。未指定时归一为 artc，客户端据此选用对应供应商的 SDK 入会 |

> video 模式创建成功只代表房间和外部 stream 已创建，不代表数字人渲染侧已经回连完成。App 仍需要建立 WebSocket 并发送 conn_init，根据 conn_init_ack 判断是否 ready。

## 2. 查询 Live 会话与账单
查询单个 live 的当前状态、会话时间和账单字段。

#### 请求示例```plaintext
GET https://{host}/live/v1/lives/{live_id}
Authorization: Token vda_xxx
```#### 响应字段

| 响应字段 | 说明 |
| --- | --- |
| `live.status` | 会话状态：`waiting`、`prepared`、`on_live`、`ending`、`ended` |
| `live.created_at` | 创建时间，Unix 秒 |
| `live.start_time` | 正式开始时间，通常在双端 ready 后写入 |
| `live.end_time` | 结束时间 |
| `live.trace_id` | 排查问题使用的链路 ID，反馈问题时建议带上 |
| `live.billed_seconds` | 计费秒数，通常从会话 ready 后开始统计 |
| `live.credits_cost` | 本次 live 消耗的积分 |
| `live.voice_model` | 回显创建会话时的实时语音模型配置 |

## 3. 查询 Live列表
按当前账号查询 live 历史记录，适合后台列表或排查历史会话。

#### 请求示例```plaintext
GET https://{host}/live/v1/lives?pager.page=0&pager.pagesz=10
Authorization: Token vda_xxx
```| Query 参数 | 类型 | 说明 |
| --- | --- | --- |
| `pager.page` | Int | 页码，从 0 开始；不传时按默认值处理。 |
| `pager.pagesz` | Int | 每页数量。小于等于 0 时默认 10，大于 100 时截断为 100。 |
| `pager.page_token` | String | 预留字段，当前业务主要使用 page / pagesz。 |

#### 响应示例```json
{
  "total": 12,
  "lives": [
    {
      "id": "1234567890",
      "status": "ended",
      "call_mode": "video",
      "billed_seconds": 120,
      "credits_cost": 20,
      "voice_model": { "provider": "qwen_omni" }
    }
  ],
  "next_page_token": ""
}
```## 4. 查询录播文件
查询整场通话的录播文件下载地址。需要在创建会话时传 `enable_recording: true`；录播文件在会话结束后异步生成，通常在 2 分钟内可查询到。下载地址有效期 24 小时，文件格式为 MP4。

#### 请求示例```plaintext
GET https://{host}/live/v1/lives/{live_id}/recording
Authorization: Token vda_xxx
```#### 响应示例```json
{
  "recording": {
    "enabled": true,
    "video_url": "<录播文件下载地址>",
    "error_code": "unspecified",
    "error_message": ""
  }
}
```#### 响应字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `recording.enabled` | Bool | 是否开启录播下载回显 |
| `recording.video_url` | String | 录播文件下载地址；未开启、文件未生成或生成失败时为空串 |
| `recording.error_code` | String | 录制失败错误码 |
| `recording.error_message` | String | 失败的原始信息；无失败为空串 |

**error_code 枚举**

| 取值 | 说明 |
| --- | --- |
| `unspecified` | 无失败 |
| `start_failed` | 录制启动失败 |
| `stop_failed` | 录制停止失败 |
| `query_failed` | 录播文件查询超时 |
| `transfer_failed` | 录播文件存储失败 |

## 5. App WebSocket 控制协议
用于初始化会话、发送文本、打断和挂断。它不传输音频或视频媒体。

#### 请求示例```plaintext
wss://{host}/live/ws/live/connect?live_id={live_id}&conn_id={conn_id}
Authorization: Token vda_xxx
```| Query 参数 | 类型 | 说明 |
| --- | --- | --- |
| `live_id` | String | 必填，创建 live 返回的 `live.id`。 |
| `conn_id` | String | 可选，客户端连接 ID；不传时服务端会生成。 |

#### 响应示例```json
{
  "type": 1,
  "live_id": "1234567890",
  "user_id": "10000",
  "conn_id": "app-conn-1",
  "seq_id": 1,
  "payload": {}
}
```| type | 名称 | 方向 | 说明 |
| --- | --- | --- | --- |
| 1 | `conn_init` | App → live | 连接初始化，必须在 WS 打开后发送。 |
| 2 | `conn_init_ack` | live → App | 初始化结果。`success=true` 后表示实时控制链路 ready。 |
| 5 | `call_hangup` | App → live | App 主动挂断。 |
| 6 | `force_hangup` | live → App | 服务端强制挂断，例如超时、风控、积分不足或服务侧关闭。 |
| 7 | `audio_interrupted` | App → live | 用户打断当前 AI 输出。 |
| 15 | `baseline_reset` | App → live | 把数字人画面复位到闭口静息态；无载荷。 |
| 16 | `switch_avatar` | App → live | 播放转场视频并切换数字人形象。 |
| 99 | `text_msg` | App → live | 发送文本消息。 |
| 100 | `text_tts` | App → live | 指定文本直接合成音频播出，不产生对话回复，不进入对话上下文，也不触发数字人动作。 |
| 101 | `text_action` | App → live | 动作文本，用于触发数字人动作；不产生对话回复，也不打断数字人当前正在播放的回复。 |
| 102 | `text_dialog` | App → live | 仅对话文本，产生回复但不触发数字人动作。 |
| 103 | `error` | live → App | 服务端错误回执，仅在能力不支持或会话不可用时下发。 |

### conn_init

#### 请求示例```json
{
  "type": 1,
  "live_id": "1234567890",
  "conn_id": "app-conn-1",
  "seq_id": 1,
  "payload": {
    "conn_init": { "version": 1 }
  }
}
```#### 响应示例```json
{
  "type": 2,
  "live_id": "1234567890",
  "conn_id": "app-conn-1",
  "seq_id": 2,
  "payload": {
    "conn_init_ack": {
      "success": true,
      "error_code": "",
      "error_msg": "",
      "server_timestamp": 1710000000
    }
  }
}
``````json
{
  "type": 2,
  "live_id": "1234567890",
  "conn_id": "app-conn-1",
  "seq_id": 2,
  "payload": {
    "conn_init_ack": {
      "success": false,
      "error_code": "NOT_READY",
      "error_msg": "live sip endpoint not ready",
      "server_timestamp": 1710000000
    }
  }
}
```### text_msg
当前服务端不会为 `text_msg` 单独返回业务 ack；数字人的回复通过 RTC 音视频输出，部分文本响应也可能从 WS 下发。

#### 请求示例```json
{
  "type": 99,
  "live_id": "1234567890",
  "conn_id": "app-conn-1",
  "seq_id": 10,
  "payload": {
    "text_msg": {
      "msg_id": "client-msg-1",
      "content": "你好，请介绍一下你自己",
      "timestamp": 1710000000000
    }
  }
}
```| 字段 | 说明 |
| --- | --- |
| `msg_id` | 客户端生成的消息 ID，便于客户端日志关联。 |
| `content` | 发送给数字人的文本内容。 |
| `timestamp` | 客户端发送时间，毫秒时间戳。 |

### text_tts
指定文本直接合成音频播出，不产生对话回复：不进入对话上下文、不产生回复，也不触发数字人动作。

#### 请求示例```json
{
  "type": 100,
  "live_id": "1234567890",
  "conn_id": "app-conn-1",
  "seq_id": 13,
  "payload": {
    "text_tts": { "msg_id": "req-1", "content": "大家好，我是甜甜" }
  }
}
```| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `content` | 是 | 文本内容。 |
| `msg_id` | 否 | 调用方自定义标识 |

### text_action
仅用于触发数字人动作；不产生对话回复，也不打断数字人当前正在播放的回复。请求字段与 `text_tts` 相同。

#### 请求示例```json
{
  "type": 101,
  "live_id": "1234567890",
  "conn_id": "app-conn-1",
  "seq_id": 14,
  "payload": {
    "text_action": { "msg_id": "req-2", "content": "向观众挥手打招呼" }
  }
}
```### text_dialog
仅对话文本，进入对话并产生回复，但不触发数字人动作。请求字段与 `text_tts` 相同。

#### 请求示例```json
{
  "type": 102,
  "live_id": "1234567890",
  "conn_id": "app-conn-1",
  "seq_id": 15,
  "payload": {
    "text_dialog": { "msg_id": "req-3", "content": "帮我介绍一下今天的安排" }
  }
}
```*text_tts、text_action、text_dialog 三类文本没有成功回执：受理成功不返回任何帧，与既有 text_msg 一致。*
**各语音模型支持范围**
三类新增文本信号（`text_tts`、`text_action`、`text_dialog`）在各语音模型上的支持范围如下：

| 语义\`voice_model.provider` | qwen_omni | doubao |
| --- | --- | --- |
| `text_msg` | 支持 | 国内不支持，国外版支持 |
| `text_tts`（指定文本直出音频） | 不支持 | 支持 |
| `text_action`（动作文本） | 支持 | 支持 |
| `text_dialog`（仅对话文本） | 支持 | 国内不支持，国外版支持 |

### audio_interrupted
用于用户打断当前 AI 输出。当前没有单独 ack；客户端可结合后续音频停止、数字人响应变化或自身 UI 状态处理。

#### 请求示例```json
{
  "type": 7,
  "live_id": "1234567890",
  "conn_id": "app-conn-1",
  "seq_id": 11,
  "payload": {}
}
```### call_hangup 与 force_hangup

#### 请求示例```json
{
  "type": 5,
  "live_id": "1234567890",
  "conn_id": "app-conn-1",
  "seq_id": 12,
  "payload": {
    "hangup": { "hangup_reason": "user_end" }
  }
}
``````json
{
  "type": 6,
  "live_id": "1234567890",
  "conn_id": "app-conn-1",
  "payload": {
    "hangup": { "hangup_reason": "timeout" }
  }
}
```| hangup_reason | 触发场景 |
| --- | --- |
| `user_end` | 用户主动断开 |
| `timeout` | 会话超时 |
| `audit_violation` | 会话触发风控断开 |
| `credit_insufficient` | 积分不足 |
| `sip_closed` | SIP / provider 侧关闭 |
| `provider_closed` | provider 主动 close |
| `sip_reconnect_timeout` | SIP 断连后超过重连宽限仍未恢复 |
| `client_reconnect_timeout` | App 客户端断线后超过重连宽限仍未恢复 |
| `prepared_sip_disconnected` | video live 还在 prepared、App 从未 ready/未开播时 SIP 断开，直接结束 |
| `owner_taken_over` | SIP 断连期间 owner 被其他节点接管，本地 session 自关 |
| `owner_lease_lost` | owner 续租失败/丢失，本地 session 自关 |
| `ai_output_closed` | AI 输出通道关闭导致 session 关闭 |
| `external` | Redis live:close，广播关闭 |

> PS：除监听 `type=6` 外，客户端还必须监听 WebSocket close / error 事件做兜底。主动挂断后建议先关闭 WebSocket，再调用 RTC SDK 的 `leaveChannel()`。

### session_update
用于在会话进行中动态更新部分 session 配置，无需挂断重建会话。服务端整体校验本次更新，任一字段非法则本次更新失败，所有字段均不生效，原配置保持不变。

#### 请求示例```json
{
  "type": 97,
  "live_id": "1234567890",
  "conn_id": "app-conn-1",
  "seq_id": 20,
  "payload": {
    "session_update": {
      "avatar": { "voice": "Tina" },
      "vad": { "type": "server", "threshold": 0.5, "silence_duration_ms": 400 },
      "llm": { "temperature": 0.7, "top_p": 0.8, "max_tokens": 50 }
    }
  }
}
```> 可更新字段与约束（沿用创建会话时的类型与范围；`knowledge_retrieval` / `memory_retrieval` 组内为整组替换，其余字段只传需要更新的部分）

| 字段 | 类型 | 取值 / 约束 | 生效时机 |
| --- | --- | --- | --- |
| `avatar.voice` | String | 已有音色或克隆音色 ID | 当前播报结束后生效（无播报时立即） |
| `avatar.persona` | String | ≤ 5 万字 | 当前播报结束后生效（无播报时立即） |
| `vad.type` | String | server / semantic | 下一轮 |
| `vad.threshold` | float | [0, 1.0]，仅 type=server 生效 | 下一轮 |
| `vad.silence_duration_ms` | int | [200, 6000] ms，仅 type=server 生效 | 下一轮 |
| `knowledge_retrieval.enabled` | bool | true / false | 下一轮 |
| `knowledge_retrieval.endpoint` | String | 可访问的 http(s) 绝对 URL，启用时必填 | 下一轮 |
| `knowledge_retrieval.authorization` | String | 非空，转发为外部 API 的 Authorization | 下一轮 |
| `knowledge_retrieval.timeout_ms` | int | ≤ 30000 ms | 下一轮 |
| `memory_retrieval.enabled` | bool | true / false | 下一轮 |
| `memory_retrieval.endpoint` | String | 可访问的 http(s) 绝对 URL，启用时必填 | 下一轮 |
| `memory_retrieval.authorization` | String | 非空 | 下一轮 |
| `memory_retrieval.timeout_ms` | int | ≤ 30000 ms | 下一轮 |
| `llm.seed` | int | -1（随机）或 0 ~ 2³¹−1 | 下一轮 |
| `llm.max_tokens` | int | 1 ~ 64K | 下一轮 |
| `llm.frequency_penalty` | float | > 0 | 下一轮 |
| `llm.presence_penalty` | float | [0, 2] | 下一轮 |
| `llm.top_k` | int | [0, 100] | 下一轮 |
| `llm.top_p` | float | (0.0, 1.0] | 下一轮 |
| `llm.temperature` | float | [0.0, 2.0) | 下一轮 |

#### 响应示例```json
{
  "type": 98,
  "live_id": "1234567890",
  "conn_id": "app-conn-1",
  "payload": {
    "session_update_ack": {
      "success": true,
      "error_code": "",
      "error_msg": ""
    }
  }
}
```### prompt_operation
在直播进行中切换或清除数字人画面的参考图（R2V 参考生能力），无需中断推流。消息为 JSON 文本帧，`type=11`，外层结构与其他信令一致。
切换参考图（switch）：下发 1~3 张新的参考图。每张参考图独立携带地址、稳定标识（`image_id`）、可选的场景类型与自然语言描述。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `op_type` | string | 否 | 操作类型，`switch`（默认，可省略）/ `remove` |
| `images` | object[] | 是 | 参考图数组，1~3 张。数组内任一张的地址或 `image_id` 非法则整次操作失败。 |
| `images[].image_uri` | string | 是 | 参考图地址。支持平台上传 URI（`ssupload:?id=...`）、base64 data URI（`data:image/*;base64,...`）、http(s) URL，格式与创建直播时的参考图一致。
注意, websocket 单条消息大小上限 16MB，使用base64时需要注意发送的帧大小 |
| `images[].image_id` | string | 是 | 这张参考图的稳定标识，1~128 字符，单次操作内不可重复。清除参考图（remove 定点）时凭此定位。 |
| `images[].kind` | string | 否 | 这张参考图的场景类型：`object`（手持物）/ `garment`（换装）/ `background`（换背景）。不传时按参考图自动识别。 |
| `images[].user_text` | string | 否 | 对这张参考图的自然语言描述（期望的画面变化），可为空。 |

切换参考图后画面生效需要数秒渲染时间，期间音频对话不受影响。不传 `images[].kind` 时按该张参考图自动识别；若单张参考图内同时出现服饰、物品与背景等多个可能的编辑目标，自动识别结果可能不符合预期，建议显式传入 `kind`。```json
{
  "type": 11,
  "live_id": "21456057768887297",
  "conn_id": "<connection-id>",
  "seq_id": 1,
  "payload": {
    "prompt_operation": {
      "op_type": "switch",
      "images": [
        {
          "image_uri": "https://example.com/cobalt-mug.png",
          "image_id": "mug-001",
          "kind": "object",
          "user_text": "让数字人手持一个钴蓝色陶瓷杯"
        },
        {
          "image_uri": "https://example.com/jacket.png",
          "image_id": "jacket-001"
        }
      ]
    }
  }
}
```清除参考图（remove）：数字人画面恢复原始状态。支持两种方式——**清除最近一张**：不传 `images`，恢复到最近一次切换参考图之前的状态；**按 `image_id` 定点清除**：`images` 传 1~3 个元素，每个元素只需 `image_id`（为此前 switch 时使用的标识），可一次清除多张。```json
{
  "type": 11,
  "live_id": "21456057768887297",
  "conn_id": "<connection-id>",
  "seq_id": 2,
  "payload": {
    "prompt_operation": { "op_type": "remove" }
  }
}
```按 `image_id` 定点清除两张参考图：```json
{
  "type": 11,
  "live_id": "21456057768887297",
  "conn_id": "<connection-id>",
  "seq_id": 3,
  "payload": {
    "prompt_operation": {
      "op_type": "remove",
      "images": [
        { "image_id": "mug-001" },
        { "image_id": "jacket-001" }
      ]
    }
  }
}
```服务端处理完成后返回 `type=12` 的回执：```json
{
  "type": 12,
  "live_id": "21456057768887297",
  "conn_id": "<connection-id>",
  "payload": {
    "prompt_operation_ack": {
      "success": true,
      "error_code": "",
      "error_msg": ""
    }
  }
}
```失败时的 `error_code` 取值：

| error_code | 说明 |
| --- | --- |
| `PROMPT_OP_PARAM_INVALID` | 参数不合法（`images` 缺失或超过 3 张、`image_uri` 格式不支持、`image_id` 为空 / 超过 128 字符 / 单次内重复等） |
| `PROMPT_OP_MODEL_NOT_SUPPORTED` | 当前直播未使用 vidu-s2 模型，不支持参考图操作 |
| `PROMPT_OP_LIVE_NOT_ACTIVE` | 直播不在进行中 |
| `PROMPT_OP_IMAGE_TRANSFER_FAILED` | 参考图获取失败（地址不可访问等） |
| `PROMPT_OP_SIP_NOT_CONNECTED` | 渲染链路未就绪，请稍后重试 |
| `PROMPT_OP_FAILED` | 其他内部错误 |

> 操作不依赖回执顺序：每次 switch 是独立完整的操作，客户端可随时重发；remove 后可再次 switch。`image_id` 由调用方维护：单次操作内不可重复；跨操作建议不复用同一 `image_id`，以保证定点清除能精确对应此前的参考图。单条消息大小上限 **16MB**；一次 switch 传入多张 base64 参考图时，总量计入该上限。

### baseline_reset（type=15）
客户端在对话过程中可随时触发，立即把数字人画面姿态复位到不说话的初始画面。
请求字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | integer | 是 | 固定 `15`。 |
| `live_id` | string | 是 | 当前直播 ID。 |
| `conn_id` | string | 否 | 连接标识。 |
| `seq_id` | integer | 否 | 客户端自增序号。 |
| `payload` | object | 否 | 本信令不携带载荷；若误带，服务端忽略。 |

请求示例：```json
{
  "type": 15,
  "live_id": "1234567890",
  "conn_id": "<conn_id>"
}
```回执语义：成功不下发任何回执；仅在下述两种情况下下发一帧 `error`（`type=103`），`payload.error.source` 固定为 `baseline_reset`，其余执行期异常不产生回执。重复触发是幂等的（等价于重复下发同一闭口姿态），但不建议无意义地高频连发。
失败回执示例：```json
{
  "type": 103,
  "live_id": "1234567890",
  "payload": {
    "error": {
      "source": "baseline_reset",
      "code": "not_supported",
      "message": "baseline reset is not supported by this live",
      "msg_id": ""
    }
  }
}
```错误码：

| 错误码 | 触发条件 |
| --- | --- |
| `not_supported` | 当前直播形态不具备该能力（如纯语音模式）。 |
| `live_not_active` | 直播未在运行中（已结束 / 不可用）。 |

### switch_avatar（type=16）
直播运行中，客户端可让数字人播放一组转场视频，并在播放过程中把数字人切换为新的形象。消息为 JSON 文本帧，`type=16`，外层结构与其他信令一致。
请求字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | integer | 是 | 固定 `16`。 |
| `live_id` | string | 是 | 当前直播 ID。 |
| `conn_id` | string | 否 | 连接标识。 |
| `seq_id` | integer | 否 | 客户端自增序号，失败回执会原样带回，便于关联请求。 |
| `payload.switch_avatar.switch_videos` | string[] | 是 | 转场视频地址列表，至少 1 个，每项须为 http(s) 地址。按列表顺序播放，至少完整播放一轮；本期不设数量上限。 |
| `payload.switch_avatar.avatar_id` | integer | 条件 | 资产库形象 ID（JSON 中序列化为字符串） |

请求示例：```json
{
  "type": 16,
  "live_id": "1234567890",
  "conn_id": "<conn_id>",
  "seq_id": 7,
  "payload": {
    "switch_avatar": {
      "switch_videos": [
        "https://example.com/transition_1.mp4",
        "https://example.com/transition_2.mp4"
      ],
      "avatar_id": "100012345"
    }
  }
}
```回执语义：成功不下发任何回执（不要以 WS 是否写出成功判断执行结果）；失败时下发一帧 `error`。
失败回执字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `type` | integer | 固定 `103`。 |
| `live_id` | string | 当前直播 ID。 |
| `seq_id` | integer | 原样回带请求的 `seq_id`。 |
| `payload.error.source` | string | 固定 `switch_avatar`。 |
| `payload.error.code` | string | 错误码，见下表。 |
| `payload.error.message` | string | 可读描述。 |

错误码：

| 错误码 | 触发条件 |
| --- | --- |
| `SWITCH_AVATAR_PARAM_INVALID` | 入参非法：`switch_videos` 为空或含非 http(s) 地址；`avatar_id` 未传；或指定形象不存在 / 无权使用 / 尚未就绪。 |
| `SWITCH_AVATAR_LIVE_NOT_ACTIVE` | 直播未在运行中（或已结束 / 不可用）。 |
| `SWITCH_AVATAR_MEDIA_TRANSFER_FAILED` | 转场视频或新形象图片处理失败。 |
| `SWITCH_AVATAR_RENDER_NOT_CONNECTED` | 渲染服务未就绪，暂时无法切换，可稍后重试。 |
| `SWITCH_AVATAR_FAILED` | 其它失败。 |

注意事项：
- 新形象在转场视频播放完成后生效；转场期间画面按视频列表顺序播放。
- avatar_id 场景会一并应用该形象的形象描述。
## 6. RTC 入会协议
接入时要同时建立两条链路：App WebSocket 负责控制，RTC 负责媒体，两条链路是并行关系，缺一不可。

| 链路 | 承载内容 | 典型动作 |
| --- | --- | --- |
| App WebSocket | 控制信令 | `conn_init` 开始、`text_msg` 文字互动、`audio_interrupted` 打断、`call_hangup` 挂断。 |
| RTC | 实时媒体流 | 发布 App 麦克风音频；`video` 模式发布摄像头视频；订阅数字人音频和视频。 |

上表中的媒体链路默认由阿里云 RTC（artc）承载。若创建会话时通过 rtc.provider 指定了其他供应商，则改用对应供应商的客户端 SDK 入会，接入时序不变，rtc 对象中各字段的语义按下表对应。实际生效的供应商以创建会话响应中的 rtc.provider 为准。

| provider | 客户端 SDK | 入会信息对应关系 |
| --- | --- | --- |
| `artc` | 阿里云 RTC SDK | app_id 为应用 ID，channel_id 为频道 ID，user_id 为用户标识，token 为入会凭证 |
| `trtc` | 腾讯云 TRTC SDK | app_id 为 SDKAppID，channel_id 为房间号，user_id 为用户标识，token 为 UserSig |
| `agora` | Agora SDK | app_id 为 App ID，channel_id 为频道名，user_id 为用户标识，token 为频道 Token |
| `volcengine` | 火山引擎 RTC SDK | app_id 为 App ID，channel_id 为房间 ID，user_id 为用户标识，token 为房间 Token |```plaintext
flowchart LR
  CreateLive["Create Live"] --> WsInit["App WS conn_init"]
  CreateLive --> RtcJoin["RTC joinChannel"]
  WsInit --> ControlReady["Control Ready"]
  RtcJoin --> MediaReady["Media Ready"]
  ControlReady --> Interact["Live Interaction"]
  MediaReady --> Interact
```**阿里 ARTC 前置条件**
- 客户端需要单独集成 ARTC SDK。Web 端可参考[阿里云 RTC Web SDK 文档](https://help.aliyun.com/zh/live/quick-use?spm=a2c4g.11186623.help-menu-29949.d_1_1_7_4_1.309729ea6qpZJK)，并在页面中加载对应 SDK。
- 创建 live 接口返回的 `rtc` 对象就是入会凭证来源，不需要客户端自行生成 token。
- `rtc.token`：传给 `joinChannel` 的鉴权信息。
- `rtc.user_id`：当前 App 用户在 RTC 房间里的身份，作为 `joinChannel` 的第二个参数。
- `rtc.channel_id`：服务端创建的 RTC 房间标识，主要用于日志、订阅回调和问题排查；客户端通常不需要自行拼接。
- `rtc.token_expire_at`：token 过期时间，Unix 秒；过期后应重新创建 live。
**腾讯云 TRTC 前置条件**
- 客户端需要单独集成腾讯云 TRTC Web SDK（v5）。可参考[腾讯云 TRTC Web SDK 文档](https://web.sdk.qcloud.com/trtc/webrtc/v5/doc/zh-cn/TRTC.html)，并在页面中加载对应 SDK。
- 创建 live 接口返回的 `rtc` 对象就是入会凭证来源，不需要客户端自行计算 UserSig，也不需要在客户端保存 SDKSecretKey。入会方法为 `trtc.enterRoom()`，参数按下面几条对应填入。
- `rtc.app_id`：对应 `sdkAppId`，SDK 要求数字类型，传入前需转为 number。
- `rtc.token`：对应 `userSig`，即入会签名。
- `rtc.user_id`：对应 `userId`，当前 App 用户在 RTC 房间里的身份。
- `rtc.channel_id`：服务端下发的是字符串形式的房间号，必须用 `strRoomId` 传入，不要用整型的 `roomId`。TRTC 的整型房间和字符串房间互不连通，各端必须统一用 `strRoomId`，否则会进到不同房间、看不到数字人。
- `rtc.token_expire_at`：UserSig 过期时间，Unix 秒；过期后应重新创建 live。
**声网 Agora 前置条件**
- 客户端需要单独集成声网 Agora Web SDK 4.x。可参考[Agora Web SDK API 文档](https://api-ref.agora.io/en/video-sdk/web/4.x/interfaces/iagorartcclient.html)，并在页面中加载对应 SDK。
- 创建 live 接口返回的 `rtc` 对象就是入会凭证来源，不需要客户端自行生成频道 Token，也不需要在客户端保存 App Certificate。入会方法为 `client.join(appid, channel, token, uid)`，四个参数依次取自 `rtc` 对象。
- `rtc.app_id`：对应第 1 个参数 `appid`。
- `rtc.channel_id`：对应第 2 个参数 `channel`，即频道名。
- `rtc.token`：对应第 3 个参数 `token`，即频道 Token。
- `rtc.user_id`：对应第 4 个参数 `uid`。服务端下发的是字符串，Agora 支持 String 型 UID，但必须与服务端签发 Token 时使用的 uid 完全一致，不要自行改写、截断或转成数字，否则会鉴权失败。
- `rtc.token_expire_at`：Token 过期时间，Unix 秒；过期后应重新创建 live。
**火山引擎 Volcengine RTC 前置条件**
- 客户端需要单独集成火山引擎 RTC Web SDK。可参考[火山引擎 RTC Web SDK 文档](https://www.volcengine.com/docs/6348/106914)，并在页面中加载对应 SDK。
- 创建 live 接口返回的 `rtc` 对象就是入会凭证来源，不需要客户端自行生成 Token，也不需要在客户端保存 AppKey。入会流程是先 `VERTC.createEngine()` 创建引擎实例，再调用 `engine.joinRoom()` 进房。
- `rtc.app_id`：传给 `VERTC.createEngine(appId)`，用于创建引擎实例。
- `rtc.token`：对应 `joinRoom()` 的第 1 个参数 `token`，即房间 Token。
- `rtc.channel_id`：对应 `joinRoom()` 的第 2 个参数 `roomId`。
- `rtc.user_id`：对应 `joinRoom()` 的 `userInfo.userId`，Token 与 roomId、userId 绑定，三者必须与服务端下发的保持一致。
- `rtc.token_expire_at`：Token 过期时间，Unix 秒；过期后应重新创建 live。
## 7. 音色克隆
基于参考音频创建自定义音色。接口返回的 `voice` 可用于创建 live 时的 `avatar.voice`。```bash
curl -X POST "https://api.vidu.cn/live/v1/voices/clone" \
  -H "Authorization: Token vda_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "audio_url": "<参考音频，公网 URL 或 data URI>",
    "voice": "my_voice",
    "language": "zh",
    "provider": "doubao"
  }'
```| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `audio_url` | String | 必填，参考音频，支持公网 URL 或 data URI，长度 1 到 2048。支持格式：WAV（16bit）、MP3、M4A；音频时长推荐 10~20 秒，最长不超过 60 秒；文件大小 < 10MB。 |
| `voice` | String | 必填，音色名，长度 1 到 16；创建 live 时填入 `avatar.voice`。仅允许数字、大小写字母和下划线。（请注意，**音色名不要重复**） |
| `text` | String | 参考音频文本，便于服务端校验音频与文本一致性，最长 4096。 |
| `language` | String | 参考音频语言，例如 `zh`、`en`，最长 16。支持`zh`（中文）、`en`（英文）、`de`（德语）、`it`（意大利语）、`pt`（葡萄牙语）、`es`（西班牙语）、`ja`（日语）、`ko`（韩语）、`fr`（法语）、`ru`（俄语）、`th`（泰语）、`id`（印尼语）、`ar`（阿拉伯语）、`cs`（捷克语）、`da`（丹麦语）、`nl`（荷兰语）、`fi`（芬兰语）、`he`（希伯来语）、`hi`（印地语）、`is`（冰岛语）、`ms`（马来语）、`no`（挪威语）、`fa`（波斯语）、`pl`（波兰语）、`sv`（瑞典语）、`tl`（他加禄语）、`tr`（土耳其语）、`ur`（乌尔都语）、`vi`（越南语）。
中文方言：东北话（`Dongbei`）、陕西话（`Shannxi`）、四川话（`Sichuan`）、河南话（`Henan`）、长沙话（`Changsha`）、天津话（`Tianjin`）、杭州话（`Hangzhou`）、辽宁话（`Liaoning`）、沈阳话（`Shenyang`）、鞍山话（`Anshan`） |
| `provider` | String | 音色所属的实时语音模型供应商，枚举值：`qwen_omni`（默认）/ `doubao`。复刻出的音色与供应商绑定，只能用于同一 `voice_model.provider` 的会话。（使用国外服务时，doubao不支持复刻） |

查询自定义音色：`GET /live/v1/voices` → `{ "voices": [{ "voice": "my_custom_voice" }] }`
删除自定义音色：`DELETE /live/v1/voices/{my_custom_voice}`
复刻返回的 `voice`（音色名）在创建会话时填入 `avatar.voice` 或对应供应商分支的 `voice`，须与 `voice_model.provider` 一致使用，否则返回 400。
## 8. 外调记忆
业务侧外接记忆 API 需要遵循的 HTTP JSON 协议

#### 调用方式```plaintext
POST <memory_retrieval.endpoint>
Content-Type: application/json
Accept: application/json
Authorization: <memory_retrieval.authorization>
```> 注意：`endpoint` 和 `authorization` 来自 CreateLive 请求中的 `memory_retrieval` 配置。

#### 请求示例```json
{
  "live_id": "1234567890",
  "query": "用户偏好的代码风格、编程语言偏好、脚本输出风格",
  "reason": "用户要求按之前喜欢的代码风格生成脚本，当前上下文没有相关偏好信息。",
  "memory_types": ["preference", "style"],
  "time_hint": "长期偏好",
  "max_results": 5
}
```| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `live_id` | string | 必填，当前 live ID，可用于日志、调试或映射服务端上下文 |
| `query` | string | 必填，模型生成的自然语言检索意图，不应只是机械复制用户原话 |
| `reason` | string | 必填，模型说明为什么当前回复需要检索记忆，便于日志、调试和风控 |
| `memory_types` | string[] | 希望检索的记忆类型 |
| `time_hint` | string | 时间范围提示，例如“最近”“上次”“长期偏好” |
| `max_results` | integer | 最多返回条数。live 侧限制在 `1..10`，建议外部 API 也做限制 |

**memory_types 枚举**

| 类型 | 含义 |
| --- | --- |
| `preference` | 用户偏好，例如饮食、语言、工具、回答风格 |
| `profile` | 用户基本信息，例如职业、所在地、角色 |
| `history` | 过往对话事实、历史选择 |
| `project` | 用户正在做的项目、长期任务 |
| `constraint` | 用户明确限制，例如不要用 Python、预算有限 |
| `relationship` | 人际关系、团队成员、联系人 |
| `style` | 用户喜欢的输出风格、语气、格式 |
| `other` | 其他不确定类型 |

#### 响应示例

外部 API 应返回 JSON。推荐只返回 `memories` 数组；不需要返回 `has_more`。```json
{
  "memories": [
    {
      "id": "mem_101",
      "summary": "用户偏好代码简洁，避免过度封装，变量命名清晰。",
      "type": "style",
      "confidence": 0.94,
      "updated_at": "2026-06-01T09:00:00+08:00",
      "source": "long_term_memory"
    },
    {
      "id": "mem_102",
      "summary": "用户通常偏好 Go 示例；如果用户明确要求 Python，则可以使用 Python。",
      "type": "preference",
      "confidence": 0.86,
      "updated_at": "2026-05-20T13:00:00+08:00",
      "source": "long_term_memory"
    }
  ]
}
```| 类型 | 含义 |
| --- | --- |
| `memories[].summary` | 给模型看的核心内容，建议是短自然语言句子，不要返回大量原始聊天记录 |
| `memories[].type` | 记忆类型，建议与请求中的 `memory_types` 枚举保持一致。 |
| `memories[].confidence` | 可信度，越高越可信 |
| `memories[].updated_at` | 更新时间 |
| `memories[].source` | 记忆来源 |

> PS：当结果为空时，这样返回“"memories": []”，不要返回纯文本（例如“没查到”）。

#### 错误响应

外部 API 返回非 2xx 时，系统会把工具结果归一化为错误输出提交给模型。系统会限制响应体大小，过大响应会被视为 `response_too_large`。推荐仍返回结构化 JSON：```json
{
  "memories": [],
  "error": "invalid_request"
}
```## 9. 外调知识

#### 调用方式```plaintext
POST <knowledge_retrieval.endpoint>
Content-Type: application/json
Accept: application/json
Authorization: <knowledge_retrieval.authorization>
```> 注意：`endpoint` 和 `authorization` 来自 CreateLive 请求中的 `knowledge_retrieval` 配置。

#### 请求示例```json
{
  "live_id": "1234567890",
  "query": "Vidu 实时数字人创建失败时的排查步骤",
  "reason": "用户询问具体排查流程，当前上下文没有产品文档内容。",
  "knowledge_types": ["procedure", "troubleshooting"],
  "time_hint": "最新版本",
  "max_results": 5
}
```| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `live_id` | string | 必填，当前 live ID |
| `query` | string | 必填，模型生成的自然语言检索意图 |
| `reason` | string | 必填，模型说明为什么当前回复需要检索知识 |
| `knowledge_types` | string[] | 希望检索的知识类型 |
| `time_hint` | string | 时间或版本提示 |
| `max_results` | integer | 最多返回条数 |

**knowledge_types 枚举**

| 类型 | 含义 |
| --- | --- |
| `faq` | 常见问题、标准问答 |
| `document` | 产品文档、说明文档、长文档片段 |
| `policy` | 政策、规则、限制、合规说明 |
| `product` | 产品能力、参数、功能说明 |
| `procedure` | 操作流程、接入步骤、使用指南 |
| `troubleshooting` | 排障指南、错误码说明、问题定位步骤 |
| `other` | 其他不确定类型 |

#### 响应示例

外部 API 应返回 JSON。推荐只返回 `knowledge` 数组。```json
{
  "knowledge": [
    {
      "id": "doc_001_chunk_03",
      "title": "实时数字人创建排查指南",
      "content": "如果 CreateLive 返回 SIP 创建失败，先检查 call_mode、avatar.image_uri、SIP provider 返回码和 live 日志 trace_id。",
      "type": "troubleshooting",
      "source": "ops_runbook",
      "updated_at": "2026-07-01T10:00:00+08:00",
      "confidence": 0.92,
      "url": "https://kb.example.com/docs/live-troubleshooting"
    }
  ]
}
```| 类型 | 含义 |
| --- | --- |
| `knowledge[].content` | 给模型看的核心内容，建议是短自然语言句子，不要返回大量原始聊天记录 |
| `knowledge[].type` | 知识类型，建议与请求中的 `knowledge_types `枚举保持一致。 |
| `knowledge[].confidence` | 可信度，越高越可信 |
| `knowledge[].updated_at` | 更新时间 |
| `knowledge[].source` | 知识来源 |
| `knowledge[].title` | 知识来源 |
| `knowledge[].url` | 知识来源 |

> 当结果为空时，这样返回“"knowledge": []”，不要返回纯文本（例如“没查到”）。

#### 错误响应

外部 API 返回非 2xx 时，系统会把工具结果归一化为错误输出提交给模型。系统会限制响应体大小，过大响应会被视为 `response_too_large`。推荐仍返回结构化 JSON：```json
{
  "knowledge": [],
  "error": "invalid_request"
}
```## 10. 记忆管理
平台内置长期记忆的资产管理接口，供 `memory_retrieval.provider=vidu` 使用。按 API Key 所属账号隔离，跨账号访问返回资源不存在。
**记忆对象字段**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | String | 记忆记录 ID，只读；当前不提供按 ID 更新或删除接口 |
| `memory` | String | 提取后的记忆正文。系统从对话中自动提取，一次请求可能产生多条 |
| `user_id` | String | 客户侧最终用户标识 |
| `agent_id` | String | 可选的记忆分区 |
| `run_id` | String | 可选的会话 / 运行标识。会话自动回写时使用 `live_id` 作为 run_id |
| `metadata` | Object | 业务自定义元数据 |
| `created_at` / `updated_at` | String | 创建 / 更新时间。创建接口返回中可能为 null，搜索与列表接口返回 ISO 8601 时间 |
| `score` | Number | 搜索相关度；非搜索场景为 0 |

**创建记忆**
从一组对话消息中提取记忆并入库。上游可能接受请求但未提取出新记忆，此时 `results` 为空数组。必填 `messages`（至少一条，元素含 role 和 content）与 `user_id`（长度 1～64）；可选 `agent_id`（最长 64）、`run_id`、`metadata`。```bash
curl -X POST 'https://{host}/live/v1/memories' \
  -H 'Authorization: Token vda_xxx' \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "customer-user-001",
    "messages": [
      { "role": "user", "content": "我叫阿澈，常用 Go 开发，喜欢简洁的代码风格" },
      { "role": "assistant", "content": "好的，我记住了" }
    ]
  }'
```**搜索记忆**
必填 `query`（非空自然语言查询）与 `user_id`；可选 `agent_id` / `run_id` 缩小范围、`filters`、`limit`。返回 `{"results": [带 score 的记忆对象]}`。```bash
curl -X POST 'https://{host}/live/v1/memories/search' \
  -H 'Authorization: Token vda_xxx' \
  -H 'Content-Type: application/json' \
  -d '{ "query": "用户叫什么，常用什么语言", "user_id": "customer-user-001", "limit": 5 }'
```**获取记忆列表**
必填 `user_id`；可选 `agent_id` / `run_id`、`filters`、`page` / `page_size`。返回 `results` 和 `total`。```bash
curl -X POST 'https://{host}/live/v1/memories/list' \
  -H 'Authorization: Token vda_xxx' \
  -H 'Content-Type: application/json' \
  -d '{ "user_id": "customer-user-001", "page": 1, "page_size": 20 }'
```**删除用户记忆**
查询参数 `user_id` 必填，清空该用户范围内的记忆；可选 `agent_id` / `run_id` 按附加范围删除。成功返回空对象 `{}`，删除后该 `user_id` 释放记忆用户配额。```bash
curl -X DELETE 'https://{host}/live/v1/memories?user_id=customer-user-001' \
  -H 'Authorization: Token vda_xxx'
```## 11. 知识库管理
平台内置知识库的资产管理接口，供 `knowledge_retrieval.provider=vidu` 使用。按 API Key 所属账号隔离；默认每个账号最多 100 个知识库，每个知识库最多 1000 个文档。

| 对象 | 返回字段 |
| --- | --- |
| 知识库 | `id`、`name`、`status`、`error_msg`、`created_at`、`updated_at` |
| 知识文档 | `id`、`knowledge_base_id`、`file_uri`、`name`、`status`、`error_msg`、`created_at`、`updated_at` |

**创建知识库**
同步创建并完成索引。`name` 可选，去除首尾空格后最长 256 个字符。实测耗时约 2 秒。```bash
curl -X POST 'https://{host}/live/v1/knowledge-bases' \
  -H 'Authorization: Token vda_xxx' \
  -H 'X-Request-ID: <uuid>' \
  -H 'Content-Type: application/json' \
  -d '{ "name": "产品 FAQ" }'
```**列出 / 查询 / 删除知识库**
列表查询参数 `pager.page` 从 0 开始（默认 0）、`pager.pagesz` 默认 10 最大 100，返回 `total`、`items`、`next_page_token`。```bash
curl -G 'https://{host}/live/v1/knowledge-bases' \
  -H 'Authorization: Token vda_xxx' \
  --data-urlencode 'pager.page=0' --data-urlencode 'pager.pagesz=20'

curl 'https://{host}/live/v1/knowledge-bases/<knowledge_base_id>' \
  -H 'Authorization: Token vda_xxx'

curl -X DELETE 'https://{host}/live/v1/knowledge-bases/<knowledge_base_id>' \
  -H 'Authorization: Token vda_xxx'
```**添加知识文档**
同步添加并完成灌库，成功后可立即检索。`file_uri` 必填，传平台可访问的文件地址；`name` 可选、最长 256 个字符，省略时从文件地址推导。每个文档最大支持150Mb，PDF、DOCX、DOC、TXT、Markdown、PPTX、PPT、XLSX、XLS、HTML、PNG、JPG、JPEG、BMP、GIF等常见格式```bash
curl -X POST 'https://{host}/live/v1/knowledge-bases/<knowledge_base_id>/documents' \
  -H 'Authorization: Token vda_xxx' \
  -H 'X-Request-ID: <uuid>' \
  -H 'Content-Type: application/json' \
  -d '{ "file_uri": "https://example.com/product-faq.txt", "name": "product-faq.txt" }'
```**列出 / 查询 / 删除知识文档**
分页参数与知识库列表相同。查询单个文档返回的 `file_uri` 为临时可访问地址（带签名，有有效期），不要长期保存。```bash
curl -G 'https://{host}/live/v1/knowledge-bases/<knowledge_base_id>/documents' \
  -H 'Authorization: Token vda_xxx' \
  --data-urlencode 'pager.page=0' --data-urlencode 'pager.pagesz=20'

curl 'https://{host}/live/v1/knowledge-bases/<kb_id>/documents/<document_id>' \
  -H 'Authorization: Token vda_xxx'

curl -X DELETE 'https://{host}/live/v1/knowledge-bases/<kb_id>/documents/<document_id>' \
  -H 'Authorization: Token vda_xxx'
```**检索行为与限制**
- 检索失败、超时或空结果**不会中断 Live**，数字人会继续会话。
- 会话自动搜索记忆不限定 `run_id`，因此可召回跨场长期记忆；`enable_write` 回写时自动使用 `live_id` 作为 `run_id`。
- 最多同时处理 4 个受管工具调用，超过后返回工具繁忙结果。
- 创建 Live 只校验知识库存在且属于当前账号，不校验其中是否有文档。
## 12. 动作库
自建动作库供创建会话时用 `action.library_id` 绑定。按账号 owner 隔离，同一用户下多个 API Key 共用一套库；每账号最多 20 个库，每库最多 100 条动作。均需 `Authorization: Token vda_xxx`，ID 在 JSON 中为 string。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/action-libraries` | 创建库。`name` 必填，超配额或重名返回 400 |
| GET | `/action-libraries?pager.page=0&pager.pagesz=10` | 列表，返回 `total` + `items`，创建时间倒序，只含本账号未删除库 |
| GET | `/action-libraries/{id}` | 库详情。他人库或不存在均返回 404 |
| PATCH | `/action-libraries/{id}` | 改 `name` / `description`，重名返回 400 |
| DELETE | `/action-libraries/{id}` | 删库，库内动作一并删除；进行中的会话不受影响 |
| POST | `/action-libraries/{id}/actions` | 新增动作，**同步改写 `description` 后入库**，常见耗时数秒 |
| GET | `/action-libraries/{id}/actions[/{action_id}]` | 列表 / 详情，可查看改写后的 `description` |
| PATCH | `/action-libraries/{id}/actions/{action_id}` | 改 `name` 不触发改写；改 `description` 会先改写，失败则原记录不变 |
| DELETE | `/action-libraries/{id}/actions/{action_id}` | 删除一条动作 |

**字段约束**

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| 库 `name` | 是 | 1~50 字符，同账号未删除范围内唯一 |
| 库 `description` | 否 | ≤ 200，可空 |
| 动作 `name` | 是 | 1~20 字符，库内未删除范围内唯一 |
| 动作 `description` | 是 | 请求侧 5\~500；服务端改写后再校验 5\~500，改写失败则不入库，可重发同一请求重试 |

库对象另返回 `id`、`action_count`（未删除动作数）、`created_at` / `updated_at`（ISO 8601）；动作对象另返回 `id`、`action_library_id` 与同样的时间字段。```bash
curl -X POST 'https://{host}/live/v1/action-libraries' \
  -H 'Authorization: Token vda_xxx' -H 'Content-Type: application/json' \
  -d '{"name":"默认手势库","description":"挥手点头等"}'

curl -X POST 'https://{host}/live/v1/action-libraries/<id>/actions' \
  -H 'Authorization: Token vda_xxx' -H 'Content-Type: application/json' \
  -d '{"name":"挥手","description":"双手向镜头挥手打招呼"}'
```## 13. 错误响应及其他说明

| 来源 | 状态 / 错误码 | 典型原因 | 客户端处理建议 |
| --- | --- | --- | --- |
| HTTP | `400` | 参数非法、字段缺失、`call_mode` 非法、文本超过长度限制、会话状态不允许继续操作。 | 按接口字段说明修正请求；如果 live 已结束，重新创建会话。 |
| HTTP | `401` | API Key 缺失、格式不正确或无效。 | 检查 `Authorization: Token vda_xxx`；确认 API Key 属于当前环境。 |
| HTTP | `403` | 访问了不属于当前 API Key / 当前账号的 live。 | 使用创建该 live 时同一个 API Key；不要跨账号复用 `live_id`。 |
| HTTP | `404` | 会话不存在、已过期，或 `live_id` 写错。 | 确认 `live_id`；无法恢复时重新创建会话。 |
| HTTP | `500` | 服务内部依赖异常，例如 DB、SIP / video provider、AliRTC token 等。 | 可短暂重试；若持续失败，带上 `live_id`、`trace_id` 和请求时间反馈排查。 |
| HTTP | `503` | 所选 RTC 供应商暂未开通或暂时不可用。 | 服务端不会自动改用其他供应商；可稍后重试，或改用其他 provider。 |
| WS | `NOT_READY` | `video` 模式下数字人渲染侧尚未回连完成，`conn_init` 暂时不能成功。 | 不要立即重建页面；等待 2 到 3 秒后重试 `conn_init`，可使用指数退避。 |
| WS | `LIVE_CONN_INIT_FAILED` | 初始化失败，可能是会话状态异常或服务端依赖异常。 | 关闭当前 WS，重新创建 live；如果仍失败，带上 `live_id` 和日志反馈排查。 |

## 14. 接入要点
- WebSocket 鉴权走 Header；建议服务端做代理，避免 Vidu token 泄漏。
- RTC 需单独下载 SDK 并集成，不是发个 HTTP 请求就行。
- `video` 模式可能会遇到 `NOT_READY`，属正常现象，必须实现重试。
- 任务过程中按时长自动扣积分，余额清零自动断开。
- 单次会话最长 7200 秒，达上限服务主动关闭。
- 保持心跳，客户端必须在 **15 秒内有任何消息**，否则被判定为死连接强制断开。
- 除监听 `conn_init_ack` 外，客户端还必须监听 WebSocket `close` / `error` 事件做兜底。
- App WS 只接受文本 JSON 信令，不要通过 App WS 发送二进制音频或视频。
- `audio_start`、`audio_stop`、`emotion_signal` 在协议枚举中预留，当前接入不要求客户端发送。
- 除 `conn_init` 外，`text_msg`、`audio_interrupted`、`call_hangup` 当前没有独立业务 ack。
- `stream_url` 当前主要是保留字段，实时媒体播放应使用 `rtc` 信息接入 AliRTC。
