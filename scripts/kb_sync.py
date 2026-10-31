"""把 kb/docs/*.md 同步到 Vidu 平台知识库（data URI 方式上传，无需公网托管）。

用法：[DOTENV_CONFIG_PATH=.env.global] python3 scripts/kb_sync.py [--recreate]
- 首次运行创建知识库，ID 写入 .env 的 VIDU_KB_ID
- 再次运行：删除同名旧文档后重新上传（--recreate 则整库重建）
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / os.environ.get("DOTENV_CONFIG_PATH", ".env")
KB_NAME = "杨幂-分身知识库"


def load_env():
    env = {}
    for line in ENV.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def set_env(key, value):
    lines = [l for l in ENV.read_text().splitlines() if not l.startswith(key + "=")]
    lines.append(f"{key}={value}")
    ENV.write_text("\n".join(lines) + "\n")


env = load_env()
BASE = f"https://{env.get('VIDU_HOST', 'api.vidu.cn')}/live/v1"


def api(method, path, body=None, query="", retries=3):
    for attempt in range(retries):
        try:
            return _api(method, path, body, query)
        except urllib.error.HTTPError as e:
            msg = f"{method} {path} -> {e.code} {e.read().decode()[:500]}"
            if e.code < 500 or attempt == retries - 1:
                sys.exit(msg)
            print("retrying:", msg)
            time.sleep(2 * (attempt + 1))


def _api(method, path, body, query):
    req = urllib.request.Request(
        BASE + path + query,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Token {env['VIDU_API_KEY']}",
            "Content-Type": "application/json",
            "X-Request-ID": str(uuid.uuid4()),
        },
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read() or b"{}")


def list_all(path):
    items, page = [], 0
    while True:
        r = api("GET", path, query=f"?pager.page={page}&pager.pagesz=100")
        items += r.get("items", [])
        if len(items) >= int(r.get("total", 0)) or not r.get("items"):
            return items
        page += 1


kb_id = env.get("VIDU_KB_ID")
if kb_id and "--recreate" in sys.argv:
    api("DELETE", f"/knowledge-bases/{kb_id}")
    print("deleted kb", kb_id)
    kb_id = None
if not kb_id:
    kb_id = api("POST", "/knowledge-bases", {"name": KB_NAME})["id"]
    set_env("VIDU_KB_ID", kb_id)
    print("created kb", kb_id)

existing = {d["name"]: d["id"] for d in list_all(f"/knowledge-bases/{kb_id}/documents")}
for f in sorted((ROOT / "kb/docs").glob("*.md")):
    if f.name in existing:
        api("DELETE", f"/knowledge-bases/{kb_id}/documents/{existing[f.name]}")
    uri = "data:text/markdown;base64," + base64.b64encode(f.read_bytes()).decode()
    d = api("POST", f"/knowledge-bases/{kb_id}/documents", {"file_uri": uri, "name": f.name})
    print(f"{f.name}: {d.get('status')} {d.get('error_msg', '')}")
