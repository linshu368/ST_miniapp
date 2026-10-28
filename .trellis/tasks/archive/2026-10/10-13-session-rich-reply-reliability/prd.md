# 会话级富文本指令与容错渲染修复

## Goal

根治真机对话中富文本协议裸露、第二轮后渲染失败，以及完整规则次数跨会话共享的问题。

## Requirements

- 每个独立 `session_id` 的第 1～3 个逻辑轮使用 full；第 4 轮起，仅当前一轮最新 revision 的富回复诊断为 `exact` 时使用 concise，诊断为 `recovered`、`failed` 或缺失时下一轮恢复 full；三个槽位关闭时使用 off。
- 同一逻辑轮重生成根据被替换 revision 的富回复诊断重新确定 full/concise，并把结果写入新 revision；并发会话互不影响。
- `turn_index` 与 `chat_history` 是会话轮次真相，不新增计数表或缓存状态。
- 后端固定注入唯一、版本化的机器语法；Admin full/concise 仅决定内容详略，不再决定标签结构。
- 对完整闭合但格式偏差的 choices/status/memory 做安全降级，控制标签不得裸露；只有合法选项可发送。
- 保留已应用 migration 和旧计数字段，不执行远端迁移、部署、提交或推送。

## Acceptance Criteria

- [ ] 两个新会话分别在第 1～3 轮得到 full；第 3 轮诊断为 `exact` 时第 4 轮得到 concise，诊断为 `recovered`、`failed` 或缺失时第 4 轮得到 full；关闭槽位稳定为 off。
- [ ] 重生成根据被替换 revision 的 `exact` / `recovered` / `failed` / 缺失诊断选择 concise/full，并把三槽位模式持久化到新 revision。
- [ ] 标准协议、裸 choices、缺少代码围栏的 status/memory、带 details 的 memory 均不裸露控制标签。
- [ ] 后端渲染结果总含固定协议，Admin 默认规则与固定协议无语法冲突。
- [ ] 新增前向 migration 通过迁移 lint/ledger 静态检查；不改历史 migration。
- [ ] Shared、Backend、ReplyRenderer 相关测试与受影响包 typecheck 通过。

## Notes

- 数据库目标对象仍属于 `experience` 会话域；权威写入方为开轮 RPC，生命周期随逻辑轮，运行时消费者为 Backend prompt engine。
- `on_first_two_turns` 是已发布配置契约中的兼容字段名；当前运行时含义是 full 文案，不再表示严格的“两轮计数”。
- 发布顺序：容错 parser/固定协议应用代码 → TEST 前向 migration → TEST 真机验收；Production migration 已由独立发布流程执行，应用发布后仍需 Production 配置与真机验收。
- 回退优先回退应用；数据库函数问题通过 reviewed forward-fix 恢复。旧字段保留，避免本次形成破坏性 contract。
