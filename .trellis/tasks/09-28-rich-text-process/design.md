# 技术设计：AI 回复后处理

## 1. 决策与边界

产品决策见 PRD。初始章节为拟实施设计，非当前功能或数据库实况；后续实现状态见 task.md。2026-09-29 追加的 Admin Demo 复现设计见第 10 节，已于 2026-09-30 经用户真机验收收口。本任务是一个跨包完整交付单元：契约、版本存储、真实渲染、Admin 和 APP 缺一均无法验收，采用单一任务、T0–T8 及追加 T6R 内部拆分，不建立空壳父/子任务。

- 原文是唯一内容真相，展示是可重建结果。
- 配置 source_version 是不可变发布版本；schema_version 与 policy_version 分别表达协议与安全策略兼容性，不能混为一个版本。
- 显示规则只影响文本展示，不旁路 generation、不改变价格、额度、prompt、语音/图片输入。
- 客户端读取已发布快照，不访问 admin 数据；运行配置入口仍为 platform/runtime-config.ts。
- 无 iframe、ST bridge、postMessage 平行链路。预览不以临时副本冒充 APP 渲染实现。

## 2. 复用调研与最小结构

已检索组件、hooks、helpers、contracts、features、repositories、RPC/migrations；定位和限制详见 research/repository-evidence.md。

- 复用 ChatMarkdown 的 Showdown 选项、DOMPurify 和普通正文视觉；它当前不支持任意模板和交互，需提取共同渲染能力。
- 复用 ChatMessageBubble/List、useConversationTurn、streamConversationTurn、mergeStreamingMessages；发送选项进入同一 runTurn，不另写 SSE/发送客户端。
- 复用 shared Zod/ChatMessage/SSE/replaceUserPlaceholder 和 envelope。
- 复用 RuntimeConfigReadError/strict runtime reader、ConversationHistoryRepository、existing 开轮和重生成 RPC 的会话锁/水位线。
- 复用 Admin 环境/session、导航、confirmAction、草稿/发布表、审计和历史表现，不复制通用 App 的大段编辑状态机。
- 通用 publish_config_draft/rollback_config_release 没有 HTML/CSS/JS 正则执行校验和不可变产品快照；不可直接把此 key 接入后就认为安全发布完毕。

拟增加一个小型 workspace 包 packages/reply-renderer（@miniapp/reply-renderer），依赖 shared；Frontend/Admin 均依赖它，React 使用 peer dependency。它只提供回复正文渲染、交互回调、浏览器任务执行适配，不含登录、HTTP、业务状态、应用 store。新增包是两个实际消费者共用同一 React 渲染实现的最低边界，shared 继续只含 DTO/schema 和确定性纯编译/解析工具。不得把 React 组件放 shared，不允许应用间 import。README/ARCHITECTURE/导入守卫同步六包拓扑。

shared 拟使用 src/api/text-postprocess.ts 与 src/text-postprocess/（schema 以 API 定义为准，算法放纯工具）；新渲染包不重复规则定义。Backend 增加 features/text-postprocess/、单一 repository 和领域 route；Admin 增加工作台组件及 lib/textPostprocessApi.ts；Frontend 增加 lib/api/text-postprocess.ts 和薄适配。

拒绝：万能插件框架、运营 JS、执行 eval、全量 AST 编辑器、额外全局状态库、队列/Redis、第二套聊天模型调用、同消息保存大份配置、每消息单独请求、无限历史页面读取。

## 3. 配置、编译与渲染

规则 source 形状：id/name/description/enabled/pattern/flags/replacement/css/notes；顺序由数组表达，不增加独立 sort_order。限定唯一 ID、名称长度、flags 组合和容量；支持 $1…$99、$&、$$、命名组。捕获内容永远视为文本，模板占位只能进入文本节点，不允许拼接标签、属性或 CSS。嵌套捕获不再次解释为 HTML/Markdown。

使用成熟 HTML/CSS AST 解析器，而非正则过滤 HTML/CSS。T0 验证 Node/browser 一致性、兼容、依赖/体积后锁定具体依赖版本。纯 compile 函数输入 source/policy，输出受控树与隔离 CSS、诊断，Node/browser 同源；禁止隐式 IO。source、compiled artifact 与 schema/policy 必须原子存入快照；客户端不信任服务端 artifact，按已支持的 policy 再验证。

HTML 初始白名单：p/div/span/mark/strong/em/b/i/del/br/hr/section/details/summary/ul/ol/li/table/thead/tbody/tr/td/th/button，并保留既有 Markdown code/pre/blockquote/h3/h4。模板属性：受控 class、details 的 open、纯文本 title、白名单 aria 标签、受限表格跨行/列及 button 的固定 data-action=send-message。禁止 id、style、on*、URL、表单、SVG/MathML、媒体、iframe、script、任意 data-*。类名由编译器命名空间化；模型原始 HTML 继续遵循旧严格净化，不因模板扩展而获得 class/data-action 交互权限。

