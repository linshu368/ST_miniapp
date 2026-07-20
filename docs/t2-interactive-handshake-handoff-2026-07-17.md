# T2 三段握手 · 交接文档（2026-07-17）

> 交接对象：接续本任务的新会话。
> 工作分支 `dev_iframe_optimization`，所有提交已推远程并由人工合并 `dev` 部署（Railway dev 环境 + Vercel dev 前端）。
> 阅读本文档前置：`docs/cold-boot-baseline-2026-07-13.md`（baseline 口径）。
>
> **⚠️ 2026-07-20 更新：§三的坏模块图卡点已收敛（方案 b 根治，dev 压测 24 boot 零复发），
> 全程记录见文末【七、追记】；§四计划的 1/2/3 项均已落地，剩余 4/5 项待办。
> 团队汇报与 pro 验收口径另见 `docs/iframe-optimization-t0-t2-report-2026-07-20.md`。**

---

## 一、背景与目标

MiniApp 点卡后 iframe 呈现耗时优化系列（T0/T1 已验收）：

- **T0**：压缩 selectCharacter 本体（`doNewChat({skipCharacterSave, skipChatFetch})` + `selectCharacterById` 的 `skipChatLoad`）。select P50 2.68s → ~0.95s，日志标记 `fastNewChat=true`。
- **发布级资产命名空间**：Docker 构建把 `<base href>` 注入为 `/st-runtime/<内容哈希>/`，nginx 剥前缀；vendor 内绝对 import 已相对化（绝对路径会逃逸命名空间产生双模块图楔死 boot——踩过的坑）；iframe 文档 URL 每次启动带唯一 `miniapp_doc` 参数。
- **T1**：酒馆助手启动长尾治理（gitlab 版本检查摘除、jsdelivr 本地化、jsoneditor 瘦身）。

**T2 目标**：在 handshake 和 ready 之间插入 `interactive` 阶段，`selectCharacter` 的 requiredPhase 从 `ready` 降为 `interactive`，允许在 APP_READY 之前执行，压缩快速点卡用户的闸门等待（动机样本：Android 冷 boot 27s，点卡后 24.6s 耗在等 ST_ready 闸门，select 本身只需 1.77s）。

---

## 二、T2 已完成实现（已验收生效）

### 提交清单（分支 `dev_iframe_optimization`，均已合并 dev）

| 提交      | PR   | 内容                                                           |
| --------- | ---- | -------------------------------------------------------------- |
| `a2f1f21` | #144 | T2 三段握手全套                                                |
| `0ddd73c` | #147 | 失败路径遥测（gate_stall / select_stall / select_error）       |
| `1a3d5e3` | #148 | 停摆定位探针（fetch 生命周期 + 静默异常收割）                  |
| `79c9c93` | #149 | message.mp3 风暴掐断 + boot_fatal 自愈 + disconnected 恢复入口 |

### 三段握手核心改动（`a2f1f21`）

- `packages/bridge-protocol/src/handshake.ts`：`HandshakePhase` 增 `'interactive'`（zod enum 同步）。
- `packages/bridge-protocol/src/actions/select-character.ts`：`requiredPhase: 'interactive'`。
- `packages/frontend/src/lib/bridge/state-machine.ts`：`handshaked → interactive → ready`，**保留 handshaked → ready 直达**（兼容旧 ST 两段握手；旧 ST 永不发 interactive，若无直达状态机会楔死在 handshaked）。
- `packages/frontend/src/lib/bridge/buffer.ts`：flush 序数 handshake=0 / interactive=1 / ready=2（ready flush 连带放出 interactive 级请求，兼容性由此保证）。
- `packages/frontend/src/lib/bridge/handshake.ts`：处理 `phase==='interactive'` 并 flush。
- `packages/frontend/src/lib/bridge/bridge-client.ts` 三处：
  - `sendAction` 缓冲判断由二元改**序数比较**（否则 handshaked 阶段的 interactive 级请求会直发被 ST 拒）；
  - 收到 interactive 即**清 60s 握手总超时并清零重连计数**（防慢 boot 长尾上在途 select 被总超时重载腰斩）；ping loop 仍等 ready 才启动；
  - 埋点 `st_interactive`。
- `packages/st-extension/src/bridge-server.ts`：phase 校验改序数比较。
- `packages/st-extension/src/handshake.ts`：监听 `miniapp:st-interactive`（once）→ `setCurrentPhase('interactive')` + `sendHandshake('interactive')`，带不从 ready 降级的防御。
- vendor `script.js`（`miniapp_fast_boot=1` 查询参数门控，Web 直访零影响）：
  - fast-boot 下 `getCharacters({renderList:false, loadGroups:false})`（浅层列表）；`getUserAvatars` 移出关键路径；
  - `initWorldInfo()` 后 dispatch `miniapp:st-interactive` + `await delay(0)` 让握手先行；
  - 13 个 UI-only init 移入延迟批次 `scheduleMiniAppDeferredUiInit`：APP_READY 后若有 select 在途（`window.__miniappSelectInFlight`，st-extension 维护）等 `miniapp:select-settled` 再 requestIdleCallback（**不用固定定时器**——旧原型 5s 定时器与点卡窗口竞争的教训）。
