# 形态 B：iOS 前台可见 boot（开屏化预热）正式方案 — 2026-07-13

> **一句话**：在 iOS 上放弃「隐藏态预热」，改为登录后让 ST iframe 以「品牌开屏」的形态
> **前台可见地**跑完 boot（~5–9s），从机制上根治 iOS 停摆（WebKit 后台降级挂起网络投递）；
> 非 iOS 平台保持现状不变。
>
> **性质**：产品级架构改动（改变 iOS 用户登录后的首屏体验），需产品确认后实施。
> **定位**：iOS 停摆的**根治候选**；与已上线的「点卡即检」止损兜底（10s）并存，不互斥。
>
> 前置阅读（本文已浓缩其结论，实施前无需重读，深挖证据时再查）：
>
> - `iframe-boot-stall-investigation.md`：停摆排查全记录，**§八 传导路径全景**是本文背景的完整版
> - `iframe-cold-boot-progress.md`：冷启动耗时基线与优化清单
> - `ARCHITECTURE.md`、`packages/frontend/CLAUDE.md`：iframe 常驻铁律与 bridge 规则

---

## 一、背景：问题是什么、为什么走到形态 B

### 1.1 停摆传导路径（浓缩版）

1. **平台策略**：ST iframe 在大厅页就静默挂载、隐藏态预热 boot（常驻预加载铁律，
   为「点卡零等待」设计）。隐藏方式：full-size 真实渲染 + `z-[-20]` + 下方不透明遮罩。
2. **iOS/Telegram WebKit 特性**：把「不产生可见渲染的文档」判为后台文档并降级——
   **挂起网络请求投递**。被遮挡 = 不可见，照样降级。
3. **boot 前段是串行网络链**：`/csrf-token`（已到 nginx 200）→ `/version`（投递被挂起，
   **永不到 nginx**）→ boot 楔死在最前段。
4. **握手永不发出**：发「首段握手」的 st-extension 由 `getSettings()` 内
   `activateExtensions` 才加载，排在楔死点之后 → 从不加载 → 握手不到达是**下游症状**。
5. **用户代价**：楔死不自愈，只能靠看门狗到点重载 iframe 重跑 boot。
   用户点卡→呈现 = 白等阈值时长 + 重跑一遍 boot。

**实测**：iOS 冷启动约 80% 命中停摆（5 样本 4 停摆）；Desktop/Android 无此型停摆
（Blink 不会对同页隐藏 iframe 挂起网络投递）。

### 1.2 已确证的死路（不要再试）

| 尝试                                               | 结果                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1×1px + `opacity-[0.01]`（round-1）                | ❌ 仍停摆（面积太小判不可见）                                                                  |
| full-size 真实渲染 + 负 z + 不透明遮罩（round-2a） | ❌ 仍停摆（被遮挡 = 不可见）                                                                   |
| Web Audio 等保活 hack                              | ❌ 那是标签级节流的规避术，骗不过 iframe 可见性判定                                            |
| boot 前段 `Promise.all` 并行化                     | 只提速健康 boot（已作为 vendor 补丁落地，见 §1.4），**不治停摆**——并行只是让请求「一起被挂起」 |

**结论**：「对用户不可见」与「对 WebKit 可见」在 iOS 上不可兼得。想让 boot 不被降级，
iframe 必须**真实、未被父层遮挡、全程可见**。

### 1.3 当前防线（形态 B 实施前的现状）

- **点卡即检（安全网 #5，主防线）**：用户进 `/tavern/` 时若距 boot 起点超过
  `visibleStallReloadMs`（**当前 10s**，commit `e61dedb`）仍未握手 → 立即重载；
  未超则武装剩余时长的定时器。重载发生在可见态，实测 100% 恢复。
  代价：停摆用户点卡→呈现仍要 **~15s 级**（白等 + 重跑 boot）。
- 其余安全网：15s load 看门狗（#3）、30s 握手到达看门狗（#4）、60s 总超时（#2），
  共享 3 次重连额度 + 2/4/8s 退避。全部在
  `packages/frontend/src/lib/bridge/bridge-client.ts`。

