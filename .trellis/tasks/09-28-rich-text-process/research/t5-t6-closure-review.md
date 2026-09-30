# T5/T6 合并态收口审阅

日期：2026-09-29。分支 `dev_rich_text_process`。本窗口独占工作区。

没有 commit、push。没有连接或修改 TEST、Production、Supabase、部署、环境变量或 feature flag。没有 reset / stash / clean / checkout / 切分支 / 新建 worktree。`git status --short --branch` 的路径集合与开窗基线逐行一致。

本窗口只写了三个文件：

- `packages/admin/src/components/TextPostprocessView.tsx`（P2 修复）
- `packages/admin/src/lib/textPostprocessPreview.test.ts`（对应回归测试）
- 本文件

`package.json`、`pnpm-lock.yaml`、`.eslintrc.json`、migration、shared、Backend、Frontend、reply-renderer 均未改动。Prisma Client 生成物没有进入工作区 diff。

## 结论

**artifact 契约缺口没有修复，本窗口按任务边界停在报告点。** 原因不是 API schema 丢字段，而是已批准的 T2 数据库方案根本没有持久化 compiled artifact。补上它必须改 T2 总体方案，这在任务约束里属于「必须停止并报告」。

因此 T5/T6 状态不前进，也不在本窗口把中央 Trellis（`task.md` / `task.json` / `implement.jsonl` / `check.jsonl`）改写成收口完成态。等用户裁决 artifact 路线后一并更新。

## 一、artifact 契约根因

逐层核对实际代码，不复述 T5/T6 总结。

### 1. T2 发布快照实际持久化了什么

`packages/shared/migrations/20260928_text_postprocess_versions.sql:133`：

```
CREATE TABLE IF NOT EXISTS app_core.text_postprocess_versions (
  version integer PRIMARY KEY,
  source jsonb NOT NULL,
  schema_version integer NOT NULL,
  policy_version integer NOT NULL,
  published_at timestamptz NOT NULL,
  ...
);
```

只有 source、schema_version、policy_version、published_at。**没有 compiled artifact，也没有 source/artifact digest。**

`admin.text_postprocess_commit_release`（同文件 `:637`，`v_value` 构造在 `:664`）写入 `app_core.runtime_config.miniapp_text_postprocess_config` 的值是 `{version, schema_version, policy_version, source, published_at}`，同样没有 artifact。

全仓 `rg -i 'artifact|compiled' packages/shared/migrations/*.sql` 在两个新 migration 里零命中。

### 2. T3 repository 是「读到了但 schema 丢弃」还是「根本没读」

**根本没读。** `packages/backend/src/features/text-postprocess/repository.ts:18`：

```
const SNAPSHOT_COLUMNS = 'version, source, schema_version, policy_version, published_at';
```

`readSnapshots`（`:51`）与 `readOneSnapshot`（`:187`）都只 select 这五列，`toSnapshot`（`:216`）用 `TextPostprocessVersionSnapshotSchema` 校验后返回。数据库里没有 artifact 列可读，API schema 也没有丢弃任何已读到的字段。

### 3. shared 契约

`packages/shared/src/api/text-postprocess.ts:575` 的 `TextPostprocessVersionSnapshotSchema` 是 `{version, schema_version, policy_version, source, published_at}`，`.strict()`。`:603` 的 `ReadTextPostprocessVersionsDataSchema` 由它组成。

`:478` 的 `CompiledTextPostprocessArtifactSchema` 是 `{schema_version, policy_version, rules}`，`.strict()`，与快照形状互不相容。

### 4. Frontend 的实际后果

`packages/frontend/src/lib/text-postprocess/reply-plan.ts:19` 把整个快照传进 `validateCompiledArtifact`：

```
export function resolveReplyArtifact(snapshot: TextPostprocessVersionSnapshot) {
  const validated = validateCompiledArtifact(snapshot);
  return validated.ok ? validated.artifact : null;
}
```

`validateCompiledArtifact`（`packages/shared/src/text-postprocess/validate-artifact.ts:19`）先比 schema/policy（都等于 1，通过），再跑 `CompiledTextPostprocessArtifactSchema.safeParse`。快照带 `version` / `source` / `published_at` 三个未知键且缺 `rules`，`.strict()` 必然失败，返回 `INVALID_ARTIFACT`。

