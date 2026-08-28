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
 * ST 退场后 nginx 已无分发对象，st-bundle 整包退场；Railway 运行 backend API 和
 * 两个无公网入口的支付 Cron。三个服务都跟随同一 GitHub 分支自动部署：
 *
 *   浏览器 ──▶ Vercel (页面) ──▶ stminiapp (backend, 对外域名) ──▶ Supabase / OpenRouter
 *                                      ▲
 *   Railway Cron ──▶ stminiapp-payment-cron（每 5 分钟运行一次后退出）
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
 * ============================================================================
 */
import { defineRailway, fn, github, preserve, project, service } from 'railway/iac';

const REPOSITORY = process.env.RAILWAY_GITHUB_REPO ?? 'linshu368/ST_miniapp';
const COMMON_API_VARIABLES = [
  'ADMIN_PLATFORM_URL',
  'BOT_INTERNAL_SECRET',
  'CS_ADMIN_TOKEN',
  'CS_TELEGRAM_BOT_TOKEN',
  'CS_TELEGRAM_WEBHOOK_SECRET',
  'DATABASE_ENV',
  'DATABASE_URL',
  'DEEPSEEK_API_KEY',
  'DEFAULT_LLM_MODEL',
  'DIRECT_URL',
  'FRONTEND_URL',
  'LLM_API_KEY',
  'MINIMAX_API_KEY',
  'NODE_ENV',
  'OPENAI_API_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'PAYMENT_BASE_URL',
  'PAYMENT_ENABLED',
  'PAYMENT_MERCHANT_ID',
  'PAYMENT_MERCHANT_PRIVATE_KEY',
  'PAYMENT_NOTIFY_URL',
  'PAYMENT_PLATFORM_PUBLIC_KEY',
  'PAYMENT_RETURN_URL',
  'PROD_SUPABASE_PROJECT_REF',
  'SENTRY_DSN',
  'SENTRY_ENVIRONMENT',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'UPSTASH_REDIS_REST_TOKEN',
  'UPSTASH_REDIS_REST_URL',
] as const;
const DEVELOPMENT_API_VARIABLES = [
  'DEV_AUTH_BYPASS',
  'MOCK_AUTH',
  'TEST_DATABASE_URL',
  'TEST_DIRECT_URL',
  'TEST_SUPABASE_PROJECT_REF',
  'TEST_SUPABASE_SERVICE_ROLE_KEY',
  'TEST_SUPABASE_URL',
] as const;
const PRODUCTION_API_VARIABLES = [
  'CS_PLATFORM_URL',
  'DEFAULT_USER_AVATAR_URL',
  'LLM_DEFAULT_MODEL',
  'LLM_PROXY_TOKEN_SECRET',
  'LLM_UPSTREAM_URL',
  'MINIAPP_SHORT_NAME',
  'PAYMENT_GATEWAY',
  'PAYMENT_MERCHANT_KEY',
  'PAYMENT_V2_BASE_URL',
  'PORT',
  'PROD_DATABASE_URL',
  'PROD_DIRECT_URL',
  'PROD_SUPABASE_SERVICE_ROLE_KEY',
  'PROD_SUPABASE_URL',
  'ST_BASE_URL',
  'ST_PROVISION_URL',
  'ST_USER_PASSWORD_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_URL',
] as const;