**真实卡点**：兜底再激进也只是止损。停摆用户的点卡→呈现物理下限 ≈
「阈值（≥健康握手最迟值 ~7.6s）+ 重跑 boot（~5–9s）」，压不进 ~13s 以内。
想让 iOS 用户稳定拿到「点卡 1–3s 进卡」，必须让**首次 boot 本身不坏**——即形态 B。

### 1.4 基线更新（2026-07-13 代码现状，与旧文档的差异）

- vendor `public/script.js` 已落地两处 `firstLoadInit` 并行化补丁（`Promise.all`，
  已在 `vendor/sillytavern/NOTICE.md` 登记）→ 健康 boot 应比旧基线（冷启动全长中位 15.2s、
  握手到达 ~5–7.6s）更快，**实施形态 B 前先重测基线**，开屏时长预算按新数据定。
- 点卡即检阈值已是 10s（不是文档旧值 18s）。

---

## 二、形态 B 方案总览

### 2.1 核心思想

> 停摆的充要条件是「boot 期间文档不可见」。那就让 iOS 的首次 boot **全程可见**——
> 但用户看到的不是原始 ST 界面，而是一块画在 **iframe 文档内部**的品牌开屏。

把无法省掉的 ~5–9s boot，从「隐藏态赌 80% 会坏」挪到「登录后前台跑、100% 可靠」。

### 2.2 用户流程对比（仅 iOS）

```
现状：   login → 大厅(自由浏览, iframe 隐藏预热, 80% 楔死)
              → 点卡 → [停摆则白等~10s + 重载重跑 boot] → 呈现(~15s) / 健康则 0–5s

形态 B： login → 品牌开屏(= 前台可见的 iframe, 内部 splash, boot 稳定推进 ~5–9s)
              → boot 完成, iframe 退回隐藏, 进大厅(自由浏览)
              → 点卡 → 会话内切卡(iframe 已 ready) → 呈现 ~1–3s, 且稳定
```

关键收益：**把不可预测的「点卡后卡 15s」换成可预测的「启动时加载 5–9s」**，
且换来点卡后的一致快速。Desktop/Android 完全不变。

### 2.3 为什么不是字面意义的「替用户默认点一张卡」

原始提议（登录后自动 `router.push('/tavern/<默认卡>')`）能达到「转可见」目的，但：

1. 会真实触发 `selectCharacter`/建聊天等副作用，选的还是用户没选的卡（脏数据 + 浪费）；
2. 污染路由历史（用户按返回会退到一张莫名其妙的卡）；
3. 可见性收益不需要导航也能拿到——只要让 iframe 元素在 boot 期间置顶可见即可。

故方案泛化为：**不导航、不选卡，只在 boot 期间把 iframe 提到前台 + 用 iframe 内部
splash 遮住 ST 原生界面**。

### 2.4 硬约束（设计必须满足）

1. **splash 必须画在 iframe 文档内部**。父窗口任何覆盖在 iframe 之上的遮罩 = 遮挡 =
   WebKit 判不可见 = 复活停摆（round-2a 已证）。这是本方案与所有 CSS 方案的本质区别。
2. splash 必须**早于 boot 前段**渲染（楔死点在 `/csrf-token`→`/version`，即文档加载后
   数秒内），所以不能靠 st-extension 画（它在楔死点之后才加载）——必须内联在
   ST 的 `index.html` 里。
3. iframe 可见窗口默认覆盖**整个 boot**（到 APP_READY），除非实验 E1（§五）证明可提前释放。
4. 铁律不破：iframe 仍常驻不 unmount；`vendor/sillytavern` 修改走最小 diff +
   `[miniapp-patch]` 注释 + `NOTICE.md` 登记（已有 `script.js` 两处补丁先例）。

---

## 三、技术设计

### 3.1 相关现状（实施者需要知道的接线事实）

