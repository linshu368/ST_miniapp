import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/entry.ts'],
  format: ['iife'],
  platform: 'browser',
  outDir: 'dist',
  noExternal: [/.*/],
  globalName: 'MiniAppBridge',
  clean: true,
  sourcemap: false,
  minify: false,
  define: {
    __BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 19)),
    __ST_COMMIT__: JSON.stringify(process.env.ST_COMMIT ?? 'vendored'),
  },
});
