# T2/T3/T5 compiled artifact 离线收口证据

日期：2026-09-29；分支：dev_rich_text_process。本文覆盖当前合并态的离线实现与验证，不代表 TEST/Production 事实。当前结论取代 t5-t6-closure-review 中 artifact P1、重复校验 P3、MiniApp source 暴露 P3 的历史结论；该历史审阅保持原样。

## 授权、基线与环境边界

- 用户授权现有未发布 T2 migration 最小修订、T3 producer/read DTO、T5 artifact consumer；不改变 T1 编译输出/安全语义，不把 compiler 带入 Frontend，不改 renderer/Admin 产品实现/聊天 history migration，不进入 T7 功能。
- 编码前读取 AGENTS、README、ARCHITECTURE、workflow、任务规划及 T0–T6/两轮 closure research，按 trellis-before-dev 阅读对应 shared/backend/frontend/admin/database checklist 与跨层/复用指南。Supabase 与 Postgres best-practices 用于核对权限、短事务与本地验证，未调用远端 MCP。
- 初始 status、tracked diff/stat、tracked/untracked 清单与 package/lock/eslint SHA256 存在本机 /tmp/artifact-closure，临时证据不加入 Git。原有大量合法修改保留；本窗口只追加本任务授权文件内容。
- 尚未远端执行的依据是 t2-database-evidence、t3-backend-evidence 及 t5-t6-closure-review 的显式环境待办记录；实际 SQL 是尚未提交的现有 migration。未发现与之冲突的本地执行证据。禁止远端核验，因此不宣称实时远端 ledger 已确认。
- 已读取本机进程清单；其他窗口停止写入的异步确认尚未收到。本机进程/文件摘要不能证明所有窗口绝无写入，仍需用户保持本窗口独占工作区。

## Findings

- P0：本范围未发现。
- P1 已修复：最终权限审阅发现行级 trigger 不覆盖 TRUNCATE，补充 statement trigger 与 postgres/replica TRUNCATE CASCADE 回归。
- P1 已修复：T2 snapshots 仅 source；T3 仅下发 source；T5 把 snapshot 本身当 artifact，合法真实版本无法进入 ReplyRenderer。修复点为 migration artifact 列/专用 RPC、repository/service/worker、shared artifact DTO、reply-plan/versions 归一化。
- P3 已修复：MiniApp/Admin source snapshot 共用，造成无需消费的 source 下发；MiniApp 已独立最小 DTO。渲染期全量验证移到响应归一化，冻结响应并以 WeakMap 记派生验证结果；非归一化对象依然完整验证，安全边界不放宽。
- P2 未修复（既有）：.eslintrc.json Frontend override 没有 compiler/parse5/css-tree 导入守卫。该文件禁改，本次通过源码与实际生产 bundle 检查证明当前干净；后续误导入仍需机制化守卫。
- P3 未修复（既有）：chat page 的语音 charCount 用原文长度，昵称占位可能带来展示偏差；voice/billing 禁改，未触及。
- 本范围无剩余 P0/P1；旧 artifact 缺失版本不可用、TEST 联调待办属于明确降级/环境门禁。

## 设计修订与所有权

compiled artifact 属于 app_core.text_postprocess_versions 不可变运行历史，与唯一 version 的 source/schema/policy/published_at 原子绑定。沿用 app_core 域、admin 发布权威及永久保留生命周期；不新增数据库域、配置面、状态源或平行 migration。runtime_config 继续仅表达当前发布 source/协议/版本指针。

publish：已保存 draft → Backend 可终止 Worker 编译 → shared schema 与语义再校验 → 专用 RPC 锁定 runtime/draft，校验 revision/digest/time/source → 新 version/source/artifact、runtime 指针、config_releases、audit_logs、draft 发布状态同事务提交。编译期间修改 draft 会 CAS conflict，不能写入部分状态。

rollback：读明确 target 的 source → 同 Worker 重新编译并校验 → RPC 校验 target/source/current CAS → 新 version 绑定新 artifact。历史目标绝不修改；旧目标无 artifact 时只允许显式回滚流程重编其自身 source，不能在读取路径修复或借用 current/latest。

