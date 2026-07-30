import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withSentryConfig } from '@sentry/nextjs';

// Dev: Next.js proxies ST paths so the iframe is same-origin (avoids X-Frame-Options
//   block). Enabled ONLY when ST_LOCAL_URL is set (local dev).
// Prod (scheme Y): Vercel is the edge entry. ST-bound paths are rewritten to the
//   Railway nginx gateway (ST_PUBLIC_PROXY_URL); nginx then dispatches ST vs backend.
//   Enabled ONLY when ST_PUBLIC_PROXY_URL is set (Vercel env var).
// The two are mutually exclusive by environment: local dev sets ST_LOCAL_URL only,
// production (Vercel) sets ST_PUBLIC_PROXY_URL only. If both were set, prod wins.
const stUrl = process.env.ST_LOCAL_URL;
const stProxyUrl = (
  process.env.NEXT_PUBLIC_ST_PROXY_URL || process.env.ST_PUBLIC_PROXY_URL
)?.replace(/\/+$/, '');

// ST static-asset + user-data root prefixes. ST's index.html declares <base href="/">,
// so every ST asset is requested at the ROOT path (never under /tavern). These mirror
// the ST-bound prefixes enumerated in ops/nginx/nginx.conf (Layer 3).
const ST_ROOT_PREFIXES = [
  // 发布级资产命名空间：st-bundle 构建时把 <base href> 注入为 /st-runtime/<build>/，
  // ST 模块图整体走该前缀（nginx 剥前缀后按原有分档转发）。
  'st-runtime',
  'scripts',
  'css',
  'img',
  'lib',
  'locales',
  'sounds',
  'webfonts',
  'backgrounds',
  'characters',
  'assets',
  'user',
  'thumbnail',
];
// ST top-level root files (ops/nginx/nginx.conf Layer 3, exact matches).
const ST_ROOT_FILES = [
  'csrf-token',
  'version',
  'favicon.ico',
  'manifest.json',
  'style.css',
  'script.js',
  'lib.js',
  'robots.txt',
  'login.html',
  // ST 多用户登录页：未认证时 ST 302 → /login（无 .html）。须随 ST 资源转发到网关，
  // 否则 Vercel 当作自身页面 → 404（与 ops/nginx/nginx.conf 的 `location = /login` 对应）。
  'login',
  'st.ico',
  'st-launcher.ico',
];

// Production rewrites forwarding ST traffic to the Railway nginx gateway.
function prodStRewrites() {
  return {
    // beforeFiles: ST iframe entry + ST static/root assets. These never collide with
    // Vercel's own pages, so forwarding them ahead of the filesystem lookup is safe and
    // gives ST assets top priority.
    beforeFiles: [
      // ST iframe entry. EXACT only — /tavern/<UUID> is the Vercel dialog page
      // (/tavern/[characterId]) and must NOT be forwarded.
      { source: '/tavern', destination: `${stProxyUrl}/tavern` },
      { source: '/tavern/', destination: `${stProxyUrl}/tavern/` },
      // ST static + user-data root prefixes.
      ...ST_ROOT_PREFIXES.map((p) => ({
        source: `/${p}/:path*`,
        destination: `${stProxyUrl}/${p}/:path*`,
      })),
      // /User Avatars/* — ST serves it URL-encoded (with the %20 space).
      { source: '/User%20Avatars/:path*', destination: `${stProxyUrl}/User%20Avatars/:path*` },
      // ST root files.
      ...ST_ROOT_FILES.map((f) => ({
        source: `/${f}`,
        destination: `${stProxyUrl}/${f}`,
      })),
    ],
    // afterFiles: catch-all /api/* → nginx (which splits ST-native vs backend, incl.
    // /api/platform/* → backend). Deliberately in afterFiles, NOT beforeFiles, so the
    // frontend's own concrete route handler /api/init-st-session (resolved in the
    // filesystem phase) wins and is never rewritten.
    // ⚠️ 新增 app/api/* 路由前，须确认其路径不与 SillyTavern 原生 /api/* 冲突：
    //    本兜底把所有未被前端 route handler 命中的 /api/* 转发到 ST 网关，新增的前端
    //    API 路由只有在「文件系统阶段」先命中时才不会被这里劫持。命名与 ST 原生
    //    /api/* 撞车会导致本应转发到 ST 的请求被前端拦截（或反之），排查困难。
    afterFiles: [{ source: '/api/:path*', destination: `${stProxyUrl}/api/:path*` }],
    fallback: [],
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const sentryRelease = process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA;
const hasSentryUploadConfig = Boolean(
  process.env.SENTRY_ORG && process.env.SENTRY_PROJECT && process.env.SENTRY_AUTH_TOKEN
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // M4 容器化：产出 .next/standalone 自包含运行时（含 server.js + 最小 node_modules）。
  output: 'standalone',
  // monorepo 下必须显式指定 trace root 到仓库根（packages/frontend 上两级），
  // 否则 standalone 文件追踪可能漏掉 workspace 依赖（@miniapp/shared 等）。
  experimental: {
    outputFileTracingRoot: join(__dirname, '../..'),
  },
  transpilePackages: ['@miniapp/shared', '@miniapp/bridge-protocol'],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  async rewrites() {
    // Production (Vercel, scheme Y): forward ST paths to the Railway nginx gateway.
    if (stProxyUrl) return prodStRewrites();
    // Local dev: proxy everything ST needs to the local ST instance.
    if (!stUrl) return [];
    return {
      beforeFiles: [],
      afterFiles: [],
      // fallback: only matched when NO page/public-file/dynamic-route matches.
      // /tavern/[characterId] page takes priority; /tavern/ falls through here.
      fallback: [
        { source: '/tavern', destination: `${stUrl}/` },
        { source: '/tavern/', destination: `${stUrl}/` },
        // ST static assets + API (scripts/, css/, img/, api/, etc.)
        { source: '/:path*', destination: `${stUrl}/:path*` },
      ],
    };
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
