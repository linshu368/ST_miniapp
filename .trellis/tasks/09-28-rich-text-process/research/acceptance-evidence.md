# TEST／PR 真机验收证据

日期：2026-09-29。范围：PR-364 与 TEST 数据库；不含 Production。本文件只记录配置和验证摘要，不保存模型业务正文、用户身份或凭据。

## 环境与只读核对

- Supabase 当前分支清单确认 `testdb` 为持久 TEST 分支，project ref 为 `zoqelpfhurwehlvypryl`。
- Railway 当前环境为 `pr-364`，后端部署 `48438fb1-deac-483f-b73c-2cccbff36e43` 状态 SUCCESS。
- TEST 正式配置 `miniapp_text_postprocess_config` 的列版本、值内版本及快照版本均为 2，source 一致，快照包含 compiled artifact，schema/policy 均为 1。
- v1 于北京时间 17:06:18 发布；选项按 `[choice]` 至行尾捕获，因此成对输出中的结束标记会进入按钮正文。20:10 截图中的高亮、状态结构和选项效果与该配置吻合；截图本身未直接提供消息绑定版本字段。
- v2 于北京时间 20:17:31 发布；选项规则改为成对标记匹配，模板仍为 `<button>$1</button>`。高亮、选项、状态、对白四条规则均启用。

## PR 后端实证

以下为本会话读取的 Railway 日志，时间已换算为北京时间：

- 19:55:07：版本批次读取 requested=1、found=1、unavailable=0。
- 20:17:28–20:17:31：草稿保存完成，发布得到 version=2；随后正式状态读取 runtimeVersion=2、history=2、hasDraft=false。
- 20:17:56：版本批次读取 requested=2、found=2、unavailable=0。

## 用户真机确认

用户在本会话明确确认以下 PR 环境真机场景通过：

- Admin 发布规则后，MiniApp 实际回复应用规则渲染。
- 选项点击正确发送一次。
- 状态折叠正常。
- 双击不重复发送。
- 发布后新回复使用新版本。

由既有实现／离线验证及上述实际集成结果，T2/T3/T5/T6 的环境待办关闭，状态更新为 Done。

## 验收范围与剩余记录

- 用户决定 T7 不再补做离线验收；既有测试和构建证据沿用对应历史文件，本次只做状态记录及文档检查。
- 未在本会话确认的环境场景包括流式按钮禁用、网络失败／结果未知、余额不足、旧历史重载、回滚、viewer／跨环境拒绝、CAS 并发冲突及资源预算。既有离线覆盖不自动等于这些场景的真机通过。
- 本次未重新采集全部 migration ledger、ACL/RLS 或每文件 postflight；当前只读结果证明实际发布和版本读取可用，不替代完整部署审计。

## T6R Admin Demo 复现增量（2026-09-29，本地）

- 实施范围仅为 `packages/admin/src/components/TextPostprocessView.tsx` 和 `packages/admin/src/styles.css`。未改 Backend、Frontend、shared、reply-renderer、migration、package/lock；未调用真实保存、发布、回滚、数据库或运行配置写入。
- 已实现并静态/构建验证：页内浅灰背景、白色连体三栏、紫色主操作与选中态；规则搜索/状态筛选/顺序号/说明/启停与同一 Worker 预览结果的匹配数；编辑图标工具栏、名称/启用、三页签、`g/i/m/s/u` 勾选和稳定 ID 次级编辑；当前规则首处匹配/捕获组；五类模板（对白、高亮、状态、选项、自定义）弹窗且新建/复制默认停用；原文、样例、字符数、自适应/375px、主题/用户名/流式模拟、主要效果区与紧凑状态；真实草稿保存/发布/请求恢复入口、复用分页/回滚的历史 Drawer 和独立 System Instructions 入口。
- 自动验证：Admin typecheck 通过；Admin Vitest 12 文件/87 测试通过；Admin production build 通过（仅有 Vite 大 chunk 警告）；`pnpm lint:imports`、定向 Prettier 与 `git diff --check` 通过。
- 已验证边界：快捷键与顶部保存复用既有 mutation gate；发布仍在本地未保存时禁用；预览继续使用现有 Worker/ReplyRenderer，选项仅本地模拟，不调用模型或业务写接口。现有 store/session、环境隔离、viewer 只读、CAS/未知请求查询与错误保留逻辑未替换。
- 未验：本地 Vite 页面只确认可达登录页，未输入凭据或绕过登录，故未完成登录后 DOM、键盘焦点、实际 1440/900/375/320 布局与 viewer/环境切换的人机检查；真实保存、发布、回滚、历史分页、CAS/超时/结果未知的远端行为仍未授权。Demo 本地 URL 的浏览器安全策略拒绝仍未绕过，只有源码对照，不能声称像素级视觉验收通过。T6R 保持 Doing，待合法受控 Admin 会话或用户提供的截图/验收环境后完成这些项。

