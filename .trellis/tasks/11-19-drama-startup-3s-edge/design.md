# Design：短剧双端起播 ≤3s（修订：#932 合入后）

## 0. 相对初版的代码事实

- **已落地**：PR #932 播放资源缓存——`(dramaId, videoId)` → `/play` + 子清单 Map；来源 `visible_cover` / `press_cover` / `intent` / `recent`；`pLoader` 命中回写。
- **未落地**：segments/init 首块、`edge_ticket`、Worker、首片 PoP 预热、iOS 默认 hls.js、hydrate 解阻、首页 switch/选集/续集 intent、缓冲水位。
- **旁路已合**：快进 #933/#934/#992；改装载层时回归，不塞进本任务同一 PR。
- **广场先例**：`plaza-video-player` 在有 MMS 时默认 `forceHlsOnApple: true`——短剧默认 hls.js 可对齐该模式。

本设计在 #932 缓存键上**扩展**，不新建第二套缓存。

## 1. 复用调研

| 已有                                                | 处理                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `drama-playback.ts`（#932）                         | **扩展** `segments`/`init` Map；来源可加 `edge`                           |
| `drama-inline-manifest-loader.ts`                   | 保留 playlist；**并列** frag/init loader                                  |
| `hls-media-source.ts` / `drama-media-source.ts`     | iOS 默认 force；补 `startFragPrefetch`、缓冲/ABR                          |
| `useDramaPlaybackWarmup` + cover pointerdown/intent | 触发链复用；预取深度升到首块；**D** 加详情路由 prefetch；**F** 动态封面数 |
| `usePreloadDramaPlayback`（只预取详情）             | **B** 改为详情并行 + play/首块预取                                        |
| `dramas/[id]/page.tsx` 的 `startDramaPlayIntent`    | 详情 switch **已有**；补 `drama-home` / episode / 续集                    |
| `stream-signing.ts`                                 | Worker 复用算法；Backend 回退                                             |
| `DramaStreamManifestCache`                          | 保留主清单；**A** 扩展起播子清单内联；预热升级到首片                      |
| Plaza `forceHlsOnApple`                             | 短剧默认策略对齐，互不破坏广场                                            |

## 2. 目标分解

```
起播 ≈ max(导航, 取址) + 清单 + 首片(TTFB+下载) + 解码/playing
```

#932 命中后清单项≈0；剩余靠首块 + 边缘取址 + iOS 可控引擎。

| 平台                     | 文档基线（#932 前） | 完整方案目标              |
| ------------------------ | ------------------- | ------------------------- |
| Android 全入口含放弃 P95 | ≥3820ms             | ≤3000ms（预期 2400–2800） |
| iOS 全入口含放弃 P95     | ≥7860ms             | ≤3000ms（预期 2800–3000） |
| `/play` 边缘命中         | ~1140ms             | ≤500ms                    |

开工前用 #932 后 Faro 重算对照基线（见 prd Notes）。

## 3. 架构（修订顺序）

### 3.0 Batch 0 — 入口与进页（先于边缘）

1. `/dramas/[id]`：hydrate 不 `return` 整页黑屏；播放器先挂，进度异步合并。
2. `drama-home` 换剧、`drama-player` 选集与自动续集：在 `beginPlayback` 后立即 `startDramaPlayIntent`（与详情 switch / cover 对齐）。
3. 诊断确认非 cover 入口出现 `address_source=cache|inflight`。

### 3.1 双端 hls.js

- 生产默认 `forceHlsOnApple`（或 env 默认 true）；对齐广场「有 MMS 则开」。
- 原生 HLS 仅无 MMS 降级；门禁承诺路径为 hls.js。

### 3.2 客户端首块（扩展 #932）

```
playlists: Map<url, text>          // 已有
segments: Map<url, { bytes, storedAtMs }>  // 新增
```

1. 有 inline/缓存主清单 → 选最低档视频 + 默认音轨子清单（已有解析）。
2. 解析 MAP + 起播 sn（续播对齐 `startPosition`）。
3. fetch 首块：视频 ≤512KB，音轨/init ≤128KB；background 并发 ≤2，critical 可抢占。
4. hls.js loader 命中同步应答；`startFragPrefetch: true`。
5. 起播 `maxMaxBufferLength` ~4–8s，`playing` 后 20–30s；保守 ABR；rebuffer → level 0。

### 3.3 边缘签发（已定：`edge_ticket`）

1. Backend 在已有 Telegram 会话鉴权后签发 TTL **5–10min** 的 `edge_ticket`（目录捎带或轻量续票）。
2. Worker **只**验 ticket（签名+过期+环境）→ KV `dramaId+videoId→uid` → 本地签 Stream JWT → 可选 inline_manifest。
3. **不**验 initData、不持 bot token、不查业务主库。
4. 票无效 / KV miss → 客户端回退 Railway `/api/dramas/play`。

### 3.4 首片边缘预热

- **E1 必做**：Cron 对热门 uid GET 最低档视频首片 + 音轨首片 + init，暖 Stream PoP。
- **E2 可选**：R2 存首块，仅门禁差一线开启。

### 3.5 附加优化（与三支柱叠加，编号同说明文档 §9）

#### A. 后端子清单内联（冷路径）