所以 `planAssistantBody` 恒定走 `{ kind: 'original' }`。**带版本的 assistant 永远显示原文 Markdown，`ReplyRenderer` 在 MiniApp 上永远不会挂载，真实 choice 按钮永远不出现。** T5 的自述与实际代码一致。

### 5. 为什么不能在本窗口修

三条路都被封住：

| 路线                      | 结论                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------- |
| 从数据库读 artifact       | 列不存在。要新增 `artifact jsonb` 并改发布 RPC/事务 → 改 T2 已批准方案 → 必须停止报告 |
| Backend 读路径编译 source | 任务边界第 6 条明确禁止「在读路径重新编译 source」                                    |
| Frontend 编译 source      | 任务边界第 4 条与「必须停止并报告」都明确禁止                                         |

`design.md` §3 写的是「source 与 policy 必须存入快照；客户端不信任服务端 artifact，按已支持的 policy 再验证」，字面上兼容「服务端产出 artifact、客户端再校验」，但没有指定 artifact 的产出位置。这正是需要用户裁决的点，不由本窗口替设计层决定。

编译能力在服务端已经具备（`packages/backend/src/features/text-postprocess/validate-pool.ts` + `validate.worker.ts` 已在发布/回滚前用可终止 worker_threads 跑 `compile.ts`），所以两条候选路线都不缺基础设施；缺的是方案授权。

## 二、Findings

### P0

无。

### P1

**P1-1（未修复，需用户裁决）** artifact 契约缺口。见上一节。影响 AC2/3/4/5：MiniApp 端富文本、状态卡、choice 全部无法生效，T5 的 `ReplyRenderer` 分支和 T4 渲染器在 APP 侧是死代码。离线测试只覆盖了「降级到原文」这一半。

### P2

**P2-1（已修复）** Admin 规则预览在 React StrictMode 下永久失效。

`packages/admin/src/main.tsx:9` 使用 `React.StrictMode`。修复前 `TextPostprocessView.tsx` 的 `useRulePreview` 是：

```
const runner = useRef(createPreviewRunner());
useEffect(() => {
  const currentRunner = runner.current;
  return () => currentRunner.dispose();
}, []);
```

`createPreviewRunner` 的 `dispose()` 置 `disposed = true`，之后 `run()` 无条件 `resolve({ ignored: true })`（`textPostprocessPreview.ts:226`、`:331`）。StrictMode 开发期的「挂载 → 清理 → 再挂载」会 dispose 掉这个唯一实例，重挂载拿到的仍是同一个已释放对象。数据 effect 里 `result.ignored` 为真时不 `setState`，于是预览永久停在 `null`：运营看不到匹配数、捕获组、诊断和渲染结果。

已用真实 `createPreviewRunner` 复现（临时 probe 断言 `expected { ignored: true } to match object { ignored: false }`，probe 已删除，未留在工作区）。现有单测只直接测 runner，不经过 hook，所以测不到。

修复：ref 初值改为 `null`，卸载时 `dispose()` 后置空，任务派发时 `runner.current ??= createPreviewRunner()` 按需重建。Worker 仍只在 `run()` 内创建，超时/崩溃仍 `terminate()`，正则和编译仍只在 Worker，行为边界没有放宽。

**P2-2（未修复，`.eslintrc.json` 在禁改清单内）** Frontend 没有机制化的编译器导入守卫。

`.eslintrc.json` 给 `packages/reply-renderer/**` 加了 `parse5` / `css-tree` / `**/text-postprocess/compile*` 的 `no-restricted-imports`（`:147`–`:189`），但 `packages/frontend/**`（`:6`–`:43`）只禁跨应用包，**没有禁 `parse5`、`css-tree` 和 compile 深路径**。而 `packages/shared/package.json` 已把 `parse5@8.0.1` / `css-tree@3.2.1` 列为 `dependencies`，Frontend 依赖 shared，解析上是可达的。

当前实际状态是干净的（见第五节构建证据），但靠的是约定 + 构建产物人工检查，不是 `pnpm lint:imports`。将来任何一次误加 import 不会在 lint 阶段被拦住。建议在 frontend override 里补同一组 pattern，但这需要改 `.eslintrc.json`，超出本窗口授权。

### P3

