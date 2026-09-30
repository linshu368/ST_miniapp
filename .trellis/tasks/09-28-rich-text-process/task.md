# 可执行任务拆分

## 状态与总门禁

Todo 未开始；Doing 实施中；Done 已验证；Blocked 需外部输入。任务已在用户审核并批准规划后进入 in_progress；T0–T6 已完成，T2/T3/T5/T6 的 TEST／PR 环境集成待办已关闭。2026-09-29 追加 T6R：按用户要求复现 Admin Demo，状态 Todo，本轮仅补规划、尚未实施。T7 真机主链路验收通过，按实际覆盖范围收口，不再补做旧离线验收；新增 Admin 界面仍须完成 T6R 增量验证；T8 待推进。证据见 `research/acceptance-evidence.md`；Production 发布与迁移仍为独立门禁。基线分支 dev_rich_text_process / PR base dev。T0–T8 及 T6R 同属一个完整任务，不使用父子关系冒充依赖。

## T0 — 安全与共用渲染技术验证

- 状态：Done（2026-09-28）；依赖：规划审阅并批准实施。结论见 `research/t0-technical-validation.md`；物理 Telegram 设备验收保留为 T7 发布门禁，不阻塞 T1。
- 范围：research/ 证据、shared 纯编译原型、reply-renderer 最小验证及必要测试；不执行远端环境写。
- 确认 HTML/CSS AST 解析依赖/锁版本，两个消费者 Next/Vite 与 Node worker_threads 可打包；验证可信槽位、Markdown、CSS 隔离、捕获组文本、任务中止、节点膨胀和预算。
- 验证：恶意 fixture、真实 timeout、窄屏和 worker 构建结果；阻塞自由度或视觉兼容则回到 design，未通过不得实施发布流程。
- 对应：AC2/3/5/8。

## T1 — shared 契约与纯处理

- 状态：Done（2026-09-28）；依赖：T0。开始于分支 `dev_rich_text_process`。技术选择与本轮证据见 `research/t1-shared-parser-evidence.md`。
- 范围：`packages/shared/src/api/text-postprocess.ts`、`api/conversations.ts`、`src/text-postprocess/`、`index.ts`、`package.json`、`pnpm-lock.yaml` 和 `src/__tests__/text-postprocess.test.ts`。
- 契约：source / schema_version / policy_version、规则诊断、可信树、版本批次、Admin CAS/request_id DTO。`ChatMessage` 与 `ConversationStreamStartEvent` 增加可选 `postprocess_version`，缺失按 null。
- 编译器使用 `parse5@8.0.1` 与 `css-tree@3.2.1` 的 parser/walker/generator 子路径，不从包根出口导出。运行时只做结构化再校验和纯文本槽位。
- 验证：`pnpm --filter @miniapp/shared test` 114 passed；`pnpm --filter @miniapp/shared typecheck` 通过；`pnpm -r typecheck` 通过；`pnpm lint:imports` 通过；定向 Prettier 通过；`git diff --check` 通过。
- 对应：AC1/2/3/7/8 的 shared 部分。Worker 调度、Next/Vite 打包和物理设备预算不在本项完成范围内。

## T2 — 数据版本与运营事务

- 状态：Done（2026-09-29，TEST／PR 集成完成）；依赖：T1；既有 PostgreSQL 17.11 离线证据保留，TEST 正式发布快照与运行指针一致，真实发布和对话消费成功。见 `research/acceptance-evidence.md`；不表示 Production 已迁移或验收。
- 范围：shared/migrations/YYYYMMDD\_\* 两文件、必要 fixtures/tests、迁移 README。
- 对象：app_core.text_postprocess_versions/runtime_config；admin 既有 draft/release/audit 新 key/CAS/service-only 发布；experience.chat_history 新 FK/开轮 wrapper。
- 保留其他配置 key 的旧 RPC 行为，删除不要求 artifact 的本 key 专用旧重载；不改写已发布历史 migration；核对 view 固定列、测试前置权限和现存函数签名。source/artifact/指针/release/audit/draft 发布原子，通用 RPC 不可绕过本 key。
- 验证：迁移静态/账本测试、TEST shape/RLS/grants/并发/失败/旧 RPC/锁容量，每文件 postflight；未知结果可查询。
- 对应：AC6/7/8。

