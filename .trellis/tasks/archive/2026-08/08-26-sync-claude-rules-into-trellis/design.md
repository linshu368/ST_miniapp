# 技术设计

## 问题定义

当前 `packages/backend/CLAUDE.md` 与 `packages/frontend/CLAUDE.md`
中已经沉淀了较完整的包级工程规则，但 Trellis 现有注入链路并没有完整承接这些约束。
这会带来几个问题：

- 包内 CLAUDE 文档成了实际规则来源，但 Trellis 只能校验其中一部分。
- 使用 Trellis 的实现与检查流程时，agent 可能漏掉一些包级强约束。
- 后续若只更新包内 `CLAUDE.md` 而不更新 Trellis，会继续产生规则漂移。

本任务的目标不是马上修改产品代码，而是先设计一套可持续的 Trellis 承接方案，
保证后续走 Trellis 时可以完整执行这些规则。

## 设计目标

1. 让 Trellis 成为 backend / frontend 包级规则的可执行入口。
2. 保留规则来源，避免 Trellis 文档与包内 `CLAUDE.md` 各说各话。
3. 将“长期约束”“实施时检查动作”“流程同步要求”拆分到合适的位置。
4. 所有新增 Markdown 文档均使用中文、结构清楚、可直接阅读。
5. 后续落地规则时，不只关注文档覆盖，还要引导实现方案优先考虑：
   可复用性、可扩展性、高可用性。
6. 规则表达本身不能鼓励过度设计，必须同时强调实现简洁、避免无用代码。
7. 规则体系需要把注释、文档、测试补齐明确纳入实施与检查要求。

## 规则落点设计

### 1. 包级稳定规则进入 `.trellis/spec/`

这类规则是长期存在、会被多次复用的代码与结构约束，适合放入 Trellis 的 package spec。

计划落点：

- 后端：`.trellis/spec/backend/app/index.md`
- 前端：`.trellis/spec/frontend/app/index.md`

适合进入 spec 的内容示例：

- 后端：
  `@frontend-ready` 注释规则、
  handler 完成度语义、
  共享契约必须先进 `packages/shared/`、
  seed UUID 保护规则、
  backend 与 frontend 的职责边界。
- 前端：
  React Query 数据获取约束、
  组件层禁止直接请求、
  表单/状态/样式规范、
  不得直接使用数据库行类型、
  iframe 持久挂载、
  bridge-only 通信约束。

另外，这两个 package spec 还应补充统一的工程导向要求：

- 结合现有组件与功能组织代码，而不是脱离仓库结构抽象设计。
- 优先保证可复用性、可扩展性、高可用性。
- 在满足以上目标的同时保持实现简洁，避免无用代码与无意义抽象。
- 要求补充必要注释、关联文档与相关测试。

### 2. 实施与审查动作进入 workflow / agent

有些规则不只是“代码应该长什么样”，而是“当检查某类文件时，必须执行什么审查动作”。
这类内容更适合进入 Trellis agent 与流程提示。

主要落点：

- `.trellis/agents/implement.md`
- `.trellis/agents/check.md`
- 必要时补充 `.trellis/workflow.md`

设计原则：

- `implement` 负责在实施前读取对应 package spec，并在写代码时遵守这些规则。
- `check` 负责在 diff 审查时，根据变更范围触发对应的包级检查清单。
- 若规则要求检查注释、文档、测试是否补齐，则要在 `check` 中显式写出。

计划加入的审查指令示例：

- backend 变更时：
  检查 routes 中 `@frontend-ready` 是否存在且状态正确；
  检查对外契约是否先进入 shared；
  检查是否误动 seed UUID。
- frontend 变更时：
  检查组件内是否直接 `fetch`；
  检查是否误用 `useEffect` 拉数据；
  检查 bridge / iframe 约束是否被绕过；
  检查是否存在未经需求授权的 UX 改动。
- 跨 backend/frontend 的共同质量要求：
  检查是否充分复用现有组件与能力；
  检查是否出现明显过度设计；
  检查是否补充必要注释、文档与相关测试。

### 3. 流程同步要求进入 process 文档

“以后如果包内 `CLAUDE.md` 更新，Trellis 也必须同步”属于流程约束，
应进入 process 文档，而不是塞进 package spec。

主要落点：

- `.trellis/spec/docs/process/index.md`

这里需要明确：

- package-local `CLAUDE.md` 变更时，必须评估 Trellis spec / workflow / agents
  是否需要同步更新；
- 不能只改包内文档，不改 Trellis；
- 新增规则时要考虑是否能够在实施与检查环节真正落地验证。

## 规则拆分准则

为了避免规则分布混乱，后续实施时统一使用以下拆分准则：

- 稳定的代码/结构约束：进入 package spec。
- 实施与检查时必须执行的动作：进入 agent / workflow。
- 规则同步与维护要求：进入 process 文档。

## 中文文档要求

本任务开始后，所有新增或重写的 Markdown 文档必须遵守：

- 使用中文书写；
- 标题、段落、列表要可直接阅读；
- 不保留英文占位、模糊缩写或只对作者自己可读的速记；
- 在表达规则时，优先写成“什么时候做什么、怎么判断是否通过”的形式。

## 与项目实际结构的关系

后续落地这些规则时，不能只做“文档转抄”。需要结合仓库现有结构与功能：

- backend 现有 routes、repositories、features、shared contracts 的协作方式；
- frontend 现有 `src/lib/api`、components、stores、bridge 的组织方式；
- 现有组件与功能中已经可复用的部分；
- 当前测试、注释、文档是否存在薄弱环节。

也就是说，Trellis 同步方案需要让 agent 在做计划和检查时，
能够主动考虑“是否应复用现有能力、是否在扩展现有结构、是否对关键功能更稳健”，
而不是只会做字面 lint。

## 验证策略

后续真正实施后，需要至少验证以下几点：

1. backend spec 已覆盖核心后端 CLAUDE 规则；
2. frontend spec 已覆盖核心前端 CLAUDE 规则；
3. implement/check agent 已显式加入包级审查职责；
4. process 文档已说明 `CLAUDE.md` 与 Trellis 的同步责任；
5. 新增中文文档可直接阅读，无英文占位；
6. 规则中已明确要求考虑复用性、扩展性、高可用、简洁实现、注释/文档/测试。

## 非目标

- 当前阶段不修改产品功能代码；
- 当前阶段不直接替换或删除 package-local `CLAUDE.md`；
- 当前阶段不开始执行 `task.py start`；
- 当前阶段不为了“高可用/可扩展”而先行引入额外框架或复杂抽象。
