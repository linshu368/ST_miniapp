# T6 Admin 富文本规则工作台证据

日期：2026-09-29。分支 `dev_rich_text_process`。本窗口只改 `packages/admin/src/**` 和本文件。没有 commit、push，没有连接或修改 TEST、Production、Supabase、部署、环境变量或 feature flag。没有改 shared、Backend、renderer、Frontend、migration、package、lockfile 或中央 Trellis manifest。

`packages/admin/package.json` 里已有的 `@miniapp/reply-renderer` 依赖来自更早的 T4，本窗口没有再改 package 或 lockfile。

## 建议状态

`Doing（Implementation and offline verification complete / environment integration pending）`

离线实现和本窗口验证已完成。不要在本文件之外把 T6 标成 Done。TEST/Production 上的 migration 和 Backend 联调仍未做。

## 实际实现

- `packages/admin/src/lib/textPostprocessApi.ts`：专用 HTTP 客户端。复用 `getAdminApiUrl` 和 Supabase session Bearer token，请求/响应用 shared Zod schema 校验。
- `packages/admin/src/lib/textPostprocessWorkbench.ts`：draft / published / local、CAS、request id、历史游标、权限和环境确认的纯状态机。
- `packages/admin/src/lib/textPostprocessSamples.ts`：四类起始模板和示例文本。字段与 `TextPostprocessRule` 一致，没有新的持久化字段。
- `packages/admin/src/lib/textPostprocessPreview.ts`：主线程 Worker 调度。超时后 `terminate()`，不回主线程执行正则。
- `packages/admin/src/lib/textPostprocessPreview.worker.ts`：在 Worker 里编译 source 并应用样例。
- `packages/admin/src/components/TextPostprocessView.tsx`：三栏工作台、窄屏单列、历史和回滚。
- `packages/admin/src/App.tsx`、`lib/adminNavigation.ts`、`styles.css`：现有导航上的最小接线。运营配置下增加「回复富文本规则」，并提供打开现有 System Instructions（`system_instructions`）的入口。
- 回归测试：`textPostprocessApi.test.ts`、`textPostprocessWorkbench.test.ts`、`textPostprocessPreview.test.ts`，以及导航测试中的新菜单项。

## API 与权限边界

Admin 只调用 T3 已有路由：

- `GET /api/admin/text-postprocess?limit=20&before_version=`
- `GET /api/admin/text-postprocess/requests/:requestId`
- `POST /api/admin/text-postprocess/draft`
- `POST /api/admin/text-postprocess/publish`
- `POST /api/admin/text-postprocess/rollback`
- `POST /api/admin/text-postprocess/discard`

没有使用 generic Supabase proxy，也没有走通用 `runtime_config` publish/rollback。组件内没有 `fetch`。token 只放在 `Authorization` 头，不写入日志、URL 或错误文案。

读超时 5 秒，失败按传输错误处理。写超时、网络中断、5xx 无法分类的响应，以及 shared/T3 的 `RESULT_UNKNOWN`，都进入结果未知。`VALIDATION_UNAVAILABLE` 单独成类，不放进字段诊断。`compile_rejected` 等 mutation code 保留字段诊断。

viewer，或 owner/operator 缺少当前环境的 `can_access_test` / `can_access_prod`，UI 为只读。这只是和 Backend 权限表现对齐，不是安全边界。test 与 production 各有一份 session，查询和 mutation 不共用。

## draft / published / local

- 正式值：`server.published`，且 `published.version` 必须等于 `server.runtime_version`。否则显示「当前正式配置不可用」，不用历史最大版本号顶上。
- 已保存草稿：`server.draft` 的 revision、updated_at、content_digest 和 source。
- 本地编辑：`session.local`。dirty 比较的是本地 source 与已保存草稿；没有草稿时才和正式 source 比较。编号输入在提交前留在 `idDraft`，不写进错误编号。
- 发布请求只带已保存的 `draft_revision`、digest、updated_at 和 runtime version，不带本地 source。本地 dirty 时发布按钮和 `planPublish` 都拒绝。
- 保存、放弃、发布、回滚成功后重新 `GET` 权威状态。mutation outcome 只用于提示，不拿来猜测当前版本。

## CAS、request_id 和未知结果

- 保存携带 `expected_runtime_version`、`expected_draft_updated_at`、`expected_draft_digest`。
- 发布再携带已保存的 `draft_revision`。
- 回滚携带 `expected_runtime_version` 和用户点选的 `target_version`。
- 每个逻辑操作在首次发送时生成一个 `request_id`。结果未知时，同一 action 和同一 payload 复用这个 id；payload 变了就阻止新 id。
- `cas_conflict` 清掉这次 mutation，保留本地 source，并显示本地规则编号和服务端规则编号的差异。
- `RESULT_UNKNOWN` 停在查询状态。界面提供「查询此请求」和「用同一请求重试」，不提示立即换号重发。
- `VALIDATION_UNAVAILABLE` 用独立警告。T3 在发布 RPC 之前编译，所以这次失败可以视为没有写入；界面不把它显示成字段错误。

## Worker 与 preview

