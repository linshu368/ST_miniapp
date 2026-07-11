# iframe 加载耗时瓶颈 — 排查现状与确定性结论（优化任务背景指南）

> 分支：已在最新 `dev` 建 `hotfix/tavern-iframe-latency`（当前工作区在 `dev_regex_global`，实现时切回）。
> 症状：生产 miniapp 中「点角色卡 → 看见对话页(iframe)」最快 5–6 秒，最慢约 1 分钟且偶发卡死。

---

## 一、已确认健康、非本问题根因（排除项）

- **IPv6 双栈修复在 pro 稳住**：8h 窗口 nginx-pro **0 次 `connect refused`**，`st-bundle-pro` **0 重启 / 0 OOM**。历史"连接被拒"这一类已消除。
- **角色卡懒下发 + 单卡 ensure 在 pro 实测通过**：provision 全走 `characterScope=none`，进对话页时 `ensure-character → written`（每次只拉当前一张）。`/api/characters/all` p50≈93ms（干净卷，不再重现全量尖峰）。
- **LLM 生成 `/generate` p50≈7.2s（尾部 12s+）是上游模型固有耗时**，非基础设施、非本问题。
- **资源饱和已排除**：慢不是 CPU/内存，而是下面的链路问题。

---

## 二、点卡 → iframe 出现的链路与「关键闸门」

```
点卡 → /tavern/[id](page.tsx)
  ↓ 等 bridgeStatus==='ready'   ← 关键闸门：ST 冷启动+两段握手完成才放行
  ↓ ensureCharacter(id) → 后端 → provision-api 单卡下发
  ↓ selectCharacter(postMessage) → ST 选角色+载入聊天+渲染
  ↓ setChatReady(true) → 开屏动画退场 → 看见 iframe
```

- iframe 全局常驻（`providers.tsx` 进大厅即挂），但 **ST 的 `/tavern/` 要等 `/api/init-st-session` 返回后才开始加载**：

```64:64:packages/frontend/src/components/bridge/st-iframe.tsx
  if (!sessionReady) return null;
```

- `bridgeStatus` 变 `ready` 的前提 = ST 完整冷启动（拉 ~200 个 JS/静态文件）+ 两段握手。

---

## 三、确定性根因（按影响排序）

### 根因 #1 — ST 静态资源「保质期 0 秒」+ 边缘不缓存【实测确认，头号主因】

- 实测（curl 生产别名）：`/lib.js`、`/scripts/*.js`、`/webfonts/*` 均返回
  `cache-control: public, max-age=0` + `x-vercel-cache: MISS`。
- 后果：**每次开对话页都要把 ~200 个文件逐个回源**（浏览器→Vercel→Railway→ST），Vercel 边缘因 max-age=0 拒绝缓存 → 每个文件每次都跑到最远端那台**共享单容器** `st-bundle-pro`。
- 这份缓存策略是 ST 原生默认值（nginx 未覆盖，原样透传）。**nginx 当前对所有 ST 静态 location 不加任何缓存头**（`ops/nginx/nginx.conf` 的 `/scripts/ /lib/ /css/ /webfonts/…`）。
- **为什么本地原生 ST 快、miniapp 慢**：同一份 max-age=0 策略——本地 `localhost` 延迟≈0，200 次重新校验≈几十毫秒无感；miniapp 把它拉长到"手机→跨国多层中转→共享容器"，距离放大几百倍，200 次长途 × 上百毫秒 × 排队 = 数秒到数十秒。**是环境放大了缺陷，不是策略本身对 ST 错。**
- **判定**：这是"慢"和"忽快忽慢不稳定"的最大头。

### 根因 #2 — 握手 60s 超时且无重连【代码确认，健壮性缺陷】

- `bridge-client.ts`：`totalTimeout=60_000`，超时即 `disconnect`，**无任何自动重连**；一旦 ST 冷启动超过 60s，`selectCharacter` 永不触发 → 开屏永久卡死，只能退出重进。
- **这就是"最慢约 1 分钟然后卡住"的机制**。60s 是天花板不是常态。

### 根因 #3 — init-st-session 串在 ST 启动前面【代码确认，部分可优化】

