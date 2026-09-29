# 执行计划

## 规划与授权门禁

本任务已获用户批准并 start，保持 in_progress。2026-09-29 本窗口获授权修订 T2/T3/T5 artifact 最小方案并离线实现；产品代码前已更新 design/implement/task 并通过 task.py validate。环境门禁独立保留；不 commit/push/部署/操作远端数据库。

当前 .trellis/config.yaml 为 codex.dispatch_mode=inline，由主会话实施与检查，不派发 implement/check 子代理。jsonl 作为交接规范清单保留，不代替此计划。

## 执行顺序与验收关联

1. T0：完成共用 renderer、HTML/CSS 语法限制、可信捕获组、Markdown 合成和 Worker 打包/预算验证，记录依赖版本/体积/允许列表。产出具体验证证据，T0 未通过不做 schema 发布。
2. T1：shared DTO/Zod/compile/segment 纯工具；兼容 ChatMessage/SSE 字段、版本批次和 Admin mutation 错误语义。
3. T2：两个 migration 已离线实现；本窗口仅修订尚未远端发布的 artifact migration，TEST 只读结构核验及执行待另行授权；完成 runtime snapshots、运营 CAS/幂等事务、消息 FK/wrapper。先离线检查 SQL/fixtures，再每文件经既有 workflow 执行并 postflight；Production 单独审批。
4. T3：Backend 当前配置读、不可变版本批次、Admin session 鉴权/编译发布、开轮绑定；不动 generation settle/billing 语义。
5. T4：packages/reply-renderer 共用实际渲染与受限交互；Node 只引用 shared compiler，不引用 React 包。
6. T5：APP query/SSE 临时态/消息渲染/选项发送接线；历史快照批次查询，保留 Markdown 退化。
7. T6：Admin 专用三栏工作台、草稿保存、正式发布、分页版本差异和回滚；同 renderer 流式预览。
8. T7：全链路安全/兼容/失败/主题/设备验收，验证已有 generation/billing/voice/image consumers。
9. T8：同步 README/ARCHITECTURE 和受影响 module spec，生成待审核 module-updates.json；呈交最终范围、验证及 commit message，再等待提交授权。

T3/T4 均依赖 T1；T3 运行联调依赖 T2。T5 依赖 T3/T4；T6 依赖 T3/T4；T7 依赖 T5/T6。T0 探索可以证明设计，但不得提前绕过用户实施审批写产品代码。

## 需要明确锁定的回归测试

本任务存在模板执行面、Regex DoS、并发发布、契约与 migration 风险，因此规划明确提出少量必要新测试，待本规划审核后实施；不为简单 UI 外观建立镜像测试。

- shared：非法 schema/flags、捕获组转义/属性禁止、组件隔离、重叠/non-global/空匹配、HTML/CSS AST 逃逸、版本向后兼容、模板膨胀上限。
- renderer：浏览器实际 Worker 超时可终止、多条慢规则总 deadline、旧任务取消、Node 发布 worker 不占主线程、普通 Markdown/模板来源不混淆、trusted choice payload、details 局部状态。Worker 真时限验证不能只 mock timeout。
- Backend：身份/环境/角色、CAS、发布前后草稿变更、重复 request_id、事务部分失败、回滚新版本、读取 unavailable、开轮失败无孤儿行；现有 generate/SSE/history/user-placeholder 测试扩展。
- Frontend：postprocess_version 经 start/merge/history 保留，选项资格/双击同步锁、生成中发布/重生成/网络未知、缓存环境切换。优先扩展现有测试，独立必要纯逻辑才新文件。
- Admin：表单/保存错误保留、越界发布拒绝、环境迟到响应、草稿冲突、分页旧版本回滚、未保存值与已保存发布值区分。
- SQL：按既有 fixtures/tests 形式，合法 source 发布、非法/越权拒绝、CAS/重复 key、transaction rollback、history FK/null 兼容、旧 RPC 行为不变。无远端凭证/业务正文 fixture。

