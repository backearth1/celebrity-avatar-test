"""把百科原始 Markdown（kb/raw/baike_com_yangmi.md）切分成面向检索的知识库文档（kb/docs/*.md）。

原则：
- 一个文档一个主题；每一行/每一段能脱离上下文独立理解（带上“杨幂”和年份）。
- 不收录：感情生活、争议事件、未经证实的港媒传闻（人设里另有应对策略）。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "kb/raw/baike_com_yangmi.md"
OUT = ROOT / "kb/docs"
SOURCE = "来源：快懂百科「杨幂」词条（www.baike.com），抓取于 2026-10-30，数据截至 2026-10-25。"

raw = RAW.read_text(encoding="utf-8")
infobox, body = raw.split("\n---\n", 1)
body = body.split("\n---\n")[0]

# 去掉未经证实的传闻句子
RUMOR_PATTERNS = [r"[^。]*据港媒报道[^。]*。", r"[^。]*抚养权[^。]*。"]
for p in RUMOR_PATTERNS:
    body = re.sub(p, "", body)


def section(text, title, level):
    """取出标题为 title 的章节正文（到同级或更高级标题为止）。"""
    hashes = "#" * level
    m = re.search(rf"^{hashes} {re.escape(title)}\s*$", text, re.M)
    if not m:
        sys.exit(f"section not found: {title}")
    rest = text[m.end():]
    end = re.search(rf"^#{{1,{level}}} ", rest, re.M)
    return rest[: end.start() if end else len(rest)].strip()


def kv(line):
    return dict(p.split(": ", 1) for p in line[2:].split("；") if ": " in p)


def year(d):
    return (d.get("release_time") or d.get("time") or "").strip()


def works_lines(text, kind):
    lines = []
    for line in text.splitlines():
        if not line.startswith("- "):
            continue
        d = kv(line)
        name = d.get("name", "").strip()
        if not name:
            continue
        y = year(d)
        s = f"- 杨幂{kind}《{name}》"
        extra = []
        if y:
            extra.append(f"上映/播出时间 {y}")
        else:
            extra.append("尚未上映或待定")
        if d.get("platform"):
            extra.append(f"平台：{d['platform']}")
        s += "（" + "，".join(extra) + "）"
        if d.get("role"):
            s += f"，饰演{d['role']}"
        if d.get("intro") or d.get("introduction"):
            s += f"，{d.get('intro') or d.get('introduction')}"
        lines.append(s + "。")
    return "\n".join(lines)


def doc(fname, title, intro, content):
    text = f"# {title}\n\n{intro}\n\n{content.strip()}\n\n> {SOURCE}\n"
    (OUT / fname).write_text(text, encoding="utf-8")
    print(f"{fname}: {len(text)} chars")


OUT.mkdir(parents=True, exist_ok=True)

summary = body.split("\n# 人物经历")[0].strip()
doc("01_基本资料与人物简介.md", "杨幂 基本资料与人物简介",
    "杨幂的基本个人信息、昵称、代表作和整体经历概述。",
    "## 基本资料\n" + infobox.strip() + "\n\n## 人物简介\n" + summary)

early = section(body, "早年经历", 2)
doc("02_童年与早年经历.md", "杨幂 童年与早年经历（名字由来、北京胡同童年、童星出道）",
    "杨幂出生成长、名字由来、童年性格和如何进入演艺圈。", early)

career = section(body, "演艺经历", 2)
# 按阶段拆成两个文档，避免单文档过长
parts = re.split(r"^### ", career, flags=re.M)
early_career = "\n".join("### " + p for p in parts[1:] if not p.startswith("稳步发展"))
late_career = "\n".join("### " + p for p in parts[1:] if p.startswith("稳步发展"))
doc("03_演艺经历_1990-2020.md", "杨幂 演艺经历（1990年—2020年：童星出道到走红、转型）",
    "杨幂从童星出道、北电求学、《神雕侠侣》《仙剑三》《宫锁心玉》走红，到《三生三世十里桃花》等代表作的历程。",
    early_career)
doc("04_演艺经历_2021至今.md", "杨幂 演艺经历（2021年至今：独立工作室、电影转型、《生万物》等）",
    "杨幂 2021 年以来的作品、综艺、晚会、代言与获奖动态，包括与嘉行传媒结束合作、《生万物》《酱园弄》《长安的荔枝》《惊蛰无声》《江山大同》等。",
    late_career.replace("### 稳步发展", "### 2021年至今：稳步发展"))

works = section(body, "主要作品", 1)
doc("05_电视剧作品.md", "杨幂 参演电视剧作品列表（含角色）",
    "杨幂参演的电视剧，按时间倒序，含播出年份和饰演角色。",
    works_lines(section(works, "参演电视剧", 2), "参演电视剧"))
doc("06_电影作品.md", "杨幂 参演电影与配音作品列表（含角色）",
    "杨幂参演的电影、微电影、短片和配音作品，含上映时间和饰演角色。",
    "## 电影\n" + works_lines(section(works, "参演电影", 2), "参演电影")
    + "\n\n## 微电影\n" + works_lines(section(works, "参演微电影", 2), "参演微电影")
    + "\n\n## 短片\n" + works_lines(section(works, "参演短片", 2), "参演短片")
    + "\n\n## 配音\n" + works_lines(section(works, "配音作品", 2), "配音作品"))
doc("07_综艺音乐与杂志.md", "杨幂 综艺节目、音乐单曲、杂志封面与学术文章",
    "杨幂参加的综艺节目和晚会、演唱的歌曲、登上的杂志封面、发表的学术文章。",
    "## 综艺与晚会\n" + works_lines(section(works, "参加综艺", 2), "参加综艺/晚会")
    + "\n\n## 音乐单曲\n" + works_lines(section(works, "音乐单曲", 2), "演唱歌曲")
    + "\n\n## 杂志封面\n" + works_lines(section(works, "杂志封面", 2), "登上杂志封面")
    + "\n\n## 学术文章\n" + section(works, "学术文章", 2))

doc("08_广告代言.md", "杨幂 广告代言品牌列表",
    "杨幂担任代言人的品牌、时间和头衔。", section(body, "广告代言", 1))


def honor_lines(text):
    out = []
    for line in text.splitlines():
        if line.startswith("- "):
            d = kv(line)
            w = f"，作品：{d['works']}" if d.get("works") else ""
            out.append(f"- {d.get('time', '')}，杨幂在「{d.get('name', '')}」获得/入围「{d.get('honor', '')}」{w}。")
    return "\n".join(out)


honors = section(body, "荣誉奖项", 1)
doc("09_荣誉奖项.md", "杨幂 获奖与提名记录",
    "杨幂获得的影视奖项、荣誉和提名（百科记录中部分条目为提名而非获奖，回答时注意区分“获得”与“入围/提名”）。",
    "## 影视荣誉\n" + honor_lines(section(honors, "影视荣誉", 2))
    + "\n\n## 其他荣誉\n" + honor_lines(section(honors, "其他荣誉", 2)))

life = section(body, "圈外生活", 2)
pet, *biz = life.split("\n")
doc("10_公益社会活动与圈外生活.md", "杨幂 公益慈善、社会任职、宠物与圈外生活",
    "杨幂的公益捐款、慈善活动、社会任职、领养的小猫喜宝、身体状况与工作室经营。",
    "## 公益与社会活动\n" + section(body, "社会活动", 1)
    + "\n\n## 社会任职\n" + section(body, "社会任职", 1)
    + "\n\n## 宠物\n" + pet
    + "\n\n## 身体状况（本人公开分享）\n" + section(body, "身体状况", 2)
    + "\n\n## 工作室与投资\n" + "\n".join(biz)
    + "\n\n## 外界评价\n" + section(body, "人物评价", 1))
