#!/usr/bin/env bash
# Sandbox Launcher AK/SK 签名客户端（协议见飞书文档《Sandbox Launcher 接口文档》§3）
# 依赖：curl + openssl + python3。用法：bash sandbox_call.sh <METHOD> <PATH[?query]> ['<json-body>']
# 环境变量：SL_BASE_URL / SL_AK / SL_SK
set -euo pipefail
METHOD="${1:?METHOD}"; TARGET="${2:?PATH}"; BODY="${3:-}"
BASE="${SL_BASE_URL:?需要 SL_BASE_URL}"
AK="${SL_AK:?需要 SL_AK}"; SK="${SL_SK:?需要 SL_SK}"

PATH_ONLY="${TARGET%%\?*}"
QUERY=""
if [[ "$TARGET" == *\?* ]]; then QUERY="${TARGET#*\?}"; fi
TS="$(date +%s)"
NONCE="$(head -c12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
BODY_HASH="$(printf '%s' "$BODY" | openssl dgst -sha256 -hex | awk '{print $NF}')"

# CanonicalQuery：按参数名排序、RFC3986 编码（空格 %20）、空值保留 key=
CANON_Q="$(QUERY="$QUERY" python3 - <<'PY'
import os, urllib.parse
pairs = urllib.parse.parse_qsl(os.environ['QUERY'], keep_blank_values=True)
enc = lambda s: urllib.parse.quote(s, safe='~')
print('&'.join(f'{enc(k)}={enc(v)}' for k, v in sorted(pairs)))
PY
)"

ST="$(printf '%s\n%s\n%s\n%s\n%s\n%s' "$METHOD" "$PATH_ONLY" "$CANON_Q" "$TS" "$NONCE" "$BODY_HASH")"
SIG="$(printf '%s' "$ST" | openssl dgst -sha256 -hmac "$SK" -hex | awk '{print $NF}')"

HDR=(-H "X-Access-Key: $AK" -H "X-Timestamp: $TS" -H "X-Nonce: $NONCE" -H "X-Signature: $SIG")
[ -n "$BODY" ] && HDR+=(-H 'Content-Type: application/json' -d "$BODY")
curl -sS --max-time 30 -X "$METHOD" "${HDR[@]}" "$BASE$TARGET"
