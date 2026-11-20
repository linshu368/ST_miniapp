# 执行与验证计划

## 启动前

用户“开始处理”已审核最终摘要，task.py start 已通过。inline执行，不派发子代理，不stage/commit/push。工作树初检为干净；继续实施前重新确认其他会话改动。

## 顺序

1. 复查research.md后，完成“超过创建后8小时或到期后三次明确未付即停”、失败不计数、窗口内补查、保留回调/主动查单及历史回填的合并摘要审核。
2. 核验production结构采集记录与TEST结构，写前向migration及回滚说明，同步registry；不在本轮远端apply。
3. repository新增结果记录，claim签名兼容；两个调度器共用8小时窗口、派发前年龄守卫与计数/停查事件。
4. 可恢复后台外呼失败显式warn，准确汇总并去等价重复业务摘要；保留严重error、基础事件与ops事实。
5. 扩展既有PaymentReconciliation.test.ts、PaymentOperationEvents.test.ts、PaymentAlertRules及repository相关回归；扩展既有scripts/test-db-reorg-p4a-migration.sh或其现有fixture验证新迁移，不默认新增测试文件。
6. 更新根README、ARCHITECTURE、ops/railway/README.md、payment/logging模块事实和相关spec。

## 必测矩阵

8小时以内/恰好8小时/超过8小时及领取后跨界；过龄不发外呼但已确认paid允许完成；到期前unpaid不增停查计数；到期后0→1→2→3停查；中间失败不计数；两个worker合计；重复结果/过期领取/重启/两个并发result；第三次与已付回调交错；计数RPC提交未知/权限失败/超时；停查后主动查询与验签回调仍幂等补账；旧数据无事件/重复事件/到期前后明确未付与failed不混计；迁移前后shape/ACL/锁与回滚及有界任务恢复；当前6笔code500仍真实failed且不计未付；资金/配置/一致性/DB仍error；逐单warn与轮级计数、trace、安全字段、告警规则不误恢复。

## 命令

- python .trellis/scripts/logging_planning_gate.py --task .trellis/tasks/11-19-payment-unpaid-stop-noise
- pnpm --filter @miniapp/backend test -- src/features/payment/usecases/PaymentReconciliation.test.ts src/features/payment/usecases/PaymentOperationEvents.test.ts
- pnpm --filter @miniapp/backend test（适用支付/网关/结算/告警/repository既有回归，确认fixture不调用真实支付）
- bash scripts/test-db-reorg-p4a-migration.sh（先核对扩展后的隔离数据库依赖与新迁移覆盖，禁止指向生产）
- pnpm -r typecheck
- pnpm --filter @miniapp/shared test（若触及共享契约）
- pnpm --filter @miniapp/admin build / pnpm --filter @miniapp/frontend build（跨包构建，记录已知本地依赖缺失）
- pnpm lint:backend-logging / pnpm lint:complexity / pnpm lint:db-contract / pnpm lint:migrations
- pnpm lint:imports（Windows空规则引号问题时用去掉--rule空对象的等价eslint命令）
- git diff --check，Prettier仅本次路径

支付风险确认必须以回归锁定；优先扩展既有测试。记录环境依赖失败和未执行的真实场景，不通过降低断言修绿。TEST人工验证重启、两个调度器停查、晚付回调/主动查单、实际日志级别和轮级汇总；真实供应商调用或生产写另按授权执行，不生成真实付款。

实施和核验结果见 verification.md。
