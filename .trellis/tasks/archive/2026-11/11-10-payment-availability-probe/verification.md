# 交付与验证记录 — 2026-11-10

## 已实现范围

独立 payment-availability-probe Cron，默认每半小时一轮；环境变量 PAYMENT_PROBE_ENABLED 默认关闭，默认 alipay 可配置 wxpay。复用 TTZF 网关，固定 1 元、一次请求、不保存订单、不查询或付款。开关独立于用户支付开关，preview/pr 环境跳过；禁用时不初始化 DB。

策略位于 `packages/backend/src/features/payment/availability/strategies/`，组合入口 `index.ts`。单/多策略统一执行，最多 8 个、并发 2；失败互不阻断，总预算 45 秒取消、60 秒硬退出。默认飞书使用现有事故/outbox，精确允许新规则 P1/恢复，持续故障去重。

附带必要修复：advisory lock 解锁失败仍关闭持有连接；删除 IaC 已有重复 paymentAlertMonitorEnv 声明；更新生产环境 example 中过时的 Vexutopia 支付配置为当前 TTZF。无新增数据库对象或 migration。

维护说明：`docs/payment-availability-probe.md`；README、架构、运维与 Backend spec 均有入口。模块事实通过本任务 module-updates.json 在归档时同步。

## 本地验证

- Shared：20 个测试文件、233 项测试通过。
- Backend 全量：以 `pnpm --filter @miniapp/backend exec vitest run --exclude "**/*.integration.test.ts" --maxWorkers 2` 运行，139 个文件、1549 项测试通过。
- 全量首次与构建/类型检查并行时，对话 branch/thinking 测试出现 5 秒超时及后续 mock 干扰；降低并发后全量通过，未为此修改对话代码或放宽测试超时。
- 末次审查增加 45 秒取消后，5 个相关测试文件、84 项测试通过，覆盖无重发/无发布、连接清理及 timer 释放。其余源码没有变化。
- `pnpm -r typecheck` 通过；Frontend 与 Admin production build 通过。Frontend 存在既有 img/hook lint 提示，Admin 存在大 chunk 提示；没有因本任务更改这些无关内容。
- Frontend 标准 build 沿用了项目已有 Sentry source map 上传行为；未部署应用或启用探测。
- `pnpm lint:complexity` 通过，只有既有基线文件增长警告；新增/修改 runtime 文件未新增复杂度超标。
- `pnpm lint:imports` 脚本在 Windows 将 `'{}'` 作为字符串传给 eslint，参数解析失败；等价命令 `pnpm exec eslint --no-eslintrc -c .eslintrc.json "packages/*/src/**/*.{ts,tsx}" --no-inline-config` 通过（省略空规则覆盖，无规则语义变化）。
- IaC 独立 tsc 检查通过；通过已安装 Railway SDK 本地求值，验证 development/production 30 分钟 Cron、Never 重启、独立开关 preserve、notify 引用与 preview 排除，资源地址无重复。未执行远端 plan/apply。
- 最终 Backend typecheck、受影响运行时代码/新增指南的 Prettier check、git diff --check、module_knowledge check 与 Trellis context validate 均通过。上下文校验提示既有 reliability spec 超出自动注入长度，本次已直接读取相关章节。

## 未执行与发布交接

没有真实上游建单、飞书发送、远程 DB 读写、部署、开关发布或 git commit/push。测试均使用 fake/mocks；测试进程出现宿主已有 TLS 环境警告，未改变宿主配置，测试不作为真实 TLS/供应商验收证据。

上线前由工程师确认 TEST/production 凭据、合法公网 clientIp、1 元受理/商户风控和通知开关，先升级共享告警 worker 后启用独立探测。受控 TEST 验证真实上游与飞书、无本地订单/账务写入；开启前后各观察 24 小时双端充值页/用户建单 P95、DB 连接及 429，低样本延长。

本次任务归档表示代码与文档交付完成，远端发布验收仍需独立完成。回退为关闭 PAYMENT_PROBE_ENABLED；不影响正常用户支付、对账或共享告警投递。
