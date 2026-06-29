import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Dev: Next.js proxies ST paths so iframe is same-origin (avoids X-Frame-Options block).
// Prod: nginx handles routing; ST_LOCAL_URL is unset → no rewrites.
const stUrl = process.env.ST_LOCAL_URL;

const __dirname = dirname(fileURLToPath(import.meta.url));

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

export default nextConfig;
