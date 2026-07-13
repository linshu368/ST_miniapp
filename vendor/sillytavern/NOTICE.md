# Vendored SillyTavern

This directory contains a vendored copy of SillyTavern and is treated as **read-only third-party code**.
All customization is done via `packages/st-extension` (injected through ST's extension mechanism).

- Source: https://github.com/SillyTavern/SillyTavern
- Commit: `51ad27fb86d39a3daca3adaa970375c9670c12df`
- Vendored on: 2026-06-23

Do NOT modify files in this directory directly. See ARCHITECTURE.md §1 for details.

## Local patches (miniapp)

本 vendored 副本含以下**受控**本地改动（例外于只读约束，经 ARCHITECTURE 铁律放开，仅限冷启动优化）。
审计：`rg "\[miniapp-patch\]" vendor/sillytavern/`。

| 文件                  | 位置                | 改动                                                                                      | 原因               | 回滚                                                             |
| --------------------- | ------------------- | ----------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------- |
| public/index.html     | critical boot shell | query-gated iframe 内品牌开屏，APP_READY 后由平台扩展移除                                 | iOS 前台可见 boot  | 见 docs/iframe-foreground-boot-plan.md                           |
| public/script.js      | firstLoadInit 前段  | getClientVersion/initSecrets/readSecretState/initLocales 串行→Promise.all                 | 冷启动并行化①      | 见 docs/iframe-boot-firstloadinit-parallelization.md §6          |
| public/script.js      | firstLoadInit 后段  | getUserAvatars/getCharacters 串行→Promise.all；移除 boot 期 getBackgrounds 调用（Tier-2） | 冷启动并行化①/②    | 同上                                                             |
| public/script.js      | MiniApp fast boot   | query-gated 跳过角色列表/分组渲染，提前 interactive，并延迟 UI-only 初始化                | 提前聊天可交互闸门 | 移除 `miniapp_fast_boot` 分支                                    |
| public/script.js      | 选角色/新对话路径   | forceNewChat 时跳过旧聊天加载、空文件读取与角色 PNG 指针回写                              | 消除重复 H3/H2 IO  | 移除 `skipChatLoad` / `skipChatFetch` / `skipCharacterSave` 分支 |
| scripts/extensions.js | activateExtensions  | MiniApp fast boot 将 Quick Reply / JS-Slash-Runner 延迟到 interactive 后加载              | 缩短握手前扩展解析 | 移除 `miniapp:st-interactive` 延迟分支                           |
| scripts/st-context.js | extension context   | 向平台扩展暴露受控 `doNewChat` 原生调用                                                   | 跳过 slash 管线    | 移除 `doNewChat` context 导出                                    |
