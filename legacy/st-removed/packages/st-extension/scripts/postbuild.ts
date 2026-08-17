/**
 * postbuild — 将构建产物 + manifest 拷贝到 ST 扩展目录。
 * 若 vendor/sillytavern/ 尚未 vendoring，跳过并打印警告。
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const DIST_DIR = resolve(PKG_ROOT, 'dist');
const MANIFEST = resolve(PKG_ROOT, 'manifest.json');
const TARGET_DIR = resolve(
  PKG_ROOT,
  '../../vendor/sillytavern/public/scripts/extensions/third-party/miniapp-bridge'
);

if (!existsSync(resolve(PKG_ROOT, '../../vendor/sillytavern'))) {
  console.warn(
    '⚠️  vendor/sillytavern/ not found — skipping postbuild copy. Run T1 vendoring first.'
  );
  process.exit(0);
}

mkdirSync(TARGET_DIR, { recursive: true });

cpSync(DIST_DIR, TARGET_DIR, { recursive: true });
cpSync(MANIFEST, resolve(TARGET_DIR, 'manifest.json'));

console.log(`✅ st-extension build artifacts copied to ${TARGET_DIR}`);
