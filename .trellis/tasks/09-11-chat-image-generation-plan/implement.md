# 图片生成功能实施计划

## 评审门禁

- 产品确认：默认 OpenAI `gpt-image-1`、`1024x1536`、健康向策略、200 字上限及初始价格。
- 工程确认：数据库任务队列而非语音 fire-and-forget；成功后结算，余额竞争失败删除产物。
- 运维确认：test/prod 分别配置 `OPENAI_API_KEY`、Storage bucket、runtime config；不把 secret 写入文档或 Admin。

## 实施顺序

1. **Shared 契约**：新增 image DTO/Zod、错误码和 exports；保持公开字段可兼容扩展。
2. **Migration**：新增 experience attempt 表、索引、RLS/grants、claim RPC；新增 billing 原子结算 RPC/ledger 类型；提供独立 rollback 文件和锁/容量说明。
3. **Backend generation 基建**：在统一出口增加结构化文本生成、图片 provider 和结算入口；所有公开方法在定义处写中文注释，明确职责、超时、幂等和模糊失败语义。
4. **Backend image feature/route/job**：实现 config/description/session query/create；注册 `@frontend-ready` 路由与 runner；日志只使用 allowlist。
5. **Frontend API**：集中 image query keys/hooks，pending 时 1.5~2 秒轮询，终态和后台停止；余额成功扣除后精确刷新 wallet。
6. **Frontend 组件图**：
   - `ChatImageSheet`：面板状态编排；props 为 session/message/config/open，events 为 close/recharge/completed。
   - `ChatImagePromptEditor`：受控 prompt 与 200 字校验；不请求 API。
   - `ChatMessageImageFooter`：某 message 的 pending/ready/failed 展示与“重新生成”。
   - `ChatImageViewer`：Dialog 大图、alt、关闭与长按保存提示。
   - Chat page 仅组合 hooks 并通过现有 `renderFooter` 按“图片在上、语音在下”注入。
7. **文档/发布**：补 env example、runtime config 管理项、ARCHITECTURE；test 验证后再更新 module spec 的“当前状态”。

## 可执行验证

按用户要求不新增测试文件，但运行既有测试：

```bash
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm -r typecheck
```

Migration 在 test 环境逐文件执行并记录：执行前后表/RPC shape、RLS/grants、claim 并发、结算幂等、余额不足、锁等待、rollback。不得因“规划通过”直接执行生产 migration。

## 人工与接口场景

- 入口：开场白/历史/streaming/中断均隐藏；最后完整回复显示。
- 描述：成功、空响应、格式错误、超时、内容拒绝；均不扣费。
- 确认：原描述和自定义 1/200/201 字、空白、双击、两个设备并发。
- 任务：受理后离页/切会话/刷新；pending、provider 前重启、provider 模糊超时、Storage 失败、runner 多实例抢占。
- 计费：预检不足、预检后余额被抢、结算 RPC 重放、对象删除失败；对拍 wallet/ledger/attempt。
- 展示：多次生成 current 切换、旧 attempt 保留、图片/语音顺序、大图关闭、窄屏/软键盘/safe area/reduced motion。
- 回跳：充值后回到原 character/session/message，不自动提交。

## 发布与恢复

- test：migration → bucket → backend secret/config → backend → frontend → 开关 → smoke。
- production：复核 test 证据，逐项重复，先保持开关关闭；小流量开启并观测成功率、P95、429、失败码、扣费不一致、孤儿对象。
- 回滚：先关开关；让 runner 收口已接单任务；回退应用。已产生记录和账务不删除，异常数据用审计脚本 forward-fix。
