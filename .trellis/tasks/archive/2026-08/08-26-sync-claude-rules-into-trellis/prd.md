# 需求文档

## 目标

将当前仅存在于 `packages/backend/CLAUDE.md` 与
`packages/frontend/CLAUDE.md` 中、但尚未被 Trellis 流程完整承接的规则，
正式同步到 Trellis 的规划、实现与校验链路中，使后续通过 Trellis 执行的任务也能
完整校验这些包级约束，而不是仅依赖包内 CLAUDE 文档。

## 需求

- 识别 `packages/backend/CLAUDE.md` 与 `packages/frontend/CLAUDE.md`
  中所有“可执行、可校验”的规则，并明确哪些规则当前尚未进入 Trellis，
  或者虽然已经进入，但约束力度不足。
- 保留规则来源可追溯性。同步后的 Trellis 文档需要明确这些规则来自对应包下的
  `CLAUDE.md`，避免规则脱离源头后难以维护。
- 规划一套清晰的 Trellis 落地点，区分：
  代码与结构类长期规则应进入 `.trellis/spec/`，
  实施与检查时必须执行的审查动作应进入 workflow / agent 指引，
  流程同步要求应进入 process 文档。
- 后端侧必须覆盖的规则至少包括：
  `@frontend-ready` 路由标注、
  `false -> true` 状态复核、
  对外数据契约优先进入 `packages/shared/`、
  seed UUID 不可随意删除或修改、
  backend 与 frontend 的职责边界。
- 前端侧必须覆盖的规则至少包括：
  服务端数据只能经由 React Query hooks、
  组件层不得直接 `fetch` / `axios`、
  禁止 `useEffect` 做数据获取、
  表单 / 状态 / 样式规范、
  不得直接消费数据库行类型、
  未经需求明确不得改 UX、
  iframe / bridge / postMessage 约束。
- Trellis 的 `implement` 与 `check` 流程需要显式说明：
  当变更范围落在 `packages/backend` 或 `packages/frontend` 时，
  必须按对应包规则进行实现前审阅与变更后校验。
- 所有本任务新增或修改的 Markdown 文档必须使用中文书写，
  内容需要可直接阅读、结构清晰，不能保留英文占位稿、机翻痕迹或难以执行的抽象描述。
- 后续制定落地计划与实施方案时，必须结合项目现有组件与功能现状，
  重点关注可复用性、可扩展性、高可用性，避免脱离仓库实际结构空谈规则。
- 后续真正实施 Trellis 同步时，规则设计必须明确强调：
  实现要简洁明了，不引入无用代码，不做无意义抽象。
- 后续真正实施 Trellis 同步时，规则设计必须明确要求：
  代码需要补充必要且完整的注释说明、相关文档以及对应测试要求，
  并在检查环节显式核对。
- 当前阶段仅输出规划产物，不进入实现，不执行 `task.py start`。

## 约束

- 本任务当前处于 Trellis `planning` 阶段，只允许补充与修订规划文档。
- 规划必须基于以下现有文档与流程，不得脱离仓库实际情况重写一套平行规范：
  `packages/backend/CLAUDE.md`、
  `packages/frontend/CLAUDE.md`、
  `.trellis/spec/backend/app/index.md`、
  `.trellis/spec/frontend/app/index.md`、
  `.trellis/spec/docs/process/index.md`、
  `.trellis/agents/implement.md`、
  `.trellis/agents/check.md`、
  `.trellis/workflow.md`。
- 规划中提出的高复用、高扩展、高可用要求，必须与“简洁实现、避免无用代码”
  同时成立，不能以过度设计换取表面上的可扩展性。

## 验收标准

- [ ] `prd.md` 明确描述问题背景、范围、约束、规则来源与新增硬性要求。
- [ ] `design.md` 明确说明哪些规则进入 spec、哪些进入 workflow / agent、
      哪些进入 process 文档，以及为什么这样拆分。
- [ ] `implement.md` 给出按步骤执行的落地计划，并显式纳入：
      中文文档要求、组件/功能现状审视、复用性/扩展性/高可用、
      简洁实现、注释/文档/测试补齐等质量要求。
- [ ] `task.md` 将后续实施拆成可核对、可验证的任务项，并包含对应验证方式。
- [ ] 本任务的规划文档全部为中文且可直接阅读，不保留英文占位内容。

## 备注

- 本任务涉及的源文档包括：
  `packages/backend/CLAUDE.md`、
  `packages/frontend/CLAUDE.md`、
  `.trellis/spec/backend/app/index.md`、
  `.trellis/spec/frontend/app/index.md`、
  `.trellis/spec/docs/process/index.md`、
  `.trellis/agents/implement.md`、
  `.trellis/agents/check.md`、
  `.trellis/workflow.md`。
