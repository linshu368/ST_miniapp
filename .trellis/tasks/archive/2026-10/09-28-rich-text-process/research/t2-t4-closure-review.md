# T2/T4 收口审阅

日期：2026-09-28。分支 `dev_rich_text_process`。这是对当前工作区 T1 消费边界、T2 离线 migration 与 T4 renderer 的独立代码审阅，不是新功能实现，也不是 TEST/Production 证据。

## Findings 与修复

### P1 — 已绑定消息版本可被直接清空

`20260928_chat_history_postprocess_version.sql` 的 trigger 原先允许任意 `NEW.postprocess_version IS NULL`。因此有 `chat_history UPDATE` 权限的 `service_role` 可以把非空绑定清空，绕过专用开轮 wrapper。修复后只有旧 RPC 的 INSERT NULL 被允许；UPDATE 不变值允许，修改或清空都需要 wrapper guard。SQL 场景新增清空拒绝与原值保留断言。

### P2 — details 状态跨消息污染

renderer 的 details 状态 key 原先未包含 `messageKey`。复用同一组件实例切换消息时，相同 rule/source range/path 会继承上一条消息的展开状态。修复后组件 key 和 `openStore` key 都包含 `messageKey`；回归覆盖同消息 content 更新保留、换消息重置。

未发现 P0，也未发现需要改变 T1 公开契约、已批准 PRD/design 或数据库总体方案的问题。修复后未发现阻塞 T3 编码的问题。

## 审阅结论

- T1：根出口只暴露 runtime validator/apply/slot/CSS serializer，不导出 compiler；reply-renderer 的主依赖图不含 parse5/css-tree。未修改 T1 shared 源码。
- T2：不可变快照、当前发布值、专用发布四写、CAS/request_id、通用 RPC 拒绝、SECURITY DEFINER search_path/grants、动态补丁 fail-closed、nullable FK/view/wrapper 和顺序恢复均有离线实现与场景覆盖。PostgreSQL 属主/超级用户仍可主动禁用 trigger，这是数据库最高权限固有边界，TEST preflight 必须核对 owner/grants，不能声称 trigger 能对抗恶意超级用户。
- T4：Markdown 单次解析、DOMPurify 强制净化、可信树/capture 文本、choice payload、CSS scope、Worker terminate/generation/jobId、SSR 降级和 consumer build 均通过代码与测试核对。模型 HTML 不获得 class/data/action/URL/事件/SVG/style/外部资源能力。
- lockfile：由仓库声明的 pnpm 9.15.9 读取，新增 importer、parse5/css-tree、renderer DOM 测试依赖及相应 jsdom/esbuild/Vite peer snapshots 可解释；未发现依赖降级或手工编辑证据。

## 本轮验证

- `pnpm --filter @miniapp/shared test`：12 files / 114 tests passed。
- `pnpm --filter @miniapp/shared typecheck`：通过。
- `pnpm --filter @miniapp/reply-renderer test`：1 file / 17 tests passed。
- `pnpm --filter @miniapp/reply-renderer typecheck`：通过。
- `pnpm -r typecheck`：6/7 workspace projects 通过。
- `pnpm lint:imports`、`pnpm lint:migrations`、`pnpm test:migration-ledger`：通过。
- `pnpm --filter @miniapp/frontend build`：通过。
- `pnpm --filter @miniapp/admin build`：通过，保留既有大 chunk warning。
- PostgreSQL 17.11 隔离临时集群：T2 migration 重入、场景与锁竞争通过，输出 `text_postprocess_t2 ok`；临时集群已停止并清理。

## 状态与剩余门禁

- T2：Doing（Implementation complete / environment pending）。未连接 TEST/Production，未执行 migration；仍需 TEST 只读结构采集、逐文件 preflight/apply/postflight，Production 另行审批。
- T4：Done。
- T3：可以开始编码；数据库联调继续等待 T2 TEST 门禁。
- T5/T6：不能开始；依赖 T3 + T4，目前 T3 尚未完成。