shared 根出口故意不导出 `compileTextPostprocessSource`，避免 MiniApp 主包带上 parse5/css-tree。Backend 校验 Worker 已经按文件加载 `packages/shared/src/text-postprocess/compile.ts`。Admin preview Worker 使用同一源码子路径，没有复制编译器，也没有改 package exports。

Admin 的 `tsc` 不会自动带上 shared 里的 `css-tree-entries.d.ts`。Worker 文件用 triple-slash 引用这份已有声明，否则深路径导入会在 admin typecheck 里把 css-tree 子路径看成隐式 any。这不是新的依赖。

主线程调度只负责计时和 `terminate()`。超时、Worker 不可用或崩溃时清空 artifact，显示诊断，样例原文保留。`ReplyRenderer` 在没有 artifact 时走原始 Markdown，不会在主线程跑规则。

生产构建里：

- 主包只引用 `textPostprocessPreview.worker` 和 `postprocess.worker` 文件名。
- `scriptingEnabled` / `sourceCodeLocationInfo` 只出现在 `textPostprocessPreview.worker-*.js`（334.93 kB）。
- reply-renderer 的 `postprocess.worker-*.js` 为 88.99 kB，不含这些编译器标记。

预览使用 `@miniapp/reply-renderer` 的 `ReplyRenderer`。选项回调只走 `applyLocalChoice`，不发请求。模拟流式是本地切片，有开始、暂停/继续和重置。工作台文案标明这是本地模拟。

规则列表的 React key 是 rule id。移动和筛选不改变 `selectedRuleId`。

## 回滚语义

回滚必须点某一条历史版本。成功文案是「已创建新发布版本 N，来源是版本 T。旧快照没有被修改。」历史分页使用 Backend 的 `limit=20` 和 `before_version`（当前已加载版本的最小值，向更早翻页），`has_more` 决定是否继续。当前正式版本只来自 `runtime_version` 与 `published.version` 的对照。

## 测试和验证

| 命令                                                                                                          | 结果                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @miniapp/admin test`                                                                           | 通过。12 个文件，84 项。                                                                                                |
| `pnpm --filter @miniapp/admin typecheck`                                                                      | 通过。                                                                                                                  |
| `pnpm --filter @miniapp/admin lint`                                                                           | 不适用。`packages/admin/package.json` 没有 lint script。pnpm 输出 `None of the selected packages has a "lint" script`。 |
| `pnpm --filter @miniapp/admin build`                                                                          | 通过。Vite 8.1.0。见上面的 Worker 分包。                                                                                |
| `pnpm --filter @miniapp/shared test`                                                                          | 通过。12 个文件，114 项。                                                                                               |
| `pnpm --filter @miniapp/shared typecheck`                                                                     | 通过。                                                                                                                  |
| `pnpm --filter @miniapp/reply-renderer test`                                                                  | 通过。17 项。                                                                                                           |
| `pnpm --filter @miniapp/reply-renderer typecheck`                                                             | 通过。                                                                                                                  |
| `pnpm lint:imports`                                                                                           | 通过。                                                                                                                  |
| T6 文件定向 Prettier                                                                                          | 已运行。                                                                                                                |
| `git diff --check -- packages/admin/src .trellis/tasks/09-28-rich-text-process/research/t6-admin-evidence.md` | 通过。                                                                                                                  |

没有跑全仓 `pnpm -r typecheck`。其他窗口可能还在写 Frontend/Backend。留给收口窗口。

回归覆盖了：API schema 和 Bearer/环境 URL、环境之间的迟到响应、viewer 只读、三态 dirty、排序后仍按 rule id 编辑、发布只用已保存 revision、CAS 保留本地、同一逻辑操作复用 request id、`RESULT_UNKNOWN`、`VALIDATION_UNAVAILABLE` 独立分类、回滚文案是新版本、Worker 超时不执行主线程正则、预览源码引用 `ReplyRenderer` 且没有新的 `dangerouslySetInnerHTML` 或 `fetch`、本地 choice 不增加网络计数、production 确认文案。

## 未完成的环境门禁

T2 migration 还没在 TEST/Production 执行。T3 数据库联调还在等这道门禁。因此本窗口没有：

- 登录 Admin 后对真实 draft/publish/rollback 做联调
- 验证 test/production 两套数据确实落在不同库
- 验证 request id 在真实 RPC 上的重放
- 用浏览器点选窄屏、主题和模拟流式

可重复的人工场景，等 TEST 门禁打开后再做：viewer 只读；operator 保存草稿后正式版本不变；未保存时发布被拒绝；制造 CAS 冲突后本地文本还在；发布途中断网后只查询原 request id；回滚后出现更大的新版本且旧版本仍在历史中；390px 宽度下三栏变单列；预览选项只显示「模拟发送」且网络面板没有聊天请求。

构建产物在 gitignore 的 `dist/`，没有提交。没有新增 node_modules、coverage、日志或 probe。

## 剩余限制

没有 Backend 和 migration 的目标环境时，工作台只能完成本地状态、契约校验和预览编译。正式发布、回滚和 request 查询要等 T2 TEST migration 与 T3 数据库联调之后才能验收。
