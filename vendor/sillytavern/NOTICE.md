# Vendored SillyTavern

This directory contains a vendored copy of SillyTavern and is treated as **read-only third-party code**.
All customization is done via `packages/st-extension` (injected through ST's extension mechanism).

- Source: https://github.com/SillyTavern/SillyTavern
- Commit: `51ad27fb86d39a3daca3adaa970375c9670c12df`
- Vendored on: 2026-06-23

Do NOT modify files in this directory directly. See ARCHITECTURE.md §1 for details.

## Local patches (miniapp)

本 vendored 副本含以下**受控**本地改动（例外于只读约束，均经 ARCHITECTURE 铁律登记）。
审计：`rg "\[miniapp-patch\]" vendor/sillytavern/`。

| 文件                         | 位置               | 改动                                                                                                                                                                                                                    | 原因                                                                  | 回滚                                                             |
| ---------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| public/script.js             | firstLoadInit 前段 | getClientVersion/initSecrets/readSecretState/initLocales 串行→Promise.all                                                                                                                                               | 冷启动并行化①                                                         | 见 docs/iframe-boot-firstloadinit-parallelization.md §6          |
| public/script.js             | firstLoadInit 后段 | getUserAvatars/getCharacters 串行→Promise.all；移除 boot 期 getBackgrounds 调用（Tier-2）                                                                                                                               | 冷启动并行化①/②                                                       | 同上                                                             |
| public/script.js             | 选角色/新对话路径  | forceNewChat 时跳过旧聊天加载、空文件读取与角色 PNG 指针回写                                                                                                                                                            | 消除重复 H3/H2 IO                                                     | 移除 `skipChatLoad` / `skipChatFetch` / `skipCharacterSave` 分支 |
| public/script.js             | context import     | 使用版本化 st-context URL                                                                                                                                                                                               | 避免新旧模块混用                                                      | 移除 `miniapp_v` 查询参数                                        |
| public/scripts/extensions.js | context import     | 与 script.js 共享版本化 st-context URL                                                                                                                                                                                  | 避免 context 双版本                                                   | 移除 `miniapp_v` 查询参数                                        |
| public/scripts/extensions.js | 扩展资产加载       | script/css/manifest/locale/hook URL 经 import.meta.url 在发布命名空间内解析                                                                                                                                             | 防扩展逃逸出版本化命名空间加载第二份 script.js 实例                   | 还原为绝对 `/scripts/extensions/` 字面量                         |
| public/scripts/extensions.js | 扩展激活           | script/style 元素已存在时 resolve（原实现 promise 永不 settle）                                                                                                                                                         | 防重复激活挂死 boot                                                   | 移除 else resolve 分支                                           |
| public/scripts/\*（16 文件） | 模块 import        | `/script.js`、`/lib.js`、`/scripts/...` 绝对 import 统一相对化                                                                                                                                                          | 防逃逸出命名空间产生双模块图（双 firstLoadInit 楔死 boot）            | 还原为绝对路径（`rg "相对化" vendor/` 定位）                     |
| public/scripts/st-context.js | extension context  | 向平台扩展暴露受控 `doNewChat` 原生调用                                                                                                                                                                                 | 跳过 slash 命令管线                                                   | 移除 `doNewChat` context 导出                                    |
| public/script.js             | firstLoadInit      | `miniapp_fast_boot=1` 门控：浅层 getCharacters、getUserAvatars 与 13 个 UI-only init 移入延迟批次、world-info 就绪后 dispatch `miniapp:st-interactive`                                                                  | T2 三段握手：select 可在 APP_READY 前执行                             | 移除 `miniAppFastBoot` 分支与 `scheduleMiniAppDeferredUiInit`    |
| public/script.js             | getCharacters      | 增可选参数 `renderList` / `loadGroups`（默认 true，原行为不变）                                                                                                                                                         | fast-boot 关键路径跳过列表 DOM 渲染与群聊拉取                         | 移除参数与对应 if 分支                                           |
| public/script.js             | 模块顶层           | TEMP DEBUG 停摆定位探针（miniapp_fast_boot 门控）：fetch 包装记录请求生命周期 + 静默异常捕获，暴露 `__miniappFetchLog` / `__miniappBootErrors` 供父窗口收割；捕获坏模块图致命签名时向父窗口发 `boot-fatal` 触发立即重载 | boot 楔死请求定位 + 坏模块图自愈                                      | 随 [iframe-timing] 埋点整体移除                                  |
| public/index.html            | 消息提示音         | `audio#audio_message_sound` 增 `preload="none"`                                                                                                                                                                         | 代理链残缺 206 触发 WebKit 每 ~75ms 无限重试风暴（疑似坏模块图诱因）  | 移除 preload 属性                                                |
| public/index.html            | 模块脚本引导       | 5 个并列 `<script type="module">` 根合并为单一内联根，静态 import 按原文档序（monkey-patch → swiped-events → eventemitter → i18n → script.js）                                                                          | WebKit 全缓存冷启动下多根共享循环图求值失序 → TDZ → boot 死亡（根治） | 还原 5 行 `<script type="module" src=...>` 并删除内联块          |
| src/users.js                 | session name       | 支持 `ST_SESSION_COOKIE_NAME` 显式覆盖；未配置时保留 hostname hash 回退                                                                                                                                                 | 固定域名长期累积部署相关 Cookie                                       | 删除环境变量分支，恢复仅按 hostname 生成                         |

> 另注（非仓库内改动）：`ops/docker/Dockerfile.st-bundle` 在构建镜像时把 `public/index.html`
> 的 `<base href="/">` 改写为 `/st-runtime/<内容哈希>/`（发布级资产命名空间，配合
> `ops/nginx` 的 `location ~ ^/st-runtime/` 前缀剥离）。仓库内 index.html 保持原样，
> 本地 dev 不受影响；回滚 = 删除 Dockerfile 对应 RUN 步骤。
