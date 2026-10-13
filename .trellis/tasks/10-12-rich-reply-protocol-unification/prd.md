# Rich reply protocol and authoring unification

## Goal

以 `/Users/qj/Downloads/后处理规则.md` 为当前最新版和唯一业务事实源，先解除 `{{INTERACTION_MODE}}` 对 System Instructions 保存/发布的阻塞，再把核心富文本模块演进为可版本化、可验证、低维护成本的结构化协议。

## Current facts

- 测试环境 System Instructions 的 Admin Zod 校验、数据库 `admin.validate_managed_config_value` 和 Backend 渲染链路仍把 `{{INTERACTION_MODE}}` 当作三项必填占位符之一。
- 当前附件协议固定要求正文、3 个 choices、status 和 memory；不再需要用 `pref_show_options` 动态注入“显示/不显示选项”的指令块。
- 当前文本后处理按顺序只处理 text segment；外层规则生成 slot 后，捕获内容作为纯文本进入可信树，无法再由内部详情规则递归处理。
- 已发布规则允许 HTML/CSS 自定义，但模板 class 与 CSS selector 是两份自由文本，当前没有“CSS 必须能命中本规则模板”的引用完整性门禁。
- `10-10-relax-rich-text-css-policy` 已在当前功能分支实现 CSS AST capability denylist；进入本任务实施前必须确认这些提交已存在于选定基线，否则报告“缺少 T1 基线”，不得复制重做。

## Requirements

### R1. 单一事实源

- 附件中的协议内容必须原样成为版本控制内的 canonical rich-reply protocol source；System Instructions、Admin 默认示例、协议 fixture 和说明文本不得各自维护另一份协议副本。
- System Instructions 的有效模板应组合 canonical protocol 与仍需保留的 `{{WORD_COUNT}}`、`{{USER_CUSTOM_INSTRUCTIONS}}`；不得再要求或替换 `{{INTERACTION_MODE}}`。
- 当前附件之外的旧 `[highlight]`、`「……」`、两选项协议不得继续出现在默认示例或提示词中。

### R2. 兼容地退休 INTERACTION_MODE

- Admin schema/editor/说明只展示并要求 `{{WORD_COUNT}}` 与 `{{USER_CUSTOM_INSTRUCTIONS}}`。
- Backend 不再读取 `interaction_mode_blocks` 来渲染平台规则，也不再替换 `{{INTERACTION_MODE}}`。
- 新增 forward-only migration，使 TEST/Production 的数据库发布校验只要求两个保留占位符；不得改写历史 migration。
- 现有 `interaction_mode_blocks` 配置和用户 `pref_show_options` 数据先保留为兼容数据，不删除表字段、不迁移业务行；它们不得再影响新协议输出。后续物理清理由独立任务决定。

### R3. RichReplyV2 结构化核心模块

- `choices`、`status`、`memory` 由一个版本化协议解析器一次生成结构化节点，不再通过多条正则与捕获 HTML 组合。
- 模型只提供业务内容，不提供 `<details>`、class、inline style、URL 或交互代码。
- provider 支持结构化输出时使用 schema 约束；不支持时允许单一 envelope 适配，但两者必须归一到相同 RichReplyV2 DTO。
- 正文 Markdown 与简单对白强调可以保留受限规则；规则不得递归处理已经生成的结构化 slot。

### R4. 原子 authoring artifact

- 对仍允许运营编辑的简单规则，将 pattern、template AST、CSS AST、scope 和 selector-to-template 引用作为一个 rule bundle 编译、保存和回滚。
- 发布前必须检测模板/CSS class 漂移、无法命中模板的 selector、跨规则 selector、未绑定捕获组和危险能力。
- diagnostics 一次返回全部可行动问题，并区分语法错误、安全拒绝、兼容提醒和预算超限；不得要求运营逐个保存撞错。
- CSS 继续采用 capability denylist，不恢复视觉属性正向白名单；安全厂商前缀应规范化或在有标准声明时忽略，不应导致整份安全样式原子失败。

### R5. 同构预览与发布

- Admin Preview、Backend publish revalidation、Frontend MiniApp 必须消费同一 shared contract 与 ReplyRenderer。
- Admin 默认样例从 canonical protocol fixture 生成；不得手写旧协议示例。
- Worker 初始化与规则执行分别计时；预热/ready 之前的启动耗时不能被算作规则超时。
- 任一协议、artifact 或渲染错误必须完整回退原始 Markdown，不显示部分结构。

### R6. 范围约束

- 不修改支付、计费、消息发送、choice 正常发送链路和历史消息版本绑定语义。
- 不删除现有数据库对象或业务数据；数据库变更仅允许 forward migration 更新 validator。
- 本任务规划审核前不得执行代码、migration、Admin 保存/发布或环境写入。

## Acceptance Criteria

- [ ] 不含 `{{INTERACTION_MODE}}`、但包含另外两个占位符且包含 canonical protocol 的模板，可通过 Admin 和数据库校验并发布。
- [ ] Backend 渲染结果中不存在未替换的 `{{INTERACTION_MODE}}`，也不再因 `interaction_mode_blocks` 缺失而进入 degraded 状态。
- [ ] 附件三组示例可解析为 RichReplyV2，并在 Admin 与 MiniApp 渲染为 3 个 choice、可嵌套展开的 status/memory 与中文引号对白。
- [ ] malformed/超限/未知版本输入完整回退原始 Markdown；捕获内容不能注入 HTML、事件、URL 或伪造 choice action。
- [ ] 模板 class 与 CSS selector 不一致时，在发布前得到明确的引用完整性诊断。
- [ ] 附件中安全 CSS 除可规范化的兼容声明外可一次编译；危险能力 fixture 继续被拒绝。
- [ ] Admin 默认示例、System Instructions 协议片段和 shared fixtures 均可追溯到同一 canonical source。
- [ ] 旧 v1 artifact、旧消息 `postprocess_version=NULL` 和已发布历史版本继续按现有逻辑读取/回退。
- [ ] TEST 按 migration → Backend → Admin/Frontend 顺序验收；Production 只形成单独发布清单，本任务不自动执行。

## Non-goals

- 本任务不移除 `pref_show_options` 数据字段或清理历史 `interaction_mode_blocks` 配置行。
- 不为任意 HTML/CSS 建立无边界的通用页面构建器。
- 不在本任务中更新 Production 配置或执行 Production migration。
