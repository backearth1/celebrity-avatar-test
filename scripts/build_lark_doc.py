"""生成飞书总结文档的 XML（整体重建用），把关键文件以代码块形式嵌入。"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def code(path: str, lang: str = "text", caption: str = "") -> str:
    body = esc(Path(ROOT / path).read_text(encoding="utf-8").rstrip())
    cap = f' caption="{esc(caption)}"' if caption else ""
    return f'<pre lang="{lang}"{cap}><code>{body}</code></pre>'


parts = []
A = parts.append

A("""<title>杨幂 AI 数字分身 · 开发总结（Vidu S2-Avatar 实时版）</title>
<p><b>文档版本：</b>2026-10-31 综合版　<b>代码目录：</b>服务器 /home/ubuntu/vidu-avatr　<b>当前环境：</b>海外站 api.vidu.com</p>
<p>本文把整个开发过程做一次完整收拢：先讲清系统怎么跑，再分别总结人设、动作、知识库、记忆四块的设计与踩坑，关键文件全文嵌入在对应章节里，可以直接对照代码看结论。最后一章列出仍未解决的问题。</p>

<h1>一、项目与系统架构</h1>
<p>目标是基于 Vidu S2-Avatar 实时接口，在已取得肖像、声音与 AI 分身授权的前提下，做一个杨幂的 AI 数字分身，在浏览器里进行 1 对 1 实时视频通话。研究重点是三件事如何配合：人设提示词、平台内置知识库、平台内置长期记忆。</p>
<p>服务部署在 https://42.194.196.244:8443，自签名证书（SAN 含公网 IP），带 Basic Auth 访问保护。Vidu API Key、访问密码只存在服务器 .env 文件中，不下发浏览器，本文也不记录。</p>
<p>一次通话的调用链：浏览器点开始，向本地服务请求建会话；服务端先按人设分区拉取该用户的长期记忆，拼进人设后调用 POST /live/s_avatar/realtime 创建 Live；拿到 RTC 凭证后，浏览器用 Agora Web SDK 发布麦克风和摄像头、订阅数字人音视频；控制信令（初始化、文字消息、打断、挂断、转写回传）经本地服务的 WebSocket 代理转发到 Vidu，代理负责补鉴权 Header、每 10 秒发 ping、按回复文本下发手势，并把双方上下行全部写入 logs/&lt;live_id&gt;.jsonl 用于事后复盘。</p>
<p>国内站与海外站各有一套配置：.env.cn 指向 api.vidu.cn，.env.global 指向 api.vidu.com，.env 是指向当前站点的软链接，命令里用 DOTENV_CONFIG_PATH 切换。两个站各有独立的知识库、形象与克隆音色资产。</p>
<table>
  <colgroup><col width="150"/><col width="300"/><col width="300"/></colgroup>
  <thead><tr><th background-color="light-gray">资产</th><th background-color="light-gray">国内站</th><th background-color="light-gray">海外站（当前）</th></tr></thead>
  <tbody>
    <tr><td>知识库 ID</td><td>1013680961558163456</td><td>1013713138974986240</td></tr>
    <tr><td>形象 avatar.id</td><td>1013691185841053696</td><td>1013727500401917952（第二版形象）</td></tr>
    <tr><td>音色</td><td>默认 Maia（克隆音色已建但停用）</td><td>克隆音色 yangmi_v1</td></tr>
  </tbody>
</table>

<h1>二、人设</h1>
<p>人设是整个体验的骨架。两个人设各自独立成目录，记忆分区（agent_id）分开，前端可在开始通话前切换，选择结果存在浏览器本地。</p>
<table>
  <colgroup><col width="140"/><col width="200"/><col width="190"/><col width="180"/></colgroup>
  <thead><tr><th background-color="light-gray">人设</th><th background-color="light-gray">目录</th><th background-color="light-gray">记忆分区</th><th background-color="light-gray">定位</th></tr></thead>
  <tbody>
    <tr><td>官方口吻分身</td><td>persona/clone/</td><td>yangmi_clone_v1</td><td>承认是 AI 分身，信息型</td></tr>
    <tr><td>女友角色扮演</td><td>persona/girlfriend/</td><td>yangmi_girlfriend_v1</td><td>不提 AI，沉浸式陪伴</td></tr>
  </tbody>
</table>

