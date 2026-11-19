# Design：短剧双端起播 ≤3s

## 1. 复用调研

| 已有                                                       | 处理                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `lib/api/drama-playback.ts` 播放资源缓存（/play + 子清单） | **扩展**：同键增加 segment/init 首块 `ArrayBuffer` Map；来源枚举增加 `edge`   |
| `drama-inline-manifest-loader.ts` pLoader                  | **扩展或并列**：frag/init loader 命中内存首块                                 |
| `hls-media-source.ts` / `drama-media-source.ts`            | 统一双端 hls.js；补缓冲水位与 ABR；iOS 默认 `forceHlsOnApple`                 |
| `useDramaPlaybackWarmup` + cover pointerdown/intent        | 触发链复用；预取深度从「清单」升到「清单+首块」                               |
| `stream-signing.ts` 本地 RS256                             | **搬到边缘 Worker 复用同一算法**；Backend 保留同实现作回退                    |
| `DramaStreamManifestCache` 主清单进程缓存 + prewarm        | 保留；边缘侧增加清单 KV 镜像 + **首片预热任务**                               |
| `POST /api/dramas/play` 契约                               | 响应 schema 兼容；新增可选 `delivery.path=edge\|railway` 类诊断字段（无密钥） |
| Faro/Loki drama.startup 诊断                               | 扩展 prefetch segment / edge 命中；不新造第二套计时 owner                     |

不复用：React Query 缓存 play 结果（仍按意图、确认当前路径）；完整媒体反向代理作为默认路径。

## 2. 目标分解（为何三支柱缺一不可）

```
起播耗时 ≈ max(导航, 取址) + 清单 + 首片(TTFB+下载) + 解码/playing
```

| 支柱                          | 砍掉的项                            | 不做则                                 |
| ----------------------------- | ----------------------------------- | -------------------------------------- |
| hls.js 双端统一               | iOS 无法可控预取/缓冲/segment cache | iOS P95 难下到 3s                      |
| 边缘签 `/play`                | 取址 24% 里的跨境 RTT（~1s P95）    | 未预取命中的 cover/episode 仍易 >3s    |
| 首片边缘预热 + 客户端首块预取 | 慢样本 54% 的首片                   | 清单预取后仍到不了 95%（11-18 已结论） |

量化预期（含放弃 P95，发布后验证，不补零）：

| 平台             | 基线    | 三支柱齐全后目标                                    |
| ---------------- | ------- | --------------------------------------------------- |
| Android 全入口   | ≥3820ms | ≤3000ms（预期落点 2400–2800）                       |
| iOS 全入口       | ≥7860ms | ≤3000ms（预期落点 2800–3000，依赖边缘+默认 hls.js） |
| `/play` 边缘命中 | 1140ms  | ≤500ms                                              |

## 3. 架构

```
剧场封面空闲/按下
  → 边缘或 Railway /play（优先边缘）
  → 缓存：playback + inline_manifest + 子清单 + 视频/音轨首片 + init
  → 进 /watch 或 /dramas/:id（播放器不挡在 hydrate 后）
  → hls.js startLevel:0 + 自定义 loader 命中首块 → 首帧+playing
  → 稳播后 ABR 升档；缓冲达标后撒点预取下一部首块

并行边缘任务：
  Cron/队列 → 热门 uid 签临时 URL → GET 首片/音轨/init → 暖 Stream PoP
             （可选）写入 R2/Cache，Worker 在极端冷区回源前先吐首块
```

### 3.1 边缘签发（R2）

**已定鉴权：Backend 签发短时 `edge_ticket`（不在 Worker 验 initData）。**

1. Cloudflare Worker 暴露与前端约定的 `POST /play` 兼容入口（或 `POST /api/dramas/play` 经 CF 路由到 Worker）。
2. **Ticket 生命周期（已拍板）**
   - Backend 在用户已通过现有 Telegram 会话鉴权后签发：优先捎带在剧场目录/`/api/dramas`（或进 `/dramas` 后的轻量 endpoint），TTL **5–10 分钟**，可刷新。
   - 载荷有界：随机 `jti`、过期时间、用户绑定声明（匿名化 id 或现有 session 主体）、签发环境；用与 Worker 共享的 HMAC/对称密钥或短公钥验签。
   - Worker **只**校验：ticket 签名有效、未过期、环境匹配；**不**接收、不校验原始 `initData`，不持有 bot token。
   - 客户端每次边缘 `/play` 带上 `edge_ticket`；过期或 401 → 回 Railway 原 `/play` 一次，并可异步向 Backend 续票。
3. Worker 从 **KV/DO** 读取 `dramaId+videoId → stream_uid`（由 Backend 发布片单/DB 变更时同步；容量按片库有界）。
4. Worker 本地 RS256 签 Stream JWT（密钥在 Worker secrets），组装 `play_url`；清单命中则带 `inline_manifest`。
5. ticket 无效 / 未登记 uid / KV miss → JSON 指示客户端回退 Railway 原接口（不静默假成功）。

**拒绝的过度设计：** Worker 直接验 initData、边缘查 Supabase 主库、边缘代理全部分片、边缘实现完整选源实验逻辑。选源规则仍由 Backend 权威同步到 KV 快照。

