# 支付宝支付前置提示弹窗：技术设计

## 范围与复用调研

- 复用 `PaymentVpnPromptDialog`：它是既有微信截图付款提示，继续消费运行时 `payment_prompt_dialog_config`，不改其契约或样式语义。
- 新增支付宝专属 Dialog 组件：固定展示本任务确认的三步文案和本地 VPN 确认状态；不把两种渠道文案抽成一个可配置框架，避免运营配置错误影响支付宝流程。
- 复用 `openCreatedPayment`：继续负责 `pay_url` 存储、外部付款前暂停录制、打开链接和进入订单等待页；新 Dialog 不能重写、复制或提前执行这些副作用。
- 改动两个调用入口：充值页和 VIP 页在创单成功后按 `PaymentType` 选择支付宝或微信提示；后端、共享 contracts、数据库、遥测均不改。

## 交互和状态流

`createOrder.mutateAsync` 成功 → 记录既有创单事件 →

- `alipay`：保存创单结果，打开支付宝 Dialog；用户确认 VPN 后才调用 `openCreatedPayment`。
- `wxpay`：当既有 runtime 配置启用时，保留微信 Dialog；否则直接调用 `openCreatedPayment`。

两个 Dialog 关闭时都会清除暂存创单结果，不调用 `openCreatedPayment`。确认后仅有一个分支调用现有统一外跳函数，因此外跳、副作用与订单页跳转保持一次且不变。

## 可靠性、兼容与恢复

- 创单前仍由既有 mutation pending 与 `submitLock` 防重复；弹窗只延后外跳，不创建第二笔订单。
- VPN 确认仅是本地 UX 门槛，不作为服务端支付或入账事实；订单成功仍只由既有服务端结算与订单轮询判定。
- Dialog 关闭、Esc、点击遮罩均视为用户取消当前外跳，不报支付失败，也不写 pending 外部支付记录。
- 窄屏沿用项目 Dialog、安全区和可滚动内容规则；按钮和确认控件使用语义交互与 aria label。
- 回滚为移除新增支付宝 Dialog 分流；保留现有 `openCreatedPayment` 和微信 Dialog 不变。无需迁移、灰度或数据修复。

## 最小充分方案

新增一个支付宝组件，修改两个页面的本地弹窗状态与渠道分流。拒绝把单一支付宝固定流程扩展为新 shared DTO、运行时配置或通用步骤引擎，因为这会扩大 API、Admin、迁移和误配风险。
