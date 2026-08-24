import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withSentryConfig } from '@sentry/nextjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sentryRelease = process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA;
const hasSentryUploadConfig = Boolean(
  process.env.SENTRY_ORG && process.env.SENTRY_PROJECT && process.env.SENTRY_AUTH_TOKEN
);

/** Preview feature PRs talk to Railway env `pr-{number}` → stminiapp-pr-{n}.up.railway.app */
function resolvePublicApiUrl() {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  const vercelEnv = process.env.VERCEL_ENV;
  const target = process.env.VERCEL_TARGET_ENV;
  const gitRef = process.env.VERCEL_GIT_COMMIT_REF;
  const prId = process.env.VERCEL_GIT_PULL_REQUEST_ID;

  if (vercelEnv === 'production') {
    return configured || 'https://stminiapp-production.up.railway.app';
  }
  if (target === 'dev' || gitRef === 'dev') {
    return configured || 'https://stminiapp-development.up.railway.app';
  }
  if (vercelEnv === 'preview' && prId) {
    return `https://stminiapp-pr-${prId}.up.railway.app`;
  }
  return configured || 'https://stminiapp-development.up.railway.app';
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_API_URL: resolvePublicApiUrl(),
  },
  // M4 容器化：产出 .next/standalone 自包含运行时（含 server.js + 最小 node_modules）。
  output: 'standalone',
  // monorepo 下必须显式指定 trace root 到仓库根（packages/frontend 上两级），
  // 否则 standalone 文件追踪可能漏掉 workspace 依赖（@miniapp/shared 等）。
  experimental: {
    outputFileTracingRoot: join(__dirname, '../..'),
  },
  transpilePackages: ['@miniapp/shared'],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  release: {
    name: sentryRelease,
    create: hasSentryUploadConfig,
  },
  sourcemaps: {
    disable: !hasSentryUploadConfig,
    deleteSourcemapsAfterUpload: true,
  },
  telemetry: false,
  silent: !hasSentryUploadConfig,
  webpack: {
    autoInstrumentServerFunctions: false,
    autoInstrumentMiddleware: false,
    autoInstrumentAppDirectory: false,
    treeshake: {
      removeDebugLogging: true,
      excludeReplayIframe: false,
    },
  },
});
