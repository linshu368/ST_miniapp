# 实施与验证记录（2026-11-19）

用户“开始处理”批准后启动。只实施支付自动对账；未改订单金额、钱包、公开支付 API、主动查单和验签回调。无 stage/commit/push，无 TEST/生产 migration 或部署。

## 结果

- 自动窗口 7 天缩至创建后 8 小时，DB 夹紧旧调用窗口，应用在每次派发前再检查，恰好边界允许。在途确认已付仍完成原幂等结算。
- 到期后的明确 unpaid 按当前领取 timestamp CAS 计数，0..3，两个任务共用持久状态；错误/超时/未知不计，第三次停止，停查行保留至超龄/终态清理。历史只回填当前窗口内有效自动 unpaid。
- 后台自动 query 的 provider*unavailable/network/timeout/rate_limited 为 warn，outcome 仍 failed，ops 事实/告警不变。其他故障 error。每轮单一业务摘要以数值 Count 输出，去除脚本重复摘要；保留基础 operation 事件、链路及单次停查 info。安全 code 限数字或 HTTP*数字，禁上游原始 msg/URL。取消与独立错误交错时仍保留真正故障。

## 已执行

- `pnpm -r typecheck` 全部通过；最后增补测试后 backend typecheck 再通过。
- `pnpm --filter @miniapp/backend exec vitest run src/features/payment src/infrastructure/payment src/infrastructure/repositories/MiniappPaymentOrderRepository.test.ts src/platform/observability --maxWorkers=2`：22 文件 / 245 测试通过。覆盖边界、排队跨界、在途支付、第三次停查/重放、不明确响应、分级、真实安全字段投影、持久化失败及回调/主动恢复原回归。
- `pnpm --filter @miniapp/shared test`：25 文件 / 264 测试通过。
- Admin/Frontend build 均通过，有既有大 bundle、img、Browserslist 和 Tailwind 警告。Frontend 现有构建钩子上传了本地 release sourcemap 到既有 Sentry 项目；未部署应用。
- logging planning gate、module baseline、上下文 validate、backend-logging、复杂度、migration 命名、db-contract、等价 imports eslint 和 diff whitespace 均通过。复杂度有既有超标警告；db-contract 6 条视频历史告警，与本次无关。
- 本机无 Docker/psql，先修复缺失的 node_modules（frozen lockfile，不改 manifest/lockfile）。从 PostgreSQL 官方链接的 EDB ZIP 在 TEMP 启动独立 PG17.12，只监听 localhost，合成数据，无远端 URI。扩展现有 test-db-reorg-p4a-migration.sh；临时适配仅把 Docker 传输改为该原生实例，保留同一 fixture/SQL/断言，非超级用户 app_admin 执行两轮均通过。
- 隔离 SQL 覆盖 p4a 原 expand/contract/RPC 的重放与 SKIP LOCKED，新迁移重复执行、0/1/2/超过3的历史封顶、到期前/失败/用户查询过滤、8 小时 DB 夹紧、计数 1/2/3、同键重放/旧领取、双会话结果只增一次、已付款回调锁交错、service_role 权限、原 claim 函数体回退并核验后前向恢复。不改钱/订单的断言通过。

## 全量测试局限

首次 backend 全量 185 文件：181 文件通过，6 失败 / 1968 通过。降低为 2 workers 后 5 失败 / 1970 通过（其间补了 1 项测试）。失败集中 conversations-branch 首次鉴权、conversations-thinking 首次取消（后续一项受超时串扰）、conversation-detail 两项真实断连、generation/upstream 本机 HTTP 计时。

已在干净 HEAD abdd4063 的隔离 worktree 用相同依赖及原环境（仅内存传递，不复制/导出凭据）复跑四个原文件：同样 6 失败 / 79 通过，确认原基线可复现，不为本次改动修改聊天用例或降低断言。本地配置使用全局 ProxyAgent，localhost 网络测试可能受代理影响；未将推测写成确定根因。全量门禁尚非全绿。

## 发布与剩余验收

必须先 TEST 单文件迁移，再人工验收两个任务/重启停查、晚付验签通知/主动查询、真实日志和告警；之后独立审核生产迁移并部署两个任务。发布时暂停/排空自动任务，API 恢复入口保持可用。当前源码完成不代表线上生效，线上旧单仍按现运行版本直到发布。

建议将支付恢复验收纳入既有本地验收流程：有效期内支付、第三次待付停查、8 小时超龄、停止后晚付通知/主动查询、双任务与重启。UI fixture 只能覆盖页面状态，真实网关、DB 并发与资金验证继续用专用 TEST 流程。

回退/前向恢复和清理已移除任务的限制见 packages/shared/migrations/README.md；不回滚订单或钱包。Android/iOS 页面/API P95 不适用，本次未伪造线上性能样本。

清理：隔离 PG 已正常停止，干净基线 worktree 与依赖 junction 已移除。删除 TEMP 中本次下载/测试暂存目录及 ZIP 的清理命令被自动审批返回 blocked by policy，未执行；保留临时文件，没有修改审批策略。
