# 文档与流程规范

适用于 `docs`、`.trellis`、PR 模板以及流程类变更。

## 开发前检查

- 阅读 `.trellis/workflow.md`。
- 阅读 `AGENTS.md`。
- 判断本次改动是在更新项目事实、包级工程规则，还是只在调整流程表达。
- 更新 Trellis 时，优先修改 `.trellis/` 下的运行时文件，而不是在 `docs/trellis/` 新建平行文档。
- 如果改动涉及 `packages/*/CLAUDE.md`、package spec 或 agent 流程，先确认规则来源与同步责任。

## 必须遵守

- 所有 Trellis 任务产物使用 `.trellis/tasks/{MM-DD-slug}/`。
- `prd.md` 只写需求、约束与验收标准。
- `design.md` 负责技术设计与规则落点说明。
- `implement.md` 负责按顺序描述实施计划、验证方式与风险控制。
- 汇总项目约束时保留来源引用，避免规则脱离原始文档。
- 当 `packages/backend/CLAUDE.md` 或 `packages/frontend/CLAUDE.md` 更新时，
  必须同步评估以下 Trellis 文档是否需要更新：
  `.trellis/spec/backend/app/index.md`、
  `.trellis/spec/frontend/app/index.md`、
  `.trellis/agents/implement.md`、
  `.trellis/agents/check.md`、
  以及必要的 workflow / process 文档。
- 规则进入 Trellis 时，需要区分：
  长期代码约束进 package spec，
  实施与审查动作进 agent / workflow，
  同步维护义务进 process 文档。
- 新增或重写的 Markdown 文档必须以中文展示，且内容可直接阅读，不保留英文占位、模糊速记或仅作者可懂的简写。
- 制定落地计划与实施方案时，要结合项目现有组件、模块与功能，优先考虑可复用性、可扩展性、高可用性。
- 在强调复用、扩展与可用性的同时，保持方案简洁明了，避免引入无用代码、无意义抽象或过度设计。
- 对需要长期维护的实现与规则变更，要同时考虑必要注释、相关文档与测试要求，并在检查环节显式核对。

## 质量检查

- 条件允许时，对变更过的 Markdown 运行 Prettier。
- 调整 spec、agent 或流程结构后，运行 `python ./.trellis/scripts/get_context.py --mode packages`。
- 检查 Markdown 是否为中文且结构清晰可读。
- 检查包级 CLAUDE 规则与 Trellis 承接文档之间是否存在漂移或矛盾。
