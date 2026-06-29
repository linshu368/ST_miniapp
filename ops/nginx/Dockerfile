# ST_miniAPP — nginx 生产网关镜像（方案 Y：仅 ST/backend 内部分发）
#
# nginx.conf 是 envsubst 模板（upstream 用 ${BACKEND_UPSTREAM} / ${ST_UPSTREAM}
# 占位）。nginx 官方基础镜像自带 entrypoint 脚本
# /docker-entrypoint.d/20-envsubst-on-templates.sh：它会把
# $NGINX_ENVSUBST_TEMPLATE_DIR/*.template（默认 /etc/nginx/templates/）里的
# ${VAR} 替换为同名环境变量，输出到 $NGINX_ENVSUBST_OUTPUT_DIR。
# 我们把输出目录设为 /etc/nginx，于是
#   /etc/nginx/templates/nginx.conf.template  →(envsubst)→  /etc/nginx/nginx.conf
# 在容器启动时生成最终主配置。envsubst 只替换「环境里存在的变量名」，nginx 运行时
# 变量（$host / $remote_addr / $http_* 等）不在环境中，不受影响。
#
# 部署时必须由 Railway 注入 BACKEND_UPSTREAM / ST_UPSTREAM（Railway 内网服务名形态，
# 见 ops/env/nginx.env.production.example）。下方 ENV 仅给出占位默认值，便于本地
# `docker run` 冒烟；未覆盖时 nginx 会因无法解析占位主机名而拒绝启动（fail-fast）。
#
# 仅 COPY 配置 + 模板化，无编译步骤 → 跨平台（amd64 / arm64）天然无差异。
FROM nginx:1.27-alpine

# 移除官方默认 server（conf.d/default.conf），改用本仓库自包含的 nginx.conf
# （含 events + http + server；不 include conf.d）。
RUN rm -f /etc/nginx/conf.d/default.conf

# 模板放入官方约定的模板目录；输出目录指向 /etc/nginx 以生成主 nginx.conf。
COPY nginx.conf /etc/nginx/templates/nginx.conf.template
ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx

# 占位默认值（务必在 Railway 控制台用真实内网服务名覆盖）。
ENV BACKEND_UPSTREAM=backend.railway.internal:3001
ENV ST_UPSTREAM=st-bundle.railway.internal:8000

# NOTE: no build-time `nginx -t`. The config is templated + exercised at container
# start (entrypoint runs envsubst, then `nginx -g daemon off;`) and probed by the
# /nginx-health HEALTHCHECK below. Upstream names only resolve at runtime inside the
# Railway private network, so a standalone build-time test would fail DNS resolution.

EXPOSE 80

# 容器内健康检查命中 nginx 自身 health 端点（不依赖任何 upstream）。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/nginx-health || exit 1

STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;"]
