# 实施方案

## 实施目标

把 backend / frontend 包内 `CLAUDE.md` 的强规则补齐到 Trellis 的 spec、
workflow、agent 与 process 体系中，并让这些规则在后续实施与检查阶段具备可执行性。

## 实施原则

- 所有新增或重写的 Markdown 文档必须为中文且可阅读。
- 方案制定不能脱离项目现有组件、模块与功能结构。
- 设计与规则表达要优先支持可复用性、可扩展性、高可用性。
- 在满足上述目标时，坚持实现简洁明了，避免无用代码、无意义抽象和过度包装。
- 对需要长期维护的实现，必须同时考虑：
  必要注释说明、配套文档更新、相关测试补齐以及检查环节验证。

## 分步计划

### 1. 建立规则清单与落点映射

梳理 `packages/backend/CLAUDE.md` 与 `packages/frontend/CLAUDE.md`
中的规则，并按以下类别归档：

- 应进入 package spec 的长期规则
- 应进入 implement/check/workflow 的实施与审查动作
- 应进入 process 文档的同步维护规则
- 暂不纳入本次 Trellis 承接范围的内容

验证方式：

- 每条规则都有明确落点；
- 能说明为什么放在该位置；
- 不出现同一规则在多个位置彼此矛盾。

### 2. 先审视现有项目结构与可复用能力

在真正改 Trellis 文档前，先根据当前仓库现状审视：

- backend 的 route / feature / repository / shared contract 协作模式
- frontend 的 `src/lib/api` / components / stores / bridge 组织方式
- 已存在的组件、工具、能力是否足够复用
- 哪些规则需要额外强调“不得绕开现有能力另起一套”

验证方式：

- 规划中能体现项目现有结构的现实约束；
- 后续同步出来的 Trellis 规则不会鼓励另起炉灶式实现。

### 3. 更新 backend / frontend package spec

目标文件：

- `.trellis/spec/backend/app/index.md`
- `.trellis/spec/frontend/app/index.md`

更新要求：

- 补齐 CLAUDE 文档中缺失的关键规则；
- 保留规则来源引用；
- 加入对复用性、扩展性、高可用、简洁实现、
  注释/文档/测试要求的明确说明；
- 文档内容全部使用中文且表述可读。

验证方式：

- backend / frontend spec 分别覆盖核心包级规则；
- 文档中能清楚看出哪些规则来自包内 CLAUDE。

### 4. 更新 implement / check / workflow / process 指引

目标文件：

- `.trellis/agents/implement.md`
- `.trellis/agents/check.md`
- `.trellis/spec/docs/process/index.md`
- 如有必要，补充 `.trellis/workflow.md`

更新要求：

- implement 要知道在改 backend / frontend 时必须读取并遵守对应 package spec；
- check 要知道当 diff 命中相关目录时，必须执行对应检查；
- process 要求后续修改 package-local `CLAUDE.md` 时同步评估 Trellis；
- 如涉及注释、文档、测试补齐要求，要写成显式检查项。

验证方式：

- agent 文档中存在明确的目录命中条件与检查动作；
- process 文档中存在同步责任说明；
- workflow 若被修改，应增强而不是模糊现有流程。

### 5. 做一致性检查与轻量验证

检查内容：

- 文档是否全部为中文；
- 同一规则是否在不同 Trellis 文档中语义一致；
- 是否既强调复用/扩展/高可用，也同时强调简洁实现；
- 是否明确要求注释、文档、测试，而非只写“注意质量”这类空话。

验证命令：

- `python ./.trellis/scripts/get_context.py --mode packages`
- `prettier --check .trellis/**/*.md`
- 对关键规则做定向文本检索，确认落点齐全

## 质量门禁

后续真正进入实现阶段后，任何同步结果都应满足：

- 文档为中文且可读；
- backend / frontend 核心规则被 Trellis 明确承接；
- agent 能按变更范围执行对应检查；
- 规则中显式纳入注释、文档、测试要求；
- 不因为追求“完善”而制造明显冗余或过度设计。

## 风险与防范

- 风险：只做文档搬运，未结合项目现有结构。
  防范：先做规则清单与结构审视，再落 Trellis 文档。
- 风险：过度复制 CLAUDE 内容，导致 Trellis 与源文档同时变得冗长难维护。
  防范：保留来源引用，提炼成可执行规则，而不是整段照搬。
- 风险：把“高可用/可扩展”写成泛泛口号，无法检查。
  防范：在 agent 检查项中补充是否复用现有能力、是否存在无用抽象等可审查点。
- 风险：只强调实现质量，不要求注释/文档/测试补齐。
  防范：在 spec 与 check 双重位置显式写出这些要求。
