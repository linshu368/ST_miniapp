# 数据库重组阶段 1：地基与清理

## Goal

为后续搬迁打地基，并清掉已确认没用的结构：

- 建 `ops`、`cs_feed`；
- 让客服仓库只读视图层，收窄外部只读账号；
- 合并两个分析 schema；
- 删除死表、死列、死配置；
- 把 admin 托管配置的 24 层包装函数改成登记表。

## Requirements

1. 1a：新建 `ops`（只给 service_role）与 `cs_feed`（`user_identities`、`user_profiles` 两个视图，输出列与客服现有 SQL 一致）。
2. 1b：客服仓库 4 个 domain 文件改读 `cs_feed`；画像簇提示与 README 写明可读范围。
3. 1c：收回 `cs_runtime_v1` 对业务表的直接读权限；`cs_persona_reader` 只保留 `cs_feed` 与 `miniapp_analytics`；删除 `cs_outreach_reader_v1`。
4. 1d：删除 `users.st_handle`/`st_initialized_at`、`wish_roles`、`cs_platform`、`miniapp`、`public` 残留函数与两个停用 cron；`botlinks` 列名改小写；`drama_survey_responses` 迁入 `miniapp_features`。以 Supabase 每日备份为归档。
5. 1e：`admin.managed_config_keys` 登记表取代 `*_before_*` 包装链，校验行为不变；复核并删除无人读取的 runtime_config key。
6. 1f：`analytics_grafana` 并入 `miniapp_analytics`，Grafana 面板 SQL 同步替换，数值前后一致。

## Acceptance Criteria

- [ ] 每个子步骤的 migration 先通过本地 PG17 脚本验证，再执行 TEST，然后由所有者确认后执行生产。
- [ ] 客服工作台的资料卡、对话列表、回访、告警在 1b 上线后与切换前一致；1c 之后客服账号直接读业务表报 permission denied。
- [ ] 1e 前后对每类托管 key 的草稿校验结果一致。
- [ ] 1f 前后 Grafana 面板在同一时间范围的查询结果一致。
- [ ] registry 中 phase 1 的条目全部回写为最终状态。

## Android/iOS 性能 P95 门禁

不涉及 MiniApp 页面与接口：cs_feed 只给客服服务读；admin 托管配置校验只影响运营平台发布；删除的对象已没有读者。见 `task.json.meta.mobile_performance`。