**P3-1（未修复）** `resolveReplyArtifact` 每次渲染都重跑全量校验。`chat-message-list.tsx:132` 的 `replyPlanFor?.(message)` 在 render 内联调用 `planMessageReply`，后者对每条带版本的 assistant 跑一次 `validateCompiledArtifact`（含每条规则的 `inspectPattern` 编译正则 + `inspectTemplateTree` + `checkCssRule`）。当前因为契约缺口会在 Zod 阶段快速失败，代价不明显；**artifact 契约修好之后，这会变成每条消息、每次父组件重渲染（流式期间每帧）的重复工作**。修 artifact 时应一并按版本号 memo 化校验结果，而不是按消息。

**P3-2（未修复）** 版本快照 `source` 的下发范围偏宽。`ReadTextPostprocessVersionsDataSchema` 与 Admin 的 `TextPostprocessAdminStateSchema` 复用同一个 `TextPostprocessVersionSnapshotSchema`。Admin 确实需要 `source`（`textPostprocessWorkbench.ts:699` 的 `summarizeVersionChange` 做版本差异、`casConflictNotice` 展示规则编号），MiniApp 完全不需要。加 artifact 时应让 MiniApp 批量接口只下发 `{version, schema_version, policy_version, artifact, published_at}`，不要给两个 consumer 一个含义含混的合并 DTO。

**P3-3（未修复）** 带版本 assistant 的语音字数预估会偏差。`user-placeholder.ts` 现在对带版本的 assistant 跳过 `{{user}}` 替换以保留原文，而 `page.tsx:391` 的 `charCount={message.content.length}` 直接用原文长度，于是 `{{user}}`（8 字符）而不是实际昵称参与计价展示。展示侧偏差，未触及实际计费链路。

## 三、T5 合并态审阅结果

逐项核对，编号对应任务书第四节。

| #   | 项                                                  | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 历史 DTO 与 SSE `start.postprocess_version` 贯穿    | 通过。`generate.ts:160` 输出 `turn.postprocessVersion`（wrapper RPC 返回的行），不在流中重读 current；`applyStreamStart` 写入 `StreamingTurn`；`mergeStreamingMessages` 落到临时 assistant                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2   | delta 不覆盖版本                                    | 通过。`appendStreamText` 只 `text + text`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 3   | turn 0 / null 保持原 Markdown                       | 通过。`readPostprocessVersion` 把缺失、null、0、非正整数统一成 null；`planAssistantBody` 直接 original                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 4   | artifact 可用时使用 `ReplyRenderer`                 | **不通过（P1-1）**。当前不可能可用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 5   | loading / unavailable / 错误显示完整原文            | 通过。`VersionSnapshotState` 区分 loading/error/unavailable/ready，四者都走 `ChatMarkdown` 全文                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 6   | 无半处理 segment / slot token / 空白 / 错误版本内容 | 通过。`planAssistantBody` 额外校验 `snapshot.snapshot.version === version`，只有恒等才继续                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7   | user 消息不进后处理                                 | 通过。`chat-message-list.tsx:132` 与 bubble 的 user 分支都是纯文本                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 8   | `{{user}}` 不重复替换                               | 通过。Backend 对带版本 assistant 保留原文；降级路径由 `ChatMarkdown` 替换一次，renderer 路径由 `ReplyRenderer`/`compose` 替换一次，二者互斥                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 9   | 两条路径保持 sanitizer 边界                         | 通过。`ChatMarkdown` 仍是 Showdown + DOMPurify + `ALLOWED_ATTR: []`；没有新增 `dangerouslySetInnerHTML`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 10  | choice 资格与防重                                   | 逻辑通过、端到端未验证。`isLatestCompleteAssistant` 要求尾部同 id+revision、`turn_index > 0`、`getChatReplyPresentation === 'complete'`（streaming 返回 null 因此不可点）；`tryAdoptChoice` 同步写锁并立刻进 `consumed`；`normalizeChoiceText` trim 后非空且 ≤ `min(MAX_USER_INPUT_LENGTH, maxOptionUnits)`；提交复用 `runTurn({ mode: 'send' })`，402/余额/输入恢复未改；`settleChoiceLock` 要求 `dataUpdatedAt > baselineUpdatedAt`、非 fetching、无 streaming，尾部有后续消息则永久留在 `consumed`；换会话清锁；revision 变化是另一 key。**但按钮在真实快照下不会出现，所以这些门禁没有一条经过真实点击** |
| 11  | StrictMode / 快速 mount-unmount / 迟到结果          | 通过。`useStayOnScreen` 的 observer 在 effect 内并 `disconnect`；`ReplyRenderer` 用 `signature` + `active` 标志丢弃迟到 worker 结果；`assignVersionBatch` 只回填本批请求过的版本                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 12  | SSR 模块加载不碰 `window`/`document`/`Worker`       | 通过。`useTextPostprocessVersions` 用 `clientReady` 门控 `enabled`；`ChatMarkdown` 在 `typeof window === 'undefined'` 时返回空串；Worker 只在 `ReplyRenderer` 的 effect 内创建                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 13  | bundle 不含 compiler/parse5/css-tree                | 通过，见第五节                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 14  | First Load JS                                       | `/chat/[characterId]` 95.7 kB / First Load 360 kB，与 T5 自述一致。**本窗口不做动态加载优化**：`ReplyRenderer` 目前在 APP 侧不可能激活，先量后优会得到错误结论；artifact 打通后再评估                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 四、T6 合并态审阅结果

