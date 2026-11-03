# 验证记录

## 实现结果

- 无返回快照、无有效会话发现条件时，`/characters` 默认使用 `latest`；已有用户选择与详情返回快照继续优先。
- 默认最新不会启动推荐批次请求；切换推荐后原换批、撤回、曝光和失败恢复链路不变。
- Android/iOS 首批角色卡从6张收紧为4张；水合兜底也为4张。Android 平台策略只把首图设为 eager/high priority，iOS 保留前2图 eager、首图 high priority。
- 缓存列表的异常兜底刷新从统一1.5秒改为 Android 3秒、iOS 2.5秒、其他1.5秒；首图正常 load/error 后仍可立即刷新。

## 已执行检查

- `pnpm --filter @miniapp/frontend typecheck`：通过。
- `pnpm --filter @miniapp/frontend test -- src/lib/mobile-performance.test.ts`：1文件、6项通过。
- `pnpm --filter @miniapp/frontend test`：69文件、757项通过。
- `pnpm --filter @miniapp/frontend lint`：通过；仅有仓库既有的其他文件 `<img>` 告警，本次文件无新增告警。
- `pnpm --filter @miniapp/frontend build`：通过。首次因本地 Next.js 包缺少 `dist/build/webpack-build/impl` 失败；`pnpm install --force --frozen-lockfile` 按现有锁文件重建依赖后通过，锁文件未修改。
- `pnpm --filter @miniapp/ui-tests typecheck`：通过。
- `pnpm --filter @miniapp/ui-tests exec playwright test --project=android --grep '浏览角色时栏目固定|换批保留质量分层入口'`：2/2通过。
- `pnpm --filter @miniapp/ui-tests exec playwright test --grep '@roleplay'`：Android与narrow合计23/23通过。首轮在验收仍假设默认推荐时21项失败；脚本改为先断言默认最新，再显式切推荐后全绿。
- `git diff --check`：通过，仅有 Git 的 LF/CRLF 工作区提示。

## 生产 P95 门禁

基线窗口为 2026-11-02 18:00 至 2026-11-03 16:00（Asia/Shanghai）。Grafana `st_page_critical_visual` 的 `/characters` fetch+spa loaded/foreground：Android P95 5906.97ms（N=75），iOS P95 2538ms（N=6，低样本）；Sentry `GET /api/characters` P95 214.22ms（N=370）。

2秒是发布目标，不是本地 fixture 可以证明的线上结果。发布后需按 release 连续观察至少两个完整24小时窗口，分别检查 Android/iOS、cache/fetch、mount/spa；每组有效终态少于100时延长窗口。关键视觉 P95 仍高于2秒或失败率上升时停止扩大发布，回退默认排序/首屏预算或 forward-fix。