- `packages/st-extension/src/handlers/select-character.ts`：select 在途计数 + settle 事件（成败均发）。
- 前端闸门 `packages/frontend/src/app/tavern/[characterId]/page.tsx`：interactive/ready 均放行。**关键坑**：effect 依赖必须用派生布尔 `gateOpen`（interactive→ready 升级时布尔不变，否则 effect 重跑会作废在途 select 并重复发起）；`bridgeStatusAtGate` 经 ref 读取。
- `packages/frontend/src/components/bridge/st-iframe.tsx`：boot URL 追加 `&miniapp_fast_boot=1`。
- `packages/backend/src/routes/debug.ts`：相位标签补 `st_boot(→interactive)`、`interactive→APP_READY`。

### 验收结果（生效）

成功样本中：`st_interactive` 相位全部出现；快速点卡样本 `bridgeStatusAtGate=interactive`，select 在 APP_READY 前约 300ms 开始执行并成功；`fastNewChat=true` 全样本保持；select 链路无回归（0.6–2.3s）。本轮测试设备较快，interactive 仅领先 APP_READY 280–440ms，目标收益（慢 Android 长尾的数秒~数十秒）尚未在真实长尾样本上验证。

---

## 三、当前问题（真正的卡点，非 T2 引入）

### 现象

部署后复测出现「点卡永卡开屏动画」。多轮排查确认：**卡死与 T2 逻辑无关**（卡死样本中 T2 代码根本未执行到），是一个此前被 5 层看门狗掩盖、由复测暴露的既有 boot 稳定性问题。

### 已证实的根因链（探针数据支撑，非推测）

1. **卡死 = ST boot JS 在扩展初始化前死亡**：卡死样本 timeline 无 `st_init_start`、无任何握手；iframe onload 正常触发（模块图加载完成）。
2. **不是网络楔死**（round-3 曾假设、round-4 证伪前身）：fetch 探针显示 `/csrf-token` 正常 200 归来（`@xxx→yyy(200)`），此后 boot 死于同步段。
3. **死因是坏模块图 TDZ 异常**：每个卡死样本捕获到 `ReferenceError: Cannot access uninitialized variable`（老 WebKit 措辞）或 `Cannot access 'xxx' before initialization`（iOS 18.7 措辞），出错点 `jquery ready 派发链 + script.js`（`power_user` 访问处）。iOS 给出的变量名：`power_user`、`extension_prompt_types`、`trackMissingDynamicTranslate`——多个模块导出绑定同时未初始化 = ST 模块循环依赖圈以错误顺序求值。
4. **触发条件已锁定：全缓存冷启动**。卡死样本的全部模块脚本加载耗时 +0ms（纯 HTTP 缓存）。规律在 4 轮复测中 100% 复现：**vendor 变更 → 命名空间哈希滚动 → 首批会话（全新拉取）必好；缓存填满后的重启会话概率性出坏图；一旦出坏图，重载复用同一缓存 → 每次必坏 → 重连额度耗尽 → disconnected 终态永卡**。三轮哈希：`7f092b30320c`（round1/2）→ `315ebb6b3645`（round3）→ `2a59c48c6732`（round4），每次滚动后"表面恢复"，随后重启会话复发。
5. **已证伪**：message.mp3 请求风暴（代理链对 Range 返回 2 字节残缺 206 → WebKit 每 ~75ms 无限重试）曾是头号嫌疑；round-4 已用 `preload="none"` 掐断（瀑布零出现），坏图依旧发生 → 风暴不是诱因（但掐断本身是正确修复，保留）。

### 当前工作假说（待验证）

全缓存时多个 module 入口几乎同时就绪，循环依赖圈从与走网络时不同的入口开始求值（网络时体积最大的 script.js 总是最后就绪，圈总是以"正确"顺序进入），绑定初始化顺序错乱 → TDZ。属 WebKit + 多 module 入口 + 大循环图的组合行为。

### 自愈机制现状（round-4 实测）

