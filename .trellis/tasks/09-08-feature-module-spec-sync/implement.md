# 功能模块知识库与归档同步实施计划

本规划通过评审后再进入实现；建议拆为两个子任务，先建立知识基线，再启用归档同步，避免机制在空/错误基线上强制运行。

## A. 冻结契约与测试样例

1. 评审模块边界、ID、目录和模板；确认 database 与 shared 的分类口径。
2. 冻结 `task.json.meta.module_impact`、`module-updates.json` schema、启用日期和 legacy 豁免策略。
3. 建立临时 fixture 仓库/目录，覆盖 create/update/rename/delete/no-change、跨包、公共基建和业务模块。

门禁：产品/架构负责人确认“当前事实 vs 编码规范”边界；未确认不批量生成基线。

## B. 基线知识库（子任务 1）

1. 新增各 scope 的 `modules/{business,infrastructure,shared}`、package 索引和全局索引模板。
2. 以 shared/database → backend → frontend → admin → cs-platform 顺序盘点；每批记录检索过的 routes/pages/features/components/hooks/helpers/contracts/repositories/migrations/tests。
3. 编写首批一功能一文件现状；跨包仅互链，不复制其他包实现正文。
4. 新增 module map 和只读 baseline checker；检查重复 ID、frontmatter、章节、目标路径、代码路径/测试链接、坏链接和孤儿索引。
5. package owner 人工抽检核心业务与基础设施，修正推断并标记待核验。

验证：

```bash
python ./.trellis/scripts/module_knowledge.py baseline-check
python ./.trellis/scripts/get_context.py --mode packages
pnpm prettier --check ".trellis/spec/**/*.md"
```

回滚：删除新增 modules/index/map 并恢复 package index 链接；此阶段不改变 archive 行为。

## C. 任务声明与同步 CLI（子任务 2）

1. 实现零第三方依赖的 schema/path/frontmatter/摘要/coverage 校验。
2. 实现 `check`、`apply`、`rollback`、`rebuild-index`、`baseline-check`；写临时文件后原子替换。
3. 增加锁、大小/数量限制、symlink/路径穿越防护、secret/异常内容检查和结构化安全日志。
4. 扩展 task create 模板/workflow/Phase 3.3：规划声明模块，完成时生成并审核载荷，把命中模块文件加入 implement/check context。

单元测试至少覆盖：

- 合法五种操作与重复 apply 幂等；
- 摘要冲突、重复 ID、目标错位、缺章节、路径不存在/越界/symlink、超限正文；
- delete 无理由/无替代、rename 目标存在、声明与载荷不一致；
- diff 命中漏报、新路径无映射、no-change 与产品改动冲突；
- 锁竞争、陈旧锁处理、写入中断和 rollback manifest 恢复；
- 索引确定性（相同输入字节一致）和不输出正文/secret。

## D. 归档集成与事务测试

1. 在 `cmd_archive` 状态写入和目录移动前接入阻断式 preflight/apply；保留 after_archive 给成功后通知。
2. 删除/禁用 archive、session/journal、hook 的自动 Git 提交路径；默认只产生工作区变更和人工审核包，禁止自动 push。
3. 实现人工确认门禁：展示路径、最终 diff/摘要、验证结果和拟提交清单；确认后复核摘要，再显式 stage allowlist 和 commit。任何变化使确认失效。
4. 为状态写入、session 清理、目录移动、审核前恢复和 commit 失败各节点加入补偿/恢复提示，并测试 rollback manifest 保留策略。
5. `--no-commit`、`session_auto_commit=false` 和已有 parent/child 行为分别回归；过渡期文档和命令始终使用二者，不能自动提交。

集成场景：

- preflight 失败：task 仍 planning/in_progress、原路径存在、spec 字节不变；
- apply 中断：spec 恢复，索引不产生半状态；
- move 失败：任务和模块均可恢复，命令返回非零并给出恢复指令；
- 未人工确认：任务归档与模块更新停在工作区，不 stage、不 commit、不 push；
- 确认后文件变化：摘要复核失败并要求重新审核，不沿用旧确认；
- 成功确认：任务归档和模块更新进入同一提交，after hook 只执行一次；push 仍未执行；
- 两个进程更新同一/不同模块：同一模块冲突，不同模块串行后均不丢失；
- 存量任务 legacy_exempt 可审计，新任务无法豁免。
- 扫描全部 Trellis 命令，断言不存在未经人工门禁的 `git commit` / `git push` 旁路。

建议命令（以实现后的实际测试入口为准）：

```bash
python -m unittest discover .trellis/tests -p "test_module_knowledge*.py"
python -m unittest discover .trellis/tests -p "test_task_archive*.py"
python ./.trellis/scripts/module_knowledge.py check .trellis/tasks/<fixture>
python ./.trellis/scripts/task.py validate <fixture>
```

## E. 灰度、consumer 校验与文档

1. observe 模式跑全仓 baseline-check；修正所有错误，告警按 module owner 分批确认。
2. 用新建 fixture task 做 dry-run、失败恢复和 archive `--no-commit` 演练；检查 git diff 只含允许文件，且未产生 commit/push。
3. prepare 模式验证新任务规划能从 index 找到模块，并通过 context manifest 注入具体文件。
4. enforce-new 后观察至少一轮真实的小型业务任务和一个跨包任务；出现停止条件立即关 enforcement。
5. 更新 `.trellis/workflow.md`、process spec、各 package spec index、tasks README；说明 module facts 不是规则、载荷编写方法、恢复命令、人工审核/提交/推送授权边界与 legacy 截止日。

全量检查：

```bash
python ./.trellis/scripts/module_knowledge.py baseline-check
python ./.trellis/scripts/get_context.py --mode packages
python ./.trellis/scripts/task.py validate <new-task>
pnpm format:check
git status --short
```

人工验收：分别从“语音业务”“后端鉴权基建”“shared 公共契约”“database 计费能力”开始新任务，确认能在两跳内找到当前状态、文件路径、实现链和关键约束；修改/删除后归档，确认文件只保留调整后的当前事实。

## F. 发布与恢复

- 发布顺序：基线 PR → checker 告警 PR → 新任务声明 PR → archive 阻断 PR；不一次性启用。
- 无数据库/外部服务迁移；旧模块文件由 Git 保留历史，不额外复制归档。
- 关闭 enforcement 不删除载荷或模块文件；先恢复归档可用性，再 forward-fix checker。
- 任一任务同步错误优先用该次 rollback manifest；已提交错误用独立修复提交，不 amend、不改写归档历史。
- 所有阶段的提交都必须在最终 diff 人工审核确认后执行；所有 push 必须单独人工授权，任何脚本不得自动完成。
