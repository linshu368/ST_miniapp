# 实施计划

> 初级图片部分在父 T2 稳定后可启动；高级图片权限联调等待父 T3。原图片工程师审核本规划并认领后，才执行本子任务 `task.py start`。

## 阶段 0：交付验收

1. 接收父 T2 的稳定 commit、migration、免费额度/allocator/refund/Shared 签名和 test 证据。
2. 接收父 T3 的 VIP status/entitlement 签名；若尚未完成，先做 basic，不阻塞已解耦工作。
3. 明确 advanced provider/model/price 配置来源；未确认保持开关关闭。
4. assignee 认领，从公共底座稳定 commit 建分支，集成目标为 `dev_vip_0920`。

## 阶段 1：图片契约和 attempt 快照

1. 扩展 images Shared 契约为 basic/advanced，复用公共 free-trial/status。
2. 添加兼容 migration/列与约束；历史/default=basic，记录 billing/config/VIP 快照。
3. 测试旧请求、旧行、非法 tier、配置不完整和 mapper 完整性。

## 阶段 2：Basic 免费体验

1. 请求受理时预留 basic_image ordinal，额度耗尽走 main-only 预检。
2. queue/lease 生命周期续租；所有写稿、翻译、provider、Storage、job 失败释放。
3. 扩展 settlement：free consume+ready 或 main-only debit+ready；重放回读。
4. 接入原路退款、限流和 allowlist 日志。

## 阶段 3：Advanced VIP 门禁

1. 接入父 T3 VIP 服务，在受理时固化资格；无 VIP直接拒绝。
2. 读取并验证 advanced config/price，禁止缺失时回退 basic。
3. advanced 永远 main-only 且无 free reservation；最终结算校验受理快照。

## 阶段 4：Frontend

1. 图片 hook/确认 UI展示第 N/3 次、原价、tier、VIP 锁定和充值钱包不足原因。
2. 保持现有生成进度、失败提示、图片展示和重试体验。
3. 非 VIP“前往 VIP”使用父任务提供的统一路径。

## 阶段 5：验证与交付

```bash
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm -r typecheck
pnpm lint:migrations
pnpm test:migration-ledger
```

在 test 验证 basic 1/2/3/4、只有 bonus、并发、排队/lease、所有失败终态、重复 job、退款；验证 advanced 非 VIP/VIP/过期/处理中到期/配置缺失/余额组合。向父任务交回 commit/PR、migration 记录、命令结果、场景证据和剩余风险。

## 停止条件

父底座接口漂移、免费次数超领、专项钱包被扣、failed_unknown 计次/扣款、重复 current ready、advanced 绕过 VIP或错误回退 basic 时停止，不在子任务内重写公共规则。