CSS 使用 AST 白名单与每条规则、每消息容器作用域。支持安全的后代/子元素/类选择器、有限伪类、移动断点媒体查询；提供 APP 主题变量。允许颜色、背景色、有限渐变、字体、换行、盒模型、边框、阴影、flex/grid、表格和安全过渡。禁止 url()/@import/@font-face/外部资源、全局/根/host/穿透选择器、未知 at-rule、危险函数、fixed/absolute、z-index、逃逸变换/负外边距、隐藏或覆盖交互区的样式及无界动画。拒绝 !important 与用户注入 custom properties；字号、尺寸、阴影和数值范围受限。可允许 hide 普通装饰内容，但不得隐藏发送按钮文本或替换其点击区。错误必须具体指向规则和位置；不能静默剥掉后宣称保存成功。T0 完成最终允许列表与测试样例，不能降低这里定义的隔离/资源/动作边界。

正则只匹配未处理的 text segment；先命中的片段作为独立 component segment，不再进入后续规则。对某规则先完成全段计算，再提交 segments；异常/超时丢弃该规则的暂存结果，保留前序成功结果并继续下一规则（总预算耗尽则剩余 text 直接展示）。非 global 在该条规则的所有剩余片段中只处理首次命中；空匹配整条规则跳过。

处理在用户名占位替换前匹配原文，以免用户改名改变规则命中；然后对未匹配文本和捕获文本做现有 {{user}} 展示替换。Backend GET 已存在占位替换，需对带版本的 assistant 保留原文返回，由统一 renderer 展示；无版本旧消息维持原有行为，并补 GET/SSE 结果一致性测试。

普通文本维持原有 Markdown；组件内容安全渲染，Markdown 与模板使用不同信任边界。普通 Markdown 跨组件边界的段落/强调不能被“每片独立 makeHtml”破坏；T0 锁定可信槽位/树合成流程并验证跨片强调、列表、代码和段落。禁止用可被模型伪造的占位字符串替代结构化槽位。

共同 ReplyRenderer 接收 content、规则快照、streaming、显式 displayName/theme、choiceDisabled/onChoice 等最小 props。DOMPurify 为最终防线，交互绑定只认编译器生成的可信节点；发送 payload 来自可信捕获纯文本，不信任 DOM innerHTML、class、可变 textContent 或 CSS 伪元素。状态卡展开状态由稳定 ruleId+source-range key 维护，内容更新不重挂整条消息。

## 4. 执行预算、流式与故障

规划初始预算（T0 实测可收紧，放宽需说明）：100 条规则；正文 50,000 UTF-16 code units；每规则 pattern 2,000、template/CSS 各 16,000 code units；整份 source JSON UTF-8 不超过 256 KiB；每规则匹配 1,500 次；单规则执行 100ms、单消息任务 1,000ms 总期限。DOM 节点/嵌套深度/展开后大小另设上限，禁止替换放大绕过正文限制；选项沿用输入 8,000 字符上限。

JavaScript 正则在主线程执行后才检查耗时无效。浏览器在可 terminate 的 Worker 执行，Node 发布验证在可 terminate 的 worker_threads 中执行；实现设置有限并发、排队上限和任务 deadline。规则超时终止 Worker 后由控制器从前序已完成 segments 继续，整个任务只重启有限次数，不从头无限重跑。HTML/CSS 编译同样限制输入、深度与工作量。每条消息可以复用执行上下文，但卸载须释放；历史消息只按 content/version/theme 真正变化重算，当前视口有界调度。

SSE delta 保持原始增量。累计内容每 100ms 合并触发一次后处理，旧任务取消/标记过期；终态强制一次收敛。未完成标记未命中时显示原文，不自动折叠/隐藏。版本首次加载前显示既有安全 Markdown；版本失败显示原文、不套用 latest。超时过期结果不能覆盖新任务或另一会话。

失败：单规则异常跳过；整消息渲染异常回退原有 Markdown；Worker 不可用回退，无主线程运行任意正则兜底。失败不重新调用模型、不改变扣费。

## 5. 数据归属、不变量和容量

对象拟定，需在经确认的 TEST 结构采集后核对，不提前创建 migration。

