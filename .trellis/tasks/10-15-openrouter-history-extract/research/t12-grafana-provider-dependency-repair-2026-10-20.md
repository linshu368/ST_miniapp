# T12 Grafana 旧字段依赖前向修复（2026-10-20）

## 授权、来源与环境

用户明确要求直接修复、验证后提交推送。范围是现分支dev_openrouter_migrate的本地修复与Git交付，不执行远端migration/合并/部署。保留原Admin preview及问题汇总dirty。复用既有10-15-openrouter-history-extract任务，规划先于实现，T12归属/复用/可靠性/恢复与验证见PRD/design/implement/task。

失败Action39372233798（main/ca44cd17，2026-10-20T04:57:25Z）实际运行的是`20261016_openrouter_chat_history_drop_legacy_aliases.sql`，不是用户口述history_disposition；在UPDATE/DROP前依赖守卫拒绝并回滚。Production wbtsfzozlmurljvglhpn经get_project确认PG17.6/ACTIVE_HEALTHY；本轮MCP仅catalog只读，直接PG只读事务只采TEST对象/ledger与生产调度元数据，不采业务行/正文/凭证。

生产直接依赖：analytics_grafana.v_llm_calls引用OR旧别名及主表待删metadata；mv_free_quota_daily引用旧usage；mv_card_unit_economics_30d引用旧usage/finish_reason，且两MV也有主表待删列依赖。两MV的直接包装视图分别为v_free_quota_daily/v_card_unit_economics_30d；后者下游还有v_card_unit_economics_trusted_30d。v_llm_calls的下游还包括mv_strategy_model_daily、v_billing_daily_live、v_data_freshness、v_llm_calls_canonical、v_model_hourly、v_provider_daily。不能CASCADE处理。

采样对象owner均postgres。v_llm_calls、card MV向grafana_reader SELECT；free MV只有owner ACL；card包装视图还向grafana_cloud SELECT。两MV各有一个完整唯一索引。所有目标列ACL为NULL，MV options为空、heap默认tablespace、已填充。源定义不在仓库，为避免猜测以2026-10-20真实pg_get_viewdef结构构造合成fixture，未加入任何生产行。定义文本指纹逐对象约束替换；发生DDL漂移停止。

TEST zoqelpfhurwehlvypryl（2026-10-20T05:07:26Z只读）不存在analytics_grafana schema；恢复catch-up新文件已记账，其余OpenRouter历史文件/两处DROP已记账。新文件在该环境跳过，不创建外部报表schema。TEST跳过不代替生产分支验证。

## 实现与边界

新增`packages/shared/migrations/20261020_grafana_provider_metadata_dependencies.sql`，checksum `0c1439fc877761578a01e700a2f4e5e1d0e7d6d569b71e50cd3bc0523ca2b459`。保留所有已执行文件及原alias DROP的依赖守卫、checksum和同checksum失败claim；新文件成功后，再正常apply原alias文件，force_rerun=false，无需abandon_claim。

- 域归属为miniapp_analytics的派生分析；只原地维护现场analytics_grafana兼容表面，保留外部Grafana/调度使用的名称，不新建schema、业务真相或公共API。源码仍仅experience/billing/app_core权威写入。
- 精确校验5对象源定义、kind、2索引、既有MV存储shape、grantor与已知直接下游；schema缺失跳过，部分存在/漂移/未知依赖/暂存名冲突拒绝。重入时若五对象已无待删列依赖，则不改对象。
- 替换仅限已核对定义中的o旧别名、ch待删metadata到OR canonical；保留Venice映射、ch.llm_finish_reason、全部汇率/单位/星尘/终态/人群公式。canonical是新权威，历史滞后父值不再优先，不承诺滞后旧值与新报表数值完全相同。
- canonical缺失由同一OR行旧别名只补NULL；非空冲突/provider重叠拒绝。先物化最多2001个候选ID，超过2000停止，实际写入仅该ID集合；不改父行/正文/账务/原始JSON。
- 两MV先在\_or_new名称WITH DATA构建并建唯一索引；`psql \gexec`让每条CREATE均受原60s statement_timeout限制。无需新函数/后台worker；正式runner本来用psql --file，回归以同一方式执行。
- 暂存完成后用同schema ALTER取得对象DDL锁，再复核OID、定义、owner/ACL/options/comments/列与索引；短切换保留MV原名称、wrapper和v_llm_calls OID，并原样恢复ACL/grant option/注释/唯一索引名称。新MV默认授予的额外ACL全部撤销。未知MV列ACL拒绝而非忽略。
- 最后RESTRICT删除旧MV，检查列名/序/类型/ACL/comments及整个analytics_grafana零待删列依赖。所有步骤一个事务；构建、漂移、权限、锁5s、语句60s或任一守卫失败整笔回滚，不上线空/未填充MV，不自动重试。

