"""生成待机动作章节的 XML（3.1 静默动作）。"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
raw = json.loads((ROOT / "persona/clone/idle_motions.json").read_text(encoding="utf-8"))


def esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


groups = {
    "手部为主": ["撩发到耳后", "双手拢头发", "手指绕头发", "整理衣领", "挥手招呼", "低头看手再抬头"],
    "头颈与倾听": ["双手托腮", "单手托腮换手", "抱臂歪头", "看向一侧再回来", "双手交叠前倾"],
    "肩颈与舒展": ["伸懒腰", "转转肩膀"],
    "情绪与表情": ["捂嘴偷笑", "打个小哈欠"],
}
by_name = {m["name"]: m for m in raw}

rows = []
for g, names in groups.items():
    for n in names:
        m = by_name[n]
        rows.append(
            f"<tr><td>{g}</td><td>{n}</td><td>{esc(m['content'])}</td><td>{m['weight']}</td></tr>"
        )

xml = f"""<h2>3.1 静默动作：把幅度做出来（正面半身像专用）</h2>
<p>第一版待机动作在正面半身像里几乎看不出来，原因有两个：动作词本身就是小幅度（轻轻点头、微微歪头、放松地眨眼），而平台默认动作库的动作同样偏小，两者混用后整体更弱。半身像只露出头、肩、手臂和上半身，任何"只动眼睛、只动嘴角"的设计在这个画幅里都会丢失信号。</p>
<p>改动分四步。其一，<b>不再混用默认库</b>，改为 source=custom，只用自定义动作池。其二，<b>把动作全部重写成上半身可见的大幅动作</b>：抬手到头部、双手托腮、双臂举过头顶、肩膀转动、转头看向一侧，共 15 个。其三，<b>每个动作都写完整的过程</b>——抬手、执行、放下，而不是只描述一个静态姿势，这样渲染才有明确的起止，不会卡在半途。其四，<b>加快节奏</b>，由"停 10 秒动一次、动完静止 4 秒"改为 6 秒 / 3 秒。</p>
<p>写法上最有价值的一条经验：<b>描述里不要出现"轻轻""微微""小幅"这类词。</b>它们会被渲染理解成小动作，即使动作本身是抬手也一样。改成"明显地拨到耳后""双臂举过头顶""肩膀前后转两圈"这类可量化、有明确方向的表述，幅度才够。</p>

<h3>针对半身像新增的 15 个动作（原始数据）</h3>
<table>
  <colgroup><col width="110"/><col width="130"/><col width="400"/><col width="60"/></colgroup>
  <thead><tr><th background-color="light-gray">分类</th><th background-color="light-gray">动作</th><th background-color="light-gray">原始 content</th><th background-color="light-gray">权重</th></tr></thead>
  <tbody>
{chr(10).join(rows)}
  </tbody>
</table>

<p>表格中的文字即提交给平台的原始描述，逐字对应 persona/clone/idle_motions.json。完整文件如下：</p>
<pre lang="json" caption="persona/clone/idle_motions.json"><code>{esc((ROOT / "persona/clone/idle_motions.json").read_text(encoding="utf-8").rstrip())}</code></pre>

<table>
  <colgroup><col width="170"/><col width="150"/><col width="370"/></colgroup>
  <thead><tr><th background-color="light-gray">参数</th><th background-color="light-gray">第一版</th><th background-color="light-gray">现在</th></tr></thead>
  <tbody>
    <tr><td>source</td><td>mixed（默认库 + 自定义）</td><td>custom（只用自定义，避免默认库的小动作稀释）</td></tr>
    <tr><td>动作数量</td><td>6</td><td>15</td></tr>
    <tr><td>desc 词法</td><td>轻轻点头、微微歪头、放松地眨眼</td><td>明显、大幅、有明确方向与完整过程</td></tr>
    <tr><td>motion_interval</td><td>10 秒</td><td>6 秒</td></tr>
    <tr><td>rest_after_motion</td><td>4 秒</td><td>3 秒</td></tr>
    <tr><td>recommend</td><td>random</td><td>intelligent（按人设与近两轮对话推荐）</td></tr>
  </tbody>
</table>
<p>权重决定被抽中的概率，范围 0.1 到 10。出现频率高的是监听类动作（托腮、歪头、戳头发），权重 2 到 3；突兀度高的动作（伸懒腰、打哈欠、挥手招呼）权重压到 0.8 到 1.5，避免显得过于活泼。</p>

<h2>3.2 说话时的手势</h2>
<p>说话过程中的动作不走平台默认匹配，而是由本地服务按回复内容与用户发言触发，具体规则与时序见 3.3；改造前的原始实现见 3.4。这里只补充一条与静默动作相通的结论：说话手势同样要避免一次性动作（点头、挥手这类有明确起止的），改为持续性的"边说话边比划"，因为渲染延迟几秒时，一次性动作会被明显看出慢半拍，持续动作则不会。</p>
"""

(ROOT / "lark_idle.xml").write_text(xml, encoding="utf-8")
print(len(xml))
