# 两日性能回归与提交证据

## 报告对比

- 2026-10-30 15:00 至 10-31 15:00：`messages` P95 34.31s、`regenerate` 55.14s；会话详情/创建 5xx 集中，聊天页面终态 error 103/109。
- 2026-10-31 15:00 至 11-01 15:00：`messages` P95 50.56s、`regenerate` 65.22s，但浏览器首字成功 P95 分别为 5.36s、5.05s，完整回复 P95 为 42.11s、61.12s；会话 5xx 和页面终态错误已明显恢复。
- 第二天 `creator/polish` P95 72.45s，完整生成慢型号超过 100s，`stream_interrupted + timeout` 增加；这说明主要长尾位于供应商/完整生成阶段，而非首字前准备。
- `/chat`、`/profile`、`/chats` 页面导航反弹，但 `/characters`、`/dramas` 改善；首页 pageload 样本从 10,735 降至 175 后 P95 变化，不能直接作为同口径代码回归。

## 提交与口径

- `0010be69` 接入首字 Grafana 观测；`bbd3d7f0` 并行模型目录与用户映射、压缩首字前准备，方向上应改善首字，现有 5 秒左右首字数据与之相符。
- `aa3965bc` 增加启动壳和 startup 埋点，`5043d930` 改入口渲染与页面追踪；它们改变采集覆盖和 ready 阶段，首页 pageload 跨窗口样本不可直接比较。
- `da70a3a3`、`3ec41958` 分别优化生成后置等待、图片/组件加载和 Profile 社群面板；这些提交并不能解释第二天完整生成长尾。
- `f69ea842` 是大量性能改动的汇总合并，降低单提交归因能力；前期 Railway 证据显示资源远未饱和，不能归因于 CPU/内存不足。

## Sentry 按 release 复核（2026-11-02 查询）

- 自动 `http.server` span 在 `5fffd6ce`（10 月 30 日 22:59 的 dev 合并）上，`messages` P95 45.65s（n=1,925）、`regenerate` 56.36s（n=200），低于 11 月 1 日日报跨 release 聚合的 50.56s/65.22s。
- 同一自动 span 口径在更早 release 也有极端值：`98eced45` 的 `messages` P95 110.64s、`a1600184` 60.49s；最近 `b07cd964`、`d1ae70a8` 仍可见 76.79s、87.22s。
- 因而没有“10 月 30 日某个最新 commit 使 SSE 响应单调变慢”的证据。聚合波动更符合完整输出时长、模型/provider、会话与回复长度分布变化；同时自动 span 的连接生命周期口径会系统性放大接口响应 P95。

## 根因分级

1. 已证实：Sentry 自动 `http.server` span 与现有 `onResponse` Metrics 都等待 SSE 流结束，统计的是完整回复，不是首字响应；因此 50–65 秒不能作为 SSE 响应 P95。
2. 已证实：首字约 5 秒而完整回复 42–61 秒，长尾主要发生在首字之后；中断、超时、慢模型与 OpenRouter/Railway 内部依赖失败仍集中在生成链路。
3. 强相关：聊天/个人中心/会话列表的页面反弹更偏 Telegram WebView、共享资源、客户端编排和样本结构；普通读取接口多为亚秒级。
4. 尚不能唯一归因：缺少按相同 release、设备、provider/model、输入输出 token 的稳定样本，不能指定单个提交或单家供应商为唯一根因。

## 复用调研

- 复用 `createReplyStreamSink` 作为“确实写到 socket”的唯一事实源，不在生成编排层猜测首字是否交付。
- 扩展 `perf-metrics.ts` 的全量 Sentry Metrics 与故障隔离模式，不新建第二套监控框架。
- 保留 `observeChatFirstToken`/Grafana 的服务端选中和浏览器提交口径；它们用于不同阶段，不能互相替代。
- 修改现有 `sse.test.ts`、`perf-metrics.test.ts`，不创建新测试文件。
