# 实施计划

> 本文件是用户审核后进入 `in_progress` 阶段的执行方案。当前仅完成规划，不应提前修改目标 spec、AGENTS 或 README。

## 阶段 0：基线与范围冻结

1. 记录 `git status`，区分本任务文件与用户已有修改。
2. 用 `git ls-files` 生成 admin、cs-platform、shared 的受控文件清单，确保目录地图无遗漏。
3. 重新读取根配置、各包 package、现有 spec、ARCHITECTURE、ops 和部署文件，防止规划后代码变化导致事实过期。
4. 核实测试库 MCP 连接；未明确指向测试项目则停止数据库步骤并询问用户。

**检查点**：输出基线清单和来源清单；不修改产品代码。

## 阶段 1：持久化详细研究资料

1. 在任务 `research/` 下整理 admin 文件/组件/功能矩阵。
2. 整理 cs-platform 文件/组件/业务/API/查询矩阵。
3. 整理 shared 出口/API contracts/schema/工具/测试/consumer 矩阵。
4. 整理根文档、部署、环境变量、commit 和 backend 规范复用基线。
5. 整理数据库迁移现状、schema 归属和已知风险。

**检查点**：每项结论都有文件路径来源；不记录 secret。

## 阶段 2：Supabase 测试库只读采集与对账

1. 通过 MCP 获取测试项目身份与 schema 清单。
2. 采集目标业务 schemas 的 relations/columns/constraints/indexes/comments。
3. 采集 RLS/policies/grants、functions/triggers、enums/custom types 和跨 schema 依赖。
4. 保存规范化的研究摘要（Markdown，不保存业务行数据或凭证）。
5. 与 `packages/shared/migrations`、`config.toml`、`inventory.sql`、schema 文档对账。
6. 标注测试库实况、迁移声明、差异和待确认项；明确不代表生产库。

**检查点**：对象类别齐全、采集时间/环境可追溯、敏感扫描通过。若 MCP 不可用，本阶段为 Blocked，不得伪造结果。

## 阶段 3：编写 Trellis specs

1. 扩充 admin index 并按设计拆分专题规范。
2. 扩充 cs-platform index 并按设计拆分专题规范。
3. 扩充 shared contracts index 并按设计拆分专题规范。
4. 扩充 database/supabase index、迁移/安全/采集规范和测试库参考文档。
5. 对照 backend 规范统一术语、MUST 级别、Pre-Development Checklist 和 Quality Check。
6. 在各包 spec 中加入后续 Trellis 规划模板与设计门禁：复用调研、故障模型、高可用措施、最小充分方案、复杂度预算、兼容/发布/回滚和失败路径验证。
7. 为 Admin、CS Platform、Shared/Supabase 分别给出适用示例，明确哪些可靠性机制属于对应层，避免将服务端模式机械套用到纯前端组件或共享类型。

**检查点**：所有 index 链接有效；每个包覆盖职责、目录/文件、组件/模块、数据流、安全、测试和部署；旧规则未被弱化；未来任务能直接依据 spec 产出兼顾可靠性、复用和简洁性的四类规划工件。

## 阶段 4：编写根 AGENTS.md 与 README.md

1. 在 Trellis 管理块外重组 AGENTS 项目指引，增加规范路由和全局硬规则。
2. 新建根 README，写项目简介、结构、包关系、技术栈、环境准备和 workspace 命令。
3. 增加环境变量矩阵；仅变量名/用途/来源，不含值。
4. 增加开发、测试、构建、Supabase、部署、迁移、commit、分支与上游合并保护说明。
5. 链接 ARCHITECTURE、ops 和 Trellis specs，避免重复维护大段实现细节。
6. 在 AGENTS 中加入全局规划门禁：复杂任务未完成复用检索、故障/容量分析、最小方案权衡、测试和回滚设计时，不得进入 `in_progress`。

**检查点**：新成员仅按 README 可完成依赖安装并知道如何分别启动各包；AI 按 AGENTS 可定位全部强制规范。

## 阶段 5：全局质量检查

建议命令：

```bash
python ./.trellis/scripts/get_context.py --mode packages
python ./.trellis/scripts/task.py validate 09-07-package-specs-and-project-docs
pnpm exec prettier --check README.md AGENTS.md .trellis/spec/**/*.md .trellis/tasks/09-07-package-specs-and-project-docs/**/*.md
git diff --check
```

补充人工检查：

- 校验 Markdown 相对链接、命令、包名、脚本、端口和部署目标；
- 搜索疑似 `eyJ...` JWT、`service_role` 实值、数据库 URI、私钥头和真实 key；
- 抽查每个包受控文件都出现在文件地图或文件组说明中；
- 抽查 shared contract 及消费者依赖描述；
- 核对数据库文档明确标注“测试库，不代表生产库”。
- 使用一个跨包需求样例走查新规范，确认可据此完整填写 PRD/design/implement/task，并能明确高可用措施的适用性、复用落点和最小实现边界；
- 搜索“高可用”“复用”“简洁/最小方案”等规则，检查其均附有执行条件和验证方式，而不是不可操作的原则口号。

## 阶段 6：审核与提交

1. 由 check 阶段对全部文档进行事实、一致性、安全和可执行性复核。
2. 修复问题后再次运行阶段 5。
3. 汇总新增/修改文件和未解决差异。
4. 按 Trellis Phase 3.4 检查 git dirty state，向用户提交一次性 commit 计划；未经确认不 commit，不 push。

## 回滚点

- 每一阶段均为文档改动，可按阶段文件组回退。
- MCP 仅允许只读；任何工具显示将执行 DDL/DML 时立即取消。
- 若数据库资料包含敏感信息，删除该输出并重新以结构元数据方式采集，不进入 Git 历史。