编号对应任务书第五节。

| #   | 项                                                    | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 只经 T3 HTTP API                                      | 通过。`TextPostprocessView.tsx` 里没有 `fetch(`、没有 `.from(`/`.rpc(`，`SupabaseClient` 只作为类型出现（`:2`、`:104`）；没有走 generic supabase proxy，也没有通用 `runtime_config` publish/rollback                                                                                                                                                                                                                                                                            |
| 2   | test/production session、base URL、缓存、迟到响应隔离 | 通过。`WorkbenchStore.sessions` 按环境分开；`shouldAcceptAsyncResult` 同时比 `environment === activeEnvironment` 和 `generation === responseGeneration`；`acceptLoadedState`/`failLoad` 再按 generation 二次拒绝；URL 来自 `getAdminApiUrl(environment)`                                                                                                                                                                                                                        |
| 3   | viewer 只读 / owner-operator 写权限                   | 通过。`textPostprocessCanMutate` 对 viewer 恒 false，owner/operator 按 `canAccessProd`/`canAccessTest` 分环境判定                                                                                                                                                                                                                                                                                                                                                               |
| 4   | published / saved draft / local dirty 三态            | 通过。`publishedAvailability` 要求 `published.version === runtime_version`，否则 unavailable；`isDirty` 有草稿时比草稿、无草稿时比正式值，草稿解析失败恒 dirty                                                                                                                                                                                                                                                                                                                  |
| 5   | publish 只发布已保存 revision                         | 通过。`planPublish` 先 `isDirty` 拒绝，再要求 `draft.source`/`draft_revision`/`updated_at`/`content_digest` 齐全，body 只带已保存的四项，不带本地 source                                                                                                                                                                                                                                                                                                                        |
| 6   | CAS 冲突保留本地编辑                                  | 通过。`finishRejected` 只清 mutation 和写 notice，不动 `local`；`casConflictNotice` 同时展示本地与服务端规则编号                                                                                                                                                                                                                                                                                                                                                                |
| 7   | `request_id` 在同一逻辑操作中稳定复用                 | 通过。`planLogicalMutation`：inflight 直接 blocked；unknown 且 action+payloadKey 相同则 `reused: true` 复用原 id；payload 变了 blocked，不发新 id                                                                                                                                                                                                                                                                                                                               |
| 8   | `RESULT_UNKNOWN` 走请求查询                           | 通过。`markMutationUnknown` 置 `phase: 'unknown'` 并提示「请查询同一请求。不要更换请求编号」；界面提供查询与同 id 重试                                                                                                                                                                                                                                                                                                                                                          |
| 9   | `VALIDATION_UNAVAILABLE` 不显示为字段错误             | 通过。`validationUnavailableNotice` 独立 warning，文案明说不是字段格式错误，不进 `apiDiagnostics`                                                                                                                                                                                                                                                                                                                                                                               |
| 10  | rollback 创建新版本                                   | 通过。`describeRollbackOutcome` 只在同时拿到 `version` 和 `target_version` 时才声明「已创建新发布版本 N，来源是版本 T。旧快照没有被修改」，否则要求以重新读取为准                                                                                                                                                                                                                                                                                                               |
| 11  | current 无效时不用历史最大版本顶替                    | 通过。`historyCurrentVersion` 只在 `publishedAvailability === 'available'` 时返回版本号，否则 null                                                                                                                                                                                                                                                                                                                                                                              |
| 12  | Preview Worker                                        | **修复后通过（P2-1）**。编译与正则只在 `textPostprocessPreview.worker.ts`；`previewSource` 不含 `compileTextPostprocessSource`/`applyTextPostprocess`（已有断言）；timeout/crash/unavailable 都 `terminate()` 并清 artifact；`jobId` + `generation` 双重防迟到；新任务先 terminate 旧 Worker；卸载 dispose 并置空 ref；预览复用 `@miniapp/reply-renderer` 的 `ReplyRenderer`（`:1118`）；choice 只走 `applyLocalChoice`，不发请求                                               |
| 13  | 深路径导入 `compile.ts`                               | 当前合规，但有脆弱点。`textPostprocessPreview.worker.ts:7` 导入 `@miniapp/shared/src/text-postprocess/compile`。`pnpm lint:imports` 通过（admin override 不禁 compile，这是有意的——Admin 就该在 Worker 里编译）；Vite 能解析，构建产物证明只进 Worker chunk。脆弱点：`packages/shared/package.json` 没有 `exports` 字段，深导入依赖 legacy 解析；将来 shared 一旦加 `exports`，Admin 和 Backend `validate.worker.ts` 会同时断。按任务边界不为此预先新增 shared 公共 API，只记录 |
| 14  | production 构建与 Worker URL                          | 通过。`new Worker(new URL('./textPostprocessPreview.worker.ts', import.meta.url), { type: 'module' })` 是 Vite 官方形式，产出独立 chunk；主包只出现 Worker 文件名                                                                                                                                                                                                                                                                                                               |
| 15  | 导航 / System Instructions / 窄屏                     | 代码层通过，视觉未验收。`adminNavigation.ts` 新增「回复富文本规则」并保留 `system_instructions` 入口，导航测试已覆盖；窄屏单列样式在 `styles.css`，无浏览器验收                                                                                                                                                                                                                                                                                                                 |

