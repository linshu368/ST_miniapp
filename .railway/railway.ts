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
 * 方案 Y 拓扑（网关收敛后）：对外域名绑 Vercel（前端在边缘，不在 Railway）。
 * ST 退场后 nginx 已无分发对象，st-bundle 整包退场，Railway 只剩 backend 一个服务：
 *
 *   浏览器 ──▶ Vercel (页面) ──▶ stminiapp (backend, 对外域名) ──▶ Supabase / OpenRouter
 *
 * 前端通过 build 期固化的 NEXT_PUBLIC_API_URL 直连 backend 的 Railway 公网域名，
 * 没有中间反代；跨域由 backend 的 FRONTEND_URL（CORS allow-origin）放行。
 *
 * ⚠️ backend 服务在 Railway 控制台实际命名为 `stminiapp`（内网域名
 *    stminiapp.railway.internal，监听 8080）。服务名仅决定内网 DNS，不与任何应用
 *    代码耦合（代码只通过 env 读取地址/端口）。本文件已与该实际命名/端口对齐。
 *    收敛后它是**唯一对外服务**，需在 Settings → Networking 绑好域名。
 *
 * ⚠️ 本文件**不创建项目**，只描述 desired state。首次需在 Railway 控制台建好 project +
 *    该服务（名字必须与下方 service() 第一个参数逐字一致），再 `railway config plan` /
 *    `railway config apply`。密钥类变量在控制台/IaC secret 注入，**不写进本文件**。
 *    完整变量见 ops/env/backend.env.production.example。
 *
 * ⚠️ backend 服务在 development / production 两个环境同名 `stminiapp`。原先 dev/prod
 *    需加 `-pro` 后缀区分的 `nginx` / `st-bundle` 已退场，命名差异问题随之消失。
 *    Railway 控制台里遗留的 nginx-pro / st-bundle-pro / st-data-pro 需手动删除，
 *    见 ops/railway/README.md「网关收敛的手动收尾」。
 *
 * 镜像 tag：通过环境变量注入（apply 时 `GHCR_OWNER=... IMAGE_TAG=sha-xxxxxxx railway ...`）。
 * ============================================================================
 */
import { defineRailway, image, project, service } from 'railway/iac';

// GHCR owner 与镜像 tag 由部署时注入；占位默认仅用于 `railway config plan` 预览。
const OWNER = process.env.GHCR_OWNER ?? '<OWNER>';
const TAG = process.env.IMAGE_TAG ?? 'dev-latest';

const ghcr = (name: string) => image(`ghcr.io/${OWNER}/st-miniapp-${name}:${TAG}`);

// backend 监听端口。收敛为单服务后已无跨服务 upstream 需要与它对齐，只需与 Railway
// 控制台 stminiapp 的 PORT 一致（Railway 据此把公网域名路由到容器）。
const BACKEND_PORT = '8080';

export default defineRailway(() => {
  // ── backend（Railway 服务名：stminiapp）：Fastify 平台 API，唯一对外服务 ───────
  // 服务名为 `stminiapp`（内网 stminiapp.railway.internal），镜像产物仍是
  // st-miniapp-backend；服务名不与应用代码耦合（代码仅通过 env 读取地址/端口）。
  const stminiapp = service('stminiapp', {
    source: ghcr('backend'),
    healthcheck: '/health',
    healthcheckTimeout: 120,
    env: {
      NODE_ENV: 'production',
      PORT: BACKEND_PORT,
      DATABASE_ENV: 'production',
      // LLM 计费上游（key 走密钥）。
      LLM_UPSTREAM_URL: 'https://openrouter.ai/api/v1',
      // CORS allow-origin：填 Vercel 对外域名（占位，控制台/此处按实际域名改）。
      // 收敛后前端直连本服务，此项配错会让浏览器侧全部请求被 CORS 拦掉。
      FRONTEND_URL: 'https://<your-vercel-domain>',
      // 密钥（控制台注入）：LLM_API_KEY
      // Supabase：SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, DIRECT_URL (+ PROD_* 组)
      // TG：TELEGRAM_BOT_TOKEN；支付：PAYMENT_*；可选：UPSTASH_REDIS_REST_*
      // 详见 ops/env/backend.env.production.example
    },
  });

  return project('st-miniapp', {
    resources: [stminiapp],
  });
});
