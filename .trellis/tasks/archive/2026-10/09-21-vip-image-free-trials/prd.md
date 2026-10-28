# MiniApp 图片免费体验与 VIP 门禁接入

## Goal

在父任务提供的统一免费额度、钱包和 VIP 权益底座上，把初级图片改为每账号前 3 次成功生成免费、第 4 次起只扣充值钱包；同时为高级图片建立显式档位、有效 VIP 门禁和充值钱包结算，并保持现有异步任务、Storage、`ready/failed/failed_unknown` 语义。

## Requirements

### 范围与分阶段依赖

- 父任务：`09-21-miniapp-vip-model-ui`。
- 初级图片免费体验部分可在父任务 T2 完成并通过 test 验证后开始，不依赖父任务 T4。
- 高级图片部分可以同步完成契约/attempt 设计，但其 VIP 权限接入和最终验收必须等待父任务 T3 的 VIP status/entitlement 接口稳定；同样不依赖父任务 T4。
- 父任务提供免费额度表/原语、`main_only` 钱包 allocator、幂等退款、公共免费状态和 VIP 权益服务；本子任务不得复制这些底座。
- 本任务不修改 LLM 折扣、VIP 商品支付、语音或通用钱包规则。

### 初级图片免费与计费

- 功能启用后，所有存量和新增账号均从初级图片免费成功次数 0 开始，不回溯历史生成。
- 每账号前 3 次形成已转存、可展示图片并成功收口为 current ready 的初级图片免费。
- 上游失败、翻译/写稿失败、超时、Storage 失败、`failed_unknown` 或其他未形成可用产物的调用不计次、不扣款。
- 第 4 次起沿用初级图片现有原价，只允许从充值钱包 `main_credits` 扣款；专项余额不可用于图片。
- 免费/付费结算必须与 attempt ready/current 原子收口；余额不足不得显示成功图片或部分扣款。

### 高级图片

- 图片请求和 attempt 明确区分 `basic` / `advanced`；旧请求缺省 basic。
- 高级图片不参与前三次免费，始终要求请求受理时有效 VIP，并只从充值钱包扣费。
- 高级图片 provider/model/price/文案必须来自受控运行时配置；配置不完整或未验证时入口保持关闭，不得回退初级图片冒充高级。
- 受理时固化 VIP、配置和价格快照；处理中刚好到期不推翻已受理任务，下一次请求按新状态拒绝。

### 预留、异步任务与幂等

- 初级图片在请求受理时以 image attempt ID预留免费序号，使确认页展示与最终决策一致；队列等待和 worker 执行期间按父任务契约续租。
- 明确失败释放 reservation；过期并已被其他 attempt 占用的迟到成功不得静默转为付费。
- worker 重领、provider 重试、回调重放和用户重复点击不得重复计次、重复扣费或产生两个 current ready。
- 已扣后补偿必须使用原 debit ledger 的幂等退款。

### API 与 UI

- 图片配置/确认响应返回 tier、免费 limit/used/remaining/ordinal、原价、最终计费模式以及高级图片可用/锁定原因。
- 初级图片免费范围内显示“免费体验 第 N/3 次 · 本次不消耗星尘”；用尽后显示原价。
- 非 VIP 高级图片显示锁定和去 VIP 入口；只有专项余额时明确提示需要充值钱包。
- UI 只展示服务端裁决，不本地计数或自行判断会员。

### 可观测性与安全

- 日志只记录内部 attempt/session/message/user ID、tier、reservation/settlement 状态、provider/model 名、尺寸/字节/耗时和结果摘要；原始错误用 `{ err }`。
- 禁止记录图片内容、完整 prompt、签名 URL、token、支付链接或上游大响应。

## Acceptance Criteria

- [ ] 初级图片第 1、2、3 次成功均显示正确序号、产生 current ready 且不扣星尘；第 4 次按现有原价只扣充值钱包。
- [ ] 初级图片上游、写稿/翻译、Storage、worker 和 `failed_unknown` 失败均不计次不扣款；重试成功使用正确序号。
- [ ] 只有专项余额时第 4 次初级图片在上游前被拦截；不发生专项或部分扣款。
- [ ] 20 个并发/重放 attempt 无法消费超过 3 个免费成功名额，不产生重复 current ready。
- [ ] 旧客户端缺少 tier 时继续使用 basic；历史图片和 attempt 保持可读。
- [ ] 非 VIP 高级图片后端拒绝；有效 VIP 且充值余额足够时按高级配置成功；高级图片从不占用初级免费次数。
- [ ] 高级配置缺失、VIP 到期、只有专项余额、处理中到期和重复 worker 场景符合快照及门禁规则。
- [ ] 相关 Backend/Shared/Frontend 测试、typecheck、Frontend build 和 test 数据库事务验证通过。

## Notes

- 需求真相与跨模块验收仍由父任务管理；本任务只负责图片领域适配。
- `assignee` 暂为 `unassigned`，交付前替换为原图片模块工程师的 Trellis developer id。
- 本任务保持 `planning`，由原图片模块工程师审核后再单独启动。
