# 短剧双端起播 ≤3s：hls.js + 边缘签 + 首片预热

## Goal

短剧在 Android / iOS 上，**含放弃**起播 P95 ≤ **3000ms**（3s 达标率 ≥ 95%），重点 cover；进页不黑屏；边下边播流畅。

在 **已合入的清单预取（#932）** 之上完成：

1. **入口补齐 + 进页解阻**（首页 switch / 选集 / 续集 intent；hydrate 不挡播放器）
2. **双端默认 hls.js**（iOS MMS；现状仍为 env 开关，**尚未默认**）
3. **客户端首块预取**（视频 + 音轨 + init）与缓冲/ABR 水位
4. **`edge_ticket` 边缘签** + **首片边缘预热**
5. **附加项 A–G**（子清单内联、片尾预取升级、让带宽、详情路由预取、fetch priority、动态封面数、最低档审计）——详见说明文档 §9 与 `design.md` §3.5

说明：[`docs/drama-startup-3s-optimization.md`](../../../docs/drama-startup-3s-optimization.md)（已按最新代码修订，含附加优化清单）。

## 背景与数据

- 口径：`docs/drama-playback-timing.md`。
- **#932 前**基线（文档对照）：Android 全入口 83.1% / P95≥3820；iOS 64.5% / ≥7860；慢样本取址 24% + 清单 18% + 首片 TTFB 14% + 首片下载 40%。
- **#932 后**：清单命中应抹掉大部分「主+子清单」；代码已具备 cover/详情 switch 的 `/play`+子清单预取。**无首块、无边缘、iOS 非默认 hls.js**；首页 switch/选集/续集仍不 early-fetch。
- `/play` 客户端 P95 ~1140ms，约 90% 为到 Railway 网络。
- 快进 #933/#934/#992 已合，本任务不混同 PR。

## Requirements

### R0 入口与进页（修订新增，优先）

- R0.1 `/dramas/:id`、`/watch` 不因 library hydrate 阻塞播放器首 paint。
- R0.2 `drama-home` 换剧、选集、自动续集均在确定目标后立即 `startDramaPlayIntent`（与 cover / 详情 switch 同级）。

### R1 双端统一 hls.js

- R1.1 iOS **生产默认** hls.js（MMS）；对齐广场「有 MMS 则开」先例。
- R1.2 双端共用 loader / 首块缓存 / 缓冲与 ABR。
- R1.3 原生 HLS 仅极端降级，不计入门禁承诺路径。

### R2 `/play` 边缘化（`edge_ticket` 已定）

- R2.1 CF Worker：验 Backend 短时 ticket → KV uid → 本地签 Stream JWT → 兼容 `DramaPlayback`。
- R2.2 Backend 发 TTL 5–10min ticket（目录捎带/续票）；Worker 不验 initData、不持 bot token。
- R2.3 失败回退 Railway；边缘命中客户端取址 P95 ≤500ms。

### R3 首片预热 + 客户端首块

- R3.1 同键扩展 #932 缓存：预取最低档视频首片 + 默认音轨首片 + fMP4 init。
- R3.2 边缘 Cron 暖热门 uid 首块 PoP。
- R3.3 触发：可见封面 / press / intent / 播放中下一部撒点；有界字节与并发；失败静默。

### R4 边下边播

- R4.1 起播短缓冲，稳播抬高；弱网/rebuffer 强制低档。

### R5 观测与护栏

- R5.1 扩展 prefetch segment/init 与 delivery_path；无 URL/token。
- R5.2 失败率 +≤1pt；快进 3s 恢复 −≤4pt；剔除占比波动 ≤5pt。
- R5.3 开工前用 #932 后 release 重算对照基线并写入 notes。

### R6 附加优化（并入本期，不替代三支柱）

- R6.1 **A** `/play`（及边缘等价）可选内联起播两份子清单；miss 不长时间阻塞；有字节上限。
- R6.2 **B** 临近片尾/缓冲达标后预取下一部（或下一集）的 `/play`+清单+首块，取代「只预取详情」。
- R6.3 **C** 封面 pointerdown 时降低非关键图片带宽优先级。
- R6.4 **D** 片库对详情路径 `router.prefetch('/dramas/:id')`（接着看/可见追剧）。
- R6.5 **E** 首块 critical fetch 使用 high priority（能力允许时）。
- R6.6 **F** 可见封面预取数可按停留动态扩至 ≤6，默认 4。
- R6.7 **G** 并行完成最低档 4s 分片体积审计并记 notes；异常偏高须在门禁复盘中说明。

## 不做

离线整集 · 自建转码 · 全量 SW · 同步等清单 · 首期双播放器 · 首期 R2 首块（差一线再开）· 重写 #932 缓存键 · 与快进大改同一 PR · 盲目 1s 分片 · Worker 验 initData · 首期 H–L（双 video / Cache API 会话首块等，门禁后另立）。

## Acceptance Criteria

- [ ] A0 首页 switch / 选集 / 续集诊断可见 cache|inflight；详情进页无 hydrate 整页黑屏阻塞播放器挂载
- [ ] A1 Android 全入口含放弃 P95 ≤3000ms，达标 ≥95%
- [ ] A2 iOS 同上
- [ ] A3 cover 双端达标 ≥92%（分层）
- [ ] A4 边缘命中取址 P95 ≤500ms；回退可播
- [ ] A5 首块命中组优于未命中组
- [ ] A6 iOS 默认 engine 为 hls.js
- [ ] A7 护栏通过；#932 后基线已记录
- [ ] A8 冷路径（无封面预取）在内联子清单命中时，诊断无两路子清单真实 firstByte（或等价）
- [ ] A9 片尾预取后，下一集/下一部起播出现 cache|inflight 或 segment hit（抽样）
- [ ] A10 最低档审计结论已写入 notes（含样本 uid 数与体积范围，无密钥/URL）

## Android/iOS 性能 P95 门禁

- 页面：`/dramas`、`/watch`、`/dramas/:id`
- 接口：`POST /api/dramas/play` + 边缘等价 play
- Android 含放弃 P95：文档基线 ≥3820 → **目标 3000**（#932 后对照基线待 Faro 重填 notes）
- iOS：≥7860 → **目标 3000**
- 接口：基线 1140 → 边缘命中 **500**；Railway 回退 +≤5%
- 观测：Faro drama_v3 + Loki diagnostic；≥7 天；分层 platform×入口×edge×segment×engine

## Notes

- 修订原因：最新代码已含 #932 与快进系列；初版「清单预取未落地 / hls.js 已默认」需纠正。
- 复杂跨层：Frontend + Backend ticket/KV + Worker。
- 日志与 mobile meta 见 `task.json`。