## 五、合并态验证

命令与结果（本窗口实跑）：

| 命令                                                          | 结果                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| `pnpm --filter @miniapp/shared test`                          | 通过。12 文件 / 114 项                                  |
| `pnpm --filter @miniapp/shared typecheck`                     | 通过                                                    |
| `pnpm --filter @miniapp/backend exec prisma generate`         | 通过。生成物未进工作区 diff                             |
| `pnpm --filter @miniapp/backend test`                         | 通过。562 项                                            |
| `pnpm --filter @miniapp/backend typecheck`                    | 通过                                                    |
| `pnpm --filter @miniapp/reply-renderer test`                  | 通过。17 项                                             |
| `pnpm --filter @miniapp/reply-renderer typecheck`             | 通过                                                    |
| `pnpm --filter @miniapp/frontend test`                        | 通过。35 文件 / 211 项                                  |
| `pnpm --filter @miniapp/frontend typecheck`                   | 通过                                                    |
| `pnpm --filter @miniapp/frontend lint`                        | 通过                                                    |
| `pnpm --filter @miniapp/frontend build`                       | 通过。`/chat/[characterId]` 95.7 kB / First Load 360 kB |
| `pnpm --filter @miniapp/admin test`                           | 通过。12 文件 / **86** 项（修复前 84，本窗口 +2）       |
| `pnpm --filter @miniapp/admin typecheck`                      | 通过                                                    |
| `pnpm --filter @miniapp/admin build`                          | 通过。Vite 8.1.0                                        |
| `pnpm -r typecheck`                                           | 通过（全仓）                                            |
| `pnpm lint:imports`                                           | 通过                                                    |
| `pnpm lint:migrations`                                        | 通过                                                    |
| `pnpm lint:legacy`                                            | 通过                                                    |
| `pnpm test:migration-ledger`                                  | 通过。8 条账本协议检查全绿                              |
| `packages/shared/migrations/tests/run-text-postprocess-t2.sh` | 通过。`text_postprocess_t2 ok`                          |
| 定向 Prettier（本窗口 2 个文件）                              | 通过                                                    |
| `git diff --check`                                            | 通过                                                    |

