# Implement：短剧双端起播 ≤3s

## 执行顺序（门禁前不得写产品代码以外的「假完成」）

### Batch 0 — 观测补齐（可与设计评审并行）

1. shared：`diagnostics.hls.prefetch` 增加 `segments` / `init` 命中计数与字节；可选 `delivery_path`。
2. 前端诊断透传；Grafana/Loki 查询说明写进 `docs/drama-startup-3s-optimization.md` 验收节。
3. 先部署 Backend（schema 兼容），再部署 Frontend。

### Batch 1 — 客户端三件套（Railway 路径先吃红利）

1. iOS 默认 `forceHlsOnApple` / 环境变量默认 true；engine 上报核对。
2. 扩展 `drama-playback`：解析子清单 → 预取视频首片 + 音轨首片 + MAP init；loader 命中。
3. `hls-media-source`：`startFragPrefetch`、起播/稳播缓冲水位、保守 ABR、rebuffer 降档。
4. 进页：详情/放映 hydrate 不挡播放器；episode/续集 intent 提前取址。
5. 封面让带宽：pointerdown 后媒体请求优先于装饰图。
6. 单测：缓存过期、URL 不匹配、音轨/init 缺失、重试绕过。

### Batch 2 — 边缘签发

1. Backend：签发/刷新 `edge_ticket`（TTL 5–10min，建议目录捎带）；片单/Stream 行同步 KV；Railway `/play` 回退保持。
2. Worker：只验 `edge_ticket`（签名+过期+环境）→ KV uid → 本地签 Stream JWT → 可选 inline_manifest；无效票返回可回退错误码。
3. Frontend：持票优先打边缘 play；401/过期则续票或回退 Railway 一次；诊断记 path。
4. 灰度：内部账号 → 10% → 50% → 100%；每步看 5xx、票过期率与起播失败率。

### Batch 3 — 首片边缘预热

1. Cron：热门 uid 拉视频/音轨/init 首块暖 PoP；指标成功数/耗时/失败原因码。
2. 与 Batch 1 预取叠加验收：冷启动首用户 vs 预热后 TTFB。
3. 若双端仍差 3s 门禁：评估 E2 R2 首块（单独小 PR，不阻塞回滚）。

### Batch 4 — 门禁验收

1. 等长 ≥7 天 Faro 窗口；Android/iOS × 全入口/cover × edge hit × segment hit。
2. 护栏与 discarded 流量。
3. 文档更新：`docs/drama-stream-ab.md` 增补边缘路径；本优化说明文档勾验收。

## 验证命令

```bash
pnpm --filter @miniapp/shared test
pnpm -r typecheck
pnpm --filter frontend test -- drama
pnpm --filter @miniapp/backend test -- drama
pnpm lint:complexity
pnpm --filter frontend build
pnpm --filter @miniapp/backend build
```

边缘 Worker：按 Worker 目录既有 test/typecheck（落地时补命令）。

## 人工验证

- 片库停留：可见封面出现 /play + 子清单 + 首块请求（background）。
- 点预热封面：起播无 /play、无子清单、无首片网络（或仅升档后续片）；3s 内首帧+playing。
- iOS Telegram：engine=hlsjs_mms；弱网 Fast 3G 仍可起播，不炸失败率。
- 关边缘开关：自动回退 Railway，可播。
- 预热 Cron 跑完后，冷账号首次点热门剧，首片 TTFB 低于预热前对照。
- 选集/自动下一集：挂载前已有 inflight/cache 取址。

## 规划门禁自检（start 前）

- [x] 复用调研：见 design §1
- [x] 可靠性：见 design §4
- [x] 最小充分：三支柱 + 进页/episode；拒绝双播放器首期/全量 SW/自建转码
- [x] 演进恢复：灰度开关与回退路径
- [x] 可验证性：本文件命令 + 人工场景 + Faro 门禁
- [x] mobile_performance / logging_integration：写入 task.json
