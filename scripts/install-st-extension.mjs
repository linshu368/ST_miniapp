#!/usr/bin/env node
/**
 * install-st-extension.mjs
 *
 * 把 `ops/st-extensions/<name>/` 下「受 git 跟踪的运行产物快照」幂等安装到
 * `vendor/sillytavern/public/scripts/extensions/third-party/<name>/`。
 *
 * - 纯 node:fs，无第三方依赖（本地 dev 与 Docker builder-ext 共用，免 tsx）。
 * - 幂等：每次先清空目标目录再拷贝。
 * - 映射：快照里的 `bundle/` 目录落地为 vendor 的 `dist/`
 *   （规避仓库根 .dockerignore 的 `**\/dist` 把构建上下文里的 dist 剔除）。
 * - 若 `vendor/sillytavern` 尚未 vendoring，打印警告并 exit 0（仿 st-extension postbuild）。
 *
 * 用法：node scripts/install-st-extension.mjs
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SNAPSHOT_ROOT = resolve(REPO_ROOT, 'ops/st-extensions');
const VENDOR_ROOT = resolve(REPO_ROOT, 'vendor/sillytavern');
const THIRD_PARTY_ROOT = resolve(VENDOR_ROOT, 'public/scripts/extensions/third-party');

/** 快照里这些条目不应落地到 vendor。 */
const SKIP_ENTRIES = new Set(['README.md']);
/** 已从平台完全下线的扩展；安装时同时清理 vendor 中可能残留的旧副本。 */
const DISABLED_EXTENSIONS = new Set(['MoonlitEchoesTheme']);
/** 快照里的这个目录在落地时重命名（绕开 .dockerignore 的 **\/dist）。 */
const RENAME_DIRS = { bundle: 'dist' };

/** 每个扩展安装后必须存在的关键文件（构建期/本地断言）。 */
const REQUIRED_FILES = {
  'JS-Slash-Runner': [
    'manifest.json',
    'dist/index.js',
    'dist/index.css',
    'lib/jsoneditor.js',
    'lib/tailwindcss.min.js',
    // 消息渲染 iframe 的本地化 CDN 依赖（快照 README「平台补丁 P2」）
    'lib/vendor/vue.runtime.global.prod.min.js',
    'lib/vendor/vue-router.global.prod.min.js',
    'lib/vendor/jquery.min.js',
    'lib/vendor/jquery-ui.min.js',
    'lib/vendor/jquery-ui.theme.min.css',
    'lib/vendor/jquery.ui.touch-punch.min.js',
    'lib/vendor/log.js',
    'lib/vendor/fontawesome/css/all.min.css',
    'lib/vendor/fontawesome/webfonts/fa-solid-900.woff2',
  ],
};

function installOne(name) {
  const srcDir = resolve(SNAPSHOT_ROOT, name);
  const dstDir = resolve(THIRD_PARTY_ROOT, name);

  rmSync(dstDir, { recursive: true, force: true });
  mkdirSync(dstDir, { recursive: true });

  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (SKIP_ENTRIES.has(entry.name)) continue;
    const from = resolve(srcDir, entry.name);
    const toName = RENAME_DIRS[entry.name] ?? entry.name;
    const to = resolve(dstDir, toName);
    cpSync(from, to, { recursive: true });
  }

  const required = REQUIRED_FILES[name] ?? ['manifest.json'];
  const missing = required.filter((rel) => !existsSync(resolve(dstDir, rel)));
  if (missing.length > 0) {
    console.error(`❌ st-extension "${name}" 安装后缺少关键文件: ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log(`✅ installed st-extension "${name}" → ${dstDir}`);
}

function main() {
  if (!existsSync(SNAPSHOT_ROOT)) {
    console.warn(`⚠️  ${SNAPSHOT_ROOT} 不存在，跳过 st-extension 安装。`);
    process.exit(0);
  }
  if (!existsSync(VENDOR_ROOT)) {
    console.warn('⚠️  vendor/sillytavern/ 不存在 — 跳过 st-extension 安装（先完成 vendoring）。');
    process.exit(0);
  }
  mkdirSync(THIRD_PARTY_ROOT, { recursive: true });

  for (const name of DISABLED_EXTENSIONS) {
    rmSync(resolve(THIRD_PARTY_ROOT, name), { recursive: true, force: true });
  }

  const names = readdirSync(SNAPSHOT_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !DISABLED_EXTENSIONS.has(e.name))
    .map((e) => e.name);

  if (names.length === 0) {
    console.warn(`⚠️  ${SNAPSHOT_ROOT} 下没有扩展快照，无事可做。`);
    process.exit(0);
  }

  for (const name of names) {
    installOne(name);
  }
}

main();
