# MiniApp 点卡呈现耗时优化（T0/T1/T2）· 试验报告与 pro 验收基准（2026-07-20）

> 分支 `dev_iframe_optimization`，已全部合并 dev 部署验证。
> 本文两个用途：①向团队汇报本轮优化的核心实现与预期收益；②作为 pro 自然流量验收的判据基准。
> 前置口径：`docs/cold-boot-baseline-2026-07-13.md`（pro 真实流量 528 条干净冷启动的分位数基线）。
> 过程细节：`docs/t2-interactive-handshake-handoff-2026-07-17.md`（含坏模块图卡点的排查与根治全程）。

---

## 一、问题定义与基线

**优化目标**：用户点角色卡后到对话呈现的等待。它由两段构成：

```
点卡→呈现 = 点卡→闸门（等 ST boot 就绪放行） + selectCharacter（切卡+新建对话本体）
```

ST iframe 在大厅页预加载，冷启动与浏览时间重叠；但**快速点卡用户**浏览时间压不住 boot，
闸门等待暴露（round-3 实测 10 会话中 7 个非零，中位 ~8.9s；极端动机样本：Android 冷 boot
27s，点卡后 24.6s 在等闸门，而 select 本体只要 1.77s）。

**Baseline（pro 真实流量，2026-07-13）**：

| 指标（P50，秒）                      | 全平台 | Android（84%） | iOS（14%） |
| ------------------------------------ | ------ | -------------- | ---------- |
| 冷启动全长（bridge_start→APP_READY） | 15.9   | 16.5           | 13.9       |
| 其中 ③ boot 后段（含扩展窗口 3.4s）  | 6.8    | 7.2            | 5.4        |
| selectCharacter（优化前）            | 2.68   | —              | —          |

---

## 二、三项优化：核心实现与预期收益

### T0 · 压缩 selectCharacter 本体（commit `7b0b3a3`）

**做了什么**：平台进卡必然是"强制新对话"（forceNewChat），而 ST 原生切卡链路为
Web 场景设计，包含大量对本场景无意义的串行 IO。T0 在该前提下裁剪：

- `doNewChat({skipCharacterSave, skipChatFetch})`：跳过即将被新对话替换的旧聊天读取、
  空聊天文件请求、角色卡 PNG 指针回写；
- `selectCharacterById` 增 `skipChatLoad`：跳过选卡时加载上次聊天；
- st-extension 的 select handler 改走上述受控原生调用（经 `st-context.js` 暴露的
  `doNewChat`，绕过 slash 命令管线）。
- 生效标记：日志 `fastNewChat=true`。

**直接影响的指标**：beacon 的 `selectCharacter(总)`、其中 `└H2 /newchat` 子相位、
以及整体 `点卡→呈现` 的后半段。

**受益场景**：**每一次点卡**（不分冷热启动、不分平台）——这是三项中唯一作用于全部
进卡行为的优化。dev 实测 select P50 2.68s → **~0.95s**。

### T1 · 隔离酒馆助手（JS-Slash-Runner）启动长尾（commit `8dd2ece`）

**做了什么**：酒馆助手是产品依赖的最大第三方扩展（gzip ~890KB），其启动路径上有
三类公网外联/体积问题，在弱网与中国网络环境下构成长尾：

- 摘除设置面板对 `gitlab.com` 的版本检查外联（不可达网络下挂到超时）；
- 消息渲染 iframe 的 **8 个 jsdelivr CDN 依赖**（jquery/jquery-ui/fontawesome 等）
  下载进快照 `lib/vendor/` 锁版本、改本地路径下发（走同源 + nginx 缓存分档）；
- `lib/jsoneditor.js` esbuild minify：**1.97MB → 1.22MB**（90 个导出逐一校验一致）。
- 补丁只改 `ops/st-extensions` 快照，登记于快照 README「平台补丁」。

**直接影响的指标**：③ boot 后段中的扩展窗口（`st_handshake →
EXTENSION_SETTINGS_LOADED`）、② 解析段体积部分；消息渲染 iframe 的首帧
（jsdelivr 外联原本发生在消息渲染时）。

**受益场景**：**冷启动 + 弱网/受限网络用户的长尾**。这类外联在 P50 上不明显
（快网秒回），但在 P75/P90 上是数秒到数十秒的方差来源——收益应看尾部分位数而非中位数。

### T2 · 三段握手新增 interactive 相位（commit `a2f1f21`）

**做了什么**：把「select 可执行」从「ST 完全就绪（APP_READY）」解耦出来：

- 握手 `handshake → interactive → ready`（保留 handshaked→ready 直达，兼容旧两段握手）；
- vendor `firstLoadInit` 在 `miniapp_fast_boot=1` 门控下，于 select 依赖（settings/
  浅层角色列表/tokenizers/persona/world-info）就绪后即 dispatch
  `miniapp:st-interactive`，13 个 UI-only init 移入 APP_READY 后的延迟批次
  （有 select 在途时让位，settle 后 requestIdleCallback）；
- `selectCharacter` 的 requiredPhase 从 `ready` 降为 `interactive`，前端闸门
  interactive 即放行；bridge 全链路 phase 校验序数化；
- 收到 interactive 即解除 60s 握手总超时（防慢 boot 长尾上在途 select 被重载腰斩）。
- Web 直访无 `miniapp_fast_boot` 参数，零影响。

