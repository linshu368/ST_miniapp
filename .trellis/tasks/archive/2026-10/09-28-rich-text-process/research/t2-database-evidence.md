# T2 数据库证据

日期：2026-09-28。分支 `dev_rich_text_process`。建议状态：**Implementation complete / environment pending**。不是 Done。没有连接 Supabase MCP、CLI 或 TEST/Production，没有执行 migration，没有改历史 migration。

远端结构仍是 `MIGRATION` 源码事实，不是 `TEST-DB` 或 Production。若目标库函数正文与下面锚点不一致，第一个 migration 会失败停止，不能静默漏补。

## 源码核对

- `app_core.runtime_config` 来自 015，099 从 `miniapp` 搬入。主键 `key`，`value jsonb`，`version integer`，`text_value text`。本任务不播种 `miniapp_text_postprocess_config`；没有该行就是尚未发布。
- 通用 `publish_config_draft` / `rollback_config_release` 正文只在 035。099 把其中的 `miniapp.runtime_config` 改写成 `app_core.runtime_config`，不改控制流。`upsert_config_draft` 在 037，`discard_config_draft` 在 039，`save_config_draft` 在 035。后续 migration 多次替换 `is_managed_config_key` 和 `validate_managed_config_value`，最后一版在 `20260923_vip_strategy_media_limit_alignment.sql`。本 key **不**加入这张白名单，避免通用编辑器把它当成普通配置。
- `experience.current_chat_history` 最后一次重建是 097 的 `SELECT DISTINCT ON (...) *`，099 只 `SET SCHEMA`。PostgreSQL 在创建视图时展开 `*`。`20260911` 给基表加了 `llm_billing_snapshot` / `llm_billing_settled_at`，没有重建视图，所以这两列不在当前视图里。新 migration 按执行时的视图列清单在末尾追加 `postprocess_version`，不重新展开 `*`。
- 开轮函数最后一次定义在 077，签名是 `start_chat_history_turn(uuid, text, text, integer, integer, integer)` 和 `start_chat_history_regeneration(uuid, integer, text, integer, integer, integer)`。099 把它们迁到 `experience` 并改写函数体里的 `miniapp.` 限定名。仓库里没有更晚的 `CREATE FUNCTION experience.start_chat_history_*`。wrapper 只调用这两个函数。

## 对象与归属

`app_core.text_postprocess_versions` 是已发布规则的不可变快照，不是运营审计，也不是 `miniapp_features`。删除后处理功能后，已绑定消息仍要读到原快照。权威写入方只有专用发布/回滚 RPC。禁止 UPDATE/DELETE。首期不 GC。Backend 经 `service_role` 只读；匿名和登录用户没有策略、也没有表权限。

`app_core.runtime_config` 的 key `miniapp_text_postprocess_config` 只表示当前已发布版本。值包含 `version`、`schema_version`、`policy_version`、`source`、`published_at`。

`admin.config_drafts` / `config_releases` / `audit_logs` 继续拥有草稿、发布记录和审计。草稿 `value` 是 source。`content_digest` 只给本 key 使用。`audit_logs.request_id` 是幂等键，部分唯一索引只覆盖非空值。

`experience.chat_history.postprocess_version` 可空，指向 `app_core.text_postprocess_versions(version) ON DELETE RESTRICT`。NULL 表示原 Markdown。不回填。权威写入方是两个 wrapper，不是旧 RPC，也不是应用层普通 UPDATE。

## 事务

发布在一个事务里写四项：版本快照、`runtime_config`、`config_releases`、`audit_logs`，然后把当前草稿标成已发布。任一步失败，包括审计插入失败，全部回滚。回滚同样写这四项，但新建版本，不修改旧快照，并记录 `rollback_of_release_id`。

保存和放弃不写快照或当前配置。发布读取已锁住的草稿，不接受调用方临时传入的 source。

`request_id` 先加事务级 advisory lock，再查 `audit_logs`。相同 id 且 `request_digest` 一致返回原结果并把 `replayed` 设为 true。摘要不同抛出 `P0001`，消息前缀 `request_id_conflict`。没有记录时 `get_text_postprocess_request` 返回 NULL。调用方应先查询，再决定是否用同一个 id 重试，不能换新 id 盲发。

CAS 使用 `40001`，消息前缀 `cas_conflict`。比较当前 runtime version、草稿 `base_version`、毫秒精度的 `updated_at` 和 `content_digest`。发布还要求 `draft_revision` 等于当前草稿 id。

专用 RPC 只授予 `service_role` 和 `postgres`。调用方传入已经由 Backend 确认的 `actor_user_id`，因为 `service_role` 没有运营用户的 `auth.uid()`。viewer、无环境权限、匿名和 `authenticated` 直接执行都会被拒绝。

通用 publish/rollback/upsert/save/discard 只在原正文前插入拒绝调用。锚点缺失或不唯一时 migration 失败。表触发器再挡一层：没有本事务写保护时，不能直接写这个 key、快照或带 `request_id` 的审计行。其他 key 的通用路径保持原样。

SQL 只做结构、容量、flags 字符和版本策略检查。HTML/CSS/正则 AST 仍必须由 Backend 在调用前完成。`schema_version` / `policy_version` 当前只接受 1。回滚到不再支持的 policy 使用消息前缀 `policy_unsupported`。

`content_digest` 和 `request_digest` 都是调用方用 `canonicalTextPostprocessJson` 算出的 64 位小写 SHA-256。数据库不重算，避免和 JavaScript 的 JSON 转义不一致。`request_digest` 必须覆盖操作名和参数，不能只哈希 `request_id`。