- `boot-fatal` 通道（vendor 探针捕获致命签名 → postMessage 父窗口 → bridge-client 立即走重连预算）：**Mac 生效**（重载梯队 10s+ → 3–5s/次），但重载治不了缓存性坏图，额度耗尽仍进 disconnected。
- **已知缺陷**：致命签名正则 `MINIAPP_FATAL_RE`（vendor script.js 探针内）漏了 iOS 18.7 的 `Cannot access 'xxx' before initialization` 变体 → iOS 不触发 boot_fatal，仍走慢速看门狗。**这是下一步的第一个待办。**
- disconnected 终态恢复入口（开屏 12s 后出错误提示，重试按钮 `window.location.reload()`）：已被实际使用（timeline 中 `page_mount` 早于 `bridge_start` 的样本），Mac 最终借此恢复。

---

## 四、下一步计划（按优先级）

1. **补正则**（小修，vendor script.js `MINIAPP_FATAL_RE`）：加 `before initialization`，让 iOS 触发 boot_fatal 自愈。
2. **治缓存性坏图（方案 a，推荐先做）**：boot_fatal 重载时让文档 URL 带特殊参数（如 `miniapp_nuke=1`），nginx 对该参数返回 `Clear-Site-Data: "cache"` 清 origin HTTP 缓存 → 下次加载等价于新哈希首会话（已证实必好）。涉及 `ops/nginx` 配置 + bridge-client 重载 URL 逻辑。
3. **根治方向（方案 b，验证 a 后决定）**：审计 vendor `index.html` 的多个 `<script type="module">` 入口，强制统一经由 script.js 的确定性顺序进入循环圈（如次要入口改为在 script.js 就绪后动态 import）。改动风险高于 a，需谨慎评估双模块图风险。
4. **验证 T2 原始收益**：坏图问题收敛后，在慢 Android 设备上复测快速点卡，确认 interactive 相位的长尾收益（对照：Android 曾 24.6s 闸门等待）。
5. **埋点清理**：全部 `[iframe-timing]` TEMP DEBUG（前端 iframe-timing.ts、page.tsx 打点、st-extension debug-\*、vendor 探针、backend debug.ts）在优化项目收尾时一次性移除；vendor 探针在 NOTICE.md 有登记。

---

## 五、验证工具链（复测必读）

### 拉日志

```bash
# 部署 ID 先查（环境名是 development 不是 dev；服务：stminiapp / st-bundle / nginx）
railway deployment list -s stminiapp -e development --json
# 历史模式拉取（-n 禁用流式，流式模式不会退出）
railway logs <deployment-id> -s stminiapp -e development -n 5000 --filter "iframe-timing" --json
# nginx 访问日志（请求瀑布断流定位）
railway logs <nginx-deployment-id> -s nginx -e development -n 5000 --json
```

### 上报语义（backend `/api/debug/iframe-timing` → Railway 日志）

- `[iframe-timing]` 主行：相位耗时 + timeline（全部打点按时间排序）。
- `[iframe-timing-meta]`：`reason` 区分同一次点卡的多条上报——无 reason=成功（chat_ready 时 flush）；`gate_stall`=点卡 15s 闸门未放行；`select_stall`=闸门放行 25s select 未归；`select_error`=select reject（带 errorCode）。
- `[iframe-timing-wf]` `stall_*` 行：`stall_doc`（readyState/URL/静默异常）、`stall_fetchlog_N`（fetch 生命周期，`→PENDING` 即在途挂起）、`stall_resources_N`（resource timing 截尾，`+0` 耗时 = 命中缓存）。
- timeline 关键打点：`st_init_start`（扩展开始初始化）缺失 = boot 在此之前死亡；`boot_fatal`（vendor 探针捕获致命异常）；`iframe_onload_aN`（第 N 次加载尝试）；`click_stall_reload` 等看门狗打点。

### 复测方法论（重要）

- **凡 vendor 变更都会滚动哈希 → 部署后首批会话必好，不能作为修复证据**。
- 复现坏图的路径：反复杀掉/重开 MiniApp（让模块缓存填满后做缓存冷启动），每次都点卡。
- 因果闭环判据：重启会话不再出现 `gate_stall` + TDZ；或出坏图后 `boot_fatal` → 自动重载 → 数秒内成功握手。

### 提交前验证

```bash
pnpm typecheck && pnpm -r --if-present test && pnpm --filter @miniapp/st-extension build
node --check vendor/sillytavern/public/script.js   # 改过 vendor JS 时
```

---

## 六、约束与纪律（沿用）

- 每次提交前确认分支是 `dev_iframe_optimization`；提交后推远程，人工合并 dev 部署。
- vendor 只读铁律的受控例外：最小 diff、逐行 `[miniapp-patch]` 注释、登记 `vendor/sillytavern/NOTICE.md`；禁止绝对路径 import（逃逸 `/st-runtime/` 命名空间产生双模块图）。
- pre-commit 有 lint-staged/prettier，pre-push 有前端 lint 预检。
- 上游合并保护规则见 `.cursor/rules/upstream-merge-protection.mdc`。