浏览器 DOM 测试基础设施当前不完整；若必须补，只为共用 renderer 的安全和交互引入最小环境，记录成本。真实 Telegram/WebView 不以 jsdom 结果替代。

## 实施验证命令

在实施后按改动阶段跑相关既有测试，最终完整门禁一次：

```bash
pnpm --filter @miniapp/backend exec prisma generate
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/admin test
pnpm --filter @miniapp/reply-renderer test
pnpm -r typecheck
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin build
pnpm --filter @miniapp/cs-platform build
pnpm lint:imports
pnpm lint:legacy
pnpm lint:migrations
pnpm test:migration-ledger
git diff --check
```

reply-renderer test/typecheck 脚本须在新包内新增；这是拟新增命令，不是声称当前能运行。Backend 目前没有传统 dist build，采用 typecheck/测试；前端和其他可构建 consumers 都运行 build。prettier 仅对本任务文件执行，不能全仓格式化用户工作。

## 可重复人工验证

- 固定原文含引号/highlight/status/choice，与普通 Markdown 强调、列表、代码、恶意原始 HTML 混合；Admin 与 APP 相同 theme/displayName/viewport 下对比。
- 模拟在每个标记字符处切 chunk，暂停/恢复并最终收口；未闭合原文保留，代码/段落不损坏，状态卡展开不随增量重置。
- 插入自定义 table/grid 卡片、跨行/命名组规则，改顺序和启停；复制停用、错误定位、宽窄布局、主题均验证。
- 设置灾难性正则和多条慢规则，确认倒计时/预算可终止、页面还能输入/滚动、下一消息正常；网络记录不得出现模板/CSS 诱导资源请求。
- 正式版 v1 → 保存 v2 草稿 → v1 开轮期间发布 v2 → 完成旧轮 → 新发送/重生成 → 回滚为 v3；每条消息记录自身版本，reload/分页后仍一致。
- 最新完整回复点击选项、双击、历史点击、生成中点击、空/超长 payload、慢网/断网/402/会话切换/结果未知；检查纯文本输入、一次提交及恢复提示。
- 两运营人编辑相同 draft/发布、重复 request_id、关闭页面后重读结果；viewer、无 session、跨环境及直接通用 RPC 绕过发布必须拒绝。
- TEST 独立核对迁移前后 shape/RLS/grants/关键读写、旧 RPC、水位线、当前 history view、锁/容量及回滚。匿名不得直接读 snapshots/admin drafts。
- 320px、常见 Telegram iOS/Android WebView、软键盘/安全区、亮暗主题、font-scale、键盘焦点、reduced-motion、长表格和长回复；注明设备与未覆盖项。

## 恢复与停止

发布拒绝时保留草稿并返回字段错误；CAS 冲突不强制覆盖。提交响应未知先按 request_id 读权威结果。迁移超锁/权限异常停在当前文件，不自动下一文件。应用回退保留新增快照/列，规则回滚新发布；历史依赖未核验不得 DROP。安全模板/原文污染/版本错绑/不可终止/计费回归任何一项失败都阻止开放。

## 文档与模块交付

更新根 README/ARCHITECTURE、Admin README、相关 Frontend/Backend/Admin/shared/database spec；记录渲染包依赖边界、规则允许范围、运营发布方式、容量、旧消息和 emergency fallback。module_impact 列明既有模块，模块事实仅在实现完成与验证后更新；本轮不把计划写成现状。

## T2/T3/T5 artifact 契约修订（2026-09-29，已获本窗口授权）