生产cron只读元数据确认：grafana_free_quota_daily_6h为`14 1,7,13,19 * * *`，grafana_card_unit_economics_30d_6h为`23 1,7,13,19 * * *`，strategy任务为`8 1,7,13,19 * * *`。保留原MV名/唯一索引，不修改调度。数据库cron时区本轮未核对，不把这些表达式直接换算为北京时间；执行前避开实际刷新窗口。其他下游缓存沿既有调度自然刷新。

## 验证

扩展既有scripts/test-openrouter-retirement-local.sh，新增仅含真实catalog定义与合成行的scripts/openrouter-grafana-retirement-fixture.sql；迁移/权限/不可逆DDL风险确认需要该fixture。验证旧对象确实阻断原alias DROP；修复后真正删除专表11别名与主表12列，真实PostgREST repository、报表和三个同名并发MV刷新都可运行。

覆盖无schema跳过/部分schema拒绝、源定义漂移/未知依赖/provider重叠/非空冲突/2001候选拒绝、第二MV构建失败使首MV及canonical补齐回滚、暂存阶段metadata漂移回滚、父行逐字段与账单不变、NULL/0、OR USD与Venice微USD换算、CNY系数7、星尘115与main/bonus拆分、免费额度聚合、取消终态不变、报表列契约/owner/ACL/default ACL撤销/comments/索引、所有保留view及下游OID、迁移重入、双DROP后查询/并发刷新。初次测试因将索引OID也纳入“应保留的视图OID”断言失败，已收紧到v/m对象；重建索引保留名称/定义，不要求其OID不变。

已通过Shared147测试、全仓typecheck/build、lint/legacy/migrations、ledger协议。隔离PG17+真实PostgREST最终完整通过；task validate、module_knowledge check及git diff --check均通过。Admin build仅既有chunk体积提示；无Backend/Frontend/Admin产品代码变动，真实DB消费者由集成回归验证。

## 执行顺序与恢复

1. 从本次推送分支运行正式Database Migration：TEST/apply新增20261020_grafana_provider_metadata_dependencies.sql、force_rerun=false。当前TEST预期schema absent跳过并记新ledger。
2. 独立核对Production目标/磁盘与WAL余量/刷新与流量窗口/旧writer退出/源定义未漂移，再经独立授权Production/apply同文件。不会由push自动执行SQL。两张MV采样heap约160KiB和32KiB，但底层查询/临时空间、生产整份耗时与复制滞后尚未实测，不拿本地小样本当性能放行证据；60s/5s失败停止。
3. 验证新增ledger/checksum、零旧列依赖、列契约/权限/索引/填充状态、Grafana看板与后续刷新，再正常apply原20261016_openrouter_chat_history_drop_legacy_aliases.sql。保留原claim即可按原checksum续跑，成功后工具清claim。
4. 再独立核验history_disposition（仍有2000预算与不可恢复诊断清理边界），最后主表DROP（依赖/覆盖/账务/运行门禁）。本修复不批准这两个后续文件。
5. 任一错误停止、核对事务/ledger/shape/claim；不force_rerun改预算，不改旧migration，不CASCADE。失败自动恢复旧完整对象/数据；成功后优先兼容forward-fix，禁止退回引用已删列的旧报表定义。
