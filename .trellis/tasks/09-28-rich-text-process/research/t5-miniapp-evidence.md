# T5 MiniApp 消费端证据

日期：2026-09-28。分支 `dev_rich_text_process`。本窗口只改 `packages/frontend/src/**` 和本文件。没有 commit、push，没有连接或修改 TEST、Production、Supabase、部署、环境变量或 feature flag。没有改 shared、Backend、renderer、Admin、migration、package、lockfile 或中央 Trellis manifest。

建议状态：**Doing（Implementation and offline verification complete / environment integration pending）**。不是 Done。这个状态只表示消费端离线接线已经做完并通过下面的检查。它不表示富文本已经能在真实快照上显示。版本接口返回的是规则 source，不是 compiled artifact。在契约补上可信树之前，带版本的 assistant 仍显示完整原文，选项不会出现。

## 实际实现

- `packages/frontend/src/lib/api/text-postprocess.ts`：`POST /api/v1/text-postprocess/versions`，走现有 `apiClient` 和 React Query。5 秒超时，读失败重试 1 次。组件不直接 `fetch`。
- `packages/frontend/src/lib/text-postprocess/versions.ts`：去重、按 20 个分批、按版本写缓存。query key 含 `API_URL` 和排序后的版本集合。已成功的 ready/unavailable 不重复请求。
- `packages/frontend/src/lib/text-postprocess/reply-plan.ts`：决定原文 Markdown 还是 `ReplyRenderer`。不编译 HTML/CSS。
- `packages/frontend/src/lib/text-postprocess/choice-gate.ts`：最新完整 assistant、turn 0、流式/忙碌/会话未就绪、同步锁、刷新后的尾部确认。
- `packages/frontend/src/lib/merge-streaming-messages.ts`：`StreamingTurn.postprocessVersion` 只从 SSE `start` 写入，delta 不改。
- `packages/frontend/src/hooks/use-conversation-turn.ts`：发送和重生成都走原来的 `runTurn`。
- `packages/frontend/src/app/chat/[characterId]/page.tsx`：批量加载、choice 提交、402/输入恢复仍由 `runTurn` 处理。
- `packages/frontend/src/components/chat/chat-message-bubble.tsx` 与 `chat-message-list.tsx`：有校验通过的 artifact 才挂 `ReplyRenderer`。用户消息仍是纯文本。

## 数据流与版本绑定

历史 assistant 的 `postprocess_version` 原样留在 `ChatMessage` 上，前端不重新映射。SSE `start.postprocess_version` 经 `readPostprocessVersion` 进入 `StreamingTurn`，再写入合并后的临时 assistant。缺字段、null、0 和非正整数都是 null。delta 只追加 `text`。开场白 turn 0 和旧消息的 null 不套当前配置，也不套最大版本或 latest。

版本集合来自当前已加载消息（含更早分页和正在流的那条）。同一版本只请求一次。一批最多 20 个。响应里的 `found` 只绑定自己的 `version`；`unavailable_versions` 和响应里没出现的编号都记为 unavailable。不会用另一个 `found` 填洞。

已发布快照按版本号单独缓存，`staleTime` 为无限。query key 带 API 根地址，避免 test/production 串缓存。读请求失败不把版本写成 unavailable，下次还能再读。服务端预渲染不发这个请求，模块加载不访问 `window`、`document` 或 `Worker`。

## loading / unavailable / null

- null 版本、用户消息：原来的展示。assistant 走 `ChatMarkdown`，用户消息走纯文本。
- 快照 loading、请求失败、unavailable、快照版本号对不上：完整原文，不闪到别的版本。
- 快照找到了，但 `validateCompiledArtifact` 不通过：同样完整原文。当前 source 快照会走这里。
- 只有本条版本的快照校验成 compiled artifact 时才把原文和这份 artifact 交给 `ReplyRenderer`。视口外先保持 Markdown，进入视口后挂上并保持挂载。
- 不在 Frontend 跑 parser/compiler，也不把模板、artifact 或模型 HTML 交给新的 `dangerouslySetInnerHTML`。生产静态包里没有 `parseFragment`、`compileTextPostprocessSource` 或 `css-tree`。

