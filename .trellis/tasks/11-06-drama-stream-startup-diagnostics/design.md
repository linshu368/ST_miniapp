# 设计

## 改动点

| 文件                                             | 改动                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `shared/src/api/drama-timing.ts`                 | `ResourceSchema.kind?`；`DiagnosticsSchema.hls?`（`HlsLoadSchema` ≤16 条 + `truncated`）；导出 `DramaHlsLoad`               |
| `backend/src/lib/engineering-observability.ts`   | `observeDramaStartupDiagnostic`：有 `delivery` 时跳过耗时门槛                                                               |
| `frontend/src/lib/drama-stream-origin.ts`（新）  | 解析 `NEXT_PUBLIC_DRAMA_STREAM_ORIGIN`；`warmDramaStreamOrigin()` 在播放意图时插入 preconnect                               |
| `frontend/src/app/layout.tsx`                    | 静态输出两条 preconnect                                                                                                     |
| `frontend/src/lib/api/drama.ts`                  | `startDramaPlayIntent` 调用 `warmDramaStreamOrigin()`                                                                       |
| `frontend/src/lib/perf/drama-resources.ts`       | `streamRequestKind(source, name)`：Stream 源按同域名匹配并分类；非 Stream 源仍是精确匹配、无 `kind`                         |
| `frontend/src/lib/perf/drama-hls.ts`（新）       | `recordHlsLoads(hls, Events, origin, onChange)` 通用记录器（快进窗口复用）+ `observeDramaHls(hls, Events, timing)` 起播绑定 |
| `frontend/src/lib/drama-media-source.ts`         | `loadDramaSource` 增加可选 `onHls(hls, Events)` 回调，`attachMedia` 前调用                                                  |
| `frontend/src/lib/perf/drama-timing.ts`          | `hlsTiming()` 写入 `diagnostics.hls`（终态后忽略）                                                                          |
| `frontend/src/components/drama/drama-player.tsx` | 传入 `onHls`                                                                                                                |

## 复用调研

- 网络记录复用 `observeDramaResources` / `mediaResourceFields` 和既有 `DramaNetworkTiming`，只放宽匹配并加 `kind`，不新建第二套资源观察。
- preconnect 沿用 `layout.tsx` 中 API 域名的写法。
- hls 统计不复用资源计时：跨域无 TAO 时资源计时拿不到首字节和字节数，hls.js `LoaderStats` 可以。
- 上报通道、采样、后端校验全部复用现有 `DramaTimingReportSchema` 与 `observeDramaStartupDiagnostic`。

## 可靠性

- 诊断全部被动观察，不发探测请求、不改播放器配置；记录器异常在回调内吞掉，不影响播放。
- Stream 匹配限定 `customer-*.cloudflarestream.com` 且 `startTime ≥ source_set`，同一时刻只有一个播放源，旧源请求已被时间条件排除。
- 体积：16 条网络 + 16 条 hls 约 6KB，远低于 32KB 上限。
- 全量写入的量：Stream 实验组约每天几十次起播，Loki 增量可忽略。
- preconnect 对 Supabase 组是一次多余握手，成本可忽略。

## 演进与恢复

- 发布顺序：后端先部署（strict schema），前端后部署；前端先上线只会让这段时间的诊断被拒收，不影响播放。
- 回滚：前端回滚即停止新字段；后端回滚前需先回滚前端。删除 Vercel 变量即可关闭 preconnect。
- 快进窗口复用 `recordHlsLoads` 与 `streamRequestKind`。

## 拒绝的方案

- 清单预取：URL 每次现签，没有提前窗口；只有在意图前取地址才行，而这一项已拍板暂缓。
- 在 `observeDramaMedia`（已 405 行）内接线：继续加长超限函数。
- 记录完整 hls 事件流：只保留加载相关的 5 类，够拆耗时。
