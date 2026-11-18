# 数据库重组阶段 2：观测外迁

## Goal

把观测数据（O）从业务 schema 挪进 `ops`，看板只经 `miniapp_analytics` 读。上游调用拆成两部分：身份留在 `experience.chat_generation_attempts`，明细与成本进 `ops.llm_calls`。阶段 6 计费只依赖身份，不依赖 `ops`。

先修经营看板日汇总刷新（2a）：它每天下午起频繁超时，看板停更。

## Requirements

1. 2a：`miniapp_analytics.refresh_grafana_core_day` 不再逐行随机查供应商明细表；今天、昨天拆成两个定时任务，互不连坐。口径不变。
2. 之后的子步骤（2b 起）按 design.md 逐个设计：上游调用合并、`chat_generation_requests` 纯测速列外迁、其余 O 表进 `ops`、看板视图改读 `ops` 并收回读者对 `experience` 的直接授权。

## Acceptance Criteria

- [ ] 2a：本地 PG17 上新旧函数在随机合成数据上逐行一致；生产执行后连续多次刷新成功，看板「最近两日数据更新时间」不超过 30 分钟。
- [ ] 每个子步骤的 migration 先过本地 PG17 脚本，再执行 TEST、生产。
- [ ] 迁移前后同一时间窗的首字 P95、超时率、畅聊成本、支付告警数字一致。
- [ ] registry 中 phase 2 的条目回写为最终状态。

## Android/iOS 性能 P95 门禁

2a 只改分析缓存的刷新函数和定时任务，不在 MiniApp 请求链路上。后续子步骤若改到请求链路的写入，在对应 design 段落单独评估。见 `task.json.meta.mobile_performance`。
