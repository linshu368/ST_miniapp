# 短剧快进诊断补记 hls.js 加载事件

## Goal

找出 Android hls.js「开播约 2s 内向前快进后卡死」的根因。现象是目标视频分片每 100ms 被中止再重发，用户最长卡 60s。这一项约占 Android 快进放弃样本的 2/3–3/4，估计影响恢复率 2.1–2.4pp（P0，目标 95%）。

本地用合成 HLS 复现 3 轮共 43 次都没出现（直接定位 / 真实拖动流程、1.5–8Mbps、内联主清单加载器、档位倒序），所以改用线上样本定位。现有诊断只记录**加载完成**的分片（`FRAG_LOADED`），卡死时目标视频分片从来没完成，诊断里只剩资源计时里成对出现的短请求，看不出 hls.js 在做什么。

## Requirements

- 只在**快进诊断**的观察窗口内，额外记录 hls.js 的 4 类事件：分片开始加载（`FRAG_LOADING`）、紧急中止（`FRAG_LOAD_EMERGENCY_ABORTED`）、档位切换（`LEVEL_SWITCHING`）、错误（`ERROR`，只记 `details` 标识符和 `fatal`）。每条带相对快进开始的时间、轨道、sn、level。起播诊断不变。
- 条数上限 24（保留最早 12 条和最近 12 条），其余只计数（`eventCounts`），不丢失循环的规模信息。
- 不记 URL、不记错误文案或堆栈；`details` 只接受 hls.js 的驼峰标识符（≤48 字符）。
- shared 契约是 strict 的：先发布只改契约的 PR（后端随之部署，可以接收新字段），后端上线后再发布前端记录。顺序反了，新字段会让整条诊断被后端拒收。

## Acceptance Criteria

- [ ] shared：`diagnostics.hls.events` / `eventsTruncated` / `eventCounts` 均可选，旧客户端不受影响；schema 单测覆盖合法、超限、非法 `details`。
- [ ] 前端：快进窗口内记录这 4 类事件，终态后停止订阅；单测覆盖记录、上限计数、终态后不再记录、起播诊断不带 events。
- [ ] 发布顺序：契约 PR 合并且 Railway 部署确认后，再合并前端 PR。
- [ ] 上线后 3–7 天：从带卡死特征的样本（目标视频分片未完成 + 资源计时里周期约 100ms 的成对请求）里，读出 hls.js 的重复动作和错误类型，给出根因结论和修复方案（另开任务）。

## Android/iOS 性能 P95 门禁

- 受影响页面：`/watch`、`/dramas/:id` 播放器的快进诊断（只增加观测，不改播放行为）
- 受影响接口：`POST /api/telemetry/drama-timing`（请求体多了可选字段，单条诊断增加约 1–2KB）
- Android 快进含放弃 P95：基线 ≥4350ms（hls.js）/ 目标 3000ms；本任务不直接改变耗时
- iOS 快进含放弃 P95：基线 ≥4666ms（hls.js）/ 目标 3000ms；本任务不直接改变耗时
- 数据来源与观测窗口：同 `11-18-drama-seek-snap-lowlevel`
- 发布后验证：卡死样本约 4%（Android hls.js 未缓冲向前快进），7 天预计 20–30 条，足够定位；验证 telemetry 接口的 4xx 不上升