---

## 七、追记（2026-07-17 深夜 ~ 07-20）：坏模块图卡点收敛全程

### 7.1 §四计划第 1/2 项落地（`31ad3c1`，PR #150）

- **补正则**：`MINIAPP_FATAL_RE` 增 `before initialization`，覆盖 iOS 18.7 / V8 的 TDZ 措辞。验证生效：iOS 样本开始出现 `boot_fatal:"rej:Cannot access 'extension_prompt_types' before initialization"`。
- **方案 a**：boot_fatal 触发的重连 URL 带 `miniapp_nuke=1`（bridge-client `nukeCacheOnNextReconnect` 标志，仅 boot_fatal 置位、用后即清）；nginx `/tavern` 对该参数回 `Clear-Site-Data: "cache"`（`map $arg_miniapp_nuke`，非命中不发头、正常首访零影响）。

### 7.2 恢复结局埋点（`fa74e0b`，PR #157 前后合入）

为无歧义统计自愈成功率新增：每条 beacon 的 `details.recovery`（`boot_fatal=N nuke_reload=M reload=K` 累计）、`first_boot_fatal` mark（算恢复耗时）、`reason=recovery_ok` beacon（坏图后恢复到 ready，每 episode 一次）、`reason=boot_disconnected` beacon（终态兜底——原本永久卡死等不到 chat_ready 是统计盲区）。

### 7.3 方案 a 压测结论：**iOS 上无效**（部署 #162 实测）

iOS 18.7 压测约 5 个 episode **全部失败、0% 自愈**，至少 2 个走到 `boot_disconnected` 终态。curl 实测 nginx 确实回了 `Clear-Site-Data: "cache"`，但 **iOS WKWebView 收到后不清缓存**（nuke 重载后同一 TDZ 原样复发、模块全部 `+0ms` 缓存命中）——方案 a 对 WebKit 是 no-op。Chromium 系（此前 Mac/Desktop 样本）有效。方案 a 链路保留作纵深防御（boot_fatal 归零后等于休眠保险丝）。

### 7.4 方案 b 根治落地（`ffa0002`，PR #164）

入口审计结论：5 个 `<script type="module">` 根中，`scripts/i18n.js`（import `power-user.js`）与 `lib/eventemitter.js`（被 `scripts/events.js` 引用）都通向 script.js 大循环图——**i18n.js 是危险的第二入口**，观测 TDZ 变量（`power_user`/`trackMissingDynamicTranslate`/`extension_prompt_types`）正是该邻域导出。

改法：5 根合并为**单一内联 module 根**，静态 import 按原文档序排列。要点：

- 单根之下无多根竞速，DFS 求值顺序与规范下原 5 根**逐模块一致**（循环圈仍经 i18n → power-user 进入，即联网验证过的好顺序），Web 直访零行为变化；
- 内联而非独立 boot 文件：文档 no-store 根永不陈旧，且无需新增 nginx 路由（新根文件会落 `location /` 404）；
- import 相对文档 base（含 `/st-runtime/<hash>/` 命名空间），与原 src 解析出相同 URL——无双模块图风险。

已登记 NOTICE.md（回滚 = 还原 5 行 src 标签、删内联块）。

### 7.5 方案 b 验证（部署 #164，2026-07-20 压测）

三平台 24 次冷启动（Android 8 / iOS 9 / Desktop 7，含大量缓存热态重启即原触发条件）：**TDZ boot_fatal 0 次、gate_stall 0、boot_disconnected 0，点卡 100% 成功**。上轮 100% 卡死的同一台 iPhone 本轮 9/9 干净。按上轮 70%+ 触发率估算，24 次全净的概率 <1e-5，结论可置信。耗时无回归（解析段与 baseline 同量级；interactive 全样本领先 APP_READY 280–400ms；fastNewChat 全样本保持）。

### 7.6 当前待办（更新后的 §四）

1. ~~补正则~~ ✅（7.1）
2. ~~方案 a~~ ✅ 落地但 iOS 无效（7.3），保留作纵深防御
3. ~~方案 b~~ ✅ 根治并验证（7.4/7.5）
4. **验证 T2 原始收益**：dev 跑数天自然流量确认 boot_fatal 持续为零后合并 pro，用 pro 真实流量验证 interactive 相位对慢 Android 长尾的收益（对照 24.6s 闸门等待动机样本）。验收口径见 `docs/iframe-optimization-t0-t2-report-2026-07-20.md` §四。
5. **埋点清理**：全部 `[iframe-timing]` TEMP DEBUG（含 7.2 的恢复结局埋点）在项目收尾时一次性移除；vendor 探针在 NOTICE.md 有登记。
