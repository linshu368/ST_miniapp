import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 之前没有这个文件，因为已有的测试都只引相对路径。自研聊天链路的模块要引 `@/`，
// 而 vitest 不读 tsconfig 的 paths，别名得在这里显式给一份。
// 其余一律沿用 vitest 默认值，避免改动既有 11 个测试文件的发现与执行方式。
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
