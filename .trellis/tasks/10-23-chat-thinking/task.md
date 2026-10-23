# Tasks
| ID | 状态 | 范围 | 依赖 | 验证 |
| -- | -- | -- | -- | -- |
| T1 | completed | 官方研究、当前主线与最小架构设计 | - | 官方来源、既有流程 |
| T2 | in_progress | shared契约与backend route/generation/tap | T1 | shared/backend回归 |
| T3 | completed | frontend开关/流/临时内存/UI | T2契约 | frontend回归 |
| T4 | in_progress | 集成、移动端虚拟验收、文档 | T2/T3 | 全消费者typecheck、lint/build/review |
