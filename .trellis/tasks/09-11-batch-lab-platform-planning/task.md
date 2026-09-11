# Task Breakdown

## Status Legend

- Todo：未开始
- Blocked：等待外部确认
- Done：完成并验证

## Tasks

| ID  | Status  | Task                                                              | Files / Scope                                         | Depends On | Verification                                          |
| --- | ------- | ----------------------------------------------------------------- | ----------------------------------------------------- | ---------- | ----------------------------------------------------- |
| T0  | Blocked | 人工评审 PRD/design，确认 SQL只读、内部免计费、来源环境和原型覆盖 | task artifacts / security & product decisions         | -          | 明确实施授权与阻塞项负责人                            |
| T1  | Todo    | 核对源库 turn/快照/renderer/模板实况并冻结容量上限                | task research、只读结构记录                           | T0         | 无业务行导出；来源/环境/时间证据                      |
| T2  | Todo    | 定义 Batch Lab shared API/JSONL 契约和测试                        | `packages/shared/src/api/batch-lab.ts`、exports/tests | T1         | shared typecheck/test + consumers typecheck           |
| T3  | Todo    | 创建`packages/batch-lab`骨架、API/环境banner/导航、Vercel与CI配置 | new package、root scripts、deploy config              | T2         | package typecheck/test/build；Vercel/CI/环境错误      |
| T4  | Todo    | 新建 `batch_lab` schema migration、权限、索引、租约和 repository  | shared migrations、backend repository、schema docs    | T1,T2      | test shape/RLS/grants/locks/rollback/repository tests |
| T5  | Todo    | 实现只读 SQL 模板、preview、快照补齐与冻结 UI/API                 | batch-lab/backend/shared                              | T3,T4      | S1–S4 + SQL攻击/超时/并发测试                         |
| T6  | Todo    | 实现隔离后处理、不可变版本和 UI                                   | processor worker/API/repository/pages                 | T3,T4      | P1/P2/P3 + ReDoS/sanitizer测试                        |
| T7  | Todo    | 实现实验 A/B 配置、深复制、diff、启动预检和幂等                   | experiment contracts/services/pages                   | T5,T6      | C1–C3、D1、调用数/排除测试                            |
| T8  | Todo    | 扩展唯一 generation 出口支持受控 internal research                | backend generation/batch-lab/tests                    | T7         | 不扣钱包/额度、不写 chat_history；原链路 regression   |
| T9  | Todo    | 实现 lease worker、单轮/多轮、重试/阻塞/重启恢复                  | backend worker/services/repositories                  | T8         | G1–G5 + 故障注入/双 worker测试                        |
| T10 | Todo    | 实现进度、全部结果逐轮浏览、原文/富文本和失败入口                 | Batch Lab result UI/API                               | T9         | R1、partial/unknown/refresh人工回归                   |
| T11 | Todo    | 实现复用原文、历史/复制、备注（若未后置）和 JSONL                 | backend/shared/Batch Lab                              | T10        | P4、E1/E2；零 generation task；schema解析             |
| T12 | Todo    | 全量门禁、容量/安全/advisor、文档、module facts和发布恢复演练     | all affected packages/docs/task                       | T5–T11     | PRD矩阵、全命令、test smoke、停止/恢复记录            |

## 子任务映射与完成定义

| Child                                | 依赖                                      | 独立完成定义                                                     |
| ------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------- |
| `09-11-batch-lab-foundation`         | 父规划评审                                | 新包/Shared/API client/环境/CORS/Vercel/CI可验证，未越界实现业务 |
| `09-11-batch-lab-data-samples`       | foundation                                | 新域与只读 SQL安全、preview一致性、快照冻结、迁移恢复验证完成    |
| `09-11-batch-lab-postprocessing`     | foundation + data存储边界                 | 不可变版本、硬隔离、清洗、preview/display失败矩阵完成            |
| `09-11-batch-lab-backend-execution`  | foundation + data + processor接口         | 不计用户费、不写真实会话、单/多轮、租约、重试/恢复验收完成       |
| `09-11-batch-lab-frontend-workbench` | foundation + data + processor + execution | 原型逐控件矩阵、状态/环境/可访问性、test/build完成               |
| `09-11-batch-lab-history-export`     | execution + processor + workbench         | 历史/复制/reuse零生成/备注/JSONL round-trip完成                  |
| `09-11-batch-lab-integration-spec`   | 以上六项                                  | 父PRD全矩阵、容量安全、发布恢复、Spec/docs/module facts完成      |

父任务仅在所有 child 均归档、`integration-spec` 证据完整且 Spec 收口完成后才能标记完成。父任务的 T1–T12 是跨层能力地图，实际执行状态以对应 child 的 `task.md` 为准。

## Execution Log

- 2026-09-11：读取需求说明和完整 HTML 原型；完成 admin/cs-platform/backend/shared/database 复用调研。
- 2026-09-11：完成复杂任务规划产物；任务保持 `planning`，T0 等待人工评审，不执行产品代码或数据库变更。