| 事实                                                                                                                                | 位置                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `/tavern/` 精确匹配 → nginx 代理到 ST 根 `/`；ST Express 静态 `sendFile('index.html')`，**无 SSR、无 sub_filter**，平台未改过该文件 | `ops/nginx/nginx.conf:149-157`、`vendor/sillytavern/src/server-main.js:231-238`    |
| st-extension 走 ST 原生第三方扩展机制加载（`third-party/miniapp-bridge/entry.global.js`），构建时拷入 vendor                        | `packages/st-extension/scripts/postbuild.ts`                                       |
| iframe 挂载在全局 Provider（大厅即预热），`src='/tavern/'`，先等 `/api/init-st-session` 写 cookie 再挂                              | `packages/frontend/src/app/providers.tsx:46-49`、`components/bridge/st-iframe.tsx` |
| 可见性由路由驱动：`isVisible = pathname.startsWith('/tavern/')`，无 store                                                           | `components/bridge/bridge-provider.tsx:19-20`                                      |
| 可见/隐藏只是 className 切换：`z-10` ↔ `z-[-20] + 遮罩`                                                                             | `components/bridge/st-iframe.tsx:155-159`                                          |
| 登录后落地页 = `/`（大厅 `CharacterGallery`）；点卡 = 预览浮层 → `router.push('/tavern/${id}')`                                     | `app/(main)/page.tsx`、`components/characters/character-gallery.tsx:158-163`       |
| 聊天页已有开屏组件 `ChatSplash`（视觉可复用）                                                                                       | `components/tavern/chat-splash.tsx`                                                |

### 3.2 改动 1：iframe 内部品牌 splash（vendor `index.html` 最小补丁）

**文件**：`vendor/sillytavern/public/index.html`

在 `<body>` 开标签后**立即**插入一段自包含的内联块（div + `<style>` + 少量内联 JS），
带 `[miniapp-patch]` 注释、在 `NOTICE.md` 登记：

- **渲染时机**：随 HTML 流式解析立即绘制（位于所有 ST 同步脚本之前），满足
  「文档一创建就有真实可见渲染」→ WebKit 不降级。
- **形态**：全屏、不透明、品牌底色 + logo/加载动画，视觉对齐前端 `ChatSplash`
  （颜色/动画从 `chat-splash.tsx` 与 `globals.css` 的 `splash-*` 抄）。`z-index` 高于
  ST 所有 UI（含 ST 自己的 loader），彻底遮住原生界面。
- **撤除信号**：内联 JS 监听 `document` 上的自定义事件 `miniapp:boot-splash-dismiss`；
  st-extension 在 **APP_READY** 时 `document.dispatchEvent` 派发（改动 3）。收到后淡出移除。
- **自愈**：不设自动超时移除。boot 失败时看门狗会重载 iframe → 文档重建 → splash 随
  新文档重新出现，行为自洽。
- **全平台安全**：splash 对所有平台渲染（Desktop/Android 也会短暂看到——但它们的 iframe
  在隐藏层，用户不可见，零影响）。iOS 专属的只是「boot 期间置顶可见」（改动 2）。

> 为什么不用 nginx `sub_filter` 注入：本地 dev 链路（Next rewrite 直连 ST）不过 nginx，
> 会造成环境行为分叉；vendor 补丁两条链路一致，且已有补丁登记先例。

### 3.3 改动 2：前端「开机相位」可见性状态机

**文件**：`components/bridge/bridge-provider.tsx`、`components/bridge/st-iframe.tsx`

新增开机相位 `bootPhase: 'foreground-boot' | 'done'`（仅 iOS 走 `foreground-boot`）：

- **可见性合成**：`iframeVisible = isRouteVisible || bootPhase === 'foreground-boot'`。
  `foreground-boot` 期间 iframe 用现有可见态样式（`fixed inset-0 z-10`）置顶全屏；
  大厅在其下正常挂载（被 iframe 盖住，不影响 React 渲染与数据预取）。
- **进入**：iOS 判定为真 且 iframe 完成挂载（`registerIframe` 时刻）→ `foreground-boot`。
  挂载前的短暂间隙（init-st-session ~0.6s + 文档 TTFB）由**父层 splash** 顶住（§3.5）。
- **退出** → `done`，iframe 退回 `z-[-20]` 隐藏层，恢复现状行为：
  1. 正常路径：bridge 收到 **APP_READY**（默认口径；若实验 E1 通过可提前到首段握手）；
  2. 兜底路径：`foreground-boot` 持续超过 `maxForegroundBootMs`（建议 25s，
     覆盖「重载一次再跑完」）→ 强制退出进大厅，交还给现有点卡即检兜底。
     **此兜底必须有**，否则 boot 反复失败会把用户永久锁在开屏。
