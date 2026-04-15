/** @type {import('next').NextConfig} */
const nextConfig = {
    // 关键配置：让 Next.js 编译 shared 包的 TypeScript 源码
    transpilePackages: ['@miniapp/shared'],
  };
  
  export default nextConfig;