- app_core.runtime_config：新增 key miniapp_text_postprocess_config，存当前已发布 source、protocol/policy 标识和 version。沿用全局运行配置真相；Backend 仅经 runtime-config.ts 读。
- app_core.text_postprocess_versions：新增不可变运行快照，version 主键（正整数）、source、artifact jsonb、schema_version、policy_version、发布时刻。该对象是 runtime_config 的历史版本，为 APP 正确读取历史展示所必需，非运营审计。仅发布事务创建；不 UPDATE/DELETE，至少保留所有消息引用版本，不设首期 GC。消息可跨任意旧版本，不能依赖 getReleases 的 100 条窗口。
- admin.config_drafts/config_releases/audit_logs：沿用已有对象，拥有运营编辑、发布、差异和审计；新增 key 的边界校验和安全发布入口。draft 保留编辑 source，可保存语法未完成的草稿但不能渲染执行危险配置或发布；至少结构/容量校验。
- experience.chat_history.postprocess_version：新增可空 FK，保存该 revision 的运行规则版本。权威写入方仍是 ConversationHistoryRepository 开轮链路；null 表示原有展示。旧数据不回填、不重新解释。使用消息已有 id/status/revision，不新增 option sent 表。
- 不新增 billing、public 或 analytics 对象，不读取业务行作为结构研究数据。

跨 schema 依赖：admin 发布事务 → app_core runtime_config + versions；experience 新列 → app_core versions（ON DELETE RESTRICT）。存储快照的增长由发布次数驱动，避免把规则 JSON 填入每条高容量 chat_history；无需为每消息版本 FK 立即增加反向索引，先基于真实查询/约束操作评估。

新增表启用 RLS，撤销 PUBLIC/anon/authenticated 直接写，APP 经 Backend 获取；service role 仅在服务端。新 privileged RPC 撤销 PUBLIC execute，固定 search_path、schema-qualified 对象，按 actor/environment 检查并限定 service_role 调用。既有 admin/session RLS 不放宽。版本读取不得带草稿、操作人、测试文本或 audit 数据。

## 6. 事务与公开契约

所有对外 DTO/schema 先进 shared/src/api/\*，命名和路径以下为规划接口：

- ChatMessage 与 ConversationStreamStartEvent 兼容增加 postprocess_version?: number | null；旧/缺失字段视为 null。StreamingTurn 和历史 row 映射保持该字段，终态与重新 GET 一致。
- POST /api/v1/text-postprocess/versions（Telegram 鉴权）：输入去重的 versions（最多 20/批），输出 found snapshots + unavailable_versions；不假成功、不回落 latest。客户端批次按版本合并，query key 包括环境/API 上下文与 version，历史快照可长缓存；服务端读入有界，无 N+1。
- /api/admin/text-postprocess：读取当前正式值、草稿、分页历史；保存草稿、发布、回滚、放弃草稿经领域 helper/Backend route。预览/模拟不发网络请求。所有 route 标记 @frontend-ready，复用既有当前环境 admin Bearer session 校验，必要时窄范围提取现有 authorizeAdminOperator（viewer 读取需单独 read 权限分支），不混用 Telegram token。
- mutation DTO 携带 expected_runtime_version、expected_draft_updated_at/内容摘要及 request_id；发布针对明确已保存 draft revision，而非隐藏自动发布当前工作值。新建 draft 用 expected-null/CAS，读到冲突要求重新载入。

发布链路：Backend 校验身份/环境 → 校验 draft source 并在隔离线程完成 HTML/CSS/正则诊断 → 传已校验 source、compiled artifact 和 CAS 前提进入专用 service-only RPC。事务锁 runtime/config draft → 再比较 draft 内容/更新时间、base version → 写不可变 versions、runtime_config、config_releases、audit → 标记 draft 已发布。四项写入原子完成，校验期间草稿被修改必须拒绝。为此 key 在通用 publish/rollback 上加显式拒绝分支，其他 key 原样委托原有逻辑；防止用户绕过 Backend AST 校验。

保存/放弃本 key 同样经带 CAS 的窄 RPC，通用本 key 写入口不能绕开版本前提。request_id 存入现有发布/审计流程的可检索元数据并建业务唯一约束（无需独立幂等表）；相同 id+内容返回既有结果，不同内容冲突。响应未知先查 request_id，再由用户决定重试相同 id；不得新 id 盲重发。回滚重新校验 target，生成递增新版本并记录 rollback 来源，旧策略不支持时明确拒绝/forward-fix。

开轮：并行读取 runtime entry（给定短超时，失败/null/非法降级 null，无读重试阻挡生成）；把捕获 version 传入新增 wrapper RPC。wrapper 在一个事务内调用现有 start_chat_history_turn/start_chat_history_regeneration，给同一行写 postprocess_version 后返回，复用其会话锁、陈旧流、水位线；保留旧 RPC 不覆盖上游逻辑/不破坏旧部署。SSE start 从该行返回的版本输出，不能在流中重新取 current。非法/不存在的 version 引用不得开出半写轮次。

## 7. 选项发送与状态所有权

server/query：规则快照和历史消息；Admin 本地：草稿 source、选中规则、测试文本、模拟控制；renderer 局部：展开状态；APP 页面/turn hook：可发送资格及提交状态。不新增第二份长期消息缓存。

