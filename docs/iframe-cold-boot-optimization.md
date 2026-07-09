# iframe 首屏加载耗时 —— 瓶颈定位与冷启动优化方向

> 本文是 `docs/iframe-latency-investigation.md`（上一轮"三点根因修复"）的后续。上一轮修完
> 静态缓存(#1)/握手重连(#2)/老用户放行(#3)后，**温启动切卡仍 4–6s、会话首次点卡仍 ~18s**，
> 本轮用埋点把这段耗时逐相位拆开、定位峰值、评估修复路径可行性。
>
> 面向：接手"缩短 ST 冷启动"这项优化任务的工程师。读完应能直接知道**改哪里、为什么、别碰哪里**。

---

## 一、项目背景

- miniapp 前端（Next.js，Vercel）里**常驻挂载一个 iframe，跑的是完整的 SillyTavern(ST) 前端应用**（原生 JS，零改）。用户在自研壳里点角色卡 → 进 `/tavern/[id]` → 经 postMessage bridge 让 ST 切角色、载入对话、渲染。
- 部署拓扑：前端 Vercel；`backend`(Fastify)/`st-bundle`(ST+sync-engine)/`nginx` 都在 Railway（`asia-southeast1` 新加坡）；数据真相在 Supabase，provision 把配置从 Supabase 下发到 Railway 持久卷上的 ST 文件系统。
- 用户在 Telegram WebView（手机）里访问，链路：`手机 → Telegram → Vercel 边缘 → nginx(Railway/SG) → ST`。
- 架构与链路详见 `docs/ARCHITECTURE.md`。

---

## 二、本次解决的问题

**「用户点击角色卡 → iframe 对话呈现」平均耗时过长，不可接受：**

- 会话**首次点卡**：~18–19s（实测）。
- 之后**切卡**（同一会话内）：~4–6s（实测）。

目标：定位这段耗时的**峰值在哪个相位、属于哪个模块**，给出**可行的缩短方向**。

---

## 三、修复原则（硬约束，先读再动手）

1. **不改 ST vendor 源码**（架构铁律）。`vendor/sillytavern/` 只读、锁 commit。ST 定制只能经：
   - 配置 → `config.yaml`（`ops/sillytavern/config.production.yaml`）/ 环境变量 / provision 下发的 `settings.json`；
   - 行为 → `packages/st-extension`（注入）；
   - 视觉 → `user.css`。
2. **不回退功能**。例如"每次进卡开新对话"若是产品需求，只能优化其实现（异步化/预建），不能直接砍功能。
3. **上游 merge 保护**：不因本地优化而改写/简化 upstream 行为（见 `.cursor/rules/upstream-merge-protection.mdc`）。
4. **可回滚**：所有临时排查埋点以 `[iframe-timing]` 标注，定位完成后一并移除（见附录）。

---

## 四、排查方法与工具

- **服务端日志**：`railway logs -s nginx -e development`（access log 带 `rt=` 服务端处理耗时）、`railway logs -s stminiapp -e development`（backend）。
- **客户端相位埋点（本轮新增，临时）**：用 `Date.now()`（父窗口与 ST iframe 同设备同一时钟，绝对毫秒可直接相减）在关键里程碑打点，呈现时 beacon 到后端 `POST /api/debug/iframe-timing`，落 Railway backend 日志（手机测也能用 CLI 拉）。埋点覆盖：
  - 前端：`bridge_start`(iframe 开始加载) / `iframe_onload` / 两段握手 / `page_mount`(点卡) / `gate_open` / `ensure_*` / `select_*` / `chat_ready`；
  - ST 端：`st_init_start/done`、`selectCharacter` 内部 H1/H3/H2、ST boot 生命周期事件 `ar:SETTINGS_LOADED / ar:CHARACTER_PAGE_LOADED / ar:CHAT_CHANGED / ar:APP_READY …`。
- **关键判据**：某相位在 nginx 上服务端 `rt` 之和远小于该相位墙钟时长 → 该相位瓶颈在客户端（JS 执行 / 跨区网络往返），而非服务端。

> 实测佐证：一次 11s 窗口内 59 个请求服务端 `rt` 合计仅 3.24s（且并发），**峰值确在客户端**。

---

## 五、耗时瓶颈（按优先级）

### 实测相位数据（round-2，dev，Telegram WebView）

| 相位                                  | 工厂风云（首次·冷） | 我有一个飞机杯（切卡·温） | 升职记（切卡·温） |
| ------------------------------------- | ------------------- | ------------------------- | ----------------- |
| **点卡→呈现（总）**                   | **19144ms**         | **7006ms**                | **7872ms**        |
| 点卡→闸门（等 ST 冷启动到 APP_READY） | 13450ms             | 0ms                       | 0ms               |
| ensureCharacter（单卡下发）           | 942ms               | 923ms                     | 1386ms            |
| **selectCharacter（总）**             | **4752ms**          | **6083ms**                | **6486ms**        |
| ├ H1 找卡 + `getCharacters` 全量重载  | 1506ms              | 2345ms                    | 2017ms            |
| ├ H3 `selectCharacterById`            | 1292ms              | 1141ms                    | 1533ms            |
| └ H2 `/newchat`                       | 1940ms              | 2596ms                    | 2935ms            |

冷启动内部时间线（工厂风云，相对 iframe 开始加载 `bridge_start`）：

| 里程碑                                                                                   | 偏移     | 区间                                                                 |
| ---------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `iframe_onload`（网络：index+同步资源）                                                  | +4268ms  | **4.3s** 网络                                                        |
| `st_handshake`（本扩展 init 完成，15 patch 仅 5ms；**非 DOMContentLoaded**，见下方订正） | +10265ms | **6.0s** 脚本解析执行 + boot 前段串行初始化（CPU 与跨洲 RTT 混合段） |
| `ar:SETTINGS_LOADED`                                                                     | +18333ms | **8.1s** ← 峰值：扩展加载 + getSettings                              |
| `ar:CHARACTER_PAGE_LOADED`                                                               | +20705ms | 2.4s 角色列表加载+渲染                                               |
| `ar:APP_READY`（= 闸门打开）                                                             | +23674ms | 3.0s 收尾（含载入首个聊天）                                          |

> **订正（2026-07 对照 vendor 源码复核）**：`st_handshake` 早前标注为"DOMContentLoaded"是**错的**。
> miniapp-bridge 以 ST 第三方扩展身份、由 `getSettings()` 内部的 `activateExtensions()` 动态注入
> （`manifest.json` `loading_order:1`，在所有扩展中最先加载）；注入时 `document.readyState` 早已
> `complete`，`entry.ts` 走的是立即 `init()` 分支。反证：DOMContentLoaded 必然早于 `iframe_onload`
> (+4268ms)，不可能落在 +10265ms。由此两处归因需修正：
>
> - `iframe_onload → st_handshake` 这 6.0s **不是纯"脚本解析（CPU 慢）"**：还包含 `firstLoadInit()`
>   中 `getSettings` 之前的一串 await 串行网络调用（`/csrf-token`、`getClientVersion`、`initSecrets`、
>   `readSecretState`、`initLocales`、`initPresetManager`、`initSystemMessages`、`/api/settings/get`…），
>   是 CPU 与跨洲 RTT 的混合段。只压 bundle 体积砍不掉这一整段。
> - `st_handshake → SETTINGS_LOADED` 的 8.1s 恰好是 bridge 之后**其余内置扩展串行"下载+解析+init"**
>   的窗口（`activateExtensions` 对每个扩展逐个 await；`loadExtensionSettings` 在 emit
>   `SETTINGS_LOADED` 之前 await 完成）——P0 峰值归因不变，且比原表述更精确。

### 优先级 P0 —— 点卡后等待 ST 冷启动收尾（~13s，仅每会话首次点卡）

- 是**首卡**耗时的绝对大头（占 ~70%，13.4s / 19s）。
- **口径订正**：完整冷启动（`bridge_start`→`APP_READY`）实测 **~23.7s**；其中 ~10s 借"进 App 即挂 iframe"被大厅浏览时间吸收，13.4s 是用户点卡后**仍需等待的残余**，并非冷启动全长。
- **只在每次重开 miniapp 的首卡付一次**（iframe 常驻，同会话内切卡不再冷启动 → 温启动"点卡→闸门=0ms"）。
- 峰值在 **`st_handshake → SETTINGS_LOADED` 这 8s**：nginx 日志显示此窗口 ST 在成串加载**平台用不到的内置扩展**（`tts/` 十几个 provider：xtts/volcengine/vits/speecht5/sbvits2/kokoro/edge…、`vectors/webllm`、`stable-diffusion`、`gallery`…），每个都是"下载+解析+各自初始化网络调用"。
- 次因：4.3s 网络（index+同步资源）+ 6s "脚本解析执行 + boot 前段串行网络调用"混合段（见上方订正，非纯 CPU）+ 2.4s 角色加载（`lazyLoadCharacters:false` 全量）。
- **本扩展自身 init 只 5ms，不是瓶颈。**

### 优先级 P1 —— selectCharacter（~5–6s，每次点卡都付）

`details` 每次都是 `foundInMemory=false, reloadAttempts=1`、`forceNewChat=true`。三段：

- **H2 `/newchat`（~2–3s，最大）**：`forceNewChat:true` 每次进卡新建对话。它不是单操作，而是 ~20 个**串行**接口的级联：`chats/save`(存旧)+`chats/get`(建/载新) → 渲染开场白引发 `worldinfo/get+edit`、`characters/edit+get`、`settings/save×2`、`avatars/get`、`quick-replies/save`、以及 **10 次 `tokenizers/openai/count`**。慢在 `~20 × 手机↔SG 往返`，非服务端。
- **H1 `getCharacters` 全量重载（~2–2.3s）**：懒下发刚写盘的卡**每次都不在 ST 内存列表** → 必触发一次全量 `getCharacters()`（服务端重扫目录 + 重生成缩略图）。是懒下发策略的直接副作用。
- **H3 `selectCharacterById`（~1.1–1.5s）**：ST 载入角色+渲染，相对固有。

### 优先级 P2 —— tokenizer 同步 XHR 风暴（漏进首屏路径）

- 文档上一轮认为它只影响"对话中"，本轮发现**第二触发点**：`/newchat` 渲染开场白时 ST 要数上下文 token（10 次 `tokenizers/count`），**漏进了进卡关键路径**，是 H2 的一部分。

---

## 六、尝试/评估过的路径及可行性

| 思路                                                              | 可行性                      | 结论                                                                                                                                                                                           |
| ----------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **把动态数据缓存在 WebView**（像静态文件那样只走"手机→Telegram"） | ❌ 不可行                   | boot 读的是 per-user、随时变、真相在服务器的**状态数据**（settings/secrets/characters/chats）；且 ST 只读、boot 时序写死"向服务器拉"；缓存有**过期→用错配置/凭证**风险，写操作也必须回服务器。 |
| **让 ST 一直运行/关不掉，避免重跑**                               | ❌ 不可行（且是认知误区）   | 关小程序销毁的是 **WebView 里的前端 JS 实例**，不是服务器；ST 服务器本就一直在跑。Telegram 关闭即销毁 WebView，客户端无法保活运行中的 JS 应用。                                                |
| **把 iframe 触发时机提前**                                        | ⚠️ 已接近最早，剩余空间很小 | `STIframe` 已挂根级 `Providers`（进 App 即挂、与大厅浏览重叠），只卡在 `init-st-session`(~0.6s，cookie 硬依赖，已被修复#3压低)。实测冷启动在用户点卡前 ~10s 就已开跑。                         |
| **静态资源长缓存**（上一轮 #1）                                   | ✅ 已做                     | 免掉"重复下载"，但**免不了每次全新页面的解析/执行**，也**免不了动态数据调用**——所以"重开=慢首卡"依然成立。                                                                                     |
| **并行化 `/newchat` 的调用**                                      | ✅ 部分可行                 | 无依赖的调用可并行，把 `~20×RTT` 压向 `~1×RTT`；但有次序依赖的（存旧→建新）不能无脑并行。                                                                                                      |

**核心结论**：两个杠杆里，「提前触发」剩余空间很小，**关键是「缩短 boot 本身」**。

---

## 七、最终可行的修复方向（按优先级，均不改 vendor）

### A. 缩短 ST 冷启动（P0，救首卡 ~13s）

1. **禁用平台用不到的 ST 内置扩展**（`config.production.yaml` 现 `extensions.enabled:true` 全量加载）。
   经 provision 下发 settings 的 `disabledExtensions`，关掉 `tts` / `vectors` / `stable-diffusion` / `gallery` / `caption` / `expressions` / `translate` 等。→ 直接砍那 8s 峰值里的"文件加载+解析+各自初始化调用"。**ROI 最高。**
   > 落地前需先核对：逐个确认哪些扩展平台确实不用（保留 `regex`、我们自研 `miniapp-bridge`、以及产品依赖的第三方如 `JS-Slash-Runner` 若需要）。
2. **`performance.lazyLoadCharacters: true`**（现为 false）：boot 不再全量加载角色卡，降 `getCharacters` 成本（首卡 + 切卡 H1 同时受益）。
3. **关 `extensions.autoUpdate` / `extensions.models.autoDownload`**（订正：收益比原判低，仅作卫生项）：`autoUpdateExtensions` 只在 `versionChanged && enableAutoUpdate`（即 ST 升级后的首次 boot）才进关键路径，日常同版本 boot 不触发；`models.autoDownload` 是**服务端**按需下载 transformers 模型，不在浏览器 boot 关键路径，且其触发方（caption/expressions 等）已被 #1 禁用覆盖。可顺手关掉，但别指望它救首卡。
4. （可选）**`thumbnails` 降配**：减少 `getCharacters` 时缩略图生成压力。

### B. 缩短 selectCharacter（P1，救每次点卡 ~5–6s）

5. **消除 H1 的 `getCharacters` 全量重载**：`ensureCharacter` 下发单卡后，把该卡**增量注入 ST 内存列表**（或 ensure 返回卡元数据、桥接侧补进 `ctx.characters`），避免 `handleSelectCharacter` 里 `foundInMemory=false` 每次触发全量重扫。
6. **H2 `/newchat` 瘦身**（保留"每次新对话"功能，只改实现）：
   - 把 **token 计数**（10 次 `tokenizers/count`，纯 UI 显示用）**移出关键路径**（延后/去抖/异步）——同时解掉 P2；
   - `characters/edit`、`settings/save` 等持久化**去抖/后台化**；
   - 可选：服务端在 `ensureCharacter` 时**预建新对话**，省掉存旧/建新的串行往返。

### C. 感知与边角优化（P2）

7. **最大化"大厅重叠"**：boot 已在进大厅时开跑；让大厅耐逛/首屏不催促点卡，使冷启动尽量藏在浏览时间里（感知优化，非实际缩短）。
8. **`init-st-session` 期并行预热静态**：`preconnect` ST 源 + `preload` `/lib.js` 等，把冷缓存时的网络段与拿 cookie 重叠（收益小）。

### D. 中期架构（更重，另行评估）

9. **ST 就近/多区域部署**：降低每次 boot 调用的单程 RTT，是最接近"本地感"的物理手段。
10. **boot 数据一次性注入（bootstrap）**：把用户 settings/characters 一次打包注入，让 boot 从"N 次串行调用"变"1 次"。需拦 ST boot，改动重、收益大。

---

## 八、为什么"miniapp 冷启动"远慢于"本地原生 ST"

同一份代码，环境放大了成本：

- **本地**：`localhost` RTT≈0，桌面 CPU 快，ST 服务器同机 → 几百个文件/调用的单位成本≈0，无感。
- **miniapp**：手机 CPU 慢（解析 579KB `lib.js`+~200 模块），且每个 boot 调用走"手机→Telegram→Vercel→Railway(SG)"跨洲往返 → 单位成本几十~上百 ms × 几百 = 十几秒。

因此**无法在 WebView 里"完全复现本地"**（ST 是 Node 服务器 + 用户数据在远端，塞不进手机浏览器），只能靠"**砍无用扩展 + 懒加载 + 就近部署 + 减少调用**"缩小差距。

---

## 附录：本轮临时排查埋点（定位完成后回滚）

均以 `[iframe-timing]` 标注：

- 前端：`packages/frontend/src/lib/bridge/iframe-timing.ts`（计时器+beacon）、`bridge-client.ts`（start/两段握手/接收 ST 端 debug-timing）、`components/bridge/st-iframe.tsx`（`iframe_onload`）、`app/tavern/[characterId]/page.tsx`（点卡/闸门/ensure/select/呈现 + flush）。
- ST 端：`packages/st-extension/src/debug-timing.ts`、`debug-boot-probes.ts`、`entry.ts`（init 打点+boot 探针）、`handlers/select-character.ts`（H1/H3/H2）。
- 后端：`packages/backend/src/routes/debug.ts`（`POST /api/debug/iframe-timing`）+ `app.ts` 注册。

> 这些是 **临时 debug**，不承载业务；优化落地并复测后应整体删除。
