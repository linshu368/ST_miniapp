# 当前状态与复用调研

## 已检查入口

- `README.md`、`docs/ARCHITECTURE.md`：当前包拓扑与主要业务事实基线。
- `.trellis/workflow.md`：spec 目前承载编码指南；Phase 3.3 要求任务完成前更新 spec。
- `.trellis/spec/{frontend,backend,admin,cs-platform,shared,database}/**`：现有文件以架构、编码约束和大类功能汇总为主，还没有“一功能一文件”的统一现状层。
- `.trellis/spec/docs/process/index.md`：流程类变更应落在 `.trellis`，并要求规划、实现和规范责任分离。
- `.trellis/scripts/common/task_store.py`：`cmd_archive` 当前先把状态设为 completed、移动任务、执行归档自动提交，最后才运行 `after_archive` hook。
- `.trellis/scripts/common/task_utils.py`：hook 仅从全局 `.trellis/config.yaml` 读取命令，向子进程提供 `TASK_JSON_PATH`；失败只告警，不会回滚或阻止归档。
- `task.json`：已有 `scope`、`package`、`relatedFiles`、`meta` 可复用，但没有模块影响的稳定契约。
- `implement.jsonl` / `check.jsonl`：适合注入规范与研究文件，不适合承载待修改代码或自动更新载荷。

## 复用结论

| 能力                       | 决策       | 原因                                                                                |
| -------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| 现有 package spec 入口     | 扩展       | 在各入口增加“模块现状索引”，保留原编码规范职责。                                    |
| `task.py archive`          | 小范围扩展 | 归档是强制收口点，但必须增加提交前 pre-archive 阶段；当前 after hook 太晚且不阻断。 |
| `task.json.meta`           | 扩展       | 存模块 ID 列表与策略版本，兼容已有 schema，避免新增第二个任务元数据源。             |
| 任务目录 JSON/JSONL        | 复用       | 用独立 `module-updates.json` 承载可审核更新，避免把大段正文塞进 task.json。         |
| Phase 3.3 spec update      | 扩展       | AI/开发者在此生成并审核更新载荷；archive 只确定性应用和校验。                       |
| 全局 lifecycle hook        | 不作为核心 | 当前 hook 非阻断、位于提交之后，不具备事务语义；可保留给通知。                      |
| Git diff 自动推断完整事实  | 不采用     | diff 只能发现路径，无法可靠判断业务语义、删除和跨包边界；仅作为漏报检测证据。       |
| 外部知识库/数据库/向量检索 | 不采用     | 仓库内 Markdown 已满足版本化、检索、审查和离线使用，额外基建过度设计。              |

## 关键差异与风险

1. 用户要求“归档后自动修改”，但正确事务点必须是归档动作内部、移动和提交之前；否则更新不会和归档同批提交，失败也无法阻止错误归档。
2. 纯脚本无法从任意代码变化生成可靠自然语言。因此自动化边界定为：任务执行阶段由 AI/开发者产出结构化、已审核的新状态；归档脚本自动校验、应用、重建索引并核对影响范围。
3. `relatedFiles` 可辅助发现漏报，但它通常是规划范围而非最终 diff，不应成为唯一依据。实现需同时比较任务基线 commit 到当前 HEAD/工作树的变更路径。
4. 当前仓库已有并行任务和用户未提交改动；同步器不能扫描后直接覆盖未知改动，必须限定到声明模块并做内容摘要/乐观并发校验。

## 建议的首批知识分类

- `business`：聊天、语音、钱包、支付、社区、通知、客服、角色卡、运营配置等面向业务验收的能力。
- `infrastructure`：鉴权、API client、日志、运行时配置、数据库 client、任务调度、部署适配等支撑能力。
- `shared`：包内被多个业务模块复用的组件、hooks、helpers、repositories 或公共契约；不要把所有 `utils` 合成一个巨型文件。
- database 保持按业务域/横切能力拆分，例如会话存储、计费原子性、通知、RLS 与迁移执行基础设施。

实际模块清单必须通过源码目录、路由、页面、契约、迁移和测试联合盘点，并由对应 package owner 人工审核后才能作为基线。