## T3 — Backend 配置、发布、消息绑定

- 状态：Done（2026-09-29，TEST／PR 集成完成）；依赖：T1；PR-364 实际保存、发布、正式状态读取和版本批次读取成功，新回复消费新版本经用户真机确认。见 `research/acceptance-evidence.md`。
- 范围：routes/text-postprocess.ts、features/text-postprocess/、repository、conversations/generate.ts、history row 映射、server route 注册；窄提取现有 Admin session 授权。证据见 `research/t3-backend-evidence.md`。
- runtime-config.ts 统一读取、短超时原文降级；版本批次有界；后台隔离验证 worker + CAS 发布；SSE start 固定 wrapper 返回的版本。
- 验证：既有 shared/backend、全仓 typecheck、imports/migrations/ledger 和格式验证结果见历史执行记录；真实 TEST 发布 RPC 与版本读取联调已完成。本次状态收口不重跑离线验收。
- 对应：AC1/6/7/8 的 Backend 实现及已覆盖的 TEST 集成；未覆盖的环境失败路径由 T7 单独记录。

## T4 — 两端共用 renderer

- 状态：Done（2026-09-28）；依赖：T0/T1。收口审阅修复跨 `messageKey` 的 details 展开状态污染，renderer 17 项测试、typecheck、Frontend/Admin consumer build 与全仓 typecheck 通过。
- 范围：packages/reply-renderer/、相关 workspace/package/lock、Next 转译/导入守卫最小配置。
- 同一 React renderer、CSS 作用域、Showdown/DOMPurify 信任分层、details/可信 choice callback、worker 调度和终态收敛。
- 验证：新包必要安全/DOM/worker 测试、Next/Vite 实际 consumer build、键盘/触屏、旧任务中止/资源不加载。
- 对应：AC2/3/4/5/8。

## T5 — MiniApp 接线

- 状态：Done（2026-09-29，TEST／PR 真机集成完成）；依赖：T3/T4。用户确认实际渲染、选项正确发送一次、双击防重复、状态折叠和发布后新回复使用新版本通过。证据见 `research/acceptance-evidence.md`，既有离线证据保留。
- 范围：lib/api/text-postprocess.ts、conversation-stream.ts、merge-streaming-messages.ts、use-conversation-turn.ts、chat 页面与 bubble/list/markdown。
- 正确传版、批次加载、null 原始展示、历史稳定、流中按钮禁用、最后完整回复选项经正常 runTurn；保持输入恢复/402/余额回查。
- 验证：既有 frontend tests/lint/typecheck/build，版本切换与 reload、双击、流中发布、余额/网络故障。
- 对应：AC1/4/5/6/8。

## T6 — Admin 工作台

- 状态：Done（2026-09-29，TEST／PR 集成完成）；依赖：T3/T4。实际保存、发布 v2、正式状态回读和 MiniApp 消费已确认。证据见 `research/acceptance-evidence.md`，既有离线证据保留。
- 范围：components/TextPostprocessView/必要编辑子组件、lib/textPostprocessApi.ts、导航/App 小型接线、styles.css。
- 三栏/窄屏、正则模板样式编辑、诊断/示例/模拟流、草稿/正式值分开、保存/发布/CAS/分页历史/回滚，System Instructions 已有入口。
- 验证：admin tests/typecheck/build；viewer/跨环境/迟到响应、异常输入保留、发布对象准确、旧分页回退、模拟无模型请求。
- 对应：AC3/5/6/7/9。

## T6R — Admin 工作台复现 Demo（2026-09-29 追加）

