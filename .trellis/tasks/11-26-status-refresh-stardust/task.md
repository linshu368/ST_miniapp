# 任务分解

- [x] T1 迁移 `20261126_status_refresh_charge.sql`（约束 ×2、白名单、`billing.charge_status_refresh`、尾检、回滚说明）
- [x] T2 迁移测试 `scripts/test-status-refresh-charge-migration.sh`（专项优先拆分、不足、幂等、预留保护、跨用户、旧类型、权限、重放）
- [x] T3 shared：`STATUS_REFRESH_CREDITS`、删 `manualUpdate`
- [x] T4 后端：repository + `status-refresh-billing.ts` + service/route/template 改造 + 钱包明细 + 注释
- [x] T5 后端单测 `refreshBillable`
- [x] T6 前端：说明卡、价格气泡、去 VIP、余额不足、失败文案、钱包缓存、我的页文案、ui-tests fixture
- [x] T7 文档：registry.yaml、ARCHITECTURE
- [ ] T8 本地验证命令全过；人工场景改为 `pnpm test:ui --grep @status-refresh`（Chrome 扩展未连接）
- [ ] T9 迁移 TEST → TEST 接口验证 → 迁移生产 → 代码发布 → 生产核对 → 同步回 dev