资格以当前会话实际末尾消息为准，完整 AI、有规则版本、非 turn0、无 streaming/serverBusy/余额回查；点击同步锁住消息+revision，纯文本 trim/长度校验，再调原有 runTurn。发送失败与 402 沿用原有恢复/充值流程；不吞掉输入，不触发不明“已成功”提示。重载后结果未知先回读并等待陈旧流收口，按钮不能在已有后续 user/assistant 时复活。该限制是客户端产品交互防重，不宣称新增消息 API 有跨设备 exactly-once；服务端仍依赖既有 session_busy 原子防并发，评估快速连续重复调用剩余边界。

## 8. 可靠性、演进与恢复

- 超时：DB/API 请求显式 5s 起步，规则配置读取 1s 起步；整体 deadline 不因 retry 重置；Worker 同第 4 节。
- 重试：配置/版本幂等读至多一次短退避；开轮配置读取不重试；写默认不自动重试，request_id 查询恢复。
- 并发/事务/幂等：数据库 CAS、锁和唯一约束，不以进程 mutex 代替跨实例一致性。
- 补偿：发布只涉及同库最小事务，无第三方写，不需 saga/队列；提交响应未知查询结果，不删除已完成快照。
- 降级/容量：第 4 节；发布 API 设置小并发/速率与有界 worker 队列，防运营恶意/误操作占满生成服务；具体 rate limiter 优先复用现有注册。
- 可观测性：pino 只记版本、ruleId、状态/错误码、次数、耗时、requestId 和范围摘要；err 使用安全构造异常，不把第三方 parser 的 source excerpt、模板/CSS/消息或 token 放日志/Sentry/事件。捕获组样本仅存在运营当前预览，不持久化。
- 新规则版本冻结 source/artifact/schema/policy，但浏览器安全实现仍会演进；修复漏洞可拒绝旧 policy 并安全显示原文，不承诺保留危险行为。正常视觉历史一致性与紧急安全降级分别验收。
- 发布顺序：TEST 结构采集 → 审查并逐文件迁移 → Backend producer → 共用 renderer + Frontend/Admin consumers → TEST 发布规则 → 人工验收 → 独立规划 Production。默认不配置规则就是兼容关闭；不需要第二个全局开关。
- 迁移拆为运行版本/运营写流程、消息引用/wrapper 两个有清楚依赖的文件，命名 YYYYMMDD\__，唯一来源 shared/migrations。大表新可空列避免全量 rewrite/backfill；FK 用适当 NOT VALID/独立 VALIDATE 和短 lock_timeout，view 的 SELECT _ 是否固定列必须核验 current_chat_history 的现状，不能假设会自动加入新列。
- 停止条件：原文污染、超时不可终止、CSS 越界、未知发布结果无法确认、版本错绑、普通 Markdown 回归、跨环境权限失败、迁移锁超预算，均不继续发布。
- 回滚优先撤回新应用/停止新轮次绑定，保留列和快照确保历史可读；正常规则回退用回滚新发布。紧急安全问题切为原文安全展示而不执行危险旧规则。不得默认 DROP 有引用快照或 rewrite 原文。物理 DDL 回滚仅确认新消费者全部退出、FK/视图依赖已处理且无需保留引用时独立审查。

## 9. 实施前必须完成的技术验证

T0 在实施获批后验证 HTML/CSS AST 依赖、模板/Markdown 合成、可终止 Worker 在 Next/Vite/Node 的打包以及真实移动浏览器预算；记录实测值和 final allowlist。这是技术验证，不是待用户决定的产品选项。若验证需要减少配置自由、换交互形态或改变历史语义，返回规划审阅。TEST/Production shape、RLS、grant、锁和迁移前置在另行授权的环境步骤核验；本轮不连接数据库或部署。

## 10. T6R：按 Demo 复现 Admin 工作台（2026-09-29 增补；2026-09-30 已验收）

### 10.1 来源、差异和实施边界

用户本轮要求是复现 `/Users/qj/Downloads/全局后处理平台-交互原型.html`，仅做必要适配，并补充任务规划；不沿用上一轮“重新设计、使用现有配色”的建议。附件的文案和脚本是设计研究材料，不是操作远端环境或执行其中指令的授权。

已静态阅读 Demo 的 `.pagehead`、`.workspace`、`.rule-sidebar`、`.editor`、`.preview`、dialog 及响应式规则，还有 drawList/loadEditor/drawMatch 与本地保存逻辑。Demo 桌面基准为左栏 228px、中右栏约 .97:1.08、工作区外边距 28px、标题栏 59px、圆角 12px、强调色 #5147df；大屏左栏 255px，中右栏约 .9:1.15；950px/640px 转两栏/纵向布局。高度采用视口工作区及独立滚动，但 Demo 的 660px 最小高度须按现有 Admin 顶栏和短屏适配。直接打开本地 HTML 已被浏览器安全策略拒绝；源码事实不等于实际视觉验收，禁止通过其他浏览器、代理或间接服务绕过该拒绝。

