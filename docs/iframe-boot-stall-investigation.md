# ST iframe 首载停摆(挂死)专项排查 — T0(2026-07-09)

> 定位:pro 实测「iframe 首次加载中途整体停摆,直到超时重载才恢复」。停摆一旦发生,
> 所有冷启动耗时优化对该用户无意义,故列 T0。本文交接给独立排查窗口;
> 耗时优化主线(碎片囤积修补)在另一窗口并行,互不阻塞。
>
> 上下文文档:`iframe-cold-boot-progress.md`(round-3 优化与基线)、
> `iframe-cold-boot-optimization.md`(架构与排查方法)、`ARCHITECTURE.md`。
>
> **⚠️ 接手请先读 §七(2026-07-10 更新)**:根因已确认(=H1)、两轮 CSS 修复(1px / 全尺寸遮挡)
> 均**未能消除 iOS 停摆**、点卡即检(#5)已验证为**有效兜底**。§一~§六 为 T0 原始排查记录,
> 结论以 §七 为准。

---

## 一、已确认事实(2026-07-09 pro 实测,均有日志留痕)

### 停摆发生率:5 个冷启动样本 4 个停摆(80%),不是偶发

| 本地时间 | 首载结果 | 用户代价(点卡→呈现) | 恢复方式           |
| -------- | -------- | ------------------- | ------------------ |
| 18:26    | 停摆     | 74.3s               | 60s 握手总超时重载 |
| 18:32    | 停摆     | 63.4s               | 同上               |
| 19:04    | 停摆     | 66.1s               | 同上               |
| 19:06    | **正常** | 9.2s                | —                  |
| 19:26    | 停摆     | 62.0s               | 同上               |
| 19:32    | 停摆     | 61.5s               | 同上               |

(18:2x 两例在部署后 13 分钟内;19:26/19:32 距部署 1 小时+,**部署窗口假设已排除**。)

### 停摆精确签名(nginx access log 还原,两种变体)

- **变体 B(已确认 2 例,19:26/19:32)**:文档/静态资源正常到达
  (19:26 首载 197 请求 2.9MB 在 1 秒内全部 200;19:32 静态全命中本地缓存),
  iframe `load` 事件正常触发,`/csrf-token` 返回 200,然后 boot JS 的
  **下一个请求(按 vendor 序列是 `/version`)永远没有到达 nginx**,直到超时重载。
  → 挂死点在客户端 fetch 层,不在服务端(服务端根本没收到请求)。
- **变体 A(疑似,18:2x 两例)**:文档+user.css+csrf-token 后 nginx 零请求、
  `load` 从未触发。注意:当时静态缓存已热,nginx 无请求 ≠ 浏览器无加载
  (memory cache 命中不出网),所以 A 可能只是 B 的另一种观测面,待
  `iframe_onload_aN` 按次打点数据(v2 已加)区分。

### 共同点与关键相关性

- 挂死永远发生在**首载**;超时重载后 **100% 一次恢复**,同一个连接环境秒好。
- 4 次停摆全部发生在 **iframe 隐藏期**(用户在大厅浏览、boot 在后台跑,
  平台用 `w-0 h-0 opacity-0` 隐藏 iframe);重载成功时用户已点卡、iframe 可见。
  唯一正常样本(19:06)虽也是后台 boot 但未停摆——隐藏是强相关不是充分条件。
- 环境:iPhone Telegram WebView(WebKit 内核),链路 手机→Telegram→Vercel 边缘→nginx(SG)。

---

## 二、看门狗现状:能做到什么、做不到什么

三层安全网(全部在 `frontend/src/lib/bridge/bridge-client.ts`,共享重连额度
max 3 次 + 退避 2/4/8s):

| 层                            | 触发条件                          | 状态                                          | 覆盖                            |
| ----------------------------- | --------------------------------- | --------------------------------------------- | ------------------------------- |
| load 看门狗 15s(安全网 #3)    | start/重连后 15s 无 iframe `load` | **main 已上线**                               | 变体 A(load 不触发)             |
| 握手到达看门狗 30s(安全网 #4) | start/重连后 30s 无首段握手       | **`debug/boot-watchdog-v2` 分支,待合并 main** | 变体 B(load 已触发、fetch 挂死) |
| 握手总超时 60s(安全网 #2)     | 60s 未完成握手                    | main 已上线                                   | 全部(兜底)                      |

触发时会打 `iframe_load_watchdog` / `handshake_arrival_watchdog` 埋点标记,
beacon timeline 里可直接看到哪层触发。

**看门狗的上限(为什么它不算解决)**:

1. 只能止损不能根治:变体 B 走 30s 看门狗后用户仍要等 30s+重载 ~17s ≈ **47s 才呈现**;
   即使把阈值压到贴着正常握手最迟值(~17s),停摆代价也 >30s。
2. 阈值不能再激进:正常首段握手实测最迟 ~17s(慢网络+冷缓存),30s 已是
   「不误伤正常慢 boot」的下限附近。
3. 重连额度耗尽(3 次)即终态 disconnect——若停摆是系统性的(如本轮 80%),
   连续命中会直接把用户打进死路。

---

## 三、根因假设(按证据强度排序)与验证方法

### H1:WebView 对不可见 iframe 的网络/定时器压制(相关性最强)

4/4 停摆在隐藏期。iOS WebKit 对 `display:none`/零尺寸 iframe 有已知的
资源调度降级行为;Telegram WebView 可能叠加自己的省电策略。

- 验证:前端给 beacon 补打 `document.visibilityState`、iframe 可见性、
  页面前后台切换事件(`visibilitychange`)时间线,与停摆时刻对齐。
- 实验:把隐藏方式从 `w-0 h-0 opacity-0` 改成 `visibility:hidden` 全尺寸,
  或 1×1 px 可见,对比停摆率(注意别回归 iframe 常驻铁律)。
- 若成立的修复方向:预加载期保持 iframe「技术上可见」;或点卡时若未握手
  直接主动重载一次(比看门狗更快,可与 H1 修复并存)。

### H2:首连 HTTP 连接层挂死(Telegram 代理/Vercel 边缘/HTTP2 stream 卡死)

签名是「csrf-token 200 之后下一个 fetch 永久 pending」,像是连接池里
某条连接进入僵尸态,后续请求排队在死连接上;重载强制新建连接所以必好。

- 验证:看门狗触发时、重载**之前**,先收割停摆 iframe 的
  `performance.getEntriesByType('resource')`——挂死的请求会以
  「有 startTime、无 responseEnd」的形态留在 buffer 里,能精确定位挂在哪个
  URL、DNS/TCP/TTFB 哪一段(需要 st-extension 之外的注入手段:停摆时扩展
  还没加载,可由父窗口经 `iframe.contentWindow.performance` 同源读取)。
  这是**下一步最值得做的一件事**:把「黑盒停摆」变成「有现场的停摆」。
- 若成立的修复方向:fetch keepalive/重试参数不可控(vendor 只读),
  现实路径还是「快检测+快重载」,把检测提前到秒级(见 §四-2)。

### H3:cookie/会话时序问题(权重低)

`init-st-session` 写 `SameSite=None; Partitioned` cookie 后才挂 iframe;
若 cookie 分区/失效,ST 会 302 /login——但那会表现为文档层异常而非
csrf-token 之后挂死,且重载(同 cookie)必好与此矛盾。仅在 H1/H2 排除后再查。

---

## 四、解决停摆还需要做的事(建议顺序)

1. **合并 `debug/boot-watchdog-v2` 进 main**(30s 握手到达看门狗 + `iframe_onload_aN`
   按次打点 + 瀑布缓冲修复)——先把最坏等待从 62s 压到 ~32s,同时拿到区分
   变体 A/B 的数据。
2. **停摆现场收割**(H2 验证项,父窗口同源读 iframe performance buffer,
   看门狗触发时先收割后重载,beacon 带上 pending 请求列表)——定位挂死的
   具体请求与阶段。
3. **可见性时间线埋点**(H1 验证项)+ 若相关性坐实,做隐藏方式实验。
4. **点卡即检**:用户点卡时若 bridge 仍未握手且已超过 N 秒,不等看门狗直接重载
   (用户点卡时刻 iframe 转可见,此时重载恢复率实测 100%)。
5. 根因修复(按 H1/H2 结论定),目标:停摆率归零,看门狗退回纯保险。

## 五、排查工具速查

```bash
# beacon 主行 + 瀑布行(看门狗标记在 timeline 里)
railway logs -s stminiapp -e production --lines 3000 --filter "iframe-timing" --json
# nginx 请求节奏(判定停摆窗口:某秒后零请求)
railway logs -s nginx-pro -e production --lines 5000 --json
```

- 停摆判定:beacon `[冷]iframe_load(网络)` 或「点卡→闸门」异常大(>30s),
  且 timeline 中 `iframe_onload` 偏移 ≈ 超时值+退避+文档耗时。
- 看门狗触发:timeline 含 `iframe_load_watchdog` / `handshake_arrival_watchdog`。
- 首载 vs 重载:`iframe_onload_a1` / `_a2` …(v2 部署后可用)。
- 铁律不变:`vendor/sillytavern/` 只读;所有修复走 frontend / st-extension / 配置。

## 六、当前部署状态(2026-07-09 20:20)

> ⚠️ 本节为 T0 时点快照,已被 §七 覆盖(watchdog-v2 早已合并 main;又叠加了 round-2 修复)。

- main(pro 已部署):15s load 看门狗、60s 总超时+重连、瀑布探针 v1(有 250 条缓冲截断)。
- `debug/boot-watchdog-v2`(已推送,**待合并**):30s 握手到达看门狗、
  `iframe_onload_aN`、瀑布缓冲扩容+同名聚合。

---

## 七、round-4 更新(2026-07-10):根因确认 + 已实现修复 + 效果 + 现状

### 7.1 根因已确认 = H1(WebKit 对「不可见」文档降级),H2 是其表象,H3 排除

对 vendor `firstLoadInit()` 复核 + 全尺寸遮挡实验共同锁定:停摆是 **iOS/Telegram WebKit
把「不产生可见渲染的文档」判为后台文档并降级——挂起网络请求投递**。

- 停摆窗口精确落在 vendor `script.js` 的 `fetch('/csrf-token')`(815 行,到 nginx 200)与
  `getClientVersion()→fetch('/version')`(858 行,永不到 nginx)之间,即 boot **最前段**。
- 因扩展由 `getSettings()`(875 行)内 `activateExtensions` 才加载,远在 `/version` 之后 →
  boot 楔死在前段 → 扩展从不 init → **「握手永不到达」是下游症状,不是根因**。
- H2(「csrf 后 fetch 永久 pending」)是 H1 的**表象**(网络投递被挂起,非死 TCP)。
- H3(cookie):csrf 已 200、同 cookie 重载必好 → 排除。

### 7.2 已实现的修复(按时间)

| 轮次        | 修复                                                                                                                                                              | 位置                                                                                                  | commit/PR        | 判定                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------- |
| round-1     | 隐藏预热 `w-0 h-0 opacity-0` → **1×1px** `opacity-[0.01]`(以为「非零面积」即可)                                                                                   | `st-iframe.tsx`                                                                                       | PR #99(1px)      | ❌ **无效**,iOS 仍停摆                                        |
| round-2 (a) | 隐藏预热 → **full-size、full-opacity、视口内真实图层** `z-[-20]` + `z-[-10] bg-background` 不透明遮罩挡住                                                         | `st-iframe.tsx`                                                                                       | 35febcd(PR #103) | ❌ **无效**,iOS 仍停摆(见 7.3)                                |
| round-2 (b) | **点卡即检(安全网 #5)**:进入 `/tavern/` 时若未握手,按「距 boot 起点 `visibleStallReloadMs`(默认 18s)」武装更早的停摆重载,不等 30s 握手到达看门狗;与其并存取更早者 | `bridge-client.ts`(`onActivated`/`armClickStallWatchdog`)+ `bridge-provider.tsx`(isVisible→true 调用) | 35febcd          | ✅ **有效兜底**(见 7.3)                                       |
| round-2 (c) | beacon 后端日志补记 `plat=iOS/Android/Desktop/other` + `ua=`(供分平台统计)                                                                                        | `backend/routes/debug.ts`                                                                             | 35febcd          | ✅ 已上线                                                     |
| 并行(他人)  | 摘除 ST 原生欢迎屏在 APP_READY 的渲染(省 boot 收尾一发 `/api/chats/recent`)                                                                                       | `st-extension/patches/welcome-screen-suppress.ts`                                                     | 82afd9f          | ✅ 生效(nginx 侧 `/api/chats/recent` 归零;收尾段 ~3s→~1–2.3s) |
| 并行(他人)  | 回滚「boot 尾段跳过恢复上次聊天」(实测无效操作)                                                                                                                   | `sync-engine/provisioner/merger.ts`                                                                   | 22830c6          | —                                                             |

> (a) 失败的原因:把 full-size iframe 压到负 z / 被遮罩挡住,**「被遮挡/负 z」在 WebKit 眼里
> 仍等于「不可见」**,照样降级。**「对用户不可见」与「对 WebKit 可见」在 iOS 上不可兼得
> → 纯 CSS 隐藏方案对 iOS 本质走不通。**

### 7.3 实测效果(2026-07-10,pro,分平台)

**前提:round-2 前端(Vercel)于 `last-modified 08:31:06Z` 才上线**(bundle chunk 头 + `click_stall_reload`
字符串首次出现均指向该时点)。前端/后端/ST 三者独立部署,`plat=`(后端)早于前端就绪,
**不能据 `plat=` 判定前端版本**。故:

- `07:29–08:10` 各会话跑的仍是**旧 build**(round-1 1px):
  - 07:29–45 六次冷启动 0 停摆 = 旧 build 撞上快 boot 的**运气,非 (a) 验证**(上一轮结论作废)。
  - 08:06 / 08:10 两次 iOS **停摆**,无 `click_stall_reload`、走 30s 握手看门狗,`点卡→呈现 35 / 36s`。
- `08:31:45` iOS = **首个确证跑 round-2 的会话**(`click_stall_reload` 触发):
  - **仍停摆**:`a1@+4062` 已 load,到 +18s 无握手 → boot 楔死在隐藏预热期 → **证明 (a) 未挡住**。
  - **(b) 生效**:`click_stall_reload@+18002` 主动重载 → `a2@+23816` → 握手/ready → `点卡→呈现 25.7s`
    (对照旧 build 停摆的 ~33–36s,(b) 省约 10s)。
- Android `08:31:36`:另一种 load 级挂死(`iframe_load_watchdog` + a2/a3,`load=77s`),疑似链路/网络,
  与 iOS 的 boot 前段楔死不同,样本单一待观察。

**分平台冷启动耗时(旧 build,07:29–45,均无停摆时):** Desktop 5.6–8.8s < iOS 10–16s ≈ Android 13s。
差距主因是**设备算力**(解析段 `ext`:Desktop ~2–2.9s vs 手机 3.7–5s),**非浏览器引擎**
(iOS WebKit 与 Android Blink 接近)。

### 7.4 当前停摆现状(交接结论)

- **iOS 停摆未消除**。两轮 CSS 隐藏方案(1px / 全尺寸遮挡)均无效——根因(WebKit 后台降级)
  无法靠「让 iframe 对用户不可见的同时对 WebKit 可见」的 CSS 技巧规避。
- **唯一有效的是点卡即检 (b)**:把 iOS 停摆代价从 ~33–36s(30s 看门狗)压到 ~22.5s(18s 触发)。
  但 (b) 是**止损兜底**,非根治;且 round-2 iOS 真实样本目前仅 1 个,残余停摆率未量化。
- Android/Desktop:本轮未见 boot 前段楔死型停摆(Android 有 1 例 load 级挂死,另一性质)。

### 7.5 给新窗口的建议(按优先级)

1. **把 (b) 调激进**(小改、单文件):`visibleStallReloadMs` 18s → **10–12s**。iOS 正常握手实测
   仅 ~5–7.6s(旧 17s 是冷缓存离群),10–12s 有余量、不误伤健康 boot,又能把停摆代价再降 ~6–8s。
2. **多攒 round-2 样本**(尤其 iOS/Android)量化真实残余停摆率,再决定是否加码。
3. **放弃用 CSS 根治 (a)**(保留无妨、对 Android/边角可能有益、零害),把 (b) 当主防线;
   必要时叠加**开屏进度反馈**(体感,物理上 iOS 停摆无法用 CSS 100% 消除)。
4. (可选)仍未做的 H2 现场收割(§四-2):父窗口 `iframe.contentWindow.performance` 收割停摆
   pending 请求,精确到挂在 csrf-body 还是 /version;不改结论,但能把「投递被挂起」再实锤一层。
5. **验证纪律**:每次下结论前,先 `curl -I` Vercel bundle 的 `last-modified` + grep 目标字符串
   (如 `click_stall_reload`/`z-[-20]`)确认前端**确已上线**,避免再把旧 build 误当新 build。

### 7.6 关键代码位置(round-2)

- (a) 隐藏预热渲染方式 + 遮罩:`packages/frontend/src/components/bridge/st-iframe.tsx`
- (b) 点卡即检:`packages/frontend/src/lib/bridge/bridge-client.ts`
  (`onActivated` / `armClickStallWatchdog` / `visibleStallReloadMs` 选项 / 标记 `click_stall_reload`);
  调用点 `packages/frontend/src/components/bridge/bridge-provider.tsx`(`isVisible` effect)
- (c) 分平台埋点:`packages/backend/src/routes/debug.ts`(`plat=` / `ua=`)

### 7.7 分平台排查速查(beacon 已带 plat=)

```bash
railway logs -s stminiapp -e production --lines 3000 --json  # 主行含 plat=iOS/Android/Desktop
railway logs -s nginx-pro -e production --lines 4000          # --json 大 lines 会报 Invalid input,用纯文本
```

- 停摆判定:beacon `aN=['1','2'...]`(出现 a2 = 发生过重载)+ timeline 含
  `handshake_arrival_watchdog`(30s 看门狗)或 `click_stall_reload`(点卡即检);boot 楔死时
  `iframe_onload_a1` 已触发但 `st_init_start` 迟迟不来(隔一次重载才出现)。
- 前端版本核对:`curl -sI https://st-miniapp-frontend.vercel.app/_next/static/chunks/<chunk>.js`
  看 `last-modified`;或 grep bundle 是否含 `click_stall_reload` / `z-[-20]`。

---

## 八、传导路径全景(2026-07-10 补充,给新窗口的因果链速读)

> 目的:把 §一~§七 的分散证据串成一条「从平台策略到用户耗时」的完整因果链,
> 一眼看懂「握手失败 / 停摆 / boot 耗时长」三者其实是同一件事的不同侧面。

### 8.1 先厘清「握手」——它是信号灯,不是独立会失败的协议

- 发出「首段握手」的是注入进 ST 的 **st-extension**,而它由 vendor `script.js` 的
  `getSettings()`(875 行)内 `activateExtensions` 才加载——排在 boot 前段一串网络调用**之后**。
- 所以父窗口「收到握手」≈「ST boot 已跑过前段、成功进到扩展激活阶段」。
- **关键**:握手到达是 boot 健康推进的**信号灯**,不是一个独立会「失败」的握手协议。
  「握手不到达」永远是「boot 在扩展加载前被掐死」的**下游症状**,不是病因本身。

### 8.2 传导路径(5 步)

```
① 平台策略:iframe 必须在【隐藏态】预热(常驻预加载铁律,为点卡零等待)
      │
② iOS/Telegram WebKit 省电降级:把「不产生可见渲染的文档」判为后台文档
   → 节流定时器 + 挂起(暂停投递)网络请求
      │
③ boot 前段是串行网络链,正撞降级窗口:
   /csrf-token(script.js:815)──200──► 到 nginx ✅
   /version   (script.js:858)──────► 投递被 WebKit 挂起,永不到 nginx ❌
      │
④ boot 楔死在最前段:/version 发不出 → getSettings(875)/activateExtensions 永不执行
   → st-extension 从不加载 → 首段握手永不发出
      │
⑤ 父窗口视角:iframe 已 load、但握手迟迟不到 → 判定停摆
```

**一句话**:不是握手脆弱,是「隐藏态预热(平台必需)」与「iOS 对隐藏文档降级(平台特性)」
**天生冲突**。boot 在扩展加载前就被掐停,握手根本没机会发出。pro 实测 80% 冷启动命中此冲突,
故「很容易失败」。

### 8.3 为什么导致 boot 耗时暴涨——全是次生代价

楔死后 boot 不会自愈(WebKit 不主动重投挂起请求),只能靠看门狗兜底重来:

```
健康 boot:  5–9s 直接完成 ✅
停摆 boot:  boot 楔死(白等) ─► 看门狗到阈值 ─► 重载 iframe ─► 重新冷启动 boot
              ↑ 纯浪费           ↑ 阈值时长        ↑ ≈ 重跑一遍
```

用户代价 = **白等的停摆时长 + 重载后重跑 boot**,全是「等 + 重来」的额外开销,boot 本体没变慢:

| 兜底层                      | 阈值 | 实测点卡→呈现 |
| --------------------------- | ---- | ------------- |
| 60s 握手总超时(最早)        | 60s  | ~62–74s       |
| 30s 握手到达看门狗          | 30s  | ~33–36s       |
| 点卡即检 round-2            | 18s  | ~22.5s        |
| 点卡即检(2026-07-10 调激进) | 10s  | 预计 ~15s     |

**停摆归零 → boot 回到健康的 5–9s,看门狗退回纯保险。**

### 8.4 平台差异:此型停摆 ≈ iOS/WebKit 独有

要分清「**这个特定机制**」与「**后台节流泛概念**」:

- **iOS(WebKit)**:根因是 WebKit 对隐藏文档**挂起网络投递**这一特定行为。实测 4/4 停摆在隐藏期、
  round-2 全尺寸遮挡后 iOS 仍停摆 → 前段楔死型停摆坐实。
- **Android(Blink)**:本轮仅 1 例 **load 级**挂死(`load=77s`),文档判为**另一种性质**(疑似链路/网络),
  **非** iOS 前段楔死。
- **Desktop**:本轮未见此型停摆。
- 结论:**不是「同一问题 iOS 概率高」,而是「iOS/WebKit 有一个别人基本没有的降级机制」**。
  Blink/Desktop 对「同页面内隐藏 iframe」不会激进到暂停网络投递,故未重现此链路。
  主防线(点卡即检)主要为 iOS 设计;Android/Desktop 靠通用看门狗覆盖即可。

### 8.5 根治边界:为什么并行化不治停摆,以及真正能「保证握手发出」的手段

**Q:把 `getClientVersion / initSecrets / readSecretState / initLocales` 串行 await 合并为
`Promise.all`,能治停摆吗?**

- **不能,治标不治本(对停摆)**。停摆是 WebKit 对**后台文档**挂起网络**投递**,与请求串行/并行无关:
  并行只是把 N 个请求「一起被挂起」而非「逐个被挂起」,第一个请求(/version)照样发不出。
- 它也**无法把握手提前**越过降级窗口——握手依赖远在下游的 `activateExtensions`,与前段是否并行无关。
- 该并行化是 §`iframe-cold-boot-progress.md` 三-2 登记的**健康 boot 提速项(省 1~2s)**,
  与停摆是两个问题,别混淆。至多在「有宽限窗口」的假设下**边际降低**停摆概率,但未经验证、不可依赖
  (本文档核心论断即:CSS/时序技巧无法可靠规避根因)。

**Q:那什么能真正保证握手发出?只能从「隐藏预热 vs iOS 降级」这个冲突入手吗?**

是的,本质上必须**打破两只角之一**,没有免费午餐:

| 方向                                      | 做法                                                                         | 结论                                                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **A. 破「iOS 降级」角**(让 WebKit 认可见) | CSS 让 iframe 对 WebKit 可见但对用户不可见                                   | ❌ 已证死路(1px/全尺寸遮挡/负 z 全被判不可见);唯一真可见方案需对用户也可见 → 要产品级重设计(如 boot 跑在可见开屏上)         |
| **B. 破「隐藏预热」角**(点卡后前台 boot)  | 放弃隐藏预热,用户进 /tavern/(iframe 转可见)再 boot                           | ✅ 前台 boot 不停摆、最稳的「保证」,但丢掉「点卡零等待」,与常驻预加载铁律冲突                                               |
| **C. 绕过:消除前段网络**(bootstrap 注入)  | 前段所需数据(csrf/version/secrets/locales)在文档创建时内联注入,ST 不发 fetch | ⚠️ 仅当「挂起只针对 fetch/XHR」且「到握手前全程可无网络」才成立;扩展 JS 加载大概率仍需网络 → 未验证、改动重、依赖拦 ST boot |
| **D. 保活 hack**(Web Audio 等)            | 用音频/定时器等骗过后台判定                                                  | ❌ 那是**标签级**节流的规避手段,骗不过 WebKit 对**隐藏 iframe 可见性**的判定,不可靠                                         |

**「点卡即检」为何有效——它其实是 B 的务实混合**:隐藏态尽力预热(best-effort),
一旦用户点卡让文档**转可见**、且未握手就重载 —— 恢复 boot 此时跑在**前台可见态**,
不再停摆(实测 100% 恢复)。即:**接受停摆、用「转可见 + 重载」把恢复 boot 拉回前台执行**,
以「多等一次重载」的代价换「保证握手发出」。这是目前性价比最高的路径;A/C 均需付出产品/工程重代价。
