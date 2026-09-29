# 实施计划

> 仅在本子任务规划被原语音工程师确认、父任务 T2 底座已在 test 验证且本任务执行 `task.py start` 后实施。

## 阶段 0：交付验收

1. 接收父任务 T2 的稳定 commit、migration 编号、RPC/Shared 签名、错误码、功能开关和 test 证据。
2. 在 test 只读核对 `chat_message_audio`、现有 voice RPC和新免费额度对象 shape；不读业务行。
3. 确认 assignee 和工作分支从上述稳定 commit 创建，PR/集成目标为 `dev_vip_0920`。

## 阶段 1：契约和 attempt 快照

1. 扩展 voice Shared DTO与 runtime schema，复用父任务公共免费状态。
2. 通过新 migration/兼容列把 reservation、billing mode、ordinal 和价格快照关联到 audio attempt；不改历史余额。
3. 增加 old row/default/旧客户端兼容测试。

## 阶段 2：Backend 状态机接入

1. 在上游前预留免费次数，额度耗尽走 main-only 预检。
2. 在所有 TTS/Storage/取消/超时失败路径释放 reservation。
3. 扩展语音结算 RPC：免费 consume+ready，付费 debit+ready，同 ID重放回读。
4. 接入原路退款补偿和 pino allowlist 日志。

## 阶段 3：Frontend 展示

1. 扩展现有 voice hooks/cache，不直接 fetch。
2. 显示第 N/3 次免费或现有原价，处理额度竞态后的服务端结果。
3. 回归播放、重试、软键盘和慢网交互。

## 阶段 4：验证与交付

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

在 test 人工验证 1/2/3/4、只有 bonus、并发、上游失败、Storage 失败、重复点击、开关关闭和退款。向父任务交回 commit/PR、migration 证据、命令结果、失败矩阵、日志摘要和剩余风险。

## 停止条件

父任务接口漂移、专项钱包被扣、免费次数超领、失败计次、迟到成功意外付费、audio ready 与结算不一致时立即停止并回到父任务协调，不在子任务内改通用底座规避。
