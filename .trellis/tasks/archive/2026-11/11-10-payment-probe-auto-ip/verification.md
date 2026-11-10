# 自动获取探测 IP 更正记录 — 2026-11-10

## 实现与文档

已删除 PAYMENT_PROBE_CLIENT_IP 的 runtime 读取、PaymentProbeSettings 字段、IP 必填门禁、IaC 变量及环境模板配置。探测使用 `resolvePaymentProbeClientIp()`，本机首个非内部有效 IPv4 优先；空网卡、仅回环、仅 IPv6 或枚举异常均回退 127.0.0.1。无外部 IP 查询、额外依赖或请求；用户支付网关和真实用户 IP 处理保持不变。

README、Railway 运维、策略维护指南、Backend spec 已同步；钱包支付模块当前事实由 module-updates.json 在归档时更新。旧归档任务保留历史证据，本次更正取代其“IP 必填”的约定。使用现有测试文件补充回归，没有新建测试文件。

## 验证

- 定向 3 个测试文件、70 项测试通过，覆盖自动选择/兜底、探测请求实际传入自动 IP、原有隔离与取消契约。
- `pnpm -r typecheck` 全包通过；Shared 20 个文件、233 项测试通过。
- Backend 全量首次在类型检查并行时为 138 文件通过、1 文件失败，两个失败均为既有 conversations-thinking 的 5 秒超时及后续 mock 干扰；该文件单独重跑 23 项全部通过，未改对话代码或增加超时。
- `pnpm --filter @miniapp/backend exec vitest run --exclude "**/*.integration.test.ts" --maxWorkers 1` 串行全量复跑通过：139 个文件、1552 项测试。
- IaC tsc 及已安装 Railway SDK 本地求值通过：development/production 已无 IP 变量，开关、渠道和半小时周期保留。没有远端 plan/apply。
- 复杂度门禁通过（既有基线警告），等价 ESLint 导入检查、受影响代码/指南格式检查及 diff 检查通过。
- Frontend/Admin 源码、依赖和消费者契约均未变，沿用上一实现任务成功的 build 结果，本次不重复构建/上传 source map。
- 独立检查代理复核无阻断项。

## 发布边界

未发起真实 TTZF/飞书/DB 请求、未部署、未改线上环境变量、未提交或推送。容器本地地址不等于公网出口，上游实际是否接受该合成请求 IP 仍需受控 TEST 验收。已有 IP 环境变量不再读取，可在后续部署维护中移除。开关继续为 PAYMENT_PROBE_ENABLED，默认关闭。

## 后续 production 补建 — 2026-11-10

用户在代码推送后明确授权“帮我补到production”。通过 Railway 插件核实原服务尚未创建后，仅在 production 新建 `stminiapp-payment-availability-probe`，连接 `linshu368/ST_miniapp` 的 `main` 分支。应用前核对待发布变更只包含该新服务，无删除或其他服务变更。

服务使用现有 backend Dockerfile、独立探测启动命令、`*/30 * * * *` 调度、`NEVER` 重启策略与现有 production 同区域；配置引用同环境 `stminiapp` 的数据库、TTZF 与观测变量，无公网域名、TCP proxy 或卷。保留默认 `PAYMENT_PROBE_ENABLED=false` 与 `PAYMENT_PROBE_CHANNEL=alipay`，无需 client IP 变量。

部署 `36ae24f7-4b3b-401c-aa59-f98b83c18f8a` 状态为 `SUCCESS`，源码提交为 `246f5b062068d0003199717ddf93973acaf963b8`。回读确认 live 配置与调度正确、无遗留 staged changes；development 未创建该服务。构建沿用现有镜像，仍有 Node 20 与 package 要求 Node >=22 的既有 engine 提示，本次未修改共享镜像。

本次只完成默认关闭的 production 服务部署，未执行真实上游建单、飞书发送或数据库业务验收，不能作为供应商可用性或告警送达证据。真实验收及开启条件仍按维护指南执行。原任务保持已归档状态，后续记录作为本次授权部署的补充证据。
