# Batch Lab Testing Deployment And Recovery

## 自动验证

常规修改至少运行：

```bash
pnpm --filter @miniapp/shared test -- batch-lab-contract
pnpm --filter @miniapp/backend test -- batch-lab execution-service BatchLabExecutionRepository
pnpm --filter @miniapp/batch-lab test -- client query-keys workbench
pnpm --filter @miniapp/batch-lab build
pnpm -r typecheck
git diff --check
```

跨包契约变更还需要确认 backend route、Batch Lab client、shared tests 和所有 consumer typecheck 都通过。

## 人工验收矩阵

E2E 手工验收路径：

1. test SQL preview。
2. freeze sample set。
3. 创建 A/B 单轮实验并 start。
4. 创建 A/B 3 轮实验并 start。
5. worker run-once 或常驻 worker 执行。
6. 检查 success、failed、blocked/unknown 的详情。
7. copy 实验并确认新草稿 lineage。
8. reuse-display 并确认模型调用数为 0。
9. 写入 annotation。
10. 下载 JSONL，确认失败和备注未丢失。

## 故障演练

必须可重复验证：

- kill worker 后重启，未完成 attempt 可恢复。
- 双 worker 并发不会重复认领。
- expired lease 可被新 worker 接手。
- duplicate start 不重复创建 attempt。
- retry 只重试安全可重入路径。
- unknown upstream/result path 不阻塞导出。

## 发布顺序

推荐顺序：

1. 执行 migration 到 test，记录 shape、RLS/grants、关键读写、锁和回滚。
2. 部署 backend 且保持 Batch Lab feature off 或仅内部 allowlist。
3. 跑 CI/typecheck/test/build。
4. 部署 Vercel Batch Lab SPA，配置 Preview API base 和 SPA rewrite。
5. 配置 backend `BATCH_LAB_URL` CORS。
6. 开启 worker/feature-on，执行 smoke。

## 回滚与停止条件

应用回滚优先退回 SPA/backend release；数据库已执行迁移不改历史，采用 forward-fix 或关闭 feature。出现来源写入、真实会话污染、重复扣费、secret 泄漏、批量 worker 无法停止或 JSONL 丢事实时，立即停止 worker 并关闭入口。
