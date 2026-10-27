import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withSentryConfig } from '@sentry/nextjs';
import { resolvePublicApiUrl } from './resolve-public-api-url.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sentryRelease = process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA;
const hasSentryUploadConfig = Boolean(
  process.env.SENTRY_ORG && process.env.SENTRY_PROJECT && process.env.SENTRY_AUTH_TOKEN
);

const publicApiUrl = resolvePublicApiUrl();
// Next 不会覆盖 Vercel 已注入的 NEXT_PUBLIC_*，必须先写回 process.env 才能内联进 bundle。
process.env.NEXT_PUBLIC_API_URL = publicApiUrl;

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Local UI tooling uses its own cache so a preview never overwrites a normal build.
  ...(process.env.NODE_ENV === 'development' && process.env.ST_UI_PREVIEW_MODE
    ? {
        distDir: process.env.ST_UI_PREVIEW_MODE === 'test' ? '.next-ui-test' : '.next-ui-preview',
        typescript: { tsconfigPath: 'tsconfig.ui-preview.json' },
      }
    : {}),
  env: {
    NEXT_PUBLIC_API_URL: publicApiUrl,
    NEXT_PUBLIC_DRAMA_RELEASE: process.env.VERCEL_GIT_COMMIT_SHA || sentryRelease || 'unknown',
  },
  // M4 容器化：产出 .next/standalone 自包含运行时（含 server.js + 最小 node_modules）。
  output: 'standalone',
  // monorepo 下必须显式指定 trace root 到仓库根（packages/frontend 上两级），
  // 否则 standalone 文件追踪可能漏掉 workspace 依赖（@miniapp/shared 等）。
  experimental: {
    outputFileTracingRoot: join(__dirname, '../..'),
  },
  transpilePackages: ['@miniapp/shared', '@miniapp/reply-renderer'],
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