- **`onActivated()`（点卡即检）不动**：仍由路由进入 `/tavern/` 触发。`foreground-boot`
  期间各看门狗照常武装，重载后 splash 随新文档自动重现。

**iOS 判定**：新建 `lib/platform.ts`，UA 正则口径与后端 beacon 的 `plat=` 判定
（`packages/backend/src/routes/debug.ts`）对齐（`iPad|iPhone|iPod` + iPadOS 桌面 UA 的
`Mac + maxTouchPoints > 1`）。误判代价可接受：误进（Android 判成 iOS）= 多看一次开屏；
漏判（iOS 判成桌面）= 退回现状（点卡即检兜底），均不致损。

**APP_READY 获取**：确认 bridge 是否已把 APP_READY 作为事件暴露给壳端
（beacon `ar:APP_READY@+X` 打点的来源链路）。若只在 st-extension/打点层可见，
则在 `@miniapp/bridge-protocol` 补一个事件并由 st-extension 转发——协议改动很小，
但要按规则走 protocol 包，禁止字面量。

### 3.4 改动 3：st-extension 派发 splash 撤除事件

**文件**：`packages/st-extension/src/`（entry 或现有 APP_READY 处理处）

在 ST `APP_READY` 时：`document.dispatchEvent(new CustomEvent('miniapp:boot-splash-dismiss'))`。
事件名常量放 `@miniapp/bridge-protocol` 共享（vendor 内联脚本无法 import，
在补丁注释中标注「与 protocol 常量手工同步」）。

### 3.5 改动 4：父层 pre-mount splash（挂载间隙的视觉衔接）

**文件**：`app/providers.tsx`（或新组件 `components/bridge/boot-splash.tsx`）

iOS 且 `bootPhase === 'foreground-boot'` 且 iframe 文档尚未首绘的间隙，父层渲染一块与
内部 splash **视觉完全一致**的全屏 splash。撤除时机：

- **保守口径（默认）**：iframe 挂载即撤（`registerIframe` 时刻）。间隙后段
  （文档 TTFB ~0.5–1.5s）iframe 是白屏——用 iframe 元素自身的 CSS `background` 设为品牌底色
  兜住，视觉上仍是纯色开屏，文档内部 splash 一渲染即无缝接上。
- **禁止**：父层 splash 盖住**已在加载文档**的 iframe（哪怕只盖到 `onload`）。
  ST 文档的同步脚本在 HTML 解析期就开始下载（~3.8s 网络段），被遮挡期间即可能降级楔死，
  且楔死时 `onload` 永不触发，撤除时机形成死锁。这是 round-2a 的翻版，不要试。

### 3.6 埋点（沿用 `[iframe-timing]` beacon 体系）

新增标记：`foreground_boot_start` / `foreground_boot_end`（含退出原因
`app_ready | timeout_fallback`）。配合既有 `plat=`、`aN`、`click_stall_reload`、
`handshake_arrival_watchdog`，可直接算出 §六的所有验收指标。

### 3.7 开关与回滚

`NEXT_PUBLIC_FOREGROUND_BOOT=1`（Vercel 环境变量）总闸，默认关。
关闸 = 完全回退现状（隐藏预热 + 点卡即检）。vendor splash 补丁与 st-extension 事件
无需随闸回滚：非 iOS/关闸时 iframe 在隐藏层，内部 splash 用户不可见、零行为影响。

---

## 四、实施步骤（建议顺序与验证点）