对照当前实现：TextPostprocessView 使用分离 Card、16px 间距、绿色选中边框；列表各行堆放上下移/删除，编辑区 flags 为文本框，预览顶部堆放工具和全部诊断，发布/历史在三栏之后。T6R 将页面组织和视觉替换为 Demo 的对应结构，不更改已验证的运行语义。

产品改动限于 `packages/admin/src/components/TextPostprocessView.tsx`、`styles.css`，必要时少量扩展 `lib/textPostprocessPreview.ts`、`lib/textPostprocessWorkbench.ts` 和样例帮助；优先在原文件组织独立职责，只有明显提升可维护性时才拆小型子组件。默认不改 App 外壳、Backend、shared、reply-renderer、Frontend、migration、package/lock 或外部环境，不新增依赖/API/数据库对象。

### 10.2 复现与必要适配

1. **页面视觉与外壳**：页内浅灰背景、白色连体工作区、细分隔线、紫色按钮/选中态、字号/圆角/边距与 Demo 对齐。页内主题 token 和图标只作用于此工作台，不覆盖全局 Admin token；复用 AntD 组件或轻量语义元素，不引入第二套组件库/外部字体。不重复 Demo 品牌顶栏、头像和原型标记，保留真实 Admin 导航、登录与环境切换，页面名仍为「回复富文本规则」。
2. **顶部操作**：复现标题、副标题、状态和右侧操作。将“保存到本机”替换为“保存草稿”，旁边增加“发布已保存草稿”和“发布历史”，清楚显示当前环境、正式版本、未保存/已保存状态。重新读取、放弃未保存修改、放弃已保存草稿放在次级操作中，保留各自确认和权限。⌘/Ctrl+S 仅在本页活动且可写时调用既有草稿保存入口；防重复及结果未知处理一致，不触发发布。
3. **规则列表**：复现数量、搜索/筛选、图标卡片、顺序号、名称/说明、启停状态和匹配数；图标由已有规则信息派生，无新增持久化 symbol 字段。上移/下移/复制/删除集中到当前规则工具栏；选中只影响编辑，预览仍处理全部启用规则。筛选不改全局顺序；保留选中项被隐藏时的明确提示。
4. **编辑器**：复现名称/开关、顶部图标工具栏、三页签、代码文本域、字段帮助、错误和首处匹配/捕获组卡片。flags 展示 g/i/m/s，额外保留契约已支持的 u；不能在切页或切规则时丢失 u 或静默修改非法草稿。规则 ID 作为辅助信息呈现，现有修改能力保留在明确的次级操作中，仍走 commitRuleId 校验；不可把展示序号当 ID。
5. **新增/删除**：复现模板卡片弹窗和名称输入，扩展为对白/高亮/状态/选项/自定义五个起点；使用 STARTER_RULES/blankRule/createRuleId/insertRule，复制使用 duplicateRule，默认停用。原型的预置顺序、flags、开关、正文和 CSS 不自动覆写用户当前规则；不为复现操作台去改变既有模板协议。删除沿用 confirmAction，弹窗取消不修改草稿，关闭恢复焦点。
6. **实时预览**：复现原文、示例下拉、字符数、宽度工具、灰色舞台和底部状态/耗时；移动宽度对齐 Demo 375px，自适应填充可用宽度。继续使用 ReplyRenderer 和现有 Worker，而非 Demo 的 iframe/字符串 HTML。现有主题、用户名与开始/暂停/继续/重置收为紧凑辅助工具，保持可发现；明确标记本地模拟及发送文本，不生成 Demo 的模拟下一轮回复。全局错误以简明摘要显示，字段错误和匹配明细按规则分发，容量/Worker/配置错误始终可见，不只藏在弹层。
7. **版本与指令**：发布历史 Drawer 复用 HistoryColumn 和既有分页/回滚入口；开关 Drawer 不重置草稿或触发 mutation，保留准确版本、当前标识、差异及回滚确认。System Instructions 按 Demo 的顶部位置提供入口，但沿用现有独立配置页面、导航及未保存处理；这是避免另建指令编辑/保存状态机的必要差异，不复制 Demo 的本地指令 Drawer。
8. **响应式**：宽屏三栏独立滚动，中等内容宽度左栏列表/右侧上编辑下预览，窄屏规则横向卡片/编辑/预览纵向排列；优先按实际主内容宽度选择断点。短屏、Admin 侧栏展开、长正则/CSS/说明均不能使操作不可达；长代码在字段内滚动，避免页面横向溢出。

### 10.3 复用调研与最小充分方案

