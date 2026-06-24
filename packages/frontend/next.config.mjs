// Dev: Next.js proxies ST paths so iframe is same-origin (avoids X-Frame-Options block).
// Prod: nginx handles routing; ST_LOCAL_URL is unset → no rewrites.
const stUrl = process.env.ST_LOCAL_URL;

/** @type {import('next').NextConfig} */
const nextConfig = {
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