### 3.2 首片边缘预热（R3）

**Phase E1（必做）：被动暖 PoP**

- 定时任务（Railway cron 或 CF Cron Trigger）对热门 uid 列表：签名 → GET 最低档视频首片 URL、音轨首片、EXT-X-MAP init。
- 超时、限并发（如 4）、失败重试有界；只记成功/失败计数与耗时，不记 URL。
- 目的：用户真实请求到达时 Stream 边缘已有对象，TTFB 下降。

**Phase E2（可选增强）：主动首块缓存**

- 将首块字节写入 R2，键为 `uid/rendition/sn0`（与 token 无关）。
- 仅当客户端 loader 或 Worker 判定「PoP 仍冷」时，用同一次签名会话下发可短时访问的首块；默认仍走 Stream URL，避免把 Worker 变成带宽中枢。

### 3.3 客户端首块预取

在 `drama-playback` 缓存条目上：

```
playlists: Map<url, text>
segments: Map<url, { bytes: ArrayBuffer, storedAtMs }>
```

流程：

1. 有 `inline_manifest`（或边缘返回）→ 选最低档视频 + 默认音轨子清单 URL → fetch 子清单（可已缓存）。
2. 解析子清单：取 `#EXT-X-MAP`（若有）+ 起播 sn（开头=0；续播=对齐 `startPosition` 的片）。
3. `fetch` 首块，单块上限约 512KB（视频）/ 128KB（音轨/init），总预取并发：background ≤2，critical 可抢占。
4. hls.js `loader`：playlist 或 frag/init URL 命中则同步应答；并 `startFragPrefetch: true`。
5. 起播配置：`maxMaxBufferLength` 起播约 4–8s，`playing` 后升到 20–30s；`abrEwmaDefaultEstimate` 偏保守。

### 3.4 iOS 默认 hls.js

- 生产默认开启 `forceHlsOnApple`（或等价环境变量默认 true）。
- 诊断强制带 `engine`；看板按 engine 分层，原生降级不计入 A1/A2 成功路径承诺，但计入分母透明度说明。

### 3.5 进页

- `/dramas/[id]/page.tsx`：hydrate 不 return 整页黑屏；播放器先挂，进度异步合并。
- episode/续集：`beginPlayback` 后立即 `startDramaPlayIntent`（与 cover 一致）。

## 4. 可靠性

| 项   | 设计                                                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 超时 | /play 5s；子清单/首块 5s；预热单对象 3–5s                                                                                                     |
| 重试 | 预取不重试；正式播放失败 `freshRequest` 绕过缓存；边缘失败回退 Railway 一次                                                                   |
| 幂等 | 缓存键 `(dramaId, requestedVideoId)`；边缘签按请求即时签，无写库                                                                              |
| 并发 | 可见封面最多 4 部清单级、首块额外限流；预热并发 4                                                                                             |
| 降级 | 无边缘 → Railway；无首块 → 现网 HLS；无 MMS → 原生 HLS（体验降级）                                                                            |
| 容量 | 播放缓存条目上限保持有界（可略增至 8–12）；首块总内存预算有硬顶（如 8MB）                                                                     |
| 安全 | 不日志 play token/URL/initData/edge_ticket 原文；Worker 仅持 Stream 签私钥与 ticket 验签密钥（secrets）；ticket TTL 5–10min；过期回退 Railway |
| 回滚 | 关边缘路由开关；iOS 可回退原生 flag；预取 feature flag 关闭后走原路径                                                                         |

## 5. 数据流与契约

- shared：`DramaPlayback` 可增加可选诊断/路径字段；`DiagnosticsSchema.hls.prefetch` 增加 segment/init 命中与字节。
- Frontend 不读 DB 行；uid 映射只经 HTTP/边缘响应。
- 不新增业务表；若 KV 快照需要生成管道，用现有片单/DB Stream 行只读导出，不进 `public` 乱放。

## 6. 日志与观测

见 `task.json.meta.logging_integration`。复用 `drama.startup_diagnostic` 与 Backend `drama.request_timing`；边缘增加有界 `drama.edge_play`（或等价）终态：auth/kv/sign/outcome/duration，无敏感字段。

## 7. 演进与发布顺序

1. shared 诊断字段 + Backend 兼容
2. 客户端：iOS 默认 hls.js + 首块预取 + 缓冲水位 + 进页/episode intent（可先打在 Railway 路径上验证 Android）
3. 边缘 Worker 签发 + 路由灰度（百分比）
4. 首片边缘预热 Cron 全量热门
5. 双端门禁窗口观察；未达标则开 E2 R2 首块或扩预热名单，而不是放松 3s 门禁

停止条件：失败率/护栏破线；边缘 5xx 升高；预取流量异常；iOS hls.js 错误率不可接受 → 回滚对应开关。

## 8. 最小充分 vs 拒绝

- 做：三支柱 + 进页/episode + 缓冲策略。
- 不做：双播放器首期（可作为达标后的体验增强）、全量 SW、自建转码、边缘查主库。