<h2>2.1 人设写作的四条经验</h2>
<p><b>高频事实前置到人设，长尾留给知识库。</b>检索是模型自己决定要不要调用的工具，常识类问题它往往直接凭印象回答。测试中把粉丝名放在知识库里，她答成了「小幂们」。所以粉丝名、昵称、生日、代表作这类高频事实直接写进人设，作品全表、奖项、代言等长尾才依赖知识库。</p>
<p><b>示例对话的长度决定回复长度。</b>模型会照着示例的篇幅说话。人设示例超过 40 字时，回复普遍 60 到 80 字；把示例全部压到 30 字以内后，短问题回复降到 11 到 20 字。这条比「请简短回答」这类抽象要求有效得多。</p>
<p><b>边界要写清第几次追问怎么办，不能只写「一句带过」。</b>最初只写「一句带过」，第一次问离婚她挡回去了，第二次追问就编出了「真实原因」。补上最高优先级条款后，明确规定不许说、不许猜、不许编，并给出第二次以后的标准话术，连续三次追问均未松口。</p>
<p><b>分身身份与角色扮演要分开设计。</b>官方口吻人设保留 AI 身份声明；女友人设则是明确的角色扮演，不提 AI，但要约定退出方式（用户说「停，我不玩了」），并对现实经历的追问采取「不承认也不否认、撒娇挡回」的策略，避免用「我什么时候离婚了」这种方式生硬否定事实。</p>

<h2>2.2 人设一：官方口吻分身（全文）</h2>
""")
A(code("persona/clone/yangmi_persona.md", "markdown", "persona/clone/yangmi_persona.md"))
A("<h2>2.3 人设二：女友角色扮演（全文）</h2>")
A(code("persona/girlfriend/persona.md", "markdown", "persona/girlfriend/persona.md"))
A("<p>预设共同记忆单独成文，建会话时替换人设中的 {shared_memories} 占位符，作为两人之间已经发生过的事注入，不依赖平台记忆模块：</p>")
A(code("persona/girlfriend/shared_memories.md", "markdown", "persona/girlfriend/shared_memories.md"))
A("""<h2>2.4 开场白与动作风格（全文）</h2>
<p>开场白提示词限 200 字符以内。官方人设要求先看记忆里有没有这位朋友，认识就接上次的话题；女友人设则是一句恋人式的问候。动作风格提示词决定她说话时的整体肢体语言，同样按人设分开。</p>
""")
A(code("persona/clone/greeting.txt", "text", "persona/clone/greeting.txt（官方口吻）"))
A(code("persona/girlfriend/greeting.txt", "text", "persona/girlfriend/greeting.txt（女友）"))
A(code("persona/clone/action_prompt.txt", "text", "persona/clone/action_prompt.txt（官方口吻）"))
A(code("persona/girlfriend/action_prompt.txt", "text", "persona/girlfriend/action_prompt.txt（女友）"))

A("""<h1>三、动作系统</h1>
<p>动作分两种场景：她没说话时的静默小动作，和她说话过程中的手势。两者最初的实现都不理想，下面按问题、原因、做法记录。</p>

