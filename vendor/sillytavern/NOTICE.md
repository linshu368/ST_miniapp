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

| 文件             | 位置               | 改动                                                                                      | 原因            | 回滚                                                    |
| ---------------- | ------------------ | ----------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------- |
| public/script.js | firstLoadInit 前段 | getClientVersion/initSecrets/readSecretState/initLocales 串行→Promise.all                 | 冷启动并行化①   | 见 docs/iframe-boot-firstloadinit-parallelization.md §6 |
| public/script.js | firstLoadInit 后段 | getUserAvatars/getCharacters 串行→Promise.all；移除 boot 期 getBackgrounds 调用（Tier-2） | 冷启动并行化①/② | 同上                                                    |