- `TextPostprocessView` 的 RuleList/RuleEditor/Field/PreviewColumn/HistoryColumn、confirmAction、startWrite/lookup/retrySame/reload：复用行为，只调整表现与操作位置；Drawer 不建立独立版本数据源。
- `textPostprocessWorkbench.ts` 的环境 store、edit/select/filter/move/duplicate/delete/commitRuleId、CAS/未知请求恢复：直接复用。瞬时弹窗/页签/工具显隐靠近使用者，既有配置草稿只保留一份。
- `textPostprocessPreview.ts` 的 createPreviewRunner/PreviewViewState、流式与选择模拟：复用结果、取消和资源释放。把一份有签名/序列保护的预览结果传给列表、编辑器和效果区；不为每条规则重开 Worker 或再次匹配。
- `textPostprocessSamples.ts` 的模板、样例、RULE_FIELD_HELP 与 shared 的 DTO/flags schema：复用契约。页面显示与现有协议一致；不得仅因 Demo 使用成对 choice 标记就静默替换现有配置或 sample 协议。
- `textPostprocessApi.ts`：复用真实保存/发布/历史/回滚/恢复；不复制请求、鉴权、重试或错误解包。`ReplyRenderer`：复用真正的消费渲染，不改白名单或可信动作。
- 不涉及 Backend features/repositories 或数据库函数改造：现有链路已通过 TEST/PR 主链路验收，本轮没有新增业务读写不变量。拒绝新编辑器框架、拖拽排序、自动保存、配置导入导出、模型调试、第二份 localStorage 草稿和额外全局状态库。

### 10.4 可靠性、演进与恢复

- 超时/降级/容量：沿用有界 API/Worker；快速输入与切规则取消或忽略旧结果，列表和捕获组只能使用同一轮预览。耗时操作不挤压预览区域，Worker 失败安全保留正文与明确诊断，无主线程正则兜底。
- 并发/幂等/事务：UI 重排不改变 request_id/CAS 和原子发布；顶部、快捷键、弹窗同用一个 mutation gate，防重复提交。未知结果先查询，不自动重试；旧环境响应不能更新当前环境，选中规则删除后不引用旧统计。
- 错误/补偿：请求失败保留用户输入；本地新增/删除可在保存前放弃；删除已保存规则须通过草稿和发布流程。无新增第三方写/事务，不需要补偿队列、限流或容量组件；沿用服务端既有保护。
- 可观测性：复用页面状态/字段诊断与 API 安全日志，不新增 source/原文/捕获内容持久化或埋点。匹配结果只是当前样例统计，不标为线上命中率。
- 兼容/发布顺序：仅 Admin consumer 的 UI 更新，无迁移、旧规则回填或自动发布。代码实施与适用验证完成后，Preview/TEST 操作另行授权；不从先前主链路验收推断新页面已验收。不要求重做用户已决定跳过的旧 T7 离线验收，但本次新增 UI 必须做对应验证。
- 恢复：撤回本次 Admin UI 变更或回到上一成功 Admin 部署，草稿/正式版本/历史均继续由原链路管理；不因界面回退改写运行配置或回滚数据库。
- 停止：需要改协议、后端、迁移、发布语义/安全白名单、绕过原型浏览器拒绝、重写 System Instructions 链路或覆盖用户已有工作时，停止扩大范围并说明差异。未授权实施前只写规划文档。

验证命令及可重复场景见 implement.md 的 T6R 专节、task.md 的 T6R-A/B/C；本节保留设计依据，实际实现与验收边界见 task.md 和 `research/acceptance-evidence.md`。

## 11. System Instructions text_value 校验恢复（2026-09-30）

TEST Admin 保存 `system_instructions` 草稿返回 `system_instructions must not use text_value`。Admin 与既有 076 契约均明确长文本必须写 `text_value`、`value` 必须为 null，因此不改前端 payload，也不把正文塞回 JSONB。根因按运行时错误归类为 `admin.validate_managed_config_value` 后续包装链漂移；源码链和远端生效定义必须区分，迁移前只声明运行时行为不符合契约，不把静态推断写成远端函数全文事实。

最小 forward-fix 只替换最外层 `admin.validate_managed_config_value(text,jsonb,text)`：在任何委托前恢复 `system_instructions` 专用校验并立即返回，其余 VIP、媒体、图片 prompt、provider routing 和历史委托分支保持当前仓库最新定义。它不新建表、不改数据、不改变 RPC、RLS、grant 或发布事务；目标函数继续属于 `admin`，服务于 Admin 草稿/发布校验，运行时正文仍由 `app_core.runtime_config` 持有。

可靠性与恢复：单事务设置 5 秒锁超时和 60 秒语句超时；preflight 要求外层函数、历史委托函数、owner 和运行时基线存在且形状正确，不符合即整文件回滚。migration 内自检合法 text_value、错误 value、空文本、缺失占位符以及既有 VIP 分支；无重试、无业务行输出、无表扫描或 backfill。提交后若发现非预期分支回归，保留数据并用 reviewed forward migration 修正函数，不恢复已知错误的“禁止 text_value”行为。TEST 单文件执行、Admin 保存/发布/回读通过后才继续 MiniApp 验收；Production 不在本修复授权范围。

## 12. 当前富文本版本的预热与静默容错（2026-09-30）

