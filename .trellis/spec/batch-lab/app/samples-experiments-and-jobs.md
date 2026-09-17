# Batch Lab Samples Experiments And Jobs

## 样本生命周期

1. Preview 读取来源会话、角色和历史摘要，展示候选样本。
2. Freeze 将样本写入 `batch_lab.sample_snapshots`，后续执行只读取冻结副本。
3. Snapshot 不随真实会话变化自动刷新；需要新的样本事实时创建新的 sample set。

缺失 session/history/character 必须显式进入统计或排除原因，不能静默构造样本。

## 实验状态机

实验以 A/B variants、冻结样本、轮数、sampling config 和 processor config 组成。状态从草稿创建，经 start 进入 queued/running，由 worker 认领 attempt 并写入 success/failed/blocked/unknown 等终态。

关键约束：

- start 必须幂等；重复 start 不应生成重复 attempt。
- worker 使用有限 lease；过期 lease 可被后续 worker 恢复。
- 双 worker 并发时以数据库约束和状态更新条件防止重复认领。
- 单 attempt 失败不能阻断整批实验完成统计。
- blocked/unknown 结果必须保留到详情和 JSONL，不能在导出阶段丢失。
- 内部工作台可对草稿执行 start、对 queued/running 执行 cooperative stop：停止后禁止新认领，已租约中的单次上游请求允许正常收口，避免强杀造成未知结果。
- “全部执行”必须仍以每批最多 10 条的有界 claim 循环，不能把整批工作放进一次无界数据库认领；每批之间重新读取持久状态，使 stop 能及时生效。操作列同时保留单条执行入口用于调试和快速验证。
- 实验删除使用软删除；queued/running 必须先停止，历史 attempt、展示结果和审计事实不得级联删除。

## 生成入口

Batch Lab 执行只允许通过 backend 内部 `internal_research` generation policy 调用上游。该 policy 复用超时、SSE/non-stream 解析和结果归一化，但跳过用户钱包、免费额度、`chat_history` 写入和真实会话结算。

## 容量边界

V1 验收容量为 50 条样本、单轮与 3 轮实验。容量评估需要覆盖：

- frozen sample 和 raw output 的 TOAST 风险。
- SQL preview/freeze limit。
- worker run-once 每批处理数量和超时。
- export JSONL 流式响应，不一次性拼接超大字符串。
- UI 列表和详情在部分失败下仍可扫描。
