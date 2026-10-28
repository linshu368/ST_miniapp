# T3 Backend 证据

日期：2026-09-28。分支 `dev_rich_text_process`。建议状态：**Implementation and offline verification complete / database integration pending**。不是 Done。没有连接 Supabase MCP、CLI 或 TEST/Production，没有执行远端 migration，没有改历史 migration，没有 commit 或 push。

RPC 签名以 `packages/shared/migrations/20260928_text_postprocess_versions.sql` 与 `20260928_chat_history_postprocess_version.sql` 为准。本地 PostgreSQL 17.11 的 T2 场景不能当成 TEST/Production 已部署。

## 复用

- 当前版本只经过 `platform/runtime-config.ts` 的 `fetchRuntimeConfigEntry` / `fetchRuntimeConfigEntryStrict`。开轮失败降级，Admin 读取失败抛出。没有第二套 `runtime_config` 查询。
- Admin session 抽到 `features/admin-access/session.ts`。原代理的 owner/operator 写权限和环境隔离保持原消息。viewer 只增加读分支。
- 开轮仍走 `ConversationHistoryRepository`。wrapper 失败时，`session_busy`、水位线参数和旧 SQLSTATE 映射没有改到应用层。
- 摘要使用 T1 的 `canonicalTextPostprocessJson`，再做 SHA-256。没有另写键序。
- 编译调用 T1 的 `compileTextPostprocessSource`，只在 worker 线程里动态加载。Backend 主线程类型图不静态导入该文件。
- 快照、草稿和专用 RPC 放在同一个 `TextPostprocessRepository`。没有新的 Supabase client。

## 公开面

MiniApp：`POST /api/v1/text-postprocess/versions`，Telegram 鉴权。一批最多 20 个去重版本，一次 `IN` 查询。返回 `found` 与 `unavailable_versions`。未知 schema/policy 算 unavailable，不用别的版本填上。

Admin，均为 `@frontend-ready: true`：

- `GET /api/admin/text-postprocess`
- `GET /api/admin/text-postprocess/requests/:requestId`
- `POST /api/admin/text-postprocess/draft`
- `POST /api/admin/text-postprocess/publish`
- `POST /api/admin/text-postprocess/rollback`
- `POST /api/admin/text-postprocess/discard`

viewer 可读，owner/operator 可写。权限按当前部署的 test/production 隔离。写操作进入 RPC 前完成 source schema；发布和回滚还要在 worker 里完成 HTML/CSS/正则和 compiled artifact 校验。

T1 已有请求和错误码。本轮只追加与 T2 outcome 对齐的响应 schema：`TextPostprocessMutationOutcomeSchema`、`TextPostprocessAdminStateSchema`、`TextPostprocessRequestLookupSchema`。没有改 source、编译或已有错误码枚举。

`RESULT_UNKNOWN` 与 `VALIDATION_UNAVAILABLE` 使用现有 envelope，不在 `TEXT_POSTPROCESS_MUTATION_ERROR_CODES` 里。原因是未知提交和 worker 不可用不是 source 诊断，扩大 T1 枚举会越过本项停止条件。

## 版本绑定

新发送和重生成在开轮前读一次当前版本，并把该数字显式传给：

- `experience.start_chat_history_turn_with_postprocess`
- `experience.start_chat_history_regeneration_with_postprocess`

`p_postprocess_version` 始终出现。NULL 表示不绑定。SSE `start.postprocess_version` 用 wrapper 返回值，不在 delta 期间重读 current。历史 assistant 消息保留该列；开场白 turn 0 固定为 null。带版本的 assistant 原文不做服务端 `{{user}}` 替换。prompt、计费、语音和图片仍使用 `user_input` / `assistant_reply`。

配置缺失、非法、超时、未知 schema/policy，或配置列与值内版本不一致时，开轮绑定 null。不用最大版本代替。配置指向未发布版本时，同一 wrapper 再用 NULL 开一次；第一次检查发生在旧开轮函数之前，不会留下半行。wrapper 函数不存在且本次版本为 null 时，回退旧 RPC，避免迁移前挡住普通生成。版本非 null 而 wrapper 不存在时，开轮失败，不把绑定悄悄丢掉。

## 写路径

保存草稿只做结构校验，不跑运营正则，不写快照或当前配置。发布和回滚先按 `request_id` 查询；已有结果再调用写 RPC 判断摘要，不重新编译。没有记录时才编译，并且只提交一次。

发布比较 draft revision、content digest 和毫秒级 `updated_at`。编译期间草稿变化由 RPC 的 `cas_conflict` 拒绝，不自动重试。相同 request id 且摘要一致由 RPC 返回 `replayed: true`。摘要不同映射为 `request_id_conflict`。回滚读取目标快照并新建版本，不更新旧行。

传输失败或返回形状无法识别时，再调用一次 `admin.get_text_postprocess_request`。查到结果就返回；查不到返回 `RESULT_UNKNOWN`，提示用同一个 request id 重试。有五位 SQLSTATE 的失败视为事务已结束，按前缀映射，不把 SQL 正文返回给客户端。

Worker 默认 2 个、队列 64、单次编译 5 秒。超时、崩溃和队列满都失败，主线程不执行运营正则。进程关闭时 `app` 的 `onClose` terminate worker。

## 验证

离线。mock/fixture 不代表 TEST 或 Production。

- `pnpm --filter @miniapp/backend exec prisma generate`：通过。生成物在 `node_modules`，没有进入 git diff。
- `pnpm --filter @miniapp/shared test`：114 passed。
- `pnpm --filter @miniapp/shared typecheck`：通过。
- `pnpm --filter @miniapp/backend test`：562 passed。不含 integration。
- `pnpm --filter @miniapp/backend typecheck`：通过。
- `pnpm -r typecheck`：shared、backend、cs-platform、reply-renderer、admin、frontend 通过。
- `pnpm lint:imports`：通过。
- `pnpm lint:migrations`：通过。
- `pnpm test:migration-ledger`：通过。临时库 `st_repo_migration_c_test`，不连 TEST/Production。沙箱里第一次因本地 socket 被拒绝；放开本机权限后通过。
- 定向 Prettier：通过。
- `git diff --check`：通过。

数据库实际 RPC 集成仍未做。T2 的两个 migration 还没有在 TEST 执行，因此不能把上述 mock 说成远端可用。

## 剩余门禁

- TEST 只读结构、按文件 apply/postflight、RLS/grant、锁和真实 RPC 仍属 T2。
- Backend 在那两个文件于目标库可用之前不能做远端联调。
- T5/T6 现在有 Backend producer 和 T4 renderer，可以开始离线接线；环境联调仍要等 T2 TEST 门禁。本项不把它们标成 Doing。