相同 request_id 重放先查原 outcome.version，读其已提交 source/artifact，再由原专用 RPC 判断完整请求身份，不重新编译、不借用 current。Backend canonical digest 纳入 artifact/source；SQL 额外 SHA256 完整 actor/action/CAS/source/artifact/RPC 参数，调用方即使复用摘要也不能把不同 artifact 当 replay。未知提交结果仅查询原 request_id，不用新 ID 自动重试 mutation。

## T2 migration 审阅与实际 SQL 验证

- 现有 20260928_text_postprocess_versions.sql 增加 artifact jsonb；ALTER ADD IF NOT EXISTS 支持旧本地草案。NOT VALID check 保留旧 NULL 行但拒绝新 NULL/错误基本协议结构，不伪造回填、不删旧行。
- 不可变 trigger 无角色/guard 例外，ENABLE ALWAYS 抵抗 session_replication_role；UPDATE/DELETE 包括清空与替换均拒绝；另加 BEFORE TRUNCATE 的 ENABLE ALWAYS statement trigger，拒绝 postgres/replica 批量清空。service_role/postgres DML grants 不扩大，PUBLIC/anon/authenticated 无访问；专用事务 guard、私有 commit_release 与安全 search_path 保持。
- publish/rollback 的新签名要求 source/artifact；旧无 artifact 重载与旧 commit_release 签名显式删除。source 规则身份与 artifact 基本 shape 在 SQL 校验，不复制 JS compiler。树/CSS 的完整安全验证由现有 shared validator 在 producer 与两个消费边界执行。
- runtime/release/audit/draft 任一失败整体回滚。CAS、request lookup、其他配置 key 的通用 RPC 与 history wrapper 语义不改。
- 动态函数补丁的原锚点必须唯一；已打补丁正文也必须完整且唯一匹配，漂移即整事务失败，修复前置函数后可恢复重跑。不存在部分替换或无 artifact 旧重载绕过路径。
- PostgreSQL 17.11 一次性本地集群：/tmp 独立数据目录、Unix socket、端口 55439、listen_addresses=''；未修改原有 PostgreSQL 服务。默认 PostgreSQL 14 不支持所需 security_invoker，因此采用本机已有 PG17。集群最终 fast stop，pg_ctl status 返回 no server running（exit 3）。
- run-text-postprocess-t2.sh 通过：新安装、双 migration 重跑、source+artifact 原子发布/新版本回滚、同 payload replay、同 source/不同 artifact 冲突、CAS/审计失败无部分状态、NULL/清空/替换/直接写/角色/SECURITY DEFINER/session 绕过拒绝、旧表/旧 NULL 保留、旧重载清理、两会话锁、补丁漂移 fail closed/恢复。
- PostgreSQL superuser/owner 主动通过 DDL 删除约束或禁用 trigger 是数据库管理权限本身，不能靠同一库内约束阻止；本次没有声称防御恶意 DDL。测试覆盖保持约束启用时的 postgres/service_role DML、SECURITY DEFINER、guard/session setting 绕过。

## T3/Shared 契约与消费

MiniApp 版本 DTO 仅 version/artifact/published_at；严格 schema 拒绝 source-only、额外字段、非正整数、未知 schema/policy、非法 rules 与 source 假装 artifact。Admin 独立 SourceSnapshot 保留编辑/历史 source，兼容类型别名保留已有 T6 consumer，不共用 MiniApp DTO。

repository 单次 IN 查询最多 20 个去重版本，不做 N+1；每行独立验证 artifact 和行协议，坏行加入 unavailable_versions，不拖垮合法同批版本。返回 DTO 不包含 source/draft/digest/audit。service publish/rollback Worker 成功必须带可再验证 artifact，draft 内容摘要也重新核对；source/artifact 一起传正确 RPC。无读时编译、latest/max 替代。

## T5 实际可达性与 P3

reply-plan 只消费 snapshot.artifact，snapshot.version 必须等于消息绑定 N；null、turn 0、user、loading/error/unavailable、缺失/非法/不支持/错版 artifact 均返回完整原文。没有新增 compiler 深路径、parse5/css-tree 导入，renderer/worker 失败仍由现有 renderer 完整原文降级。

版本响应归一化使用严格 DTO 与语义校验并冻结 JSON；WeakMap 只是同一个不可变快照的派生验证 memo，不增加服务器状态源。非归一化/旧缓存对象不记 memo，继续验证；React Query 若重建对象会安全重新验证，可能失去该次优化但不会绕过安全。