export default defineRailway((ctx) => {
  // Railway CLI 5.43 的内置 TypeScript runner 尚未稳定传入 ctx.environment；
  // production plan/apply 必须显式设置 RAILWAY_CONFIG_ENV=production，避免误按 dev 渲染。
  const targetEnvironment =
    process.env.RAILWAY_CONFIG_ENV ?? ctx.environment ?? ctx.environmentName ?? 'development';
  const production = targetEnvironment === 'production';
  const branch = production ? 'main' : 'dev';

  // ── backend（Railway 服务名：stminiapp）：Fastify 平台 API，唯一对外服务 ───────
  // preserve() 只声明现有变量归 IaC 管理但不读取/覆盖其值；新增变量时须同步补入清单，
  // 否则 plan 会显示删除。域名、region 和 deploy 默认值保持由 Railway 控制台管理。
  const apiVariableNames = [
    ...COMMON_API_VARIABLES,
    ...(production ? PRODUCTION_API_VARIABLES : DEVELOPMENT_API_VARIABLES),
  ];
  const stminiapp = service('stminiapp', {
    source: github(REPOSITORY, { branch, checkSuites: false }),
    build: {
      builder: 'DOCKERFILE',
      buildCommand: 'pnpm install',
      buildEnvironment: 'V3',
      dockerfilePath: '/ops/docker/Dockerfile.backend',
    },
    env: Object.fromEntries(apiVariableNames.map((name) => [name, preserve()])),
  });

  // ── 支付 Cron：独立一次性进程，禁止把 schedule 配到 HTTP API 服务 ────────────
  // 两个任务与 API 使用同一分支和变量：快速任务每分钟查近期订单，过期任务每 5 分钟
  // 回溯并判过期。都不提供公网入口。
  const paymentCronEnv = {
    NODE_ENV: stminiapp.env.NODE_ENV,
    DATABASE_ENV: stminiapp.env.DATABASE_ENV,
    DATABASE_URL: stminiapp.env.DATABASE_URL,
    DIRECT_URL: stminiapp.env.DIRECT_URL,
    PROD_SUPABASE_PROJECT_REF: stminiapp.env.PROD_SUPABASE_PROJECT_REF,
    ...(production
      ? {
          PROD_DATABASE_URL: stminiapp.env.PROD_DATABASE_URL,
          PROD_DIRECT_URL: stminiapp.env.PROD_DIRECT_URL,
          PROD_SUPABASE_URL: stminiapp.env.PROD_SUPABASE_URL,
          PROD_SUPABASE_SERVICE_ROLE_KEY: stminiapp.env.PROD_SUPABASE_SERVICE_ROLE_KEY,
        }
      : {
          TEST_DATABASE_URL: stminiapp.env.TEST_DATABASE_URL,
          TEST_DIRECT_URL: stminiapp.env.TEST_DIRECT_URL,
          TEST_SUPABASE_URL: stminiapp.env.TEST_SUPABASE_URL,
          TEST_SUPABASE_SERVICE_ROLE_KEY: stminiapp.env.TEST_SUPABASE_SERVICE_ROLE_KEY,
          TEST_SUPABASE_PROJECT_REF: stminiapp.env.TEST_SUPABASE_PROJECT_REF,
        }),
    PAYMENT_ENABLED: stminiapp.env.PAYMENT_ENABLED,
    PAYMENT_BASE_URL: stminiapp.env.PAYMENT_BASE_URL,
    PAYMENT_MERCHANT_ID: stminiapp.env.PAYMENT_MERCHANT_ID,
    PAYMENT_MERCHANT_PRIVATE_KEY: stminiapp.env.PAYMENT_MERCHANT_PRIVATE_KEY,
    PAYMENT_PLATFORM_PUBLIC_KEY: stminiapp.env.PAYMENT_PLATFORM_PUBLIC_KEY,
    PAYMENT_NOTIFY_URL: stminiapp.env.PAYMENT_NOTIFY_URL,
    PAYMENT_RETURN_URL: stminiapp.env.PAYMENT_RETURN_URL,
  };

  const paymentReconcileCron = fn('stminiapp-payment-reconcile-cron', {
    source: github(REPOSITORY, { branch }),
    build: {
      builder: 'DOCKERFILE',
      buildCommand: 'pnpm install',
      buildEnvironment: 'V3',
      dockerfilePath: '/ops/docker/Dockerfile.backend',
    },
    start: 'tsx src/scripts/reconcile-payment-orders.ts',
    deploy: {
      cronSchedule: '* * * * *',
      restartPolicyType: 'NEVER',
    },
    env: paymentCronEnv,
  });

  const paymentCron = fn('stminiapp-payment-cron', {
    source: github(REPOSITORY, { branch }),
    build: {
      builder: 'DOCKERFILE',
      buildCommand: 'pnpm install',
      buildEnvironment: 'V3',
      dockerfilePath: '/ops/docker/Dockerfile.backend',
    },
    start: 'tsx src/scripts/expire-payment-orders.ts',
    deploy: {
      cronSchedule: '*/5 * * * *',
      restartPolicyType: 'NEVER',
    },
    env: paymentCronEnv,
  });

  return project('st-miniapp', {
    resources: [stminiapp, paymentReconcileCron, paymentCron],
  });
});