`{{user}}` 不在交给渲染器之前替换。null/降级走 `ChatMarkdown` 现有的一次替换。将来真正进入 `ReplyRenderer` 时，由它替换一次。用户消息不进后处理。

## choice 资格与防重复提交

可点条件同时成立：当前列表最后一条、assistant、`turn_index > 0`、展示为完整回复、没有本地 generating、没有 server busy、会话 query 已就绪。流式期间全部不可点。payload 只来自 `ReplyRenderer.onChoice`，trim 后非空，长度不超过 `min(8000, maxOptionUnits)`。

点击先同步写入 `messageId + revision` 锁，再调用原来的 `runTurn({ mode: 'send' })`。同一时刻第二次点击读到锁，不再提交。该回复的按钮随锁立即禁用。请求结束后进入 confirming，在会话缓存 `dataUpdatedAt` 前进且不再 fetching 之前不打开。刷新后若后面已经有消息，旧 choice 保持禁用；若尾部仍是这一条，才放开。不自动重试写请求。402、余额不足和其它 `runTurn` 失败仍走原来的充值跳转和输入恢复。换会话会清掉锁。revision 变化是另一条身份，不会继承旧锁，也不会把旧锁重新打开。

## 失败路径

- 版本批形状不合法或请求抛错：对应版本显示原文，不标记成永久 unavailable，不用 latest。
- Worker、超时、非法 artifact：不在主线程跑规则。当前 source 快照根本不启动 `ReplyRenderer`。一旦挂上，失败回退仍由 T4 渲染器显示完整原文。
- choice 在刷新确认前保持关闭。未知结果不会在 `runTurn` 返回的同一拍重新打开。

## 测试与验证

| 命令                                              | 结果                                                      |
| ------------------------------------------------- | --------------------------------------------------------- |
| `pnpm --filter @miniapp/frontend test`            | 35 files，211 passed                                      |
| `pnpm --filter @miniapp/frontend typecheck`       | 通过                                                      |
| `pnpm --filter @miniapp/frontend lint`            | 通过                                                      |
| `pnpm --filter @miniapp/frontend build`           | 通过。`/chat/[characterId]` 95.7 kB，First Load JS 360 kB |
| `pnpm --filter @miniapp/shared test`              | 114 passed                                                |
| `pnpm --filter @miniapp/shared typecheck`         | 通过                                                      |
| `pnpm --filter @miniapp/reply-renderer test`      | 17 passed                                                 |
| `pnpm --filter @miniapp/reply-renderer typecheck` | 通过                                                      |
| `pnpm lint:imports`                               | 通过                                                      |
| 定向 Prettier                                     | 通过                                                      |
| `git diff --check`（frontend src 与本文件）       | 通过                                                      |

新增回归覆盖：SSE/合并版本、缺失字段保持 null、批量去重与 21 个版本拆成 20+1、unavailable 不借用别的 found、失败批不写缓存、query key 含 API 地址、null/loading/error/unavailable 显示原文、source 快照不编译也不用 latest、用户消息不进渲染器、`{{user}}` 只交给一个替换方、流式和 turn 0 不可选、只有最后一条完整 assistant 可选、同步双击、revision 变化、新一轮后旧 choice 不恢复、刷新未完成不重开、尾部未变才重开。

没有放宽断言，没有改 T1/T3/T4。

## 未完成的环境门禁

- 没有跑全仓 `pnpm -r typecheck`。其它窗口可能还在写 Admin/Backend。留给收口窗口。
- 没有连接 TEST/Production，没有执行 migration，没有真实会话联调，没有 Telegram WebView。
- 没有浏览器点击真实 choice。当前快照契约下按钮不会出现，而且不能为了验收去连远端。

## 剩余限制

T2 的 migration 还没在 TEST/Production 执行。T3 的数据库联调还在等这道门。即使库可用，`POST /api/v1/text-postprocess/versions` 的 `found` 仍是 `TextPostprocessVersionSnapshot`（source），而 `ReplyRenderer` 只接受 compiled artifact。MiniApp 按 T0 和本项边界不重新解析运营 HTML/CSS。要让历史版本真正渲染，需要后续窗口在不把编译器打进 MiniApp 主路径的前提下，让版本读取返回可再校验的 artifact。那一步会改 shared/Backend 契约，本窗口按边界停住了。