- 状态：Doing（2026-09-29）；依赖：已完成 T6、追加规划审阅与实施授权。当前按已批准的 T6R-A/B/C 实施本地 Admin 页面与验证；不撤销 T6 已完成的运行链路事实。
- 目标：复现 Demo 的视觉与交互，仅在 Admin 外壳/身份/环境、真实草稿发布、历史恢复、共用安全 renderer、现有指令入口、协议兼容和已有模拟工具处做必要适配。以 PRD R5 补充、design 第 10 节和 implement T6R 专节为执行基准。
- T6R-A（Doing）：页头和紫色视觉、白色连体三栏、紧凑列表卡片、编辑工具栏/开关/三页签已实现并在 TEST Preview 桌面画面核验；宽屏/中屏/窄屏和短屏的实际视口逐项验收未完成。无需重建 Demo 顶栏品牌或改变 Admin 全局主题。
- T6R-B（Doing）：五类模板起点弹窗、flags 勾选兼容 u、稳定 ID 次级编辑、单一预览结果分发到匹配列表/捕获卡/效果区；原文/示例下拉/字符数/375px/自适应/底部状态；顶部保存/发布/快捷键/恢复，历史 Drawer，独立 System Instructions 入口均已实现。TEST Preview 已读验并验证流式完成/重置重新应用效果；真实写入和其余权限/错误路径不在本轮授权内。继续复用已有 helpers/state/renderer/API。
- T6R-C（Doing）：Admin typecheck/test/build、imports、定向格式与 diff 检查通过；TEST Preview 已做视觉、Modal Escape/焦点、读失败后的请求恢复和本地模拟无业务写验证。实际多视口、viewer/环境隔离、未保存/已保存/正式状态、历史分页/回滚、CAS/超时/未知结果仍待后续受控验收。真实保存/发布/回滚仅在另行授权的 Preview/TEST 中验证。
- 范围：Admin TextPostprocessView/styles 和必要 helper 小范围调整；不新增依赖/API/migration/状态真相，不改 Backend、Frontend 或共用 renderer 的安全/运行语义。默认不创建测试文件，确有逻辑变化优先扩展现有相关测试。
- 视觉证据边界：Demo 源码已阅读；本地浏览器 URL 被安全策略拒绝，未完成渲染/像素对照，不绕过。后续逐项记录复现结果、必要差异、合法参考及未验项，不能将 UI 未实施写成已通过。
- 回退：只撤回本次 Admin UI，保留真实草稿/已发布快照/原运行链路；需要扩大到协议/服务端/数据库/安全约束时返回设计审阅。
- 对应：AC5/7/9/11/12。新增 UI 验证不等于重做用户已豁免的旧 T7 离线验收；完成后追加 acceptance-evidence.md，不覆盖此前实证。

## T7 — 集成与交付验证

- 状态：Doing（真机主链路验收通过，覆盖记录待最终收口）；依赖：T2–T6。
- 范围：`research/acceptance-evidence.md`，记录安全摘要，无业务正文。
- 按用户决定不再补做离线验收，复用既有离线验证并记录 PR 环境真机结果；未覆盖项明确保留，不由主链路成功推定通过。TEST/Production 证据分开。
- 对应：AC1–AC10；任一核心失败项禁止开放。

## T8 — 规范与交付

- 状态：Todo；依赖：T7 与 T6R。
- 范围：README、ARCHITECTURE、Admin README、受影响 spec、module-updates.json、任务状态/执行记录。
- 更新六包拓扑与运行事实、运营帮助/策略边界、发布/恢复说明；模块更新采用当前 index 既有 IDs，必要新模块届时按门禁申报。
- 验证：格式、路径/context/module 校验、diff；给出最终文件清单和 commit message，等用户提交授权。
- 对应：AC10。

## 文件冲突和协作边界

inline 模式顺序实施，不默认派发子代理。shared/index.ts、conversations DTO、Admin App/导航、backend server/history mapper、package/lock 为共享接缝，由当前主会话统一修改。以后若明确授权并行工作，先划清这些文件单一归属并配置 context manifests；不得两个执行者并写。

## 执行记录

- 2026-09-30：T7A 本地实现与验证完成。新增 `20260930_bind_current_text_postprocess_on_turn_start.sql`，两个 current-postprocess RPC 在同一事务读取权威指针、校验 artifact 快照并委托旧 wrapper；Backend 发送/重生成只调用新 RPC，成功响应缺少非空版本也拒绝，移除不再作为正确性来源的预热/后台刷新/prime 状态。PostgreSQL 17 隔离 harness 覆盖 migration 重入、v2 发送/重生成自动绑定、非法协议/指针错版零半写和旧 NULL 兼容并通过；临时实例/目录已清理。Backend 72 文件/597 测试、Shared 12 文件/115 测试、全仓 typecheck、Frontend/Admin/CS build、lint/imports/legacy/migration、ledger、Trellis、格式与 diff 检查通过。未连接或写入 TEST/Production，未部署、commit 或 push；T7A 保持环境待办。
- 2026-09-30：用户确认将冷启动首轮正确性从 Backend 进程缓存提升为数据库开轮事务保证。新增 T7A 规划：以新的 experience current-postprocess RPC 读取 `runtime_config` 权威指针并校验不可变快照，再委托既有显式版本 wrapper；旧 `NULL=不绑定` 语义保留，新 Backend 不允许 migration 缺失时回退。授权仅含本地 migration/Backend/测试/文档实施与验证，不含 TEST/Production、部署、commit 或 push。

