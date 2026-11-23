# 聊天扫描与余额保护（2026-11-23，本地候选）

尚未在 TEST/生产执行迁移或部署。当前生产版本与本地分支存在其他差异，发布时只移植本次修复到最新生产分支，不直接发布整个本地分支。

## 行为

- stale streaming 扫描使用 `experience.chat_history(created_at,id) WHERE status='streaming'` 部分索引，保留 120 秒陈旧阈值、50 行预算和稳定游标。
- 原来的余额读取保留为提前拒绝；真正的准入在 `begin_chat_generation_observation` 现有事务内完成报价保存及 `billing.reserve_chat_charge`。钱包行锁下，扣除其他账单预留后分配通用/专项金额，随后才能发供应商请求。
- `usage_charges.reserved_main_credits/reserved_bonus_credits` 是冻结资金，不是实扣或流水；统一扣款保护其他预留，钱包触发器也保护直接写余额的旧消费者。实扣消费自己的预留，与流水和计费结果原子提交。
- 成功/免费终账释放；明确系统失败、超时恢复或移除计费编号释放。用户停止仍依原计费资格处理。不靠 TTL 自动释放尚未确认结果的资金。
- 数据库确认余额不足后，在同一扣费 RPC 内将未扣未扣账单永久记为 `failed`、实扣 `0`、结算完成并释放预留，再返回固定拒绝结果。充值、重放和旧结果回写均不能重新收费。已成功实扣的账单不因竞争中的拒绝被清零。
- 服务端复用 `insufficient_balance` / HTTP 402 / “星尘余额不足”。开流前返回已有余额响应；旧后台账单只结束财务失败，不把已交付的正文改坏。余额拒绝是 info/rejected，两个扣款事件的结构化 `result` 与首行均固定显示“扣款失败”，原因“星尘余额不足”，固定码 `INSUFFICIENT_BALANCE`；后台汇总 `balanceRejectedCount`，不计入普通 `failedCount`，不进入普通失败退避。其他 P0001、持久化故障和超时保持原故障等级。旧usage对账也禁止新增部分扣款及失败后追扣；已经存在的合法历史扣款/流水保留，不自动退款。

## 数据落位与兼容

只在 active 的 `billing.usage_charges` 增加同属 M 的预留金额，不增加任务表、公开接口或客户端权限。新增函数固定 `search_path`，客户端无执行权限；无历史预留/追扣回填。报价金额/权益冻结，仅允许正常 fallback 更新供应商身份。原交付闸门、流水唯一键和报价金额不变。

索引文件为非事务的 CONCURRENTLY 文件；财务前置列/索引文件先提交快速加列，再并发建用户预留索引；RPC行为文件为一个事务，锁等待 5 秒、语句 120 秒，已知锚点守卫和标记重放。若环境函数形态不同，先停下互证，不能套用测试库结论覆盖生产。

## 验证与发布

1. 本地 SQL：`node scripts/test-chat-wallet-reservations.mjs <外部PGlite dist/index.js>`。使用生产函数结构、真实钱包扣款代码和虚构数据；覆盖预留重放/超额/跨消费/直接余额保护、终态释放、用户停止、原子失败、充值后旧账零扣、未知 P0001 回滚、权限与索引计划。无创作者快照场景的创作者 helper 是空实现，不证明分成行为。WASM 不证明多连接锁调度。
2. 相关 Vitest、所有包 typecheck、shared 测试、日志和迁移/DB/复杂度检查、构建。财务并发风险明确需要回归验证。
3. 先用 `Database Migration` workflow 在 TEST 执行 `20261123_chat_history_streaming_index.sql`；核对 valid/ready、计划和查询耗时。再执行纯加列/并发索引前置 `20261123_chat_wallet_reservation_columns.sql`，然后验证兼容服务端及 `20261123_chat_wallet_reservations.sql`，使用真实 PG17 多连接同时开两会话，余额仅够一轮时仅一轮可受理；再测其他消费、余额拒绝后充值重放、进程中断和超时恢复。
4. 生产需独立确认。先部署可识别新 RPC 拒绝 JSON 的兼容 Backend，再启用财务迁移；索引可独立先执行。每次只执行一个文件，并记录账本 checksum、前后 shape、权限、关键读写及失败恢复。
5. 观察至少 1 小时：相同 stale GET 的 P95、最大耗时、超过 2 秒次数和超时率；目标为成功返回小于 2 秒，不把 2 秒取消当成功。Android/iOS 与发送 API 无可见真实 P95 基线，必须分别补发布后样本，不以本地 SQL 耗时替代。

尚未取得线上验证样本，所以不能宣称生产 2 秒目标已达标。可将两会话余额拒绝、充值后旧账不扣、超时释放加入 `packages/ui-tests` 聊天组长期验收；模拟页面不能代替真实资金/并发验证。

## 恢复

并发建索引失败时可能留下 invalid index：只读核对形态和有效性后，经审查并发删除该无效索引，再通过迁移账本运行原文件。正常回滚可 `DROP INDEX CONCURRENTLY experience.idx_chat_history_streaming_created_id`。

财务迁移采用 forward-fix；不能删除活跃预留、擦除失败终账或在充值后重开旧账。回退应用时保留数据库保护与新拒绝 JSON 的消费者；不能回退到会把业务拒绝当作返回结构损坏的旧消费者。