<h2>3.1 静默动作：从看不出来到看得见</h2>
<p>最初的待机动作是「轻轻点头」「微微歪头」「放松地眨眼」，在正面半身像里几乎看不出来；而且混用了平台默认动作库，默认库的动作同样偏小。现在的做法是只用自定义动作（source=custom），共 15 个，每个都写清抬手、做动作、放回的完整过程，只动头、肩、手臂、双手，不离开画面、不转身、不拿道具。节奏由「停 10 秒动一次、动完静止 4 秒」改为 6 秒 / 3 秒。</p>
<p>写法上的一条经验：描述里要避免「轻轻」「微微」这类词，否则生成出来依然偏小；改成「明显地拨到耳后」「双臂举过头顶」这类可量化的动作，幅度才够。</p>
""")
A(code("persona/clone/idle_motions.json", "json", "persona/clone/idle_motions.json（15 个待机动作，两个人设共用）"))

A("""<h2>3.2 说话时的手势：放弃预测，改为按回复驱动</h2>
<p>平台自带的 action.enabled 是用用户的问话来预测动作，动作在她开口之前就定了，和她实际说出来的内容常常对不上，因此关闭。改由服务端做两层驱动：</p>
<p><b>第一层，按回复文本匹配。</b>服务端监听数字人自己的回复转写（type=10），按关键词匹配手势，用 text_action（type=101）下发，该信令不产生回复、不打断当前播报。规则分九类（笑、挥手、安慰、摇头摆手、比心、比划解释、耸肩摊手、询问），每条回复至多一个动作，冷却 4.5 秒，回复少于 6 字不触发；匹配不到时发通用手势，保证正常说话也有动作。</p>
<p><b>第二层，用户话停即提前触发。</b>实测她的第一句话在用户说完约 1.8 秒后才以文字返回，动作在此基础上还要加渲染耗时，所以总是晚半拍。现在改为在用户整句转写到达时（约 300 毫秒）先发一个准备开口的中性手势，让它赶在声音之前进入渲染；冷却时间正好挡住随后到达的回复匹配动作，避免连发两个。代价是提前触发的手势只能根据用户的话选，无法贴合她要说的内容，这是「早」与「准」的取舍。</p>
<p><b>幅度全面收小。</b>用户反馈第一批动作在说话时过于夸张，现已整体收敛：笑由「抬手捂嘴、肩膀抖动」改为「嘴角上扬轻轻笑一下、手只微微抬一点」；掰手指并入「边说话边比划」；挥手改为轻挥两下；比心改为单手小比心。通用兜底手势也同步改柔和。</p>
""")
A(code("server/text_action.js", "javascript", "server/text_action.js（手势匹配规则全文）"))

A("""<h1>四、知识库</h1>
<p>使用平台内置知识库（provider=vidu），国内站与海外站各一份，内容相同。</p>
<h2>4.1 内容怎么来</h2>
<p>服务器无法访问 Wikipedia 与百度百科，最终用的是快懂百科杨幂词条：页面正文以结构化 JSON 嵌在 HTML 里，脚本解析后转成 Markdown，再按主题切成 10 篇文档；另外 1 篇来自性格调研稿。感情生活、争议事件和港媒未证实传闻不入库，交给人设按边界处理，原始抓取保存在 kb/raw/ 供人工参考。</p>
<table>
  <colgroup><col width="290"/><col width="80"/><col width="380"/></colgroup>
  <thead><tr><th background-color="light-gray">文档</th><th background-color="light-gray">字数</th><th background-color="light-gray">内容</th></tr></thead>
  <tbody>
    <tr><td>01 基本资料与人物简介</td><td>1.6k</td><td>生日、昵称、粉丝名、经纪公司、代表作、经历概述</td></tr>
    <tr><td>02 童年与早年经历</td><td>0.6k</td><td>名字由来、北京胡同童年、童星出道</td></tr>
    <tr><td>03 演艺经历 1990—2020</td><td>4.4k</td><td>童星、北电、走红与转型</td></tr>
    <tr><td>04 演艺经历 2021 至今</td><td>3.5k</td><td>独立工作室、电影转型、《生万物》等</td></tr>
    <tr><td>05 电视剧作品</td><td>2.0k</td><td>每部剧一行：剧名、播出时间、角色</td></tr>
    <tr><td>06 电影与配音作品</td><td>2.1k</td><td>电影、微电影、短片、配音</td></tr>
    <tr><td>07 综艺、音乐与杂志</td><td>4.6k</td><td>综艺晚会、单曲、杂志封面、学术文章</td></tr>
    <tr><td>08 广告代言</td><td>1.8k</td><td>品牌、时间、头衔</td></tr>
    <tr><td>09 荣誉奖项</td><td>3.9k</td><td>获奖与提名，标注需区分「获得」与「入围」</td></tr>
    <tr><td>10 公益、社会活动与圈外生活</td><td>1.8k</td><td>捐款、社会任职、宠物、工作室</td></tr>
    <tr><td>11 性格观点与原话</td><td>15.8k</td><td>采访与综艺原话、观点、昵称由来、2025—2026 公开活动</td></tr>
  </tbody>
</table>
<h2>4.2 写法与上传</h2>
<p>文档按「一篇一个主题、每一行可独立理解」生成，例如作品表写成「杨幂参演电视剧《亲爱的翻译官》（2016），饰演乔菲」，这样检索命中率明显更好。平台没有通用文件上传接口，实测文档的 file_uri 可以直接传 data:text/markdown;base64 形式，因此无需公网托管；同步脚本会替换同名文档，偶发的 500 已加重试。</p>
<h2>4.3 为什么打开每轮强制检索</h2>
<p>不强制时，模型很少主动查库，会把电视剧说成电影、把已上映说成在筹备，甚至编出剧情。打开 force_search 后，同样的问题全部答对，延迟几乎没有变化（问题之后约 2 到 4.7 秒）。</p>
<h2>4.4 怎么确认检索真的发生</h2>
<p>平台不在实时消息或会话查询接口中返回检索记录，只能间接判断。做了一次探针测试：向知识库临时上传一篇写有不可能被模型知道的事实（幸运暗号「蓝鲸-42-梧桐」）的文档，两个人设都准确答出，证明链路完整、结果确实进入了回答；测试文档随后删除。结论是知识库可用，回答出错更多源于人设约束和模型自由发挥。</p>