两条 PostgreSQL 检查的执行条件需要记录：机器上正在运行的是 **PostgreSQL 14.18**，而 `fixtures/text_postprocess_t2_harness.sql` 用到 view 的 `security_invoker`（需要 15+），在 14 上直接 `ERROR: unrecognized parameter "security_invoker"`。本窗口用已安装的 `postgresql@17` 二进制，在 `/tmp` 下 `initdb` 了一个**一次性集群**（端口 55432、unix socket 在 `/tmp`、`listen_addresses=''`），跑完即 `pg_ctl stop`。没有启动 brew 服务，没有改用户既有的 14 集群，没有连任何远端库。PostgreSQL 17.11 上 T2 harness 通过，与 T2 自述的环境一致。

构建产物隔离证据：

- Frontend `.next/static` + `.next/server`：`scriptingEnabled`、`sourceCodeLocationInfo`、`parseFragment`、`compileTextPostprocessSource`、`css-tree`、`csstree` 全部 0 命中。
- Admin `dist/assets`：`scriptingEnabled` / `sourceCodeLocationInfo` 只出现在 `textPostprocessPreview.worker-*.js`（334.9 kB）；主 chunk `index-*.js`（2.03 MB）和 renderer 的 `postprocess.worker-*.js`（89.0 kB）为 0。parse5/css-tree 内部标识（`lookupTypeNonSC`、`insertionMode`、`tokenizer`）同样只在预览 Worker chunk。
- 源码层：`rg` 确认只有 `admin/.../textPostprocessPreview.worker.ts` 与 `backend/.../validate.worker.ts` 引用 `compile.ts`，Frontend 零引用。

卫生检查：工作区无 node_modules / 构建产物 / 日志 / 临时 probe / 敏感文件进入 Git；`packages/admin/dist`、`packages/frontend/.next` 仍被 gitignore；`package.json` / `pnpm-lock.yaml` / `.eslintrc.json` 的现存改动全部来自 T1/T4，本窗口未触碰。

## 六、剩余环境门禁

- T2 migration 未在 TEST 执行，Production 未审批。本地临时库结论不代表 TEST/Production 实况（两者也不保证同构）。
- T3 的真实 RPC 联调、T5 的真实会话/Telegram WebView 验收、T6 的真实 draft/publish/rollback/request 查询联调全部仍被这道门禁阻塞。
- 未授权连接或修改任何远端环境。

## 七、进入 T7 的判定

**不建议开始 T7。** 任务书第十节的门禁里有两条不满足：

- artifact 契约缺口未解决。
- 真实版本快照在离线测试中**不能**进入 `ReplyRenderer`。
- 存在未修复的 P1（P1-1）。

其余门禁满足：Frontend 主依赖图干净、T6 preview/CAS/request_id/环境隔离通过、合并态测试与 typecheck 与两个 build 通过、T5 choice 门禁逻辑自洽。

如果现在开 T7，T7 会被迫重新设计版本读取契约，正是第十节要避免的情况。artifact 路线定下来并落地后再重评。

## 八、待用户裁决

需要在两条路线里选一条，再由后续窗口实施：

- **A. 快照持久化 artifact**（新增 migration，改 T2 已批准方案）：`app_core.text_postprocess_versions` 加 `artifact jsonb` + `source_digest`，Backend 在发布/回滚时把已在 `validate-pool` 编译出的 artifact 一并传进 `text_postprocess_commit_release`，读路径直接返回并在返回前用 shared schema 验证。语义最干净、读路径零编译，但要新 migration，且已发布的旧快照没有 artifact（需要明确「旧版本标 unavailable」还是补写）。
- **B. Backend 读路径编译 + 缓存**（不动数据库，但违反本次任务书第 6 条）：复用现有 `validate-pool`，按 version 缓存不可变 artifact。零 migration，但冷启动要编译，且需要用户明确解除「不在读路径重新编译 source」的约束。

两条都需要配套：shared 拆出 MiniApp 专用的 artifact 响应 DTO（P3-2）、Frontend 按版本号 memo 化校验（P3-1）、以及任务书第七节列出的 shared/Backend/Frontend 回归测试。