- iframe 必须等 `/api/init-st-session` 返回（拿登录 cookie）才开始加载 ST——**这段依赖去不掉**（无 cookie 会被 ST 踢去登录页）。
- 但当前把"拿 cookie"和"重写全部配置文件"捆在同一个必须等待的调用里（尤其新用户 3 阶段 provision + 两次登录 + 500ms sleep，见 `backend/src/routes/bridge.ts`）。**"拿到 cookie"其实可以更早放行**，重写配置挪后台。

---

## 四、已定的处理决策（本轮范围）

| #   | 项                          | 决策                 | 理由/风险                                                                                                                                                                                                                                                                               |
| --- | --------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1  | 静态资源缓存                | **必修（治本）**     | nginx 覆盖 Cache-Control 为长 TTL → 浏览器缓存 + Vercel 边缘缓存两层收益。**风险点**：`/scripts/extensions/third-party/miniapp-bridge/`（自研 st-extension，随发版变）需排除或给短 TTL/发版失效，避免旧 JS。缓存两层在 Telegram WebView 下均可生效（边缘层与 WebView 内核无关，稳赚）。 |
| #2  | 握手重连                    | **必修（健壮性）**   | 超时后带退避自动重连/重握手。**注意**：只兜底"资源风暴/瞬断"类；对"cookie 失效→ST 302 登录页"那类无效（需 cookie 方案，已有 `SameSite=None; Partitioned`）。                                                                                                                            |
| #3  | 串行放行                    | **必修，老/新分流**  | **老用户**：拿到 cookie 立即放行、配置后台刷新（安全，配置本已就位，最多稍旧仍有效）。**新用户**：保持同步等待（先放行会用 ST 默认配置启动 → 首次对话缺计费凭证/预设/LLM 地址且不会热重载，风险不可接受）；新用户仅首登一次，可接受。                                                   |
| #4  | 单卡 ensure 下载            | **不改（必要耗时）** | 懒下发是为加速，全量只会更慢，当前可接受。                                                                                                                                                                                                                                              |
| #5  | 开屏动画 `MIN_SHOW_MS=2400` | **不改（可接受）**   | 本就是盖 ST 启动的；强制时长可随时改成可跳转。                                                                                                                                                                                                                                          |
| #6  | tokenizer 同步 XHR 风暴     | **本轮跳过**         | 只影响"对话中"丝滑度，不堵塞 iframe 加载阶段。属方向4，另行处理。                                                                                                                                                                                                                       |

60s 超时与 #1 的关系（确定性）：**#1 是逼近/撞破 60s 的主因**（资源风暴在弱网/容器忙时排队放大）——属强推断（客户端握手无服务端日志，靠 curl 缓存头 + nginx 启动脚本簇 + 用户体感三方印证）。修 #1 应同时压扁中位数与尾部，让 60s 基本撞不到；#2 兜残余。

---

## 五、关键证据 / 现场数据（可复现）

- **缓存头**：`curl -sSI https://st-miniapp-frontend.vercel.app/lib.js` → `cache-control: public, max-age=0` + `x-vercel-cache: MISS`（scripts/webfonts 同）。
- **启动规模**：单次 ST 冷启动拉 ~185–380 个 JS/静态请求（nginx-pro 日志按 `/lib.js` 窗口统计）。
- **端点耗时（nginx-pro，rt=）**：generate p50 7.2s；settings/save p50 0.3s / p95≈1s；characters/all p50 93ms；tokenizer 7.5h 内 3432 次、服务端 p50 5ms。
- **工具**：`railway logs -s <svc> -e production -n 5000 --json`（`-n` 上限 5000≈3h；低频端点用 `-f "<关键字>"` 可回溯 8h+）;`vercel logs -p st-miniapp-frontend --environment production --since 8h`（无耗时字段、保留极短、prod 流量极少）。真实耗时信号在 `nginx-pro`（access log 带 `rt`）。
- **配置风险待核**：`packages/frontend/src/lib/api/client.ts` 的 `API_URL` 默认指向 dev 后端，prod 必须由 `NEXT_PUBLIC_API_URL` 覆盖（目前 ensure 走通说明 pro 已正确覆盖，但值得纳入核对）。

---

## 六、实现顺序建议

`#1 缓存覆盖`（治本、收益最大）→ `#3 老/新分流放行` → `#2 带退避重连`（安全网）。均属"通道 B（涉及 ST 桥接/nginx/bridge）"，改动集中在 `ops/nginx/nginx.conf`、`packages/frontend/src/lib/bridge/bridge-client.ts`、`packages/backend/src/routes/bridge.ts` + `st-iframe.tsx`。

---