- **问题**：`DramaStreamManifestCache` 只缓存/内联**主清单**；无封面预取或冷 miss 时，客户端仍要拉最低档视频 + 默认音轨两份子清单。
- **做法**：同一次 `/play`（及边缘等价响应）在已有 `inline_manifest` 基础上，可选附带 `inline_startup_playlists: { video?: string; audio?: string }`（或等价字段），内容为当次 token 解析出的两份子清单文本。
- **缓存**：子清单 URL 含 token，**不能跨签发复用**；进程内可按 `uid+rendition` 缓存「无签名相对结构」仅用于加速拉取，下发前必须用当次 `play_url` 重写绝对 URL；更稳妥是签完后短超时并行拉两份子清单，命中主清单缓存时成本可控。
- **约束**：单份子清单上限沿用前端 256KB 量级；总响应仍受现有 body 上限约束；miss **不得**同步阻塞超过既定预算（建议与主清单一样：等不起就省略字段，后台补齐）。
- **收益**：Railway 回退路径与未预取入口直接少 2 次 RTT，和边缘签正交。

#### B. 片尾预取升级（替换「只预取详情」）

- **现状**：`usePreloadDramaPlayback` 只 `prefetchQuery` 详情，注释写明不预取地址（关 Stream 后旧 URL 不可用）。
- **做法**：临近片尾 / 缓冲达标后改为：`prefetchDramaPlayback(nextId, nextVideoId, …)`（清单 + 首块），详情预取可保留作并行。
- **安全**：仍遵守签发 ≤5min、剩余有效期 ≥5min；失败静默；用户滑走则 abort。不在片尾提前很久整集下载。

#### C. 按下封面让带宽

- `pointerdown` 已 critical 取址；同时把当前封面图 `fetchPriority` 降为 `low`（或暂停非关键图片解码），避免与即将发出的子清单/首块抢带宽。
- 仅作用于被按的那一张及同屏装饰图，不影响 LCP 首屏策略的长期默认。

#### D. `/dramas/:id` 路由预取

- `useDramaPlaybackWarmup` 在片库除 `prefetch('/watch')` 外，对「接着看」/追剧入口可见时 `router.prefetch(/dramas/:id)`。
- 避免详情进页卡在 Next 路由 chunk。

#### E. 首块 fetch priority

- 客户端预取/装载首块（及 critical 路径 frag）使用 `fetch(..., { priority: 'high' })`（类型与 polyfill 按浏览器能力降级）。
- background 可见封面首块保持默认/ low，避免拖垮剧场。

#### F. 可见封面预取数动态扩

- 默认仍 4；片库停留超过约 P50（~8–10s）且 `canPrefetchInBackground` 放行时扩到 5–6，硬顶 ≤6。
- 仍按 DOM 顺序视口封面；超额淘汰最旧缓存条目。

#### G. 最低档体积审计（编码/运营，并行）

- 从现网主清单抽样：最低 RESOLUTION 的 AVERAGE-BANDWIDTH × 4s 是否约 ≤280–350KB。
- 若明显偏高：在 Stream 侧调整最低档或接受弱网 P95 上限，**不**为起播盲目改 1s 分片（高 RTT 下 TTFB 占比更大）。
- 产出写入任务 notes / 说明文档，不阻塞前端 PR，但门禁未达标时优先复查本项。

#### 门禁后（H–L，设计预留不首期实现）

- H 双 video 预热、I Cache API 会话首块、J 连滑撒点下 N 部、K 拆小 `drama-player`、L Railway 热门行缓存——详见说明文档 §9.2；验收差一线再立项。

## 4. 可靠性

| 项   | 设计                                                                             |
| ---- | -------------------------------------------------------------------------------- |
| 超时 | /play 5s；子清单/首块 5s；预热 3–5s                                              |
| 重试 | 预取不重试；播放失败 fresh 绕过缓存；边缘失败回退 Railway 一次                   |
| 并发 | 可见封面默认 ≤4、动态扩 ≤6；首块另限流；预热并发 4；子清单内联拉取 single-flight |
| 容量 | 缓存条目有界；首块内存硬顶（如 8MB）；`/play` 内联子清单有字节上限               |
| 安全 | 不日志 ticket 原文 / play URL / initData；secrets 管理签钥                       |
| 回滚 | 关边缘路由；关首块 flag；关子清单内联字段；iOS env 回退（应急）                  |

## 5. 日志与观测

见 `task.json.meta.logging_integration`。扩展 prefetch segments/init；边缘 `drama.edge_play`；预热 `drama.segment_prewarm`。与快进诊断字段隔离，避免同分母。

## 6. 演进

1. shared 诊断字段（segment/init；若做 A 则 playback 契约增加可选内联子清单字段）
2. Batch 0：进页 + 全入口 intent + **D** 详情路由预取
3. Batch 2：iOS 默认 hls.js + 首块 + 水位 + **C/E/F** + **B** 片尾升级（Railway）
4. 并行：**G** 最低档审计；Backend **A** 子清单内联（可早于或并行于边缘）
5. Batch 3–4：edge_ticket + 首片 Cron
6. 门禁窗 ≥7 天；未达标再开 H–L / E2

停止：失败率/护栏破线、边缘 5xx、预取流量异常、内联响应体膨胀、iOS hls.js 错误不可接受 → 回滚对应开关。

## 7. 最小充分 vs 拒绝

- **做**：Batch 0 + 三支柱 + 水位 + 附加 A–G（A/G 可并行）。
- **不做（首期）**：双播放器、全量 SW、自建转码、Worker 验 initData、重写 #932 缓存键、1s 分片、同步阻塞等清单、H–L（门禁后另立）。
