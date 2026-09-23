# Task Breakdown

## 依赖

- 09-11-batch-lab-foundation

## Tasks

| ID  | Status | Task                                   | Files / Scope               | Depends On | Verification                     |
| --- | ------ | -------------------------------------- | --------------------------- | ---------- | -------------------------------- |
| T0  | Done   | 人工评审并确认依赖/环境/安全门禁       | task artifacts + target env | -          | prod/test 分支关系只读核验       |
| T1  | Done   | 冻结 shared 契约、状态、错误与容量限制 | shared contracts/tests      | T0         | 66 tests + consumers typecheck   |
| T2  | Done   | 实现持久边界、事务/幂等与 repository   | backend/database            | T1         | repository/migration/并发测试    |
| T3  | Done   | 实现数据库、环境和样本集链路核心能力   | owned application files     | T2         | PRD业务验收                      |
| T4  | Done   | 覆盖失败、恢复、安全与容量             | tests/runbooks              | T3         | 故障注入与停止/回滚演练          |
| T5  | Done   | 完成消费者检查、Spec payload和集成交接 | spec/docs/module updates    | T4         | 命令全绿 + integration owner验收 |

## 完成定义

- [x] 写 SQL、多语句、危险 schema/函数被拒绝且只读角色物理上无写权限
- [x] 参数/SQL/limit/source 改动使旧 preview 失效
- [x] 保存使用同一 preview，不重新抽样；零有效样本不可保存
- [x] 重复、不足、历史缺失分别统计，冻结内容不随源库变化
- [x] production 未显式 allow、ref 或只读凭据任一不符即拒绝启动
- [x] 验证命令、失败路径、发布/回滚和 Spec/module payload完整。
- [ ] 本任务独立归档后，父任务仍不完成；必须等待 integration-spec 全量收口。

## Execution Log