- 2026-09-30：用户确认修复首次回复因 1 秒版本读取超时而绑定 `NULL`，并明确富文本故障不得阻断聊天或向用户报错。已实现 Backend 监听前 3 秒有界预热、热路径内存读取、5 秒后台单飞刷新、最近成功版本保留、无缓存静默 Markdown 降级、发布/回滚 prime 和可取消 strict read；不新增数据库对象/API/依赖，未操作远端环境。Backend 72 文件/601 测试、定向 17 测试、Backend 与全仓 typecheck、imports、Prettier、Trellis validate、diff check 均通过；待用户确认提交/推送后再做 TEST 冷启动首条回复真机验收。

- 2026-09-30：TEST Admin 保存 System Instructions 测试协议时返回 `system_instructions must not use text_value`；页面仍为 TEST、正式版本 2、本地未保存编辑保留。用户授权直接修复、推送并继续保存。按既有 R8/AC9 在本任务内增加最小数据库 forward-fix：恢复外层 validator 的 text_value 专用分支，保留其他配置分支，不改 Admin payload、不操作 Production；完成本地验证后仍按提交前文件范围门禁和 TEST 单文件 Database Migration 流程执行。
- 2026-09-30：新增 `20260930_fix_system_instructions_text_value_validation.sql` 并完成本地验证。临时 PostgreSQL 14 中迁移连续执行两次通过，合法 text_value、四条拒绝路径、既有 VIP 分支、历史委托探针和 service_role 无直接 EXECUTE 均通过；首次沙箱实例因共享内存权限失败，不计代码失败，获准在本机临时实例重跑成功。`lint:migrations`、migration-ledger、shared 12 文件/115 测试、全仓 6 包 typecheck、imports、Trellis validate、定向 Prettier 与 diff check 全部通过。尚未提交/推送或执行 TEST migration，Admin 本地未保存编辑仍保留。

