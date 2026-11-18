# Vidu 数字分身 demo — 部署镜像
# 目标环境：阿里云 Agent Sandbox（systemd 微虚机，linux/amd64，需 /bin/bash，不支持 IPv6）
# 网络拓扑：沙箱公网网关做 HTTPS 终止（https://{port}-{sandbox}.cn-beijing.sandbox.aliyuncs.com），
#           容器内可跑纯 HTTP —— 浏览器侧的 secure context 由公网 HTTPS 保证。
FROM node:22-bookworm

# ffmpeg：录像下载后按时间窗裁剪用（容器内用腾讯内网源，公网 Debian 源实测 500s+ 拉不动）
RUN find /etc/apt -name '*.sources' -o -name 'sources.list' | xargs -r sed -i \
      -e 's|deb.debian.org|mirrors.cloud.tencent.com|g' \
      -e 's|security.debian.org|mirrors.cloud.tencent.com|g' \
 && apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 源码与静态资源（.dockerignore 已排除密钥/录像/日志/node_modules）
COPY server/ server/
COPY web/ web/
COPY persona/ persona/
COPY kb/ kb/
COPY scripts/ scripts/

# 运行时可写目录（沙箱重启即失，见交接文档"已知限制"）
RUN mkdir -p data logs recordings

# MODE=component PORT=8444 为默认（组件版主推模式）；标准版 MODE=standard PORT=8443
ENV NODE_ENV=production \
    MODE=component \
    PORT=8444 \
    HOST=0.0.0.0

EXPOSE 8443 8444

# 密钥不进镜像：全部经 Sandbox Launcher 的 env 字段注入（见 .env.example）。
# server.js 里 dotenv/config 找不到 .env 文件时是无操作，env 变量直接生效。
# 前台常驻（沙箱要求；不要 daemon、不要 systemd）
CMD ["node", "server/server.js"]
