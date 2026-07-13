# ST 冷启动压缩 —— 阶段总结与后续优化计划（2026-07-09）

> 本文是 `docs/iframe-latency-investigation.md`（round-1 三点根因修复）与
> `docs/iframe-cold-boot-optimization.md`（round-2 瓶颈定位）的后续，总结 round-3
> 已落地的优化、当前实测耗时基线，以及下一阶段按价值排序的优化点。
>
> 聚焦问题：**「用户进入 miniapp 后快速点卡」场景**。iframe 常驻使冷启动只在每会话
> 首次发生，且与大厅浏览时间重叠——但用户点卡快时浏览时间压不住 boot，
> 「点卡→闸门」等待暴露（round-3 实测 10 个会话中 7 个非零，中位数 ~8.9s）。
> 因此冷启动本体的继续压缩仍是主线。

---

## 一、已实现的优化措施

### Round-1/2 遗留（本轮前已在线）

| 措施                                                                              | 位置                       | 效果                                                                 |
| --------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------- |
| 静态资源缓存分档（ST 原生包 90d immutable / third-party no-cache / 用户数据不动） | `ops/nginx/nginx.conf`     | 免重复下载 ~200 个 JS/CSS                                            |
| 老用户先登录放行、provision 后台异步刷新                                          | `backend/routes/bridge.ts` | init-st-session 压到 ~0.6s                                           |
| bridge 握手超时（60s）带退避自动重连安全网                                        | `frontend/lib/bridge`      | 首次加载整体卡死时自动重载恢复（07-09 部署窗口实测触发两次，均恢复） |

### Round-3 新增（本轮 5 个 commit，全部不改 vendor）

| #   | 措施                                                                                                                                                                                                       | commit    | 实测效果                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | provision 强制禁用 10 个平台无用内置扩展（tts/vectors/stable-diffusion/gallery/caption/translate/expressions/connection-manager/assets/attachments，merger 强制并入 `disabledExtensions`，用户段无法解禁） | `f8e988e` | 扩展串行窗口 8.1s → 4.1s                                                                                               |
| 2   | 酒馆助手（JS-Slash-Runner）静态资源 30 天缓存（原 third-party 全量 no-cache 导致每次 boot 全量重下 ~890KB gzip）                                                                                           | `b343612` | 扩展窗口再降至 2.3~3.0s；nginx 实测缓存命中后 3 个大文件零请求                                                         |
| 3   | `lazyLoadCharacters: true` + selectCharacter 单卡增量注入（boot 只拉浅层列表；懒下发新卡走 `/api/characters/get` 单卡注入内存，替代全量重扫）                                                              | `044daef` | `SETTINGS_LOADED→CHARACTER_PAGE_LOADED` 2.4s → 1.0s；H1 全量重扫消除（注入路径待「历史首开新卡」验证 `injected=true`） |
| 4   | 角色预览浮层打开即预取懒下发（ensure 提前到点卡时刻，会话级共享 promise 去重）                                                                                                                             | `3c8e982` | 待部署验证；预期 ensure 0.6~1.9s 从关键路径消失                                                                        |
| 5   | 消除切卡关键路径远程 token 计数（st-extension 移除 `data-token-counter` 属性使 RA_CountCharTokens 零调用 + merger 强制 `message_token_count_enabled=false`）                                               | `2990ce9` | 待部署验证；预期 H2 /newchat 2s → 0.5~1s                                                                               |

> #4/#5 优化的是「点卡后路径」而非冷启动本体，列入以完整记录本轮改动。

---

## 二、当前耗时基线（2026-07-09 17:2x，10 次冷启动样本，#4/#5 部署前）

**冷启动全长（bridge_start→APP_READY）：中位数 15.2s**（基线 23.7s，-36%）。
样本分布：13.5 / 14.2 / 14.9 / 15.1 / 15.2 / 15.3 / 17.1 / 19.6 / 21.9 / 31.4s。

分段中位数：

| 相位                                                                   | 中位数   | 说明                                                                                         |
| ---------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `bridge_start → iframe_onload`（网络：/tavern 文档 + 同步资源）        | **3.8s** | 静态包已缓存，主要是文档请求 + 缓存校验 + 跨洲首连                                           |
| `iframe_onload → st_handshake`（脚本解析执行 + boot 前段串行网络调用） | **4.5s** | CPU 与 RTT 混合段；两个离群样本（8.2/10.3s）出现在快速连续进出的资源竞争时段                 |
| `st_handshake → APP_READY`（boot 后段）                                | **7.3s** | 再拆：扩展窗口 ~2.3-3.0s + 角色浅层列表 ~1.0s + 收尾 ~3s（含载入 active_character 上次聊天） |