- 2026-09-29：用户明确授权按 T6R-A/B/C 实施本地代码与验证。已核对分支 `dev_rich_text_process`、受保护的既有任务文档脏改和 Trellis 绑定状态；开始在既有 Admin store、API、Worker 预览和 ReplyRenderer 边界内复现 Demo。未授权远端保存/发布/回滚、部署、数据库或运行配置写入。
- 2026-09-29：T6R-A/B 本地实现及 T6R-C 自动检查完成。只改 Admin `TextPostprocessView.tsx`/`styles.css`：Demo 风格三栏、模板 Modal、flags/稳定 ID/匹配诊断、预览工具、顶部真实操作入口和历史 Drawer 均复用既有状态机/Worker/renderer。Admin typecheck、12 文件/87 测试、build、imports、定向格式与 diff 检查通过；未登录、不触发真实 mutation，Demo URL 仍不绕过安全拒绝，因此像素对照、受保护页面键盘/响应式、viewer/环境和远端写入场景未验。详见 `research/acceptance-evidence.md`；T6R 保持 Doing，T8 未推进。
- 2026-09-29：用户完成 TEST Preview 登录后，已核验新版本界面、规则/诊断、模板 Modal 的 Escape 焦点返回、历史 Drawer、375px 控件和流式工具；未执行远端写。发现流式模拟导致共享 Worker 任务超时，改为流式中仅展示原文、在完整或重置终态才调用既有 ReplyRenderer/Worker。`b0f558df` 推送后，Preview 资源已切换且流式完成/重置均重新应用规则；一次读取失败可由既有“请求恢复”恢复。复跑 Admin typecheck、12 文件/87 测试、build、imports、格式和 diff 检查均通过。像素级 Demo 对照、真实多视口和其余受控验收仍未完成，T6R 保持 Doing，T8 未推进。
- 2026-09-30：TEST 真机发现 MiniApp 流式正文抖动且终态选项不可交互。Frontend 复现为每个 delta 都挂载 ReplyRenderer/Worker，现改为流式保持 ChatMarkdown、终态首次挂载 renderer；既有 artifact DOM 回归扩展为流式无按钮、终态按钮启用且双击只发送一次。正式 v4 规则和 System Instructions v3 已只读核对一致；未执行远端写。Frontend 237 测试、typecheck、lint、build、全仓 typecheck、imports lint、格式与 diff 检查通过；待提交、推送、部署后真机复验，Production 未触及。
- 2026-09-29：用户将 Admin 优化方向明确为“复现 Demo，只做必要适配”，授权补充本任务规划。更新 PRD/design/implement/task 的复现要求、差异理由、复用/可靠性/恢复和增量验收，追加 T6R Todo；本轮未改产品代码、未实施 UI、未提交推送或操作环境，保留已有 T6/T7 真机结论。
- 2026-09-28：分支已为 dev_rich_text_process。发现既有同名 planning 骨架并原地补全，保留 creator/assignee；本轮未执行 task.py start。
- 2026-09-28：用户决定受限 HTML + 隔离 CSS，强调运营自由和便利；本轮仅规划/研究文档，未连接数据库、运行模型、提交或部署。
- 2026-09-28：用户确认全部规划文档并批准实施；已运行 task.py start，状态切换为 in_progress。用户随后确认先完成 T0，再把 T1 交接给新窗口。
- 2026-09-28：T0 隔离验证完成；锁定 parse5 8.0.1、css-tree 3.2.1、结构化 capture/slot、Markdown 单次解析 transport、Worker terminate、allowlist 与预算。Vite/Next/Node/390×844 Chromium 通过；未进入 T1 产品实现。
- 2026-09-28：T1 开始。用户指定先做 shared 契约与纯处理；编码前在本机核对 parse5@8.0.1 / css-tree@3.2.1 的 fragment 位置、Raw 拒绝和确定性 generate。不声称 Worker、Next/Vite 首屏或物理设备预算已在本轮完成。
- 2026-09-28：T1 完成。shared 契约、AST 编译、分段 apply 和槽位 transport 已落地；114 项 shared 测试与全仓 typecheck 通过。未改 Backend/Frontend/Admin/CS 产品代码，未建 reply-renderer，未写 migration，未 commit/push，未连接数据库。规范同步留到 T8。
- 2026-09-28：T2/T4 收口审阅完成。T2 发现并修复 `service_role` 可把已绑定 `postprocess_version` 清空的 trigger 漏洞，PostgreSQL 17.11 临时库重入、事务、权限、wrapper 和并发场景通过；该结果仅为本地证据，T2 保持 Doing，仍等待 TEST 只读采集、逐文件 apply/postflight，Production 另行审批。
- 2026-09-28：T4 发现并修复 details 展开状态未纳入 `messageKey` 导致的跨消息污染；同消息更新保留、换消息重置的回归通过。Shared 114、renderer 17、全仓 typecheck、imports/migrations/ledger、Frontend/Admin build 均在收口窗口重新执行通过。T4 标 Done；T3 可开始编码，但数据库联调等待 T2 TEST 门禁；T5/T6 仍等待 T3 + T4。
- 2026-09-28：T3 离线实现完成。Backend 读取当前版本、Admin 发布/回滚、开轮 wrapper 和历史/SSE 字段已落地；shared 114、backend 562、全仓 typecheck、imports/migrations/ledger 通过。未连接 TEST/Production，未执行远端 migration。T3 保持 Doing，数据库联调等待 T2 TEST 门禁。T5/T6 仍是 Todo。

## T2/T3/T5 artifact 契约修订（2026-09-29，已获本窗口授权）

