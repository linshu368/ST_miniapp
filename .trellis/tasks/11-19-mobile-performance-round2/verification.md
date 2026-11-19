# 四项优化实施与验收记录（2026-11-19）

四项代码优化已落地，本地自动验证已完成。当前为未提交、未部署候选，基于HEAD `989cad2c`；生产P95、真实Telegram与Railway停止场景保留发布验收，不将本地通过称为线上达标。

| 任务       | 当前代码与验证结果                                                                                                                                                                                                                      | 尚待发布验证                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 聊天与会话 | 详情关闭连接使用确切reason分类；共享身份完成后发现已离页即不再启动后续读取。独立SDK期限、身份/权限/真实DB失败保留。重试退避取消保留原reason，断连与DB错误竞态不吞错                                                                     | 新release的详情/分组/列表P95、取消与真实错误分布；CR身份故障真实cause及F4单次未映射React堆栈仍需线上证据 |
| 角色创作   | 兼容UUID覆盖创建、附件、封面、备份和心愿；edit从授权详情取得owner，不请求无关list。草稿恢复后才ready；编辑器与心愿页按功能拆分，状态仍由原本地草稿负责                                                                                  | 新旧就绪口径分开比较；iOS低样本不能声明稳态改善；新API分类从发布后建立基线                               |
| 影像创作   | feed首页critical/分页normal/预取background，共key复用在途请求；一次源读取支持最多4块，逐块fence。20秒后不再起新块，原取源/创建/在途调用超时不缩短；编码只读验证20秒。停止有界等待30秒，非幂等创建/发布未知继续保护，Retry-After竞态保留 | 真实供应商、Railway SIGTERM/强杀与账务核验；强杀仍是原五分钟租约，不能承诺所有重启都立即恢复             |
| 冷启动     | 六个同次慢样本完成分类；现网cookie根入口与直接/chats均200/CDN HIT。设置同步器移入已有后台chunk，最终构建root layout不再包含设置端点；核心列表、SDK、参数捕获及ready时刻保持原顺序                                                       | iOS请求发出前约5秒空档及Android建连/脚本问题不能由这项小改动全部解决；按真实网络/宿主继续分段核验        |

## 自动验证

- Frontend专项：10个既有测试文件、237项通过，覆盖UUID兼容、SSE/会话恢复、草稿/润色、共享预取/分页优先级、有限Faro标签、启动计时及参数。
- Backend聊天最终专项：5文件、34项通过；影像最终专项：3文件、23项通过。另运行HTTP/日志、Storage与播放回归（9文件79项通过的较早综合批次，和最终专项有重叠，不相加）。新增风险回归文件仅为规划批准的conversation-detail.test.ts及video-delivery-job.test.ts。
- Shared：25文件、258项通过。各应用包typecheck通过；Backend重新生成本地Prisma client后消除了旧生成物与当前schema的listing类型差异，未连接数据库或执行迁移。
- 页面：首次广范围107项中99通过、8失败；针对失败与新增影像场景复验37项中36通过，剩余一项完整长流程以90秒预算复验通过。合计110个不同平台/场景已覆盖通过。320px项目是窄屏Chromium，不冒充真实iOS设备。
- 长用例是200轮历史点赞、分支、重生成与刷新：实际48.5秒，原整例45秒不够。本次只给这一用例90秒总预算，各操作/断言期限和产品P95预算不变。其余初次失败包括开发编译/热更新及跳页时序，预热后复验通过；保留首轮失败记录，不改成一次全绿。
- 生产构建：Frontend Next.js及Admin Vite均通过。本地Frontend构建关闭Sentry release/source-map上传，不产生部署或外部发布。旧standalone整体移至output/build-snapshots，未递归删除或遍历node_modules junction。
- 导入边界、复杂度、Backend日志门禁、数据库契约检查通过；模块知识载荷及五个任务的mobile_performance/logging_integration声明通过。复杂度基线收紧，原超长文件26→23、函数93→89；其余既有债务未放宽。
- Frontend既有img警告、Admin大chunk警告及既有迁移的6条DB契约提示保留；本轮没有SQL变更。Windows原lint:imports命令的空rule对象被shell误解析，使用同一ESLint配置、去掉无作用的空rule参数执行等价检查。

## 可重复入口

```powershell
pnpm --filter @miniapp/frontend exec vitest run --maxWorkers=1 src/components/creation/character-editor.test.ts src/lib/api/creator-characters.test.ts src/lib/api/conversation-stream.test.ts src/lib/api/conversations-entry.test.ts src/lib/api/image-plaza.test.ts src/lib/perf/page-tracker.test.ts src/lib/perf/grafana.test.ts src/lib/perf/api-timing.test.ts src/lib/telegram/launch-url.test.ts src/hooks/use-conversation-turn.test.ts
pnpm --filter @miniapp/backend exec vitest run --maxWorkers=1 src/routes/conversation-detail.test.ts src/infrastructure/repositories/conversation-page-retry.test.ts src/lib/user.test.ts src/features/conversations/active-delivery.test.ts src/routes/conversation-folders.test.ts src/features/image-plaza/video-delivery-job.test.ts src/features/image-plaza/video-stream.test.ts src/features/image-plaza/video-upstream.test.ts
pnpm test:ui --grep '@creator|@chat|@image|@startup'
pnpm -r --workspace-concurrency=1 typecheck
pnpm lint:complexity
pnpm lint:backend-logging
pnpm lint:db-contract
```

仅检查输出与结果保留在忽略目录 `output/performance/round2/`。首次并发单测曾因本机内存不足退出，改为单worker后通过。根yaml依赖已在锁定store内，补回本地缺失链接后DB检查通过；依赖清单/lockfile未改。构建与运行报告见 `docs/mobile-performance-round2.md`，冷启动样本与产物见子任务research目录。

## 发布与剩余边界

任务保持review：本地实施4/4完成，生产验证pending。没有commit、push、部署、生产配置写入、Sentry问题关闭、真实付费生成或数据库迁移。

发布后以新release固定48小时，按Android/iOS及route/API分别记录P95与N，同时看error/stall/left。每组N不足100时延至72小时，缺样本继续null。creator_draft_ready_v2必须单独比较，新增creator API分类不能回填历史other。冷启动4秒、聊天/角色2秒是待验目标；异常计费/丢稿/权限问题立即停止，充分样本同口径P95回退超过10%且200ms时回滚该批。无schema变更，应用回滚即可；不撤回已完成账务。

新复杂流程已纳入既有本地验收系统：角色沿@creator、聊天沿@chat、启动沿@startup；补入@image的分页/筛选/旧游标用例。真机键盘、原生遮罩、真实模型与Railway终止宽限仍由TEST/生产验证。