## 消息引用

wrapper 先确认版本存在，再调用旧开轮函数，然后给返回的 `history_id` 写 `postprocess_version`。会话锁、陈旧流和水位线仍在旧函数里。非法版本在调用前拒绝，同一事务保证不会留下半写轮次。NULL 显式传入，旧 RPC 本身不写该列。

大表只加可空列。CHECK 和 FK 先 `NOT VALID`，再单独 `VALIDATE`。`VALIDATE` 的 `statement_timeout` 是 15 分钟，锁是 `SHARE UPDATE EXCLUSIVE`，`lock_timeout` 5 秒。不建 `postprocess_version` 反向索引：快照不能删，热路径也不按版本扫消息。

## 本地验证

在临时 Postgres 17.11 集群执行，不用默认的 Postgres 14，因为 073 已使用 `security_invoker`，那是 Postgres 15 的视图选项。临时库跑了 harness、两个 migration、再各跑一次证明可重入，然后跑场景。结果：`text_postprocess_t2 ok`。

场景覆盖：合法发布的四写、重复 flags 拒绝且无快照、viewer 和跨环境拒绝、CAS、相同 `request_id` 重放、不同摘要冲突、未知请求为 NULL、审计插入失败后快照与请求都消失、通用 RPC 拒绝本 key 但另一个 key 仍可写、直接插入/更新快照失败、回滚生成新版本且旧行不变、旧开轮 RPC 保持 NULL、wrapper 委托水位线和忙碌会话、未知版本不开轮、FK `RESTRICT`、`service_role` 不能改列、两个会话抢同一配置锁时第二会话 `lock_timeout` 后持锁方回滚且请求仍未知。

另外：

- `pnpm lint:migrations`：通过。
- `pnpm test:migration-ledger`：通过。临时库名 `st_repo_migration_c_test`，不连 TEST/Production。
- `git diff --check -- packages/shared/migrations/README.md`：通过。
- 新增 SQL/脚本做了尾随空白检查：通过。
- README 曾用定向 Prettier 写过一次。随后 `node_modules/.bin` 不存在，没有再跑 Prettier，也没有 `pnpm install`。

## 未执行的环境门禁

- 未确认 TEST 或 Production 项目，未做只读结构采集。
- 未在 TEST 执行任一 migration，因此没有 preflight/apply/postflight、真实 shape、RLS/grant、锁等待或大表 `VALIDATE` 耗时。
- Production 未审批，也不能用本次本地库或将来的 TEST 结果代替。
- 通用函数补丁没有在真实库的函数正文上执行。本地 harness 使用了与 035/037/039 相同的锚点。

## 回滚与风险

应用回退时保留快照和可空列。规则回退走回滚 RPC，生成新版本。不要 DROP 已被消息引用的快照或列。

若第一个文件失败，整事务回滚。若第二个文件在列已提交后 `VALIDATE` 超时，停在该文件；重跑是安全的，不要接着发应用。`VALIDATE` 期间普通读写不被该锁挡住，但 DDL 会等。锁等待超过 5 秒应停止，不自动执行下一个文件。

`request_id` 恢复记录在审计表。已提交结果不能靠重试覆盖。快照触发器连属主也不能 UPDATE/DELETE。

## T3

可以开始 Backend 编码，按下面的 service-only RPC 和错误前缀实现。TEST 联调要等这两个文件按顺序获得单独授权并完成各自 postflight。不要把 T2 标成 Done。

- `admin.save_text_postprocess_draft(uuid, uuid, text, integer, timestamptz, text, text, jsonb)`
- `admin.publish_text_postprocess(uuid, uuid, text, integer, timestamptz, text, text)`
- `admin.rollback_text_postprocess(uuid, uuid, text, integer, integer)`
- `admin.discard_text_postprocess_draft(uuid, uuid, text, timestamptz, text)`
- `admin.get_text_postprocess_request(uuid, uuid)`
- `experience.start_chat_history_turn_with_postprocess(uuid, text, text, integer, integer, integer, integer)`
- `experience.start_chat_history_regeneration_with_postprocess(uuid, integer, text, integer, integer, integer, integer)`

开轮 wrapper 的 `p_postprocess_version` 必须显式传入，NULL 表示不绑定。返回 JSON 在旧字段上增加 `postprocess_version`。

## T2/T4 收口审阅补充（2026-09-28）

独立审阅发现 `guard_chat_history_postprocess_version` 曾对所有 `NEW.postprocess_version IS NULL` 直接放行。这样 `service_role` 虽不能把版本 2 改成版本 1，却能把已绑定值清空，绕过“只有开轮 wrapper 可以改变绑定”的不变量。现改为仅允许 INSERT 时的 NULL（兼容旧 RPC）；UPDATE 保持原值可通过，任何改值或清空都需要 wrapper 写保护。

SQL 场景新增 `service_role` 清空绑定值必须失败、失败后版本仍为 2 的回归。使用本机 PostgreSQL 17.11 隔离临时集群重跑 harness、两个 migration 各两次、完整场景与双会话锁竞争，结果为 `text_postprocess_t2 ok`。本机默认 PostgreSQL 14 不支持仓库既有 view 的 `security_invoker`，因此不作为有效执行环境。

本轮仍未连接 TEST/Production，也未执行任何远端 migration。离线修复和临时库通过不改变 T2 的环境门禁状态。
