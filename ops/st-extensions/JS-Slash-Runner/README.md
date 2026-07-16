# JS-Slash-Runner（酒馆助手）pin 快照

> 受 git 跟踪的**运行产物快照**。由 `scripts/install-st-extension.mjs` 幂等安装到
> `vendor/sillytavern/public/scripts/extensions/third-party/JS-Slash-Runner/`
> （vendor 的 third-party 被 .gitignore 忽略，约定为「产物/脚本安装」，不入库）。

## Pin 版本

- 扩展：`N0VI028/JS-Slash-Runner`
- 版本：**v4.8.7**（见 `manifest.json` 的 `version`）
- 来源：本地已验证可跑的一份拷贝
  `/Users/qj/python_project/SillyTavern-latest/public/scripts/extensions/third-party/JS-Slash-Runner/`

## 平台补丁（2026-07-16，iframe 冷启动长尾治理）

上游快照在此基础上打了 **3 处受控补丁**（均只改本快照，不碰 `vendor/sillytavern/`），
目的：消除冷启动/渲染路径上的公网外联与首装下载成本。回滚方式 = 用「升级方式」重新出一份
干净快照覆盖本目录。

### P1. 摘除 gitlab.com 版本检查（`bundle/index.js`）

- 上游在设置面板两个 Vue 组件 mounted 时无条件 fetch
  `gitlab.com/api/v4/.../manifest.json`（拉最新版本号），约 1/3 冷启动窗口内出现（大陆网络不稳）。
- 补丁：拉版本号的函数改为直接返回本地版本（`[miniapp-patch]` 注释标记），
  版本比较恒为「无更新」，零网络请求。「检查更新」UI 显示当前即最新。
- CHANGELOG 拉取（用户点开更新弹窗才触发）未改动。

### P2. 消息渲染 iframe 的 jsdelivr 依赖本地化（`bundle/index.js` + `lib/vendor/`）

- 上游 script-iframe HTML 模板从 `testingcf.jsdelivr.net` 拉 8 个**未锁版本**资源，
  带酒馆助手脚本的角色卡每次渲染都打公网 CDN（冷启动瀑布 22/200 出现，长尾来源）。
- 补丁：8 个 URL 全部替换为 `/scripts/extensions/third-party/JS-Slash-Runner/lib/vendor/...`
  （与上游模板里 tailwindcss.min.js 的本地绝对路径写法一致），文件下载进 `lib/vendor/` 锁版本：

| 文件                                                                   | 锁定版本（下载时 jsdelivr latest，2026-07-16） |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| `vue.runtime.global.prod.min.js`                                       | vue 3.5.39                                     |
| `vue-router.global.prod.min.js`                                        | vue-router 5.2.0                               |
| `jquery.min.js`                                                        | jquery 4.0.0                                   |
| `jquery-ui.min.js` / `jquery-ui.theme.min.css`                         | jquery-ui 1.14.2                               |
| `jquery.ui.touch-punch.min.js`                                         | 0.2.3                                          |
| `log.js`                                                               | gh N0VI028/JS-Slash-Runner main                |
| `fontawesome/css/all.min.css` + `fontawesome/webfonts/*.woff2`（4 个） | fontawesome-free 7.3.1                         |

- 设置面板「内置脚本库」里的 `gh/StageDog/tavern_resource` 链接（用户手动安装脚本时才拉）**未改动**。

### P3. `lib/jsoneditor.js` minify（1.97MB → 1.22MB）

- 该文件被 `bundle/index.js` 顶部静态 import，处于 activateExtensions 关键路径，
  首装（无缓存）用户必须下载+解析完才结束扩展窗口。
- 用 esbuild `--minify --format=esm --target=es2020` 处理，语义不变；
  已校验 minify 前后 90 个导出符号完全一致（含 `Mode` / `createJSONEditor` / `ValidationSeverity`）。
- 重新生成：`node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild lib/jsoneditor.js --minify --format=esm --target=es2020 --charset=utf8 --legal-comments=none --outfile=lib/jsoneditor.js`（先对干净上游副本执行）。

## 快照内容（仅运行文件，~2.6MB）

| 快照路径                 | 安装后路径（vendor）     | 说明                                                                                                         |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `manifest.json`          | `manifest.json`          | 扩展清单（引用 `dist/index.js`、`dist/index.css`、`i18n/en.json`）                                           |
| `bundle/index.js`        | `dist/index.js`          | 主 bundle（1.08MB）                                                                                          |
| `bundle/index.css`       | `dist/index.css`         | 样式（88KB）                                                                                                 |
| `i18n/en.json`           | `i18n/en.json`           | 英文 i18n                                                                                                    |
| `lib/jsoneditor.js`      | `lib/jsoneditor.js`      | **硬依赖**：`dist/index.js` 静态 `import '../lib/jsoneditor.js'`，缺失则整个扩展加载失败（已 minify，见 P3） |
| `lib/tailwindcss.min.js` | `lib/tailwindcss.min.js` | **硬依赖**：render 把它按绝对路径注入消息渲染 iframe（`.../JS-Slash-Runner/lib/tailwindcss.min.js`）         |
| `lib/vendor/*`           | `lib/vendor/*`           | **硬依赖**：消息渲染 iframe 的本地化 CDN 依赖（见 P2），缺失则带脚本的角色卡渲染失败                         |

注：`speakingurl` 等其它依赖已**内联**进 `bundle/index.js`，无需单独文件。

## 为什么 `bundle/` 而不是 `dist/`

仓库根 `.dockerignore` 含 `**/dist`、`**/node_modules`。若快照里直接放名为 `dist/` 的目录，
会被 Docker 构建上下文整体剔除（`builder-ext` 阶段拿不到 `index.js/css`）。故快照里把两个
bundle 文件放在 `bundle/`，安装脚本在落地时映射到 vendor 的 `dist/`（manifest 仍引用 `dist/`，无需改）。

## 不入库的开发态（已剔除）

`src/ .git/ @types/ dist/index.js.map(4.5MB) dist/@types*(.txt/.zip) package.json
pnpm-lock.yaml vite/tailwind/tsconfig/eslint 等配置`。

## 升级方式

1. 在某处装好目标版本（或从 GitHub pin tag 出 dist）。
2. 用同样的映射覆盖本目录的 6 个文件，更新 `manifest.json` 的 `version` 与本 README。
3. 跑 `pnpm st-ext:install` 重新落地到 vendor，重启 ST + 浏览器硬刷新验证。