<h1>五、记忆</h1>
<p>使用平台内置长期记忆（provider=vidu），接口形态与 mem0 基本一致。浏览器首次访问生成稳定的 user_id，记忆按 user_id 隔离；agent_id 按人设分区，切换人设不会串戏。</p>
<h2>5.1 写入：自动提取，但会提炼过头</h2>
<p>开启 enable_write 后，平台在会话结束后从对话中自动提取记忆。实测一场对话能提取出 5 条，中英文混杂但不影响使用。需要注意的是它会主动推理：用户随口一句「我也在想怎么离」，被提炼成「正在考虑离婚」这类结论性记忆。因此页面必须提供忘记我入口。</p>
<h2>5.2 召回：模型不主动查，所以服务端预取</h2>
<p>第二场用户只说「嗨，又是我」，她答「又是你呀」，没有叫名字也没有提上次的事，说明模型没有主动调用记忆检索，开场白也不会用到记忆。改进做法是建会话前由服务端调用 /memories/list 拉取该用户记忆，以这位朋友记得这些的形式拼进人设末尾，并要求像老朋友一样只挑一件事自然问起。改动后开场即说「嗨，小林！你那个大项目准备得咋样了？」。会话中的 memory_retrieval 仍然开启，用于中途按需检索与回写。</p>
<h2>5.3 预设共同记忆：不依赖平台，用来测记忆模块</h2>
<p>女友人设带一份 12 条的预设共同记忆（全文见 2.3 节），建会话时直接注入人设，因此每次通话都稳定成立；平台记忆模块只负责记住通话中新出现的信息。测试中问「第一次见面在哪」能答出火锅店和毛肚；但也发现她会顺着编预设里没写的结局（问丑照答「早就被我删了」），已补规则：只认写明的事，未写明的细节不要自己补。通话结束后平台还会把预设内容重新提取一遍入库，重复但无害。</p>
<h2>5.4 会话配置与注册表（全文）</h2>
""")
A(code("server/session_config.js", "javascript", "server/session_config.js"))
A(code("server/personas.js", "javascript", "server/personas.js（人设注册表）"))

A("""<h1>六、前端与运维</h1>
<p>浏览器端负责 RTC 收发音视频、控制信令、字幕和记忆查看。三个值得记录的细节：</p>
<p><b>卡死检测。</b>平台侧偶发会话卡死：画面还在，但语音、文字、打断、挂断全部失效。实测一次通话在第 169 秒后完全无响应，最终以 client_reconnect_timeout 关闭并计费 269 秒。网页端因此加了检测：发出的文字 10 秒内未被回显即判定卡住，自动挂断并提示重连。局限是只对打字有效，纯语音时无法察觉。</p>
<p><b>控制栏布局。</b>加入人设下拉框后按钮出现长宽变形，原因是按钮靠内边距撑高、下拉框用固定高度，同一行 flex 布局中互相压缩。修复方式是控制栏所有子元素统一 38px 高、禁止压缩，下拉框固定宽度并在窄屏缩小，整行允许换行。</p>
<p><b>WebSocket 代理。</b>Key 只存在服务端，代理负责鉴权、心跳（协议未定义心跳信令，用 WS ping 帧兜底）、只放行本服务创建的会话，并按人设转发手势。文档要求 15 秒内必须有消息，实测空闲 30 秒也不会被断开。</p>

