# T9 OpenRouter 专表旧别名清理（2026-10-16）

## 授权、范围与边界

用户在现有任务中追加 OpenRouter 专表 11 个重复旧别名清理，随后确认 PR430 已合并并授权继续本地实施、完成后提交推送；不新建任务。远端迁移、新 PR、其他环境升级/停止均未自动执行。主表 llm_finish_reason、model 和计费事实保留；专表 llm_generation_id/data 按已审阅约定保留现名。无 Backend/Shared/API/Frontend/Admin 产品行为或 Venice 表/mapper 变更。

## 交付

新增 packages/shared/migrations/20261016_openrouter_chat_history_drop_legacy_aliases.sql：

- 删除 llm_provider_name、llm_finish_reason、llm_usage、llm_usage_cache、llm_native_tokens_cached、llm_native_tokens_reasoning、llm_native_tokens_completion、llm_native_tokens_prompt、llm_latency、llm_generation_time、llm_model。
- 保留 11 个对应原名字段、llm_generation_id/data、主键/parent key、审计列、UNIQUE/FK/canonical CHECK/ACL。
- 逐组验证 alias/canonical 类型；非空冲突拒绝，最多2000候选仅填NULL canonical；NULL metadata/占位继续合法，0不丢失，不复制父表业务finish_reason或历史raw JSON。
- 定点移除8个既有旧单列CHECK，再DROP11列，RESTRICT、不CASCADE。未知依赖/混合CHECK、shape漂移、provider重叠、超预算及重复执行拒绝。锁5s/语句60s、独立事务；覆盖检查在DDL锁之前，外部必须先证明所有旧writer退出。
- 只扩展既有 scripts/test-openrouter-retirement-local.sh / openrouter-retirement-local.mts，不新建测试文件/状态源/通用框架。

原主表 DROP 及其他历史 SQL 字节未改。本轮没有对1797条历史JSON自动复制/清空，也没有对1281条无snapshot历史行补扣、补写假settled_at或移除守卫。它们不被认定为新调用失败；原主表DROP仍会拒绝，需独立审阅分类/处置。此限制不阻止专表独立contract。

## 本地验证

- Backend 85 files / 683 tests；Shared 15 files /147 tests，全通过（合并dev后基线新增测试，非本轮创建产品测试）。
- pnpm -r typecheck、额外Backend+.mts harness tsc --noEmit通过。
- pnpm -r --workspace-concurrency=2 --if-present build通过；适用Frontend/Admin/CS构建，Backend/Shared/Renderer无独立build脚本。Admin原有bundle体积提示。
- pnpm lint、lint:imports、lint:legacy、lint:migrations通过。
- pnpm test:migration-ledger、旧original-fields migration隔离PG回归通过。
- bash -n及git diff --check通过；task/jsonl和module payload校验见最终审阅包。
- PG17 + PostgREST16.4真实数据库验证：先删除专表11别名，再物理删除主表12列；实际Supabase client/repository的输入/正文/上下文/终态、provider ID CAS/并发/冲突、NULL-ID不清ID、metadata待回捞扫描/写入、billing outcome/recovery候选、cancel/late stop、Venice、current/latest revision和analytics视图/CS权限通过。
- SQL拒绝路径：别名view依赖、非空冲突、未知混合CHECK、2001待补齐候选、重复contract；正向核对11组字段从旧值补NULL、全数字0保留、canonical负token约束继续有效、业务父行完整不变、ID保留。原主表未知/JSON/历史结算等拒绝路径继续通过。

可重复本机命令：

```sh
OPENROUTER_TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin OPENROUTER_TEST_POSTGREST_BIN=/private/tmp/openrouter-retirement-tools/postgrest bash scripts/test-openrouter-retirement-local.sh
OPENROUTER_TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin bash scripts/test-openrouter-original-fields-migration.sh
pnpm test:migration-ledger
```

PostgREST为本机临时官方二进制，不是仓库新增依赖。隔离fixture不能替代真实上游、钱包/额度RPC故障注入或Railway多副本验收；没有用mock声称完成真实业务验收。

## 实时证据与差异

- PR430 MERGED，merge f15fb73d9c95bc4ccfcab747ee4bb36501e78bcc。dev新部署 de247e4f-7931-4702-b6e3-868b8e27e847 / f15fb73d SUCCESS；旧dev bc82947a REMOVED。PR425上次仍为5856cc3、共享TEST，未由本轮停止或升级；执行前重查。
- TEST ref zoqelpfhurwehlvypryl。13:52 UTC只读预检：11对字段的canonical缺口/非空冲突均0；主表DROP/新增专表DROP均无repo_migrations账本。catchup/views已在TEST执行且checksum匹配，不重跑。
- PR430用户真实对话后只读聚合：3条success/stop，输入/回复/上下文/快照/结算均有、专表ID全部持久化、主表12旧列全空。专表usage/finish_reason为空视为待回捞，不算失败；无provider重叠/占位缺失。全库legacy ID保全缺口0，主表旧列pg_depend为0，函数体关键词未见直接旧列候选；current 1307行与预期一致、34列类型匹配，核对ID/latency/业务finish无差异。文本/catalog检查不能排除外部分析或动态SQL。
- TEST最近catalog current.reloptions=NULL，与T5记录security_invoker=true有差异；本轮专表contract不改视图定义/owner/ACL/security mode。实际角色读取仍需目标环境复核，不将文档旧记录当实时权限证明。运行日志未成功取得，未声称运行期间零旧列访问。
- Production未在T9重做别名数据覆盖/冲突/约束/容量核验，不能把TEST零冲突当Production事实。四份历史migration前轮账本证据仍有时效边界。

## 逐文件推进与恢复

所有共享数据库的旧writer/reader升级或退出并覆盖窗口后，可先执行新增专表contract，验证新发送/回捞/角色查询，再推进主表历史治理与独立DROP。不要按字典序或一次workflow跑多个文件。已记账的catchup/views不重跑，窗口若产生新增缺口另审forward migration。

1. packages/shared/migrations/20261016_openrouter_chat_history_drop_legacy_aliases.sql
2. packages/shared/migrations/20261016_chat_history_drop_provider_metadata.sql（当前历史JSON/结算/共享旧consumer/运行门禁未通过，不能直接执行）

删列后仅用已验证两处列不存在的canonical Backend SHA或reviewed forward-fix；旧别名writer不能回滚使用，重加NULL列不等于恢复数据。不做VACUUM FULL或表重写。

## 新增 SQL 最终校验值

`20261016_openrouter_chat_history_drop_legacy_aliases.sql` SHA256：`0df338659b344fb3575ea9880b47ebce43b9187d0b00a2229221562d85e54745`。其余历史SQL及原主表DROP无diff。
