import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 之前没有这个文件，因为已有的测试都只引相对路径。自研聊天链路的模块要引 `@/`，
// 而 vitest 不读 tsconfig 的 paths，别名得在这里显式给一份。
// Node单测也会检查组件的静态状态；Next的jsx:preserve需在这里转成自动JSX运行时。
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