新增 artifact-renderer.test.tsx 用已有 esbuild 临时构建实际 ChatMessageBubble，jsdom 挂载实际 ReplyRenderer，Node worker_threads 运行实际 renderer Worker。真实可信 artifact 产生 choice 按钮，双击只送一次；username 含 {{user}} 也不二次替换；后续 assistant 出现后旧 choice 保持关闭；streaming 按钮禁用。临时 bundle/Worker 放系统 tmp 并清理，不加入 Git。

版本/计划/choice 现有及扩展测试覆盖 source-only、坏/缺失/错版本、N 不用 M、null/turn0/loading/unavailable/API 失败、streaming→complete 同版本、普通 Markdown/HTML 不伪造 choice、用户消息不处理、同步锁、runTurn、402/余额不足输入恢复、未知结果刷新确认与后续消息禁止重开。

Frontend 生产构建 static/server 搜索 compileTextPostprocessSource、parseFragment、scriptingEnabled、sourceCodeLocationInfo、css-tree/csstree 均零命中；Admin 仅 textPostprocessPreview.worker-C_rvOqNC.js 命中。compiler/T1/parser 源码未变，renderer/Admin 产品源码未变。

## 合并态验证命令及结果

- pnpm --filter @miniapp/shared test：114 passed。
- pnpm --filter @miniapp/shared typecheck：通过。
- pnpm --filter @miniapp/backend exec prisma generate：通过；仅 node_modules 生成物，无 Git diff。
- pnpm --filter @miniapp/backend test：565 passed。
- pnpm --filter @miniapp/backend typecheck：通过。
- pnpm --filter @miniapp/reply-renderer test：17 passed。
- pnpm --filter @miniapp/reply-renderer typecheck：通过。
- pnpm --filter @miniapp/frontend test：216 passed。
- pnpm --filter @miniapp/frontend typecheck：通过。
- pnpm --filter @miniapp/frontend lint：通过，无 warning/error。
- pnpm --filter @miniapp/frontend build：通过，实际 Next 生产构建。
- pnpm --filter @miniapp/admin test：86 passed，含 preview Worker、publish/rollback/request_id/CAS/StrictMode runner 重建。
- pnpm --filter @miniapp/admin typecheck：通过。
- pnpm --filter @miniapp/admin build：通过，保留既有 Vite chunk size warning。
- pnpm -r typecheck：所有包通过。
- pnpm lint:imports：通过。
- pnpm lint:migrations：通过。
- pnpm lint:legacy：通过。
- pnpm test:migration-ledger：本地集群 8 项协议检查通过。
- packages/shared/migrations/tests/run-text-postprocess-t2.sh：通过，text_postprocess_t2 ok。
- 定向 Prettier、task.py validate、JSON/JSONL/dedup/relatedFiles 检查、bash -n、尾随空白、git diff --check：通过。

检查中修正过真实测试/bundle 适配问题后重新执行对应检查：Next lint 禁止 const module、jsx preserve 与 Vitest DOM realm 要求临时 bundle adapter；Backend fixture 不引入 compiler 以保持现有 worker-only 编译边界。没有禁用 lint/typecheck 或修改 package/lock/eslint。

## Trellis、工作区与剩余门禁

task.json 保持 in_progress，relatedFiles/context manifests 去重加入本证据和 T5/T6 closure；task.md 对齐 T5/T6 已完成离线实现的事实。T2 Doing（Implementation complete / environment pending），T3 Doing（Implementation and offline verification complete / database integration pending），T5/T6 Doing（Implementation and offline verification complete / environment integration pending）。

现有 tracked/untracked 文件全部保留；package.json/pnpm-lock.yaml/.eslintrc.json 本窗口 SHA256 未变。Git 没有新增 node_modules、构建物、日志、probe、凭证或临时数据。未 commit、未 push、未部署、未连接或修改 TEST/Production/远端 Supabase/环境变量/flag。

artifact P1 已解决且离线门禁通过，可以开始 T7 离线验收准备；本窗口未执行 T7。T2 尚未在 TEST 执行 migration，T3/T5/T6 真实环境联调等待 T2 TEST shape/逐文件 migration/postflight 的独立授权；Telegram 真机、容量/锁、真实 RLS/grants 和 Production 仍未验证。Production 不从本地/TEST 推断。