## T6R Vercel Preview 增量验收（2026-09-29，TEST）

- 已在 PR #364 的已登录 Admin Preview 核验：正式版本 v2、四条规则的顺序/启停/匹配数、解析 flags（含 u）、首处匹配和捕获组、五类模板 Modal、Escape 关闭与焦点返回、新版历史 Drawer、375px 预览模式及本地流式工具均可见。期间未执行保存、发布、回滚或任何业务写入。
- 发现并修复：开始本地流式后立即重置会保留流式原文，不会再次应用同一 compiled artifact。根因是逐字模拟让每个片段都抢占共享 Worker 的同一消息任务，完整正文可能超出预算。Admin 现仅在流式中展示原文片段；达到完整终态或重置后才调用既有 `ReplyRenderer`/Worker，不改 renderer、协议或配置状态。
- 已核验 Preview 已切换至含 `b0f558df` 的新资源版本：完整示例初始高亮/状态效果正确；本地流式完成后效果正确；点击“重置”后仍保留高亮/状态效果。期间一次规则读取短暂失败，使用页面既有“请求恢复”后读取成功；未执行保存、发布、回滚或环境切换。此项通过只证明受控 TEST Preview 的读与本地模拟，不证明远端写入、权限或 Production 行为。
- 尚未完成合法 Demo 渲染画面的像素级对照；未以实际 1440×900、375×844、320px 视口逐一验收；未覆盖 viewer、环境切换、未保存/已保存草稿、历史分页/回滚、CAS/超时/未知结果等需避免真实写入或需额外身份的场景。T6R 保持 Doing，T8 不推进。
- T7 记为主链路真机验收通过、覆盖记录待最终收口；Production 迁移与发布为独立门禁，T8 文档交付待完成。

## MiniApp 流式稳定与终态选项回归（2026-09-30，本地）

- 用户在 TEST 真机发现：带后处理版本的回复流式期间已出现正文持续抖动，终态选项未能点击发送。截图证明高亮和状态交互已应用，但截图本身不提供消息 `status`、`finish_reason` 或 DOM `disabled` 属性，因此不把图片推断成服务端终态事实。
- 代码复现确认流式 delta 会持续改变 `ReplyRenderer` 签名，使渲染在 pending/applied 间替换并重复调度 Worker。修复后流式阶段使用既有 `ChatMarkdown`，服务端终态才首次挂载 `ReplyRenderer`；不改规则、artifact、发送 API 或选项同步锁。
- TEST Admin 只读核对：正式富文本 v4 的选项规则为成对 `\[choice\]([\s\S]+?)\[/choice\]` 和 `<button>$1</button>`；System Instructions v3 要求两个成对选项。未执行保存、发布、回滚或模型请求。
- 回归测试从红到绿：流式阶段没有 `ReplyRenderer`/choice button；同一气泡切换到终态后可信按钮启用，双击只接受一次。Frontend 36 文件/237 测试、typecheck、lint、production build、全仓 typecheck、imports lint、Prettier 和 `git diff --check` 均通过。真实 TEST 部署与 Telegram WebView 复验仍待提交、推送和部署后执行；Production 未触及。

## T6R / T7 最终真机收口（2026-09-30）

- 用户确认 T6R Admin Demo 复现任务已通过真机验收，T6R-A/B/C 收口为 Done。
- 用户随后确认 T7「集成与交付验证」可标记为 Done。此前已记录的主链路、流式稳定、终态 choice 与双击防重复证据继续有效，不重复补做用户已豁免的旧离线验收。
- Done 仅代表本任务经用户确认的 TEST/PR 真机验收范围完成；未逐项确认的 viewer/环境隔离、历史分页/回滚、CAS/超时/未知结果、完整权限审计和 Production migration/发布不得由此推定为通过。