**直接影响的指标**：`点卡→闸门(等ST_ready)`（快速点卡样本）；新增相位打点
`st_interactive`（可算 interactive 领先 APP_READY 的量）；meta 的
`bridgeStatusAtGate=interactive` 占比。

**受益场景**：**快速点卡 × 慢设备/慢网络**的交集，即 Android 长尾人群——正是体感最差、
投诉集中的场景。收益 = interactive 领先 APP_READY 的时长（点卡早于 interactive 时全额
兑现）。dev 快设备实测领先仅 280–440ms；**预期在慢 Android 上为数秒到数十秒**
（动机样本 24.6s 闸门等待中，select 依赖就绪远早于 UI init 完成）——这是 pro 验收的
核心待证命题。

### 收益归属速查

| 优化 | 直接压缩的相位          | 受益人群/场景     | 收益形态                    |
| ---- | ----------------------- | ----------------- | --------------------------- |
| T0   | `selectCharacter(总)`   | 所有点卡          | 中位数收益（-1.7s）         |
| T1   | 扩展窗口 + 消息渲染外联 | 冷启动、弱网用户  | 尾部分位数收益              |
| T2   | `点卡→闸门`             | 快速点卡 × 慢设备 | 长尾收益（待 pro 证实量级） |

---

## 三、同期稳定性修复（验收数据的前提）

本轮复测暴露并根治了两个既有 boot 稳定性问题（非三项优化引入，但直接决定 pro 数据质量）：

1. **发布级资产命名空间**（`0813906` 等）：Docker 构建把 `<base href>` 注入
   `/st-runtime/<内容哈希>/`，根治 WebView/边缘缓存的新旧模块版本混用（旧版本混用曾
   直接楔死 boot）。
2. **坏模块图 TDZ 根治**（`ffa0002`，方案 b）：WebKit 在全缓存冷启动下对多
   `<script type="module">` 根共享循环依赖图求值失序 → TDZ → boot 握手前死亡（终态
   永卡开屏）。修复：5 个模块根合并为单一内联根、按原文档序静态 import（单根无竞速，
   顺序逐模块保持联网验证过的规范序）。dev 三平台 24 次冷启动压测 **0 复发**（此前
   触发率 70%+）。中间产物：boot_fatal 自愈通道 + `Clear-Site-Data` 清缓存重载
   （方案 a，实测 iOS WKWebView 不支持该头、Chromium 有效，保留作纵深防御）。

不修这两个，pro 的停摆/重载样本（baseline 已有 14%）会污染全部耗时指标，且存在确定性
永卡场景。

---

## 四、pro 验收方案（自然流量跑数天后执行）

### 采样口径（沿用 baseline §五）

- `railway logs -s stminiapp -e production` 按部署 ID 回捞 `--filter "iframe-timing"`；
- 累计 **≥100 个干净冷启动**（相位完整、无停摆重载标记）再下结论；
- 分平台（至少 Android/iOS）报 P50/P75/P80；停摆/重载样本单列归因，不混入基线；
- vendor 有变更则哈希滚动，**部署后首批会话必好，不作为证据**。

### 逐项验收判据

| 项     | 指标（beacon 字段）                                                                                                | 通过判据（对照 baseline）                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| T0     | `selectCharacter(总)` 分位数；`fastNewChat=true` 覆盖率                                                            | select P50 从 2.68s 降至 ≤1.2s；fastNewChat 覆盖全部成功样本                                                   |
| T1     | `st_handshake→EXTENSION_SETTINGS_LOADED` 段；③段 P75/P80                                                           | 扩展窗口 P75 较 baseline（6.2s）下降；③段尾部收窄                                                              |
| T2     | `点卡→闸门` 分布（重点 P75/P90）；`st_interactive` 领先 `ar:APP_READY` 差值；`bridgeStatusAtGate=interactive` 占比 | 快速点卡样本闸门等待 P75/P90 显著低于 baseline 口径（中位 ~8.9s、动机样本 24.6s）；慢 Android 样本领先量达秒级 |
| 稳定性 | `boot_fatal` / `gate_stall` / `select_stall` / `boot_disconnected` 计数；停摆重载样本占比                          | TDZ 类 boot_fatal 持续为零；停摆占比明显低于 baseline 的 14%                                                   |
| 整体   | 冷启动全长 P50/P75/P80 分平台                                                                                      | 不劣于 baseline（16.5/13.9s），预期可观改善                                                                    |

### dev 参考数据（2026-07-20 压测，n=24，自有设备，方向性参考、非验收依据）

| 平台          | 冷启动全长中位 | baseline P50 |
| ------------- | -------------- | ------------ |
| Android (n=8) | ~9.1s          | 16.5s        |
| iOS (n=9)     | ~12.1s         | 13.9s        |
| Desktop (n=7) | ~7.0s          | 15.2s        |

另：24 boot 点卡 100% 成功；interactive 全样本领先 APP_READY 280–400ms（快设备下限，
慢设备领先量是 T2 验收核心）；select 链路 0.6–2.3s 无回归。

### 验收后动作

- 通过 → 移除全部 `[iframe-timing]` TEMP DEBUG 埋点（前端 iframe-timing.ts、page.tsx
  打点、st-extension debug-\*、vendor 探针、backend debug.ts；vendor 探针在 NOTICE.md
  有登记），保留 boot_fatal 自愈通道与方案 a 保险丝。
- T2 长尾收益不达预期 → 分析 `st_interactive` 领先量分布，评估是否把更多 init 移出
  interactive 前置依赖（`scheduleMiniAppDeferredUiInit` 批次扩容）。
