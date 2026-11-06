# 短剧慢启动Loki采集：最终审阅包

基线：73be921048407249c896db5332c93426ee1fc996（用户明确允许）。分支：codex/drama-slow-diagnostics-loki。原main工作区未修改。

## 变更摘要

- 仅两处运行时代码：既有OTLP出口新增受控JSON日志正文；原鉴权接收端取消Supabase分析写入，转交同一出口。
- 达到5000ms的final与迟到network完整保留；无五秒快照、无播放策略变化、无新依赖/服务/凭证/数据库迁移。
- 原工程短剧看板仅新增两个Loki详情面板与观察ID变量，保留其他面板；上线时合入当前线上JSON，不能用模板整份覆盖。
- 历史Supabase数据/导入器/旧SQL看板保留，原flag不再触发新路由写库。

## 验证

- Backend全量1038、shared186、最终相关17测试通过；真实本地HTTP接收OTLP JSON，验证完整media/queries与受限字段。
- 全仓typecheck、Frontend/Admin build、import lint、修改文件格式和diff检查通过。
- 两个LogQL经Cloud只读请求接受；未部署新事件，空结果不当送达成功。
- 本任务模块payload/hash/证据/上下文校验通过；全局模块检查被既有drama-experience.md缺少“当前状态”章节阻塞，不在本次范围。

## 完整差异与内容锁定

[完整patch](/private/tmp/st-drama-loki-review-20261029.patch)；验证细节见 [verification.md](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/.trellis/tasks/10-29-drama-five-second-diagnostics/verification.md)。

以下文件内容清单聚合SHA-256：`d5e80d1505e629f22a054626381afbb1002b15b06abe8e82a3a8df1f5b358d8d`。审阅包本身不参与自身摘要，任一源文件/任务文件修改后需要重新生成并审阅。

## 拟提交

`feat: retain slow drama startup diagnostics in Loki`

一个变更单元：下列文件，以及本review.md；不包括原工作区修改。提交、推送和生产发布各需分别授权。

- [.trellis/spec/backend/app/data-reliability-and-security.md](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/.trellis/spec/backend/app/data-reliability-and-security.md) — `af41125c3596edb53c549f7efca31c7ab7ca7d4109beff373fa6fb923a5c12ec`
- [README.md](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/README.md) — `cf7fa602e7072c526f96c4af9c6c09d0e344199975e85346646db3459b1e019a`
- [docs/ARCHITECTURE.md](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/docs/ARCHITECTURE.md) — `cbd566e6213ec47af99682e536f32fa04d6222c2bf8d523eb29f26ae40d9be67`
- [docs/drama-playback-timing.md](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/docs/drama-playback-timing.md) — `f422dfc2f4c23b69f5cde8747c62a153ac4d9866d9f89beaa42d4cc5ee1da2f5`
- [docs/grafana/drama-playback-runbook.md](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/docs/grafana/drama-playback-runbook.md) — `a05c82f1fd54f930c7b15134478908e0ef2236042bd1de9b856b39cc655bca03`
- [docs/grafana/engineering-performance.md](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/docs/grafana/engineering-performance.md) — `6f588b8c2432bc52e3392c8d6d60e380edb49c721ee9c7f4da0b357cd382d800`
- [docs/grafana/st-engineering-drama.json](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/docs/grafana/st-engineering-drama.json) — `14705066a462a2375d1841158da68cb12fbbaf5113641acd185f86b6b5aad822`
- [ops/observability/README.md](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/ops/observability/README.md) — `504eec57fba0ce75f94dfd0ef8c7d7023eeb9cbe18e5291da8037f4c9f8b2f7f`
- [packages/backend/src/lib/engineering-observability.test.ts](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/packages/backend/src/lib/engineering-observability.test.ts) — `8d436580df351d6d7def4fa66cbfb5453210adb3b34b3adafd3caf4e3fdc0fa0`
- [packages/backend/src/lib/engineering-observability.ts](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/packages/backend/src/lib/engineering-observability.ts) — `88ab671de085c80f6bed21005ddac61eba0470afeb400e75ec78da40e2cf7407`
- [packages/backend/src/routes/telemetry.test.ts](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/packages/backend/src/routes/telemetry.test.ts) — `eabcd5e44b5a2d74ba769e0022aeea9e6acf18da1fb1f13822ba42097cbf3565`
- [packages/backend/src/routes/telemetry.ts](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/packages/backend/src/routes/telemetry.ts) — `2df450a218ad8c68f22475abd80b6e7a2bc816d1283c557331707c9832d06903`
- [.trellis/tasks/10-29-drama-five-second-diagnostics/check.jsonl](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/.trellis/tasks/10-29-drama-five-second-diagnostics/check.jsonl) — `e49d25704b6a35ff1a01fe43718142756705016043e90f870c41361763a55761`
- [.trellis/tasks/10-29-drama-five-second-diagnostics/design.md](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/.trellis/tasks/10-29-drama-five-second-diagnostics/design.md) — `743cc740033fee07e3b3da64b96915892b39f5c4fa77bb53eb31332ed6ae7613`
- [.trellis/tasks/10-29-drama-five-second-diagnostics/implement.jsonl](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/.trellis/tasks/10-29-drama-five-second-diagnostics/implement.jsonl) — `e49d25704b6a35ff1a01fe43718142756705016043e90f870c41361763a55761`
- [.trellis/tasks/10-29-drama-five-second-diagnostics/implement.md](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/.trellis/tasks/10-29-drama-five-second-diagnostics/implement.md) — `197b4cc3ea64e3b34e09ffba23474da46845f786df28a4701b8cc31af836bd51`
- [.trellis/tasks/10-29-drama-five-second-diagnostics/module-updates.json](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/.trellis/tasks/10-29-drama-five-second-diagnostics/module-updates.json) — `9e0e92aaa51259a1a238e52e2a172c1934403058361947bbb04ea6d572646e0b`
- [.trellis/tasks/10-29-drama-five-second-diagnostics/prd.md](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/.trellis/tasks/10-29-drama-five-second-diagnostics/prd.md) — `1153bf86925a8f83cad031fdc53aaa207d950240a5639b97d9bc7089b762ff18`
- [.trellis/tasks/10-29-drama-five-second-diagnostics/task.json](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/.trellis/tasks/10-29-drama-five-second-diagnostics/task.json) — `b0aef463ad6e7b53d0b48b82e040f8f8147c07939c36ffdd25656af40e79210d`
- [.trellis/tasks/10-29-drama-five-second-diagnostics/task.md](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/.trellis/tasks/10-29-drama-five-second-diagnostics/task.md) — `0cf861e8aa07f66333f452579b76ee94bbbcda4cc02e5ba13bd633c8e767077d`
- [.trellis/tasks/10-29-drama-five-second-diagnostics/verification.md](/Users/qj/.codex/worktrees/drama-five-second-diagnostics/ST_miniAPP/.trellis/tasks/10-29-drama-five-second-diagnostics/verification.md) — `87774db7e09ddec101687680a8b102687cc94737b3b2359c8bbb90b2e5be57b1`

## 发布边界与恢复

尚未git add/commit/push、未创建PR、未发布Backend、未改线上看板。下一步先确认最终内容后提交；用户另行批准推送/发布，再发布Backend并补线上两面板，无Frontend/DB动作。自然慢样本可查询final与network后才算Cloud闭环。

202仅接口接收，关闭/过载/断网/强退仍可能丢失；iOS计时受限不会被日志解除。回退旧Backend前需独立授权关闭旧持久化flag，避免恢复Supabase新写入。
