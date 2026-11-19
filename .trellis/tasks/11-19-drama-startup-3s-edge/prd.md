# 短剧双端起播 ≤3s：hls.js + 边缘签 + 首片边缘预热

## Goal

短剧（及复用同一装载层的影像广场播放）在 Android / iOS 上，**含放弃**的起播含放弃 P95 ≤ **3000ms**（等价 3s 达标率 ≥ 95%），重点覆盖 `cover` 入口；播放中边下边播流畅，进详情/放映页不因 hydrate 或取址串行黑屏。

实现路径固定为三支柱，缺一不可：

1. **双端统一 hls.js**（iOS 默认 MMS + hls.js，与 Android 同策略）
2. **`/play` 边缘化签名**（砍掉客户端 → Railway 新加坡 RTT）
3. **首片边缘预热 + 客户端首片/音轨/init 预取**（砍掉首片 TTFB+下载长尾）

说明文档见仓库 [`docs/drama-startup-3s-optimization.md`](../../../docs/drama-startup-3s-optimization.md)；技术细节见同目录 `design.md`。

## 背景与数据

- 口径：`docs/drama-playback-timing.md`（首帧且 `playing`；含放弃；`stream_budget` 3s）。
- 基线（Faro，11-18 prefetch 任务窗口）：
  - Android 全入口 3s 83.1%，含放弃 P95 ≥ **3820ms**；cover 70.8%，P95 ≥ **4520ms**
  - iOS 全入口 3s 64.5%，含放弃 P95 ≥ **7860ms**；cover 48.8%，P95 ≥ **8870ms**
- Android 会话首播慢样本：取址 24% + 主/子清单 18% + 首片 TTFB 14% + 首片下载/入缓冲 40%。
- `/play` 客户端 P95 ~1140ms，其中约 90% 是到 Railway 的网络；后端处理仅几十～两百 ms。
- 已有：Stream 多码率 HLS、主清单内联、封面/按下清单预取（11-18）、`startLevel:0`、intent 并行取址。
- 已证明不够：仅清单预取到不了双端 95%；首片与 `/play` RTT、iOS 原生不可控预取是剩余主因。

## Requirements

### R1 双端统一 hls.js

- R1.1 iOS 默认走 hls.js（Managed Media Source）；不再依赖原生 HLS 作为默认起播路径。
- R1.2 双端共用：最低档起播、自定义 playlist/frag loader、首片缓存、缓冲水位与 ABR 策略。
- R1.3 原生 HLS 仅作极端降级（无 MSE/MMS），不计入本任务达标承诺路径。

### R2 `/play` 边缘化

- R2.1 新增靠近用户的边缘签发路径（Cloudflare Worker），校验 Backend 短时 `edge_ticket` 后本地签 Stream JWT，返回与现契约兼容的 `DramaPlayback`（含可选 `inline_manifest`）。
- R2.2 鉴权形态**已定**：Telegram / 会话校验只在 Backend；Backend 签发 TTL 5–10 分钟的 `edge_ticket`（可与目录请求捎带或独立续票）。Worker 不验 `initData`、不持 bot token。整体强度不低于「仅持有效 Backend 会话才能拿票」。Stream 私钥与 ticket 密钥均走 secrets，不进日志。
- R2.3 ticket 无效/过期/KV miss 时回退 Railway `/api/dramas/play`；失败率与错误码可观测；客户端 P95 目标见门禁。
- R2.4 不把完整媒体代理成默认路径；边缘主责是**签播放地址 + 可选内联清单**，不是重写整条 CDN。

### R3 首片边缘预热 + 客户端首块预取

- R3.1 边缘预热：对热门片（白名单/库内 Stream 行）定期用服务凭证拉取**最低档视频首片 + 默认音轨首片 + fMP4 init（若有）**，使 Stream PoP / 自建首块缓存变热。
- R3.2 客户端：在现有 play 资源缓存上扩展，预取并缓存上述首块；hls.js loader 命中则零网络起播。
- R3.3 触发：片库可见封面（background）、pointerdown/intent（critical）、播放中下一部/下一集撒点（仅首块）。
- R3.4 字节与并发有界；过期/失败静默；重试绕过缓存；诊断可区分 `prefetch_hit=playlist|segment|none`。

