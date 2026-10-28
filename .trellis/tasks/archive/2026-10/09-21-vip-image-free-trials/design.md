# 技术设计

## 1. 复用边界

复用现有 `features/image/*`、image job、`ChatMessageImageRepository`、`experience.chat_message_images` 和 `billing.settle_image_generation`。现有 provider 调用、Storage 校验、attempt lease、`current ready` 原子替换和 `failed_unknown` 不扣费语义保留。

父任务提供统一免费额度、main-only allocator/refund、VIP 权益服务和公共契约。本任务只把这些能力接入图片 attempt/job，不建立第二套计数、钱包或会员判断。

## 2. 档位与状态流

```text
接受图片请求并创建 attempt（固化 tier/config/price/entitlement）
  basic -> reserve(feature=basic_image, reference_id=attempt.id)
           -> ordinal 1..3：free_trial
           -> exhausted：paid + main-only 预检
  advanced -> require active VIP + complete advanced config + main-only 预检
  -> queue/lease（维持 reservation）
  -> provider + Storage
     -> failed / failed_unknown：release basic reservation，不扣费
     -> stored success：settle_image_generation
        -> basic free：consume + current ready
        -> basic/advanced paid：main-only debit + current ready
```

受理快照写入 attempt，worker 重领不重新选择 tier、价格或免费/付费模式。高级图片资格以受理时快照为准；下一次请求重新读取 VIP。

## 3. 数据与契约

- 扩展 attempt：`image_tier`、billing mode、free trial reference/ordinal、price/config version、VIP valid_until snapshot。
- 历史行/旧请求默认 basic；不得回写历史余额或重算历史价格。
- 扩展现有图片 Shared DTO与 hook，复用父任务公共 free-trial/status 类型。
- Advanced config 必须同时包含 enabled、provider/model、price 和展示信息；任一缺失都返回稳定不可用。

## 4. 原子、并发与失败

- Basic 免费成功：consume reservation 与 attempt current ready 同事务。
- Paid success：main-only debit、ledger、旧 current 失活与新 current ready 同事务。
- reservation 从受理到 worker 完成保持有效；queue/lease 续租动作有限且幂等。
- attempt/job 重领只允许重试确定安全的阶段；provider 已发出的模糊区仍沿用 failed_unknown，不把未知成功计为免费或付费。
- 迟到成功遇到 reservation 已释放/复用时不自动收费，按失败收口。
- refund 使用原 debit ledger，不删除 attempt 或产物事实。

## 5. UI 与权限

初级确认页显示服务端返回的第 N/3 次或原价。高级入口展示 VIP 锁定/配置不可用/充值钱包不足的不同状态，不能把总余额当可支付余额。所有路由再次校验，前端锁定不构成安全边界。

## 6. 发布与回滚

- Basic free trial和 advanced image 使用独立开关，默认关闭，可分阶段启用。
- 父 T2 后可以先完成/启用 test basic；advanced 等父 T3 权益稳定和配置确认后再开。
- 关闭入口不取消已受理 attempt；它们按快照收口。计费异常先停新请求，再用 ledger 审计和幂等退款。
- 不在紧急回滚删除新增列、free facts 或已支付图片记录。

## 7. 验证重点

必须覆盖异步特有风险：排队期间 reservation、lease 重领、provider 模糊成功、Storage 成功而结算失败、current ready 竞争、同 message 多 attempt，以及 advanced 的 VIP/配置/钱包组合。
