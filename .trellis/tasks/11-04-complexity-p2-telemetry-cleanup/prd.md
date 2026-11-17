# 降复杂度 P2：埋点与死代码清理

父任务：`11-04-complexity-reduction`。用户 2026-11-04 确认：死代码与生产未生效代码直接删；前端 PostHog 整套删除（以后需要再重新接）；短剧计时双轨验证已结束；Grafana 过期看板可删。

## 范围（按 PR 拆分）

### PR-A：移除 PostHog（前端 + 后端）

生产现状（2026-11-04 核对）：前端 Vercel 配了 `NEXT_PUBLIC_POSTHOG_KEY/HOST`，录屏与事件在跑；后端 Railway 未配 `POSTHOG_API_KEY`，服务端 capture 一直空转。录屏与 Sentry Replay（错误 100%、会话 5%）重复，事件在 Grafana/Sentry 无对应用途。

- 前端删除：`lib/telemetry/`（adapter/config/lifecycle/masking/ReplayLifecycleOwner）、`lib/payment/flow-telemetry.ts`、`lib/payment/paywall-continuation.ts`、`lib/image-generation/telemetry.ts` 及只服务回放的 pending/return 观测；去掉各页面/组件中的 capture 调用、`PH_*` 遮罩 class、`replayContextId` 透传；`lib/sentry/tracing.ts` 去掉 PostHog 排除；移除 `posthog-js` 依赖。
- 后端删除：`infrastructure/telemetry/posthog-capture.ts`、`PaymentOrderTelemetry.ts`、`ImageGenerationTelemetry.ts`、`config.posthog`、`GET /api/telemetry/replay-context`。
- shared：删除只服务回放事件的 schema；保留仍被其他链路使用的导出（以 typecheck 为准）。
- 同步 spec/docs/env 示例中关于 PostHog 的描述。

不变量：充值后返回原页面仍由 URL `returnTo` 驱动；支付打开链接的本地存储（open-storage）保留，仅去掉 `replayContextId` 字段；Sentry、Faro/Grafana 采集不变；聊天、支付、图片生成的业务流程与请求次数不变。

### PR-B：短剧计时写库残留与 Grafana 文档

- 删除短剧计时 Supabase 写入残留：`features/drama/timing-processor.ts`（无调用方）、`timing-repository.ts`、`scripts/import-drama-timing.ts` 的写库主流程、`getDramaTimingPersistenceConfig().enabled`。Railway 日志解析拆到 `scripts/railway-drama-report.ts`，供 `compare-drama-cdn.ts` 继续使用。数据库表/RPC 与 `scripts/test-drama-observability-local.sh`（迁移验证）不动。
- `docs/grafana/`：删除 4 个 `*-retired.json`，同步线上已改的工程看板/经营核心链接。
- 删除无引用的 `components/payment/vip-plan-card.tsx`。knip 报告的其余文件是运维脚本或部署配置入口（Railway IaC、Prisma seed、告警任务、一次性迁移脚本），保留。

### 推迟：短剧计时双轨旧轨（2026-11-04 用户决定）

生产前端仍是 legacy（后端每 6 小时约 63 条 start 报告），CDN AB 对比脚本用这些 Railway 日志算两组分母。Cloudflare 小批量 AB 试验结束后再删：`drama-observer.ts` 的非 unified 分支、`NEXT_PUBLIC_DRAMA_TIMING_MODE`、`compare-drama-cdn.ts` 与 `railway-drama-report.ts`、`ops/drama-cdn-rollout.md` 中的 legacy 锁定步骤。

## 部署后需人工清理（代码合并并上线后）

- Vercel：`NEXT_PUBLIC_POSTHOG_KEY`、`NEXT_PUBLIC_POSTHOG_HOST`（2026-11-04 已删除）；`NEXT_PUBLIC_DRAMA_TIMING_MODE` 等旧轨删除后再清。
- Railway：`DRAMA_TIMING_PERSIST_ENABLED`。
- Grafana：`chat-first-token-manual`（需先去掉工程｜02 指向它的链接）。

## Acceptance Criteria

- [ ] 仓库无 `posthog` 引用（锁文件除外随依赖移除自动消失）；`pnpm -r typecheck`、四个包测试、frontend/admin build、lint 全部通过。
- [ ] `pnpm test:ui --grep @chat`、`@profile` 通过（聊天、充值入口、订单页）。
- [ ] 上线后 24h：Sentry 错误率与 Faro 页面/接口 P95 无回退；充值成功率（经营核心看板）无异常。
- [ ] PR-B：短剧工程看板 24h 播放窗口样本数与上线前同量级，AB 分组字段仍完整；后端仍收到 legacy start 报告。

## Android/iOS 性能 P95 门禁

见 `task.json.meta.mobile_performance`：只删除埋点代码，目标为不退化；移除 posthog-js 动态加载后首屏不应变慢。
