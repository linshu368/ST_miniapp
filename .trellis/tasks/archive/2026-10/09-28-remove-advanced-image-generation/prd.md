# 移除高级图片生成并还原普通图片生成

## Goal

从 Backend、Frontend、Shared（用户原文 `shard`）和 Admin 中只移除 `advanced` 高级图片生成能力，把角色回复图片收敛为单一普通（现 `basic`）图片流程。保留并继续使用 VIP 策略中的普通图片免费调用次数、免费名额预留/消费、付费结算及同批提交中的语音、文本计费、VIP 商品、签到、支付和普通聊天功能。

## Requirements

### 1. 历史基线与回退方式

- 以当前 `basic` 图片链路为保留基线，只参考 `8f63e0da9996cac954215d762e9a15972e9ddc65` 的父提交 `d1c65130c3df4f99c41e8253d5bb5a75609ac68f` 识别高级图片引入前的单入口行为；当前已经落地的普通图片免费体验、埋点、供应商路由、错误处理和安全修复必须保留。
- 重点审查用户指定的 commits：`8f63e0d`、`5059ad2`、`7cb2f8a`、`5413afe`、`de4bb3d`、`ac8967a`。不得整 commit revert；只逆向其中属于 images 的 hunks。
- merge commit `de4bb3d` 以及后续 squash/merge 带入大量非图片 VIP 代码，必须逐文件、逐 hunk 判断，禁止按父提交整体回退。

### 2. 普通图片产品行为

- 对外只保留一个普通图片入口，不再出现 `basic/advanced` 档位选择、高级图按钮、VIP 锁定页或高级图片 provider/model/价格配置。
- 普通图片继续保留当前图片链路原有能力：中文描述生成/自定义描述、异步 attempt/worker、provider 降级、Storage 转存、失败不扣费、current/latest 聚合、预览和保存、图片安全埋点。
- 普通图片继续按 `feature_free_trial_limits.basic_image` 使用 VIP 策略发布的免费次数：免费范围内预留/消费成功次数，耗尽后按普通图片价格付费。只移除高级图片 VIP 门禁、高级价格和高级 provider/model 调用及结算。
- 旧客户端若仍发送 `tier`，后端应按设计选择“忽略并按普通图片处理”或“兼容解析后归一为普通图片”，不得使已发布客户端立即 4xx；最终策略以 design 的兼容方案为准。

### 3. 包范围

- **Backend**：移除 advanced 分支、高级 provider 选择、高级图片 VIP 校验与高级价格结算；保留普通图片免费体验预留/释放/消费及耗尽后的普通付费结算。
- **Frontend**：移除高级图入口、档位状态和 VIP 跳转；普通图片 Sheet、失败重试、充值跳转、预览/保存和轮询继续工作。
- **Shared**：把图片 HTTP DTO 收敛为单档位普通图片形状，同时保留普通图片 `free_trial`、`next_billing`、`billing_mode`、`free_trial_ordinal` 等免费调用次数与结算字段。通用 free-trial/VIP/wallet 契约不得删除。
- **Admin**：只删除高级图片开关、价格、价格文案、provider 配置的运营入口、schema、metadata 和测试断言；保留普通图片配置，并完整保留 VIP 策略中 `feature_free_trial_limits.basic_image` 的配置与发布能力。
- **Database/migration**：不得改写已执行历史 migration。若 test/production 已执行图片档位 migration，使用新的 forward migration 收敛图片对象/函数/配置；不得触碰语音列、语音函数或非图片 VIP 配置。

### 4. 严格边界

- 产品代码改动仅限 `packages/backend`、`packages/frontend`、`packages/shared`、`packages/admin` 中与 images 直接相关的文件/hunks，以及 Shared 下必要的新图片 forward migration/迁移验证。
- 不修改 CS Platform、支付、文本生成、语音生成、聊天免费额度刷新、VIP 商品/购买/提醒、签到、通用钱包分配等非图片行为。
- `5413afe` 的 `use-conversation-turn.ts` 聊天免费额度刷新不是图片功能，不回退。
- `ac8967a` 的 batch-lab、文本 generation 和通用 free-trial 上限增强不回退；普通图片仍是 free-trial 能力的有效消费者。
- 不删除或重写历史 migration 文件；不读取业务数据；生产迁移仍需单独人工批准。

## Acceptance Criteria

- [ ] 用户侧只显示普通图片入口，描述、确认、异步生成、失败重试、预览和保存流程可用；不再出现“高级图”、高级图片 VIP 门禁或档位选择。
- [ ] Backend 图片 API 不再接受 advanced 业务分流、不再读取高级图片 runtime config，但继续为普通图片预留、释放和消费 `basic_image` 免费次数。
- [ ] 普通图片免费范围内正确显示/消费第 N 次免费额度；额度耗尽后按 `image_generation_credits`/`image_price_label` 和既有原子结算生成 current ready；失败、结果未知、余额不足仍不错误计次、不产生错误扣款或错误展示。
- [ ] Shared 图片契约与 Backend producer、Frontend consumer 一致；旧客户端携带历史 `tier` 字段仍可兼容完成普通图片请求。
- [ ] Admin 不再展示或发布四个 `image_advanced_*` 配置；普通图片配置和 `feature_free_trial_limits.basic_image` 仍可正常管理、发布。
- [ ] 已存在的历史 basic/advanced attempt 仍可读取和展示；新 attempt 只产生普通图片语义。关闭/删除 runtime config 不影响已受理任务按既有快照收口。
- [ ] 语音免费体验、文本计费、VIP 商品/状态、支付、签到、聊天免费额度刷新及其他非图片行为无回归。
- [ ] 变更清单经路径与 hunk 审核确认只含 images 相关改动；Shared、Backend、Frontend、Admin 的适用 typecheck/test/lint/build 通过。

## Notes

- 本任务只完成规划，不运行 `task.py start`，待人工审核规划和确认数据库实际执行状态后再进入实施。
- 本任务严格只删除 advanced；普通图片免费调用次数及其契约、数据库事实、管理台配置、预留/释放/消费和展示全部保留。