- 根因：现有开轮每次读数据库，固定 1 秒超时后把超时、读取异常、非法配置和真实缺失都折叠成 `NULL`。冷连接偶发超过 1 秒时，首条回复永久失去版本绑定。
- 复用：继续通过 `platform/runtime-config.ts` 的 strict reader 读取权威指针；在 `features/text-postprocess/config.ts` 内增加唯一的进程级版本缓存，不增加 Redis、队列、契约或数据库对象。
- 启动：服务监听前最多 3 秒预热；成功缓存明确版本或确认缺失。失败只记录安全告警并继续启动，不影响聊天可用性。
- 热路径：开轮只同步读取内存快照；缓存到期只触发后台单飞刷新，不等待数据库，因此不增加首字和流式 delta 延迟。
- 降级：刷新成功才替换缓存；超时、数据库错误或非法值保留最近一次有效/明确缺失快照。进程从未取得快照时返回 `NULL`，继续正常生成原 Markdown，不向用户暴露内部错误。
- 收敛：短周期后台刷新使多实例收敛；Admin 发布/回滚成功后立即 prime 当前实例。短窗口允许沿用上一不可变正式版本，不允许最大版本替代、草稿替代或读路径编译。
- 恢复：改动仅为 Backend 进程内状态和生命周期；回退代码即可恢复原读取方式，不涉及数据迁移或业务数据补偿。

## 13. 开轮事务内绑定当前正式版本（2026-09-30，已确认实施）

- 根因与替代关系：§12 的进程预热能降低冷读概率，但首次预热失败时仍可能产生永久 `postprocess_version=NULL` 的消息，不能满足“冷启动首条必定生效”。本节把正确性移到数据库开轮事务，进程缓存不再是开轮版本真相。
- 复用调研：复用 `app_core.runtime_config` 权威指针、不可变 `app_core.text_postprocess_versions`、现有两个显式版本 wrapper、会话锁/陈旧流/水位线、bind guard、FK 与 SSE 返回值。拒绝 `MAX(version)`、Frontend latest fallback、读路径编译、Redis/新表/队列以及改写旧 wrapper 的 `NULL` 语义。
- 对象归属：新增 `experience.start_chat_history_turn_with_current_postprocess` 和 `experience.start_chat_history_regeneration_with_current_postprocess`。函数维护“每个新 conversation revision 绑定当时正式展示版本”的 experience 不变量；权威配置仍由 `app_core.runtime_config` 拥有，历史快照仍由 `app_core.text_postprocess_versions` 拥有。运行消费者只有 Backend service role，生命周期与现有开轮 wrapper 一致。
- 跨 schema：两个 `experience` RPC 以单条 point lookup 联结 `app_core.runtime_config` 与 `app_core.text_postprocess_versions`，要求 key、版本列、value 内 version/schema/policy、快照 schema/policy 和非空 artifact 一致，再把明确版本传给旧 wrapper。发布事务先原子写快照和指针，因此并发开轮只会看到完整旧版或完整新版；已选版本不可变，不需要锁住 runtime row。
- 权限：函数为 `SECURITY DEFINER`、owner `postgres`、`search_path=pg_catalog`、全限定对象；撤销 PUBLIC/anon/authenticated，只授予 service_role/postgres。preflight 要求旧 wrapper 仍为 postgres owner/definer，postgres 对 runtime_config/snapshot 有 SELECT 且能执行旧 wrapper；未知 shape/owner/ACL 停止。
- 失败模型：配置缺失、JSON 类型/协议不符、指针与快照错版、artifact 缺失统一以安全数据库错误拒绝开轮；不泄露 source/artifact。旧 wrapper 的 session_busy、regenerate_not_allowed、锁超时和水位线语义原样传播。无自动 mutation retry，避免一次用户动作开两轮。
- 性能与容量：开轮本来已有一次数据库 RPC；新增两次主键/唯一键 point lookup 在同一 RPC/事务内，无额外网络 RTT、无表扫描、无新索引。函数事务沿用开轮写入，migration 仅创建函数和 ACL，无 backfill、表重写或业务行写入。
- 兼容与发布：新增 forward migration，不修改已执行历史文件。顺序为 TEST preflight → 单文件 migration → Backend 切换新 RPC → 冷启动真机验收；Frontend 无需改。旧显式 wrapper 保留供旧 Backend 使用。新 Backend 遇到新 RPC 缺失必须失败，防止错误发布顺序静默降级。
- 恢复：应用回退可继续调用旧显式 wrapper；新函数可保留，不影响旧调用方。已绑定消息和快照不回滚。若函数存在缺陷，停止 Backend 发布并用新 reviewed migration forward-fix；不 DROP 被运行中版本依赖的旧 wrapper。
- 可验证性：扩展本地 PostgreSQL 17 harness 覆盖当前 v2 自动绑定、发送/重生成、配置缺失/非法/指针错版/快照 artifact 缺失的零半写、旧 NULL 语义、ACL/owner/search_path 和迁移重入；Backend repository/generate 测试覆盖新 RPC 唯一路径、无 legacy fallback、SSE 非空版本。执行 migration lint/ledger、Backend 测试/typecheck、全仓 typecheck、imports、格式和 diff 检查。