- 不变量：compiled artifact 是 app_core.text_postprocess_versions 不可变发布快照的一部分，与 source/schema/policy/version/published_at 一次写入。沿用 app_core 运行配置历史归属及永久保留生命周期；admin 专用 RPC 是唯一权威写入方，跨 schema 发布审计依赖不变。
- 复用：T1 compiler/CompiledTextPostprocessArtifactSchema/validateCompiledArtifact、T3 可终止 Worker/repository、T2 CAS/request lock/commit_release、T5 React Query 缓存/ReplyRenderer/choice gate。扩展既有边界，不改 compiler 输出语义或 renderer，不新增状态源、依赖或发布框架。
- publish：读明确已保存 draft → Worker 编译并返回 artifact → shared 再校验 → RPC 锁 runtime/draft 并比较 revision/digest/updated_at/source → 原子写 source+artifact、新版本、runtime 指针、release、audit、draft 状态。编译发生在事务前；期间草稿变化 CAS 拒绝且全部回滚。
- rollback：读明确 target 的 source → 同 Worker 重新编译并校验 → RPC 再比目标 source 与预期 current → 新版本绑定自己的 artifact。不修改目标，不复用其他版本 artifact；失败不新建版本。旧 target 没 artifact 可明确重编其自身 source 后创建新版本。
- 幂等：request_id 不变；业务 request digest 纳入 source/artifact；SQL 再对完整 RPC payload（含 actor、操作、CAS、source/artifact）计算 SHA-256 身份，避免调用方摘要漏字段。重放从已提交 outcome.version 读取原 source/artifact，不重新编译或读取 current。不同 payload 冲突；未知结果只查询原 request_id，不自动 retry mutation。
- shape：在未发布的现有 migration 加 artifact jsonb。ALTER ADD IF NOT EXISTS 支持本地早期表；NOT VALID check 允许旧 NULL 行保留但拒绝任何新 NULL/非法基本结构。不可变 UPDATE/DELETE 与 TRUNCATE 触发器无角色例外，ENABLE ALWAYS 防 session_replication_role 绕过；新 RPC 签名删除旧重载。SQL 校验基本 shape/协议及 source 规则身份，不复制 JS compiler；可信编译与安全树验证仍在 Backend，消费端独立校验。
- runtime_config 仍只放当前 source/协议/版本指针，不放 artifact。MiniApp DTO 为 version/artifact/published_at；Admin source DTO 独立。一次最多 20 去重版本、一次 IN 读；每行独立校验，缺失/非法/不支持/错版 unavailable，无 latest/max 替代、无读时编译/修复。
- Frontend：响应/缓存归一化边界校验 artifact，正文只读该版本 snapshot.artifact；renderer 仍独立防御。原文降级、用户名单次替换、用户消息不处理、choice 可信回调/同步锁/runTurn/402/刷新确认保持。P3 在归一化边界校验并冻结，通过不可变响应对象的 WeakMap 派生 memo 避免正常重复渲染全量验证；非归一化对象继续校验。
- 恢复：现有证据仅证明 migration 尚未远端执行，不连接远端复核。全新安装/旧本地表/旧 NULL 行/重跑/失败整事务恢复由本地 PG17 场景验证；不得伪造回填、删旧行或改 chat-history migration。已发布后 forward-fix 另行审批；应用回退保留快照及引用。
- 可靠性：现有有界 Worker 超时/队列/terminate、DB advisory lock/CAS/request_id 保持。无第三方写，无需补偿队列；不增加读取编译或自动 mutation 重试。日志只版本/计数/耗时，禁止 source/artifact 正文。
- 停止：需改变 T1 格式/安全/发布语义/归属、远端已执行证据、远端连接、T7 实施或第二 migration 来源时停止。环境门禁保持 TEST shape → 单文件 migration/postflight → T3/T5/T6 联调，Production 独立授权。
- 验证：新增 SQL source+artifact 原子性、不可变/清空/角色/SECURITY DEFINER/session 绕过、完整 payload 重放/冲突、CAS/审计失败零部分状态、旧行/旧签名/漂移/重跑；shared 严格 DTO；Backend Worker/RPC/批次好坏隔离/无内部泄露；Frontend 真实可信 choice 可达及原文失败路径；重跑 Admin preview/publish/rollback/request/CAS/StrictMode。执行本任务要求的全部合并态命令、PG17 local-only harness、bundle/compiler 隔离、定向格式/JSON/path/卫生检查。