<h1>七、踩过的问题与结论</h1>
<table>
  <colgroup><col width="230"/><col width="330"/><col width="190"/></colgroup>
  <thead><tr><th background-color="light-gray">问题</th><th background-color="light-gray">原因</th><th background-color="light-gray">处理</th></tr></thead>
  <tbody>
    <tr><td>粉丝名答成小幂们</td><td>模型没查知识库，凭自身知识回答</td><td>高频事实前置到人设</td></tr>
    <tr><td>《唐明皇》说成电影、电影问题列电视剧</td><td>同上</td><td>打开每轮强制检索</td></tr>
    <tr><td>关雪性格与本人原话相反、编造剧情</td><td>知识库无剧情内容，模型自由发挥</td><td>检索结果校验 + 人设禁止编造</td></tr>
    <tr><td>否认真实作品（你是不是搞混了）</td><td>无规则约束不知道的表达方式</td><td>禁止用搞混了、没演过否定，改为记不清</td></tr>
    <tr><td>追问两次就编出离婚原因</td><td>边界只写一句带过</td><td>加最高优先级条款与标准话术</td></tr>
    <tr><td>动作与说话内容不匹配</td><td>平台按用户问话预测动作</td><td>关闭 action.enabled，改按回复文本下发</td></tr>
    <tr><td>动作晚于声音约 2 秒</td><td>回复文本 1.8 秒后才到，再加渲染耗时</td><td>用户话停时提前发中性手势</td></tr>
    <tr><td>静默动作看不出来</td><td>动作词幅度小、混用默认库</td><td>只用自定义大幅动作，加快节奏</td></tr>
    <tr><td>跨会话认不出人</td><td>模型不主动检索记忆</td><td>服务端预取记忆拼进人设</td></tr>
    <tr><td>会话卡死仍在计费</td><td>平台侧无响应，画面不受影响</td><td>前端 10 秒检测自动挂断；已报 Vidu</td></tr>
    <tr><td>国内站克隆音色被挂断</td><td>平台风控 audit_violation，约 21 秒</td><td>改回默认音色；海外站正常，需报告备流程</td></tr>
  </tbody>
</table>

<h1>八、关键配置一览</h1>
<table>
  <colgroup><col width="190"/><col width="220"/><col width="330"/></colgroup>
  <thead><tr><th background-color="light-gray">配置项</th><th background-color="light-gray">取值</th><th background-color="light-gray">说明</th></tr></thead>
  <tbody>
    <tr><td>voice_model</td><td>qwen_omni</td><td>支持用户视频画面输入；doubao 不支持</td></tr>
    <tr><td>rtc</td><td>agora</td><td>agora 与 artc 均实测可用</td></tr>
    <tr><td>knowledge_retrieval</td><td>vidu 内置 + force_search</td><td>每轮强制检索，延迟几乎不变</td></tr>
    <tr><td>memory_retrieval</td><td>vidu 内置，按人设分区</td><td>enable_write 开启，会话结束后自动提取</td></tr>
    <tr><td>idle_motion</td><td>custom，15 个动作，6s / 3s</td><td>只用自定义动作，不用平台默认库</td></tr>
    <tr><td>action.enabled</td><td>false</td><td>改由服务端按回复文本下发 text_action</td></tr>
    <tr><td>llm.max_tokens</td><td>150</td><td>默认 50 偏短；长度主要靠人设约束</td></tr>
    <tr><td>vad.idle_timeout_ms</td><td>12000</td><td>用户沉默 12 秒主动找话题</td></tr>
    <tr><td>moderation / extra_motion</td><td>disabled / true</td><td>文档未公开的一级参数，由 .env 控制</td></tr>
    <tr><td>persona_enhance</td><td>false</td><td>人工打磨人设，不让平台扩写</td></tr>
  </tbody>
</table>

<h1>九、已知限制与待办</h1>
<p>当前最明显的限制有三个。一是回复长度：短问题已能压到 11 到 20 字，但开放问题和讲细节的请求仍会到 60 到 84 字，人设约束会被讲具体一点的指令冲掉，可考虑把 max_tokens 下调到 80 硬性压缩，代价是偶尔截断。二是动作与声音的对齐：提前触发只能给中性手势，若要更贴合内容，需要在浏览器端加静音检测再提前 1 到 2 秒，但会带来误判。三是平台稳定性与合规：海外站期间出现过会话卡死与 render_internal_error，国内站克隆音色触发风控，若要国内上线，需要携授权材料与 Vidu 确认明星肖像与声音分身的报备或白名单流程。</p>
<checkbox done="false">在浏览器端确认动作幅度、触发时机与声音是否对齐</checkbox>
<checkbox done="false">决定是否把 llm.max_tokens 从 150 下调到 80 以压缩回复长度</checkbox>
<checkbox done="false">决定是否在浏览器端加静音检测，把动作再提前 1–2 秒</checkbox>
<checkbox done="false">复测女友人设是否还会补造预设记忆里没有的细节</checkbox>
<checkbox done="false">决定是否在页面提供输入框，让用户自填女友应记得的事</checkbox>
<checkbox done="false">与 Vidu 确认国内站明星分身的授权报备流程</checkbox>
<checkbox done="false">如有域名，替换自签名证书</checkbox>
""")

xml = "\n".join(parts)
Path(ROOT / "lark_full.xml").write_text(xml, encoding="utf-8")
print(len(xml), "chars")