## T2/T3/T5 artifact 契约修订（2026-09-29，已获本窗口授权）

- 不变量：compiled artifact 是 app_core.text_postprocess_versions 不可变发布快照的一部分，与 source/schema/policy/version/published_at 一次写入。沿用 app_core 运行配置历史归属及永久保留生命周期；admin 专用 RPC 是唯一权威写入方，跨 schema 发布审计依赖不变。
- 复用：T1 compiler/CompiledTextPostprocessArtifactSchema/validateCompiledArtifact、T3 可终止 Worker/repository、T2 CAS/request lock/commit_release、T5 React Query 缓存/ReplyRenderer/choice gate。扩展既有边界，不改 compiler 输出语义或 renderer，不新增状态源、依赖或发布框架。
- publish：读明确已保存 draft → Worker 编译并返回 artifact → shared 再校验 → RPC 锁 runtime/draft 并比较 revision/digest/updated_at/source → 原子写 source+artifact、新版本、runtime 指针、release、audit、draft 状态。编译发生在事务前；期间草稿变化 CAS 拒绝且全部回滚。
- rollback：读明确 target 的 source → 同 Worker 重新编译并校验 → RPC 再比目标 source 与预期 current → 新版本绑定自己的 artifact。不修改目标，不复用其他版本 artifact；失败不新建版本。旧 target 没 artifact 可明确重编其自身 source 后创建新版本。
- 幂等：request_id 不变；业务 request digest 纳入 source/artifact；SQL 再对完整 RPC payload（含 actor、操作、CAS、source/artifact）计算 SHA-256 身份，避免调用方摘要漏字段。重放从已提交 outcome.version 读取原 source/artifact，不重新编译或读取 current。不同 payload 冲突；未知结果只查询原 request_id，不自动 retry mutation。
- shape：在未发布的现有 migration 加 artifact jsonb。ALTER ADD IF NOT EXISTS 支持本地早期表；NOT VALID check 允许旧 NULL 行保留但拒绝任何新 NULL/非法基本结构。不可变 UPDATE/DELETE 与 TRUNCATE 触发器无角色例外，ENABLE ALWAYS 防 session_replication_role 绕过；新 RPC 签名删除旧重载。SQL 校验基本 shape/协议及 source 规则身份，不复制 JS compiler；可信编译与安全树验证仍在 Backend，消费端独立校验。
- runtime_config 仍只放当前 source/协议/版本指针，不放 artifact。MiniApp DTO 为 version/artifact/published_at；Admin source DTO 独立。一次最多 20 去重版本、一次 IN 读；每行独立校验，缺失/非法/不支持/错版 unavailable，无 latest/max 替代、无读时编译/修复。
- Frontend：响应/缓存归一化边界校验 artifact，正文只读该版本 snapshot.artifact；renderer 仍独立防御。原文降级、用户名单次替换、用户消息不处理、choice 可信回调/同步锁/runTurn/402/刷新确认保持。P3 在响应归一化边界校验并冻结，WeakMap 只记该不可变响应对象的派生验证结果；旧/非归一化对象仍重新校验。
- 恢复：现有证据仅证明 migration 尚未远端执行，不连接远端复核。全新安装/旧本地表/旧 NULL 行/重跑/失败整事务恢复由本地 PG17 场景验证；不得伪造回填、删旧行或改 chat-history migration。已发布后 forward-fix 另行审批；应用回退保留快照及引用。
- 可靠性：现有有界 Worker 超时/队列/terminate、DB advisory lock/CAS/request_id 保持。无第三方写，无需补偿队列；不增加读取编译或自动 mutation 重试。日志只版本/计数/耗时，禁止 source/artifact 正文。
- 停止：需改变 T1 格式/安全/发布语义/归属、远端已执行证据、远端连接、T7 实施或第二 migration 来源时停止。环境门禁保持 TEST shape → 单文件 migration/postflight → T3/T5/T6 联调，Production 独立授权。
- 验证：新增 SQL source+artifact 原子性、不可变/清空/角色/SECURITY DEFINER/session 绕过、完整 payload 重放/冲突、CAS/审计失败零部分状态、旧行/旧签名/漂移/重跑；shared 严格 DTO；Backend Worker/RPC/批次好坏隔离/无内部泄露；Frontend 真实可信 choice 可达及原文失败路径；重跑 Admin preview/publish/rollback/request/CAS/StrictMode。执行本任务要求的全部合并态命令、PG17 local-only harness、bundle/compiler 隔离、定向格式/JSON/path/卫生检查。
