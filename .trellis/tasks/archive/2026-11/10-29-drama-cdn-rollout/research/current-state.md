> 本文件保留开工前基线；PR #525 合 dev 后的新源码与生产只读证据见 ../production-preflight.md，不能把此处旧状态当成当前部署。

# 实现调研

日期 2026-10-29；来源为当前工作区源码／文档，不证明当前生产实况。

## 工作区和规范

分支 `codex/drama-bunny-preview`，HEAD `c39090344fcbab67d0aefedc6f924a4c87e5e2e7`。原有 dirty `ops/drama-bunny-preview/evidence.json` 和 untracked `experiment-closed.png` 保留。主目录旧 main 的其他播放改动不触碰。`.trellis/config.yaml` 为 Codex inline 模式，不派发 implement／check 子代理。

已读根 AGENTS、workflow、相关 spec 入口与关键可靠性／跨层／共享契约／API 状态规范、UI 测试说明。实施前按具体文件继续读取入口所引用的适用文档。

## 源码事实

- `platform/runtime-config.ts` 的 `getDramaPlaybackCdnConfig` 仅允许 pr-525＋TEST＋指定源；生产不能直接启用当前配置。
- `features/drama/signed-url.ts` 的 `buildBunnyPlayback` 固定 TEST origin 和 Preview 目录；URL 缓存区分 provider，但无用户稳定分流参数。
- `routes/drama.ts` 的 `/play` 已有鉴权、剧／集归属、no-store、分段；返回值缺实际路径／实验上下文。
- `lib/api/drama.ts` 的 playback query／prefetch 会复用旧值，单改后端开关不足以使前端放弃已缓存 Bunny 地址。
- `lib/perf/drama-media.ts` 的 observer 在 startup outcome 后停止；不能直接观测其后 seek。
- `components/drama/drama-progress.tsx` 先写 currentTime 后调 onCommit；计时和缓冲判断须移至提交前的观测点，保持松手单次 seek。
- `DramaPlayer` 用户重试调用 `beginPlayback(..., 'retry')`，目前没有根恢复链／累计计时。
- `api/drama-timing.ts` 与 `drama-observer.ts` 已有粗平台和随机 sessionId，无独立用户去重键。需验证 iPad 桌面 UA 的平台分类。
- `routes/telemetry.ts` 先写白名单日志，显式启用时仅将 playback 交现有队列／RPC；seek 应保留 startup 持久化边界。
- `scripts/import-drama-timing.ts` 的 `railwayDramaReport` 可解析 Railway／Pino NDJSON，现有导入有窗口／大小／行数与 manifest 限制；比较可复用而不写分析表。

## 文档差异

README 同时有普通 TEST Bunny 和更早独立实验说明，ARCHITECTURE 亦残留已删实验页面；实施仅同步相关段。timing 文档部分是旧十秒／日志-only 口径，实际 shared 已有 v2／platform。drama 模块文件存在但索引／格式有旧基线差异；不扩大为模块治理。

## 最小方案结论

生产回源、缓存绕过关闭、seek 假成功、重试重置、独立用户与缺报偏差均属于主路径。扩兼容契约和现有流程即可，不需实验表、媒体代理、新看板或自动熔断服务。真实性能收益未知，待生产小流量证据。