- 不变量：compiled artifact 是 app_core.text_postprocess_versions 不可变发布快照的一部分，与 source/schema/policy/version/published_at 一次写入。沿用 app_core 运行配置历史归属及永久保留生命周期；admin 专用 RPC 是唯一权威写入方，跨 schema 发布审计依赖不变。
- 复用：T1 compiler/CompiledTextPostprocessArtifactSchema/validateCompiledArtifact、T3 可终止 Worker/repository、T2 CAS/request lock/commit_release、T5 React Query 缓存/ReplyRenderer/choice gate。扩展既有边界，不改 compiler 输出语义或 renderer，不新增状态源、依赖或发布框架。
- publish：读明确已保存 draft → Worker 编译并返回 artifact → shared 再校验 → RPC 锁 runtime/draft 并比较 revision/digest/updated_at/source → 原子写 source+artifact、新版本、runtime 指针、release、audit、draft 状态。编译发生在事务前；期间草稿变化 CAS 拒绝且全部回滚。
- rollback：读明确 target 的 source → 同 Worker 重新编译并校验 → RPC 再比目标 source 与预期 current → 新版本绑定自己的 artifact。不修改目标，不复用其他版本 artifact；失败不新建版本。旧 target 没 artifact 可明确重编其自身 source 后创建新版本。
- 幂等：request_id 不变；业务 request digest 纳入 source/artifact；SQL 再对完整 RPC payload（含 actor、操作、CAS、source/artifact）计算 SHA-256 身份，避免调用方摘要漏字段。重放从已提交 outcome.version 读取原 source/artifact，不重新编译或读取 current。不同 payload 冲突；未知结果只查询原 request_id，不自动 retry mutation。
- shape：在未发布的现有 migration 加 artifact jsonb。ALTER ADD IF NOT EXISTS 支持本地早期表；NOT VALID check 允许旧 NULL 行保留但拒绝任何新 NULL/非法基本结构。不可变 UPDATE/DELETE 与 TRUNCATE 触发器无角色例外，ENABLE ALWAYS 防 session_replication_role 绕过；新 RPC 签名删除旧重载。SQL 校验基本 shape/协议及 source 规则身份，不复制 JS compiler；可信编译与安全树验证仍在 Backend，消费端独立校验。
- runtime_config 仍只放当前 source/协议/版本指针，不放 artifact。MiniApp DTO 为 version/artifact/published_at；Admin source DTO 独立。一次最多 20 去重版本、一次 IN 读；每行独立校验，缺失/非法/不支持/错版 unavailable，无 latest/max 替代、无读时编译/修复。
- Frontend：响应/缓存归一化边界校验 artifact，正文只读该版本 snapshot.artifact；renderer 仍独立防御。原文降级、用户名单次替换、用户消息不处理、choice 可信回调/同步锁/runTurn/402/刷新确认保持。P3 若不能无新状态源降低成本则记录，不扩大设计。
- 恢复：现有证据仅证明 migration 尚未远端执行，不连接远端复核。全新安装/旧本地表/旧 NULL 行/重跑/失败整事务恢复由本地 PG17 场景验证；不得伪造回填、删旧行或改 chat-history migration。已发布后 forward-fix 另行审批；应用回退保留快照及引用。
- 可靠性：现有有界 Worker 超时/队列/terminate、DB advisory lock/CAS/request_id 保持。无第三方写，无需补偿队列；不增加读取编译或自动 mutation 重试。日志只版本/计数/耗时，禁止 source/artifact 正文。
- 停止：需改变 T1 格式/安全/发布语义/归属、远端已执行证据、远端连接、T7 实施或第二 migration 来源时停止。环境门禁保持 TEST shape → 单文件 migration/postflight → T3/T5/T6 联调，Production 独立授权。
- 验证：新增 SQL source+artifact 原子性、不可变/清空/角色/SECURITY DEFINER/session 绕过、完整 payload 重放/冲突、CAS/审计失败零部分状态、旧行/旧签名/漂移/重跑；shared 严格 DTO；Backend Worker/RPC/批次好坏隔离/无内部泄露；Frontend 真实可信 choice 可达及原文失败路径；重跑 Admin preview/publish/rollback/request/CAS/StrictMode。执行本任务要求的全部合并态命令、PG17 local-only harness、bundle/compiler 隔离、定向格式/JSON/path/卫生检查。

## Artifact 收口结果（2026-09-29）

- T2/T3/T5 compiled artifact P1 阻塞已解决，证据见 `research/t2-t3-t5-artifact-evidence.md`。T3 Backend 565、T5 Frontend 216、T6 Admin 86、Shared 114、renderer 17 测试通过；全部本窗口要求的合并态命令通过。
- T2/T3/T5/T6 保持上述 Doing 环境待办状态；总任务 in_progress。T7 可以开始离线验收准备，尚未执行 T7 功能或 TEST 验收。TEST migration/联调及 Production 仍需独立授权。
- 当前已复核 package/lock/eslint 初始摘要未变、原 tracked/untracked 修改保留；未 commit/push/连接远端。其他窗口停止写入的确认尚待用户回复，本地进程清单不能证明远端窗口绝无写入。

