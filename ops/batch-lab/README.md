# Batch Lab 数据库运维

本目录只存可审计脚本和操作顺序，不存数据库 URI、密码、JWT、service-role key 或其输出。
环境权威映射为：production 主项目 `wbtsfzozlmurljvglhpn`，test 持久分支
`zoqelpfhurwehlvypryl`（branch `testdb`，parent 为前述 production 项目）。环境语义必须以
任务记录和 `BATCH_LAB_SAMPLE_SOURCE_ENV` 为准，不能从历史文件名推断。

## 已完成

1. production 曾提前执行 migration `batch_lab_samples` 并暴露 PostgREST；按人工裁决保留对象，
   但 feature flag 保持关闭，不把该次验证当作 test 验收。
2. test 分支是当前实施目标；其 migration/PostgREST/LOGIN 必须重新逐项人工授权和验证。
3. 两个环境的 `batch_lab_source_reader` 与 `batch_lab_source_login` 在凭据门禁前均应保持
   `NOLOGIN`。

## 后续严格顺序

### A. 暴露平台写入域（不涉及来源凭据）

1. 当天只读复核 authenticator 的完整 `pgrst.db_schemas` 与脚本 guard 完全相等。
2. 人工授权后执行与当前目标 ref 绑定、且带当日完整基线 guard 的暴露脚本。现有
   `postgrest-expose-wbtsfzozlmurljvglhpn.sql` 仅适用于 production，不得在 test 复用。
3. reload config/schema 后，以 service-role + `Accept-Profile: batch_lab` 验证表和两个 RPC。
4. 回归原有十个 schema；anon/authenticated 对 batch_lab 必须仍被拒绝。
5. 任一失败立即停止应用发布，并按脚本注释将暴露列表退回原十项。

### B. 启用来源 LOGIN（必须由持有 secret 的人工操作）

1. 生成高熵随机密码，禁止粘贴到聊天、Git、命令行参数、日志或 Markdown。
2. 通过 Supabase SQL Editor/受控 secret 流程执行：
   `ALTER ROLE batch_lab_source_login LOGIN PASSWORD '<secret>';`
3. 将独立 direct/pooler URI 写入后端 secret `BATCH_LAB_SOURCE_DATABASE_URL`；URI 用户必须是
   `batch_lab_source_login`（pooler 可为 `batch_lab_source_login.<ref>`），必须包含
   `sslmode=require`，不得是 `postgres`/`service_role`，且不得进入浏览器 `VITE_*`。
4. 用新建的真实连接（不能用 postgres 后 `SET ROLE` 代替）验证：
   - `current_user = batch_lab_source_login`
   - `transaction_read_only = on`
   - 仅可 SELECT 三张允许表
   - INSERT/UPDATE/DELETE/TRUNCATE/DDL/序列/有副作用函数全部失败
   - statement timeout 为 5 秒，lock timeout 为 500ms
   - 验证器只输出检查名、PASS/FAIL 与 SQLSTATE，不输出 URI、secret 或业务行：
     `pnpm --dir packages/backend batch-lab:verify-source`
   - 负测仅把 read-only transaction (`25006`) 或 permission denied (`42501`) 视为预期拒绝；
     连接、超时、函数不存在等其他错误均 fail closed，避免把环境故障误报成权限验证通过。
5. 负测未全绿时立即 `ALTER ROLE batch_lab_source_login NOLOGIN;`，撤下 secret，禁止开启功能。

> 后端现已具备 fail-closed 配置与连接身份探针，但尚未实现 SQL 预检和 preview 查询器。
> LOGIN/secret 仍须在本子步骤人工确认后另行授权；负测全绿前不得开启 `BATCH_LAB_ENABLED`。

## 回滚与泄漏处置

- PostgREST 配置失败：回退为原十项并 reload config/schema；数据库对象保留。
- 来源凭据疑似泄漏：先 `NOLOGIN`，再轮换密码与部署 secret，最后重跑全部负测。
- 应用失败：关闭 `BATCH_LAB_ENABLED`；不要直接删除已有样本数据。
- 删除 schema/角色属于破坏性独立变更，必须另开 migration 和人工审批。

## T2 双会话并发验收（不保存 fixture）

自动测试已固定 advisory lock 必须先于幂等查询/插入，远端回滚事务已验证同键重放和冲突。
真正的锁等待仍需两个独立数据库会话，不能用一次 MCP SQL 调用或 `SET ROLE` 冒充：

1. 两个受控会话都 `BEGIN`，并使用可写平台角色；准备一个仅用于验收的 preview。
2. 会话 A 调用 `freeze_sample_set` 后保持事务不提交。
3. 会话 B 用**相同幂等键和相同 payload**调用；必须等待 A，而不能创建第二份样本集。
4. A 提交后，B 必须返回相同 sample set ID；表中仍只有一条 set 和对应的一份 snapshots。
5. 重做一次但让 B 使用不同 name；A 提交后 B 必须得到
   `BATCH_LAB_IDEMPOTENCY_CONFLICT`，仍只有一份冻结结果。
6. 删除仅用于验收且尚无 consumer 的 fixture，或让整个演练在可回滚测试数据库中完成。

**停止条件**：B 未阻塞、出现 unique 原始错误、产生两份结果、等待超过 timeout，均不得进入 T3。
当前 MCP 每次 SQL 是单一不可控会话，无法证明真实锁等待；该项必须由持有两个 direct test
连接的人工执行并记录两侧时间线，不能把静态测试写成已完成事实。
