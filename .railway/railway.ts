/**
 * Railway Infrastructure as Code — ST_miniAPP 生产拓扑（方案 Y）
 * ============================================================================
 * 为什么是 `.railway/railway.ts` 而不是 `railway.json`：
 *   Railway 的 `railway.json` / `railway.toml` 是「单服务部署配置」，只能写 build /
 *   deploy 两段（healthcheckPath、startCommand、restartPolicyType 等），**无法**描述
 *   多服务、镜像来源（image source）或 volume 挂载。多服务 + 镜像源 + 卷的「配置进仓库」
 *   官方支持的方式是 Infrastructure as Code（`.railway/railway.ts`，导出 defineRailway）。
 *   见 docs：https://docs.railway.com/infrastructure-as-code/reference
 *   因此本批按「Railway 配置进仓库」的决议，落到 IaC 文件而非 railway.json。
 *
 * 方案 Y 拓扑：对外域名绑 Vercel（前端在边缘，不在 Railway）。Railway 只跑三个服务：
 *
 *   Vercel rewrites ──▶ nginx (public)  ──┬─▶ backend  (st/backend 内部分发)
 *                                          └─▶ st-bundle (ST + provision-api + watcher)
 *   backend ──(Railway 内网)──▶ st-bundle:9091  (provision-api，不经过 nginx)
 *
 * ⚠️ 本文件**不创建项目**，只描述 desired state。首次需在 Railway 控制台建好 project +
 *    三个服务（名字必须与下方 service() 第一个参数逐字一致），再 `railway config plan` /
 *    `railway config apply`。密钥类变量在控制台/IaC secret 注入，**不写进本文件**。
 *    各服务完整变量见 ops/env/*.env.production.example。
 *
 * 镜像 tag：通过环境变量注入（apply 时 `GHCR_OWNER=... IMAGE_TAG=sha-xxxxxxx railway ...`）。
 * ============================================================================
 */
import { defineRailway, image, project, service, volume } from 'railway/iac';

// GHCR owner 与镜像 tag 由部署时注入；占位默认仅用于 `railway config plan` 预览。
const OWNER = process.env.GHCR_OWNER ?? '<OWNER>';
const TAG = process.env.IMAGE_TAG ?? 'dev-latest';

const ghcr = (name: string) => image(`ghcr.io/${OWNER}/st-miniapp-${name}:${TAG}`);

// Railway 内网 DNS：<service>.railway.internal。服务名须与 service() 名字一致。
const BACKEND_HOST = 'backend.railway.internal';
const ST_HOST = 'st-bundle.railway.internal';

export default defineRailway(() => {
  // ── st-bundle：SillyTavern + provision-api + watcher（s6 同容器，有状态）──────
  // ST 用户数据持久卷，挂到镜像 VOLUME 路径。
  const stData = volume('st-bundle-data', {
    region: 'us-west2',
    sizeMB: 5120,
  });

  const stBundle = service('st-bundle', {
    source: ghcr('st-backend'),
    // ST 主体监听 8000；watcher health 9090；provision-api 9091（同容器副进程）。
    // Railway healthcheck 命中 ST 根路径（200 = ST 起来了）。
    healthcheck: '/',
    healthcheckTimeout: 300,
    volumeMounts: {
      '/home/node/app/data': stData,
    },
    env: {
      NODE_ENV: 'production',
      DATABASE_ENV: 'production',
      // ST 数据目录（== 镜像 VOLUME == 上面 volumeMounts 的挂载点）。
      ST_DATA_PATH: '/home/node/app/data',
      // ⚠️ 必须 0.0.0.0：不设则 provision-api 仅绑 127.0.0.1，backend 跨服务调不到。
      PROVISION_API_BIND_HOST: '0.0.0.0',
      PROVISION_API_PORT: '9091',
      HEALTH_PORT: '9090',
      // ST 的 LLM endpoint → 平台代理（provision 写入 ST settings）。指向 backend 内网。
      LLM_PROXY_URL: `http://${BACKEND_HOST}:3001/api/platform/llm-proxy/v1`,
      CHARACTER_STORAGE_BUCKET: 'character-assets',
      // 密钥（控制台注入，须与 backend 逐字一致）：
      //   ST_USER_PASSWORD_SECRET, LLM_PROXY_TOKEN_SECRET
      // Supabase（控制台注入）：SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (+ PROD_* 组)
      // ST 管理员（控制台注入）：ST_ADMIN_USERNAME, ST_ADMIN_PASSWORD
      // 详见 ops/env/st-bundle.env.production.example
    },
  });

  // ── backend：Fastify 平台 API ────────────────────────────────────────────────
  const backend = service('backend', {
    source: ghcr('backend'),
    healthcheck: '/health',
    healthcheckTimeout: 120,
    env: {
      NODE_ENV: 'production',
      PORT: '3001',
      DATABASE_ENV: 'production',
      // ST 接线（Railway 内网，不经过 nginx）。
      ST_BASE_URL: `http://${ST_HOST}:8000`,
      ST_PROVISION_URL: `http://${ST_HOST}:9091`,
      // LLM 计费上游（key 走密钥）。
      LLM_UPSTREAM_URL: 'https://openrouter.ai/api/v1',
      // CORS：填 Vercel 对外域名（占位，控制台/此处按实际域名改）。
      FRONTEND_URL: 'https://<your-vercel-domain>',
      // 密钥（控制台注入，跨服务一致项见 st-bundle）：
      //   ST_USER_PASSWORD_SECRET, LLM_PROXY_TOKEN_SECRET, LLM_API_KEY
      // Supabase：SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, DIRECT_URL (+ PROD_* 组)
      // TG：TELEGRAM_BOT_TOKEN；支付：PAYMENT_*；可选：UPSTASH_REDIS_REST_*
      // 详见 ops/env/backend.env.production.example
    },
  });

  // ── nginx：仅内部分发网关（唯一对外服务，Vercel rewrites 指向它）──────────────
  const nginx = service('nginx', {
    source: ghcr('nginx'),
    healthcheck: '/nginx-health',
    healthcheckTimeout: 60,
    env: {
      // envsubst 注入 upstream（见 ops/nginx/nginx.conf 模板）。
      BACKEND_UPSTREAM: `${BACKEND_HOST}:3001`,
      ST_UPSTREAM: `${ST_HOST}:8000`,
    },
  });

  return project('st-miniapp', {
    resources: [nginx, backend, stBundle, stData],
  });
});
