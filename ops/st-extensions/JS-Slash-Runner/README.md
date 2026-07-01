# JS-Slash-Runner（酒馆助手）pin 快照

> 受 git 跟踪的**运行产物快照**。由 `scripts/install-st-extension.mjs` 幂等安装到
> `vendor/sillytavern/public/scripts/extensions/third-party/JS-Slash-Runner/`
> （vendor 的 third-party 被 .gitignore 忽略，约定为「产物/脚本安装」，不入库）。

## Pin 版本

- 扩展：`N0VI028/JS-Slash-Runner`
- 版本：**v4.8.7**（见 `manifest.json` 的 `version`）
- 来源：本地已验证可跑的一份拷贝
  `/Users/qj/python_project/SillyTavern-latest/public/scripts/extensions/third-party/JS-Slash-Runner/`

## 快照内容（仅运行文件，~2.6MB）

| 快照路径                 | 安装后路径（vendor）     | 说明                                                                                                 |
| ------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `manifest.json`          | `manifest.json`          | 扩展清单（引用 `dist/index.js`、`dist/index.css`、`i18n/en.json`）                                   |
| `bundle/index.js`        | `dist/index.js`          | 主 bundle（1.08MB）                                                                                  |
| `bundle/index.css`       | `dist/index.css`         | 样式（88KB）                                                                                         |
| `i18n/en.json`           | `i18n/en.json`           | 英文 i18n                                                                                            |
| `lib/jsoneditor.js`      | `lib/jsoneditor.js`      | **硬依赖**：`dist/index.js` 静态 `import '../lib/jsoneditor.js'`，缺失则整个扩展加载失败             |
| `lib/tailwindcss.min.js` | `lib/tailwindcss.min.js` | **硬依赖**：render 把它按绝对路径注入消息渲染 iframe（`.../JS-Slash-Runner/lib/tailwindcss.min.js`） |

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