## 发布权限 forward-fix（2026-09-29）

- TEST-DB 只读诊断：PR-364 的同一 Admin actor 能保存草稿，但发布 RPC 在 `INSERT app_core.text_postprocess_versions` 处收到 `42501 permission denied`。`20260929_fix_text_postprocess_writer_guard.sql` 已在 TEST 成功执行，问题不是 writer guard 或 Admin 角色；表 ACL 明确缺少 `postgres` 的 `INSERT`，而专用 `SECURITY DEFINER` 发布函数 owner 为 `postgres`。
- 最小 forward-fix：新增 `20260929_grant_text_postprocess_snapshot_insert.sql`，仅授予 `postgres` 此表 `INSERT`，维持 `service_role` 的 SELECT-only 和既有不可变 trigger；不改历史 migration、不变更数据、不增加公开 API/角色或表权限。
- Backend 只把自有 SQL 前缀 `forbidden:` 映射为 403。其他 `42501` 留在安全的通用失败边界，避免把数据库部署/ACL 故障误报成 Admin 身份不足。
- 离线验证：PostgreSQL 17 临时集群的完整 text-postprocess migration harness 通过（fresh/replay/CAS/发布/回滚/事务/权限/直写拒绝）；Backend 568、Shared 115 测试和 Backend typecheck 通过；migration lint、ledger protocol 和 `git diff --check` 通过。默认本机 PostgreSQL 14 因不支持已有 `security_invoker` view 不用于本项。该记录是 INSERT forward-fix 创建时的环境状态；后续 TEST 事实见下节，Production 未触及。

## PR-364 对话开轮权限 forward-fix（2026-09-29）

- TEST 实况：用户已执行 `20260929_grant_text_postprocess_snapshot_insert.sql`。但 PR-364 Railway 后端在 `POST /api/v1/conversations/:id/messages` 的开轮阶段仍持续返回 500；安全日志为 `permission denied for table text_postprocess_versions`，LLM 尚未调用。
- 根因与范围：`experience.start_chat_history_*_with_postprocess` 会以 `SECURITY DEFINER` 的 `postgres` owner 核验已发布版本。原 migration 声明的 snapshot `SELECT` ACL 在 TEST 实际状态中缺失或漂移；仅补 publisher 的 `INSERT` 不能恢复此读取路径。
- 最小 forward-fix：新增 `20260929_grant_text_postprocess_snapshot_read.sql`。它要求两个 wrapper 均仍为 `postgres` owner 的 `SECURITY DEFINER`，只授予 `postgres` 和既有 server-only `service_role` 对 `app_core.text_postprocess_versions` 的 `SELECT`，并明确拒绝 `service_role` 的四类写权限。未知 owner/非 definer 直接停止，不用 schema 级宽泛授权掩盖漂移。
- 发布与恢复：TEST 使用 Database Migration workflow 单文件执行，先查账本和 preflight；postflight 必须同时确认两角色 `SELECT`、`service_role` 无写权限，再真机发送及重生成各一次。该文件只改 ACL metadata、无业务行/表重写/回填；失败即停止并核验函数 owner/ACL，后续仅以新的 reviewed forward migration 恢复。Production 未获授权。

## TEST／PR 真机集成收口（2026-09-29）

- 本节更新当前状态；前文离线实现、权限故障与环境待办记录保留为发生时的历史事实。
- 已只读确认 TEST `testdb` 当前正式版本为 v2，运行指针与版本快照一致；PR-364 日志记录真实保存、发布、状态回读及版本批次读取成功。
- 用户确认选项正确发送一次、状态折叠、双击防重复及发布后新回复使用新版本均通过。T2/T3/T5/T6 标为 Done；详细证据和未覆盖项见 `research/acceptance-evidence.md`。
- T7 不再补做离线验收；主链路真机通过不代表所有失败路径或 Production 验收通过。总任务保持 in_progress，T8 尚未完成。
