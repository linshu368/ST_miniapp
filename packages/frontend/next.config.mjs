/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@miniapp/shared', '@miniapp/bridge-protocol'],
  webpack: (config) => {
    // bridge-protocol uses TypeScript ESM convention (.js extensions in imports)
    // but the actual source files are .ts — tell webpack how to resolve them.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