### R4 进页与边下边播

- R4.1 `/dramas/:id` 与 `/watch` 不因 library hydrate 阻塞播放器首 paint；封面占位到首帧。
- R4.2 episode / 自动续集 / 详情换剧均走提前取址 intent（与 cover 同级）。
- R4.3 起播期短缓冲，稳播后抬高前向缓冲；弱网/rebuffer 强制低档；升档保守。

### R5 观测与护栏

- R5.1 沿用 `drama.startup` / `drama.startup_diagnostic`；扩展 prefetch 与 edge 命中字段（无 URL/token）。
- R5.2 护栏：起播失败率 +≤1pt；快进 3s 恢复 −≤4pt；剔除占比波动 ≤5pt；预取 discarded 流量可估算。

## 不做

- 完整离线整集下载、自建转码替代 Cloudflare Stream。
- 默认同步阻塞 `/play` 等待拉清单（历史已伤冷视频）。
- 全量 Service Worker 劫持 HLS。
- 把影像广场独立重做播放器（只复用装载层收益即可）。
- 承诺「只算成功样本的 P95」替代含放弃门禁。

## Acceptance Criteria

- [ ] A1 Android 全入口含放弃 P95 ≤ 3000ms，3s 达标率 ≥ 95%（等长窗口，按 `app_version`）。
- [ ] A2 iOS 全入口含放弃 P95 ≤ 3000ms，3s 达标率 ≥ 95%（同上；N&lt;100 延长观察，不补零宣称）。
- [ ] A3 cover 入口双端各自 3s 达标率 ≥ 92%（cover 分母单独报；全入口门禁仍以 A1/A2 为准）。
- [ ] A4 边缘 `/play` 命中时，客户端取址 P95 ≤ 500ms；未命中回退 Railway 不影响可播。
- [ ] A5 首片预取命中样本：诊断无首片真实网络 firstByte（或等价 segment hit），且 3s 达标显著高于未命中组。
- [ ] A6 iOS 生产默认 `engine` 为 `hlsjs_mms`（或等价 hls.js）；原生占比仅降级。
- [ ] A7 护栏 A4 类指标通过；弱网下片库预取不拖垮剧场首屏。

## Android/iOS 性能 P95 门禁

- 受影响页面：`/dramas`（空闲预取）、`/watch`、`/dramas/:id` 起播
- 受影响接口：`POST /api/dramas/play`（保留）+ 边缘签发等价接口
- Android 起播含放弃 P95：基线 ≥3820ms / **目标 3000ms**
- iOS 起播含放弃 P95：基线 ≥7860ms / **目标 3000ms**
- cover 对照：Android 基线 ≥4520ms、iOS ≥8870ms；目标双端 ≤3000ms（作为分层对照，门禁主字段仍用全入口）
- 接口 P95：`/play` 客户端 Android 基线 1140ms / 边缘命中目标 500ms；Railway 回退路径不劣化超过 +5%
- 数据来源与观测窗口：Faro `st_drama_startup`（drama_v3）+ Loki `drama.startup_diagnostic`；发布后等长 ≥7 天（iOS 样本不足则延长）
- 发布后验证：按 release 分组；区分 edge hit/miss、segment prefetch hit/miss、engine；低样本只报方向

## Notes

- 本任务为复杂跨层规划：Frontend 播放器/预取 + Backend 契约/预热 + Cloudflare Worker/边缘缓存。
- 与 `11-18-drama-playback-prefetch` 衔接：清单预取保留并扩展为「清单 + 首块」；不重复发明第二套缓存键。
- 双端 ≤3s 为硬门禁；若某一支柱无法上线，不得把目标改回「仅 Android」而不经产品确认。