| #   | 步骤                                                                                   | 文件                                                  | 验证                                               |
| --- | -------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| 0   | 重测健康 boot 基线（§1.4，并行化补丁后），定开屏时长预算与 `maxForegroundBootMs`       | —                                                     | beacon 中位数                                      |
| 1   | vendor `index.html` 内联 splash + `NOTICE.md` 登记                                     | `vendor/sillytavern/public/index.html`                | 本地开 `/tavern/`：splash 立即出现、盖住 ST loader |
| 2   | st-extension 派发 dismiss 事件（+ protocol 常量）                                      | `packages/st-extension/`、`packages/bridge-protocol/` | APP_READY 后 splash 淡出                           |
| 3   | 确认/补 APP_READY 的壳端 bridge 事件                                                   | `packages/bridge-protocol/`、`st-extension`           | 壳端能订阅到                                       |
| 4   | `lib/platform.ts` iOS 判定                                                             | `packages/frontend/src/lib/`                          | 单测 UA 样本                                       |
| 5   | bridge-provider `bootPhase` 状态机 + st-iframe 可见性合成 + iframe 品牌底色 + 25s 兜底 | `bridge-provider.tsx`、`st-iframe.tsx`                | 本地模拟 iOS UA 走通全流程                         |
| 6   | 父层 pre-mount splash                                                                  | `providers.tsx` 等                                    | 视觉无缝、iframe 挂载即撤                          |
| 7   | 埋点 + 环境变量闸                                                                      | 同上 + Vercel                                         | beacon 出现新标记                                  |
| 8   | pro 灰度（先开闸自测,再放量），采样验收                                                | —                                                     | §六                                                |

> 步骤 1–2 全平台安全可先行合入；5–7 由闸控制。部署验证纪律照旧：`curl -sI` 看 bundle
> `last-modified` + grep 特征串（如 `foreground_boot_start`），确认前端确已上线再下结论。

---

## 五、实施前/中需要的实验

- **E1（高价值）：可见窗口能否提前释放。** 现有确证只有「隐藏态会挂起投递」，未测
  「首段握手后转隐藏，剩余 boot（getSettings 后半 + 角色列表 + 收尾，含网络）是否安全」。
  若安全，开屏可从 ~5–9s 压到 ~2–4s。做法：闸后加参数控制退出时机
  （`app_ready` vs `handshake`），iOS 真机各采 ≥5 样本对比 APP_READY 到达率与耗时。
  **默认按保守口径（APP_READY）上线，E1 通过再切。**
- **E2（可选）：部分可见的尺寸阈值。** 若某个非全屏尺寸（如半屏横幅）也能免降级，
  开屏可做成「上半大厅骨架 + 下半加载条」减弱阻断感。round-1 只证明 1×1 不行，
  阈值未知。优先级低，全屏方案跑通后再探。

---

## 六、验收口径

pro 环境 iOS 真机 ≥10 个冷启动会话（注意采样纪律：确认新 build、区分平台）：

1. **停摆率**：`foreground-boot` 会话中 `handshake_arrival_watchdog` /
   `click_stall_reload` / `a2` 出现率 → 目标 **≈0**（对照现状 ~80%）。
2. **开屏时长**：`foreground_boot_start → end` 中位数 → 目标 ≤9s（E1 通过则 ≤4s）。
3. **点卡→呈现**：进大厅后点卡的呈现耗时 → 目标中位数 ≤3s 且无长尾。
4. **兜底触发率**：`timeout_fallback` 占比 → 应为个位数百分比；偏高说明前台 boot
   仍有异常，回查 beacon timeline。
5. **回归**：Desktop/Android 各采 ≥3 会话，确认行为与耗时无变化。

## 七、风险与开放问题

| 风险                                                                 | 应对                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 产品接受度：iOS 登录后先看 5–9s 开屏（现状是立即进大厅）             | 产品决策点，本方案的核心 trade-off；E1 若通过可压到 2–4s            |
| ST 升级时 vendor `index.html` 补丁冲突                               | 最小 diff + NOTICE.md 登记（既有流程）；升级 checklist 加一项       |
| APP_READY 事件链路可能未暴露给壳端                                   | 步骤 3 先确认，缺则补 protocol 事件（小改动）                       |
| 前台 boot 仍可能遇到非停摆型故障（如 Android 那例链路挂死的 iOS 版） | 25s 兜底退出 + 既有看门狗体系原样在岗                               |
| 开屏期间用户操作预期（返回键/切后台再回来）                          | 切后台会触发真·后台降级，回前台后看门狗兜底；灰度期观察 beacon 长尾 |