- 2026-09-11：完成详细规划；保持 planning，T0等待人工评审。
- 2026-09-11：人工指定 `wbtsfzozlmurljvglhpn` 为本任务正式 test 目标；MCP 只读确认项目健康、会话表 shape 与 `batch_lab` 尚不存在，未读取业务行。
- 2026-09-11：发现 `experience.chat_history` 未启用 RLS，且目标库存在 anon/authenticated 可执行的 volatile 业务函数；将其作为来源角色最小权限与负测的强制门禁，不自动修改上游对象。
- 2026-09-11：任务已 start；远端 migration 必须在文件人工评审后另行逐次确认，当前不得自动执行。
- 2026-09-11：T1 经人工确认；继续 T2，仅编写 migration/repository，不执行远端变更。
- 2026-09-11：新增 migration 110 草案、独立 PostgREST 暴露脚本和 repository；来源实际连接角色直接配置只读 GUC，冻结 RPC 使用 advisory transaction lock 串行化同一幂等键。
- 2026-09-11：经逐次人工授权，migration `batch_lab_samples` 已应用到 `wbtsfzozlmurljvglhpn`；未执行 PostgREST 暴露、未启用 LOGIN、未创建凭据。
- 2026-09-11：远端验证 5 表均启用 RLS，anon/authenticated 无 schema usage，来源仅有三表 SELECT 且无 INSERT；两个 RPC 已创建。回滚事务验证 preview→freeze→幂等 replay：1 个 preview item、1 个 frozen snapshot、preview consumed、重复键返回同 ID，未留下验证数据。
- 2026-09-11：Security Advisor 未发现 batch_lab 的 ERROR/WARN；5 条 `rls_enabled_no_policy` 为预期 deny-by-default INFO。既有 schema 的 advisor 项未在本任务中改写。
- 2026-09-11：经单独人工授权，authenticator PostgREST 暴露列表在 guard 校验原十项后追加 `batch_lab`，并 reload config/schema；远端复核完整十一项未丢失。数据库权限复核 service_role 可 USAGE/SELECT/EXECUTE，anon/authenticated 无 schema usage、anon 无表 SELECT/RPC EXECUTE；公开 key REST 请求 batch_lab 返回 401，与既有 admin 拒绝基线一致，未出现 schema-not-exposed。
- 2026-09-11：新增 `ops/batch-lab/README.md`，固定暴露回滚与 LOGIN/secret 安全顺序。因后端尚未消费来源 URI，来源角色继续保持 NOLOGIN；待 T3 fail-closed 查询器完成后再由人工建立/轮换凭据并做真实连接负测。
- 2026-09-11：T2 回归扩展至 9 个 repository/migration tests，覆盖单 RPC preview、调用方幂等键、空 RPC 响应 fail-closed，以及 advisory lock 顺序、preview FOR UPDATE、同事务 snapshots/consumed、NOLOGIN/无密码不变量。Backend test/typecheck、Shared 66 tests、全 workspace typecheck、diff check 均通过。
- 2026-09-11：远端回滚事务补测通过：preview 子项约束失败时元数据 0→0（原子回滚）；同幂等键不同 payload 返回业务冲突，set/snapshot 均保持一份。MCP 不提供两个可控并行 direct 会话，故真实锁等待未伪报通过；双会话步骤与停止条件已写入 ops runbook，T2 保持 In Progress 待人工执行。
- 2026-09-11：T3 前人工纠正环境事实：`wbtsfzozlmurljvglhpn` 是 production 主项目；`zoqelpfhurwehlvypryl` 是其持久 testdb 分支，当前状态 ACTIVE_HEALTHY。此前 production migration/PostgREST 对象按指示保留但功能关闭，不作为 test 验收；后续先在 test 分支逐项重做。
- 2026-09-11：只读确认 test 分支存在 experience/app_core 来源表但尚无 batch_lab，且 `experience.chat_history` 仍未启用 RLS。该既有安全风险不由本任务自动修改；来源读取只能使用专用最小 SELECT + READ ONLY LOGIN，绝不能使用 anon/authenticated。
- 2026-09-11：经独立人工授权，migration `batch_lab_samples` 已应用到 test 分支 `zoqelpfhurwehlvypryl`。验证 5 表 RLS=true、anon/authenticated 无 schema usage、两个角色 NOLOGIN/NOBYPASSRLS、login 具备 read-only/5s/500ms 设置、来源 chat_history 仅 SELECT 无 INSERT；PostgREST 尚未暴露。
- 2026-09-11：test 回滚事务 smoke 通过：preview item=1、freeze snapshot=1、preview consumed、同幂等键 replay 返回同 ID，未留下 fixture。Security Advisor 对 batch_lab 仅有 5 条预期 deny-by-default INFO，无本任务新增 ERROR/WARN；Advisor 仍报告 chat_history RLS disabled 及其他既有问题，未自动改写。
- 2026-09-11：test migration 结果经人工确认。随后只读冻结 authenticator 原十项基线，新增 test ref 专用 guard/回滚脚本，并经独立人工授权追加 `batch_lab` 与 reload。复核完整十一项未丢失，service_role 可 USAGE/SELECT/EXECUTE，anon/authenticated 无 schema usage，anon 无表 SELECT/RPC EXECUTE，来源 login 仍为 NOLOGIN。
- 2026-09-11：test publishable key 对 batch_lab REST 返回 401，与既有 admin 拒绝基线一致且非 schema-not-exposed，证明 reload 生效且匿名权限未扩大。未创建来源密码或 secret。
- 2026-09-11：test PostgREST 结果经人工确认并进入 T3；人工接受双 direct 会话锁等待验收延期，步骤保留在 runbook，T2 标记 Done，不代表该延期项已伪报执行。
- 2026-09-11：T3 第一子步骤实现 fail-closed 来源配置与专用 pg 连接边界：强制 source env/ref、专用 role、TLS、production backend + 显式 allow，连接池上限 1..5/连接超时 0.5..10s；context 在声明 preview capability 前真实探针 current_user/read-only/statement timeout/lock timeout。未设置或读取真实 secret，来源角色仍 NOLOGIN。
- 2026-09-11：T3 第一子步骤验证完成：新增配置/连接/route 19 tests 通过；backend 除既有远程 conversations integration 外 408 tests 通过，shared 66、Batch Lab 5 tests 通过；backend、Batch Lab 和全 workspace typecheck 通过，diff check 通过。全量 backend 唯一失败为 test 环境既有 schema cache 缺少 `users.st_handle`，与本子步骤无关，未修改该上游测试/表。preview capability 继续保持 false，等待 SQL 预检与查询器完成后再开启。
- 2026-09-11：T3 第一子步骤经人工确认。人工评估后否决复用 Supabase service-role secret 作为来源凭据：API key 不是 pg 密码，且 service_role 绕过 RLS/权限面过大，违反专用来源物理只读与平台写入凭据隔离要求；保持专用 LOGIN 方案。
- 2026-09-11：新增 test-only 来源权限验证器（尚未连接真实角色）：只允许目标 test ref，输出仅含检查名、PASS/FAIL、SQLSTATE；核验身份/GUC、角色属性、仅三表 SELECT、无 batch_lab usage、无 schema CREATE/来源 DML/TRUNCATE/序列权限，并实测 DML/DDL及既有副作用函数拒绝。负测只接受 25006/42501，防止把连接、超时或对象漂移误报通过。相关 28 tests、backend typecheck、diff check 通过；LOGIN/secret 仍未启用，等待人工确认验证器。
- 2026-09-11：验证器经人工确认；人工仅在 test 启用 LOGIN 并注入忽略的本地 `.env`。无联网门禁二次修正后确认 test ref、专用 pooler 用户、session 5432、TLS 参数和 feature=false，未输出 secret/URI。
- 2026-09-11：经单独人工授权执行真实验证，但在首个 identity/read-only/timeouts 探针失败且无 SQLSTATE；后续三表读取及全部 DML/DDL/函数负测均未执行，未将失败伪报通过。按停止条件人工立即改回 NOLOGIN 并撤本地 URI；MCP 只读确认 rolcanlogin=false、无高权、read-only/5s/500ms 配置保留，本地确认 URI 已移除且 feature=false。下一步须单独规划不泄密连接诊断并重新授权。
- 2026-09-11：经人工确认完成不泄密诊断增强：连接阶段仅分类 DNS、TLS、认证、授权、超时、网络、容量、服务不可用或未知；会话探针逐项分类缺行、身份、read-only、statement timeout、lock timeout 不匹配。分类不包含 endpoint、用户名实际值、URI、secret、数据库返回值或原始错误消息。相关 31 tests、backend typecheck、diff check 通过；角色保持 NOLOGIN、本地来源 URI 仍为空，未重新连接，等待人工确认。
- 2026-09-14：从安全状态离线续作 T3；新增保守 SQL 预检/命名参数绑定与专用 pg READ ONLY 有界查询原语，限定三张来源表，拒绝分号、写/DDL、SELECT INTO、函数、quoted identifier、dollar quote、非白名单 relation 及参数错配；查询设置 5s/500ms local timeout、limit+1 截断、8 MiB 字节上限，并对连接/查询错误脱敏映射、失败回滚和 release。独立检查发现并修复 CTE 名伪装 schema、quoted function、cast 误绑定及连接错误泄露风险。相关 29 tests、backend typecheck、diff check 通过；未联网、未访问数据库/secret、未执行 migration，来源角色仍应保持 NOLOGIN，公开 `sample_preview` capability 继续 false，等待锚点补齐/持久编排完成。
- 2026-09-16：补齐 T3 锚点补齐与持久编排：用户 SQL 只产生 `source_history_id` 锚点，Backend 使用专用只读来源连接在 READ ONLY 事务中回读 `experience.chat_history` / `experience.chat_sessions` / `app_core.characters` 权威快照，统计重复锚点、缺失 session/history/character、无效锚点和截断；生成 `sha256` digest、15 分钟 preview TTL，并通过 `batch_lab.create_sample_preview` 单 RPC 持久化同批 preview。`POST /api/batch-lab/sample-sets` 只消费同一 `preview_id + digest + source_environment + idempotency_key`，由数据库 RPC 冻结 snapshot，不重新抽样；零有效样本在服务端拒绝。`sample_preview` capability 在 context 探针通过后开放。
- 2026-09-16：T4 自动回归覆盖 SQL 攻击/参数错配/函数拒绝、连接和查询错误脱敏、READ ONLY/timeout/rollback/release、preview 锚点补齐、重复与缺失排除、route 环境错配和冻结错误映射；未重新启用真实来源 LOGIN、未读取业务行、未执行 migration。已通过 targeted shared/backend/batch-lab tests 与 backend/shared/batch-lab typecheck；等待全量消费者 typecheck、diff check 与 module payload 校验后收口 T5。
- 2026-09-16：T5 收口：`module-updates.json` 覆盖 backend/source access、shared Batch Lab契约、database conversation-storage只读来源和 schema-security，并通过 `module_knowledge.py check 09-11-batch-lab-data-samples`。验证通过：`pnpm -r typecheck`、`pnpm --filter @miniapp/backend test`（53 files / 477 tests）、`pnpm --filter @miniapp/shared test`（47 tests）、`pnpm --filter @miniapp/batch-lab test`、`pnpm --filter @miniapp/batch-lab build`、`git diff --check`。Batch Lab build 保留既有 500 kB chunk warning。`pnpm lint:imports` 仍因仓库 ESLint 命令 `--rule '{}'` 参数解析失败；`pnpm lint:migrations` 因已提交的 `20260920_batch_lab_samples.sql` 使用三位编号失败。该 migration 已在任务历史中记录为远端执行对象，本轮不贸然改名以免迁移账本与实库执行历史分叉；交给 integration-spec/owner 单独决策 forward-fix。
