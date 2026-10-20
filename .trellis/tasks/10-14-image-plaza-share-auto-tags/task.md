# Tasks

| ID  | Status  | Title                                        | Notes                                                                                             |
| --- | ------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| T1  | Done    | tagging helper（prompt → tag ids，sanitize） | `features/image-plaza/tagging.ts` 编排；`features/generation/image-plaza-tagging.ts` 执行模型调用 |
| T2  | Done    | repository：读 prompt + tags 空则更新        | 验证 attempt 所有者及 ready 状态；条件写限制作品所有者、空 tags、未删除                           |
| T3  | Done    | share 路由 2s race + 异步补标                | 客户端非空旁路；仅新分享续接同一次分类，不重复调用返利 RPC                                        |
| T4  | Done    | 单测 + typecheck                             | 后端全量 86 个测试文件、672 个用例通过；全 workspace typecheck 通过                               |
| T5  | Pending | 真实 test 环境人工验收                       | 模型兼容性、数据库条件写、Studio 标签展示与钱包/返利验收                                          |

依赖：T1 → T2/T3；T4 收尾。实现和本地自动验证完成，真实环境验收未执行。

## 实现记录（2026-10-14）

- 复用 `image_text_model_config`，只提交最多 2000 字提示词和启用标签的 id/label；不下载图片。
- 模型请求使用 10 秒超时，不自动重试；响应最多 32768 字节。
- 输出只保留本次 runtime 快照内启用的 id，去重、最多 12 个；失败降级为空标签。
- 分享额外等待最多 2 秒；慢路径先分享，再以同一 Promise 结果补写。
- 补写只更新仍为空、属于当前用户且未删除的作品；不调用分享 RPC。
- `already_shared` 保持首次分享快照，不进行后台补标。
- 新增 10 个分类 helper 用例与 8 个分享路由用例；既有图片广场上游和计费测试也随全量套件运行。
- 未改 shared 契约、前端 UI、数据库 schema 或历史 migration；未执行远程数据库操作、commit 或 push。

## 已执行验证

- 最终复核于 2026-10-14 完成，下列测试、类型检查和静态检查再次执行通过。
- `pnpm --filter @miniapp/shared test`：16 文件 / 141 用例通过。
- `pnpm --filter @miniapp/backend test`：86 文件 / 672 用例通过（脚本排除 integration tests）。
- `pnpm -r typecheck`：通过。
- `pnpm run lint:legacy`：通过。
- `pnpm run lint:migrations`：通过。
- `git diff --check`：通过。
- 改动代码的 Prettier 检查：初次格式问题已修正；最终检查全部通过。
- Studio 接入核对：现有分享请求传入 `tags: []`，直接触发自动打标，无需改前端 UI 或 shared 契约。

Backend 没有独立 build/lint 脚本，本次仅改 Backend，不改变部署配置或跨包契约；使用 typecheck、全量单测和仓库静态检查验证。真实模型和数据库行为未由 mock 测试证明。

## 可重复人工验收（待执行）

先确认 Backend 连接的是 test 环境，不能将结果当作 production 实况。

1. Studio 生成并以 `tags=[]` 分享：模型在 2 秒内返回时，响应和作品详情含合法启用 id。
2. 将模型响应人为延迟超过 2 秒：分享先成功，随后详情出现补标；钱包和返利只变化一次。
3. 传合法非空 tags：作品标签与请求一致，日志中没有模型分类事件；非法/禁用 id 返回 400。
4. 模型未配置、HTTP 错误、非 JSON 或超时：分享成功，标签允许为空，错误日志不含提示词、密钥和上游正文。
5. 重复分享同 artifact：`already_shared`、首次 tip 和返利语义不变，首次标签不被覆盖。
6. 后台结果返回前将作品标签置为非空或软删除：条件写应 no-op，不覆盖已有值。
7. Admin 发布新的启用标签目录后，新分享使用新目录；检查广场筛选与详情展示。
8. 重启 Backend 中断慢路径：作品可保留空标签，不影响分享和返利；不要求任务恢复。

## 剩余风险与恢复

- 后台分类是进程内 best-effort，不持久化；重启、更新失败或模型失败时允许保留空标签，不自动补偿。
- 同时分享会各自分类；返利/分享幂等仍由既有 RPC 保证，条件写防止覆盖非空标签。
- 标签合法性以本次分享读取的 runtime 快照为准，不保证异步返回前 Admin 新发布配置的实时一致性。
- 回滚 Backend 自动打标分支即可恢复空标签分享；已补写标签保留，不需要 migration。
