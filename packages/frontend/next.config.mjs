import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withSentryConfig } from '@sentry/nextjs';
import { resolvePublicApiUrl } from './resolve-public-api-url.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sentryRelease = process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA;
// All browser observability describes this build, including the legacy diagnostic report.
const telemetryRelease =
  process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.NEXT_PUBLIC_GRAFANA_RELEASE ||
  sentryRelease ||
  '';
process.env.NEXT_PUBLIC_GRAFANA_RELEASE = telemetryRelease;
process.env.NEXT_PUBLIC_DRAMA_RELEASE = telemetryRelease || 'unknown';
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
    NEXT_PUBLIC_DRAMA_RELEASE: telemetryRelease || 'unknown',
    NEXT_PUBLIC_GRAFANA_RELEASE: telemetryRelease,
  },
  // M4 容器化：产出 .next/standalone 自包含运行时（含 server.js + 最小 node_modules）。
  output: 'standalone',
  // monorepo 下必须显式指定 trace root 到仓库根（packages/frontend 上两级），
  // 否则 standalone 文件追踪可能漏掉 workspace 依赖（@miniapp/shared 等）。
  experimental: {
    outputFileTracingRoot: join(__dirname, '../..'),
  },
  transpilePackages: ['@miniapp/shared', '@miniapp/reply-renderer'],
  // 冷启动落地页：有对话记录的用户进「对话」，其余进角色大厅。cookie 由前端读到会话后写入
  // （src/lib/landing-route.ts，名称与取值须一致）。按顺序匹配，第一条命中即跳。
  // query 原样透传，Telegram 放在 hash 里的 tgWebAppData 由浏览器在跳转后保留。用 307 而非 308，避免客户端缓存永久跳转。
  async redirects() {
    return [
      {
        source: '/',
        has: [{ type: 'cookie', key: 'st_landing', value: 'chats' }],
        destination: '/chats',
        permanent: false,
      },
      { source: '/', destination: '/characters', permanent: false },
    ];
  },
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