快速点卡场景（本轮 7/10 会话）：点卡→闸门中位数 **~8.9s**（4.3~27.6s），
首卡点卡→呈现中位数 **~12.6s**。大厅充分浏览时点卡→闸门=0，点卡→呈现 3~5s。

---

## 三、下一步优化点（按价值排序）

### 1. boot 尾段跳过「恢复上次聊天」（预计省 1.5~3s，零 vendor，优先做）

boot 收尾 ~3s 里包含载入 `active_character` 的上次聊天（chats/get + 世界书/
正则联动的一串调用）。**平台进卡必然 forceNewChat、ST 原生界面在闸门开前完全不可见**，
boot 时恢复上次聊天是纯浪费。思路：merger 在 B 段覆盖后强制清空
`active_character`（该字段在 writable_paths 白名单内会被用户回流值覆盖，须置于
覆盖之后；`character_ref` 校验对空值放行，见 merger `if (!currentVal) continue`）。
需确认：无其他业务依赖 active_character 兜底显示（平台壳不渲染 ST 原生首屏，预期无）。

### 2. #4 boot 前段串行调用并行化（预计省 1~2s，vendor ~5 行，铁律已放开）

`firstLoadInit`（vendor `script.js:813`）在 `getSettings` 前串行 await 一串独立
网络调用：`getClientVersion / initSecrets / readSecretState / initLocales /
initPresetManager / initSystemMessages`。多为无依赖小请求，`Promise.all` 化把
N×RTT 压向 1×RTT。这是首个 vendor 修改，要求：最小 diff、逐行注释标记
`[miniapp-patch]`、在 `vendor/sillytavern/NOTICE.md` 登记，便于审计与回滚。

### 3. #5 剩余扩展加载并行化（预计省 0.5~1s，vendor 1 行，排后）

剩余扩展窗口 2.3~3.0s 的大头是酒馆助手（1.7MB，下载已缓存、解析执行不可免）。
`activateExtensions`（vendor `extensions.js:710`）去掉循环内 `await` 即并行，
但上限受最大单体（酒馆助手）压制，且改变扩展执行顺序有时序风险
（loading_order 语义、bridge 握手时机）。等 #1/#2 落地复测后再决定。

### 4. iframe 卡死快速看门狗（鲁棒性，不缩短正常路径）

现安全网等满 60s 握手超时才重载 iframe。加一道「`iframe_onload` 15~20s 未触发
即主动重载」，把部署窗口/链路抖动导致的极端等待从 ~63s 压到 ~20s。

### 5. 感知层：闸门等待的进度反馈（体感优化）

快速点卡撞上 boot 残余时（中位数 ~8.9s），当前开屏动画无进度语义。
给 ChatSplash 接入 bridge 相位（SETTINGS_LOADED / CHARACTER_PAGE_LOADED…）
显示阶段性文案，不缩短等待但显著降低「卡死感」。

### 6. 中期（另行立项）：就近/多区域部署、boot 数据 bootstrap 注入

见 `iframe-cold-boot-optimization.md` §七-D。物理缩短 RTT 是把 3.8s 网络段和
所有 boot 调用单价降一个量级的唯一手段；bootstrap 注入把「N 次串行调用」变
「1 次」，改动重、依赖拦 ST boot。

### 明确不做 / 已排除

- 压 4.5s 解析段的 bundle 体积：ST 锁 commit 不可精简；酒馆助手是产品依赖。
  该段是手机 CPU 物理成本，只能靠减少解析总量（禁扩展已做）或就近部署间接改善。
- WebView 缓存动态数据 / 保活 ST 前端实例：见 round-2 文档 §六，机制上不可行。

---

## 四、验证口径

- 埋点：`[iframe-timing]` beacon（`POST /api/debug/iframe-timing` → Railway
  backend 日志），关键字段：`ar:APP_READY@+X`（冷启动全长）、`点卡→闸门`、
  `sel_reload_done` 的 `injected=`。
- 每轮部署后至少采 5 个会话样本再下结论；冷启动指标以**中位数**报告，
  离群样本单独归因（快速连续进出会引发资源竞争性膨胀）。
- 待验证清单：#4 浮层预取（ensure≈0）、#5 token 计数消除（H2 0.5~1s、
  nginx 无 `tokenizers/openai/count`）、H1 注入路径（历史首开新卡
  `injected=true, reloadAttempts=0`）。
