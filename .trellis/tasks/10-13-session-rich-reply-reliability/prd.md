# 会话级富文本指令与容错渲染修复

## Goal

根治真机对话中富文本协议裸露、第二轮后渲染失败，以及完整规则次数跨会话共享的问题。

## Requirements

- 每个独立 `session_id` 的第 1、2 个逻辑轮使用 full，第 3 轮起使用 concise；三个槽位关闭时使用 off。
- 同一逻辑轮重生成必须复用原始模式快照，不重复计数；并发会话互不影响。
- `turn_index` 与 `chat_history` 是会话轮次真相，不新增计数表或缓存状态。
- 后端固定注入唯一、版本化的机器语法；Admin full/concise 仅决定内容详略，不再决定标签结构。
- 对完整闭合但格式偏差的 choices/status/memory 做安全降级，控制标签不得裸露；只有合法选项可发送。
- 保留已应用 migration 和旧计数字段，不执行远端迁移、部署、提交或推送。

## Acceptance Criteria

- [ ] 两个新会话分别得到 full/full/concise，且关闭槽位稳定为 off。
- [ ] 重生成沿用原逻辑轮的三槽位模式。
- [ ] 标准协议、裸 choices、缺少代码围栏的 status/memory、带 details 的 memory 均不裸露控制标签。
- [ ] 后端渲染结果总含固定协议，Admin 默认规则与固定协议无语法冲突。
- [ ] 新增前向 migration 通过迁移 lint/ledger 静态检查；不改历史 migration。
- [ ] Shared、Backend、ReplyRenderer 相关测试与受影响包 typecheck 通过。

## Notes

- 数据库目标对象仍属于 `experience` 会话域；权威写入方为开轮 RPC，生命周期随逻辑轮，运行时消费者为 Backend prompt engine。
- 发布顺序：容错 parser/固定协议应用代码 → TEST 前向 migration → TEST 真机验收；Production 另行授权。
- 回退优先回退应用；数据库函数问题通过 reviewed forward-fix 恢复。旧字段保留，避免本次形成破坏性 contract。
