# ST_miniAPP — nginx 反向代理网关镜像（M3 产出，M4 编排直接复用）
#
# 仅 COPY 配置，无额外构建步骤 → 跨平台（amd64 / arm64）天然无差异。
# 上游 hostname（frontend / backend / st-backend）在 docker network / M4 编排时解析。
FROM nginx:1.27-alpine

# 移除官方默认 server，改用本仓库自包含的 nginx.conf（含 events + http + server）。
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/nginx.conf

# NOTE: no build-time `nginx -t` here. nginx.conf (frozen in M3) declares upstreams
# by Docker-network hostname (frontend / backend / st-backend), and `nginx -t`
# resolves those names at config-test time — they only exist at runtime inside the
# compose network, so a standalone image build would fail with
# "host not found in upstream". The config is exercised at container start
# (`nginx -g daemon off;`) and by the /nginx-health HEALTHCHECK below.

EXPOSE 80

# 容器内健康检查命中 nginx 自身 health 端点（不依赖任何 upstream）。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/nginx-health || exit 1

STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;"]
