# 轻量经营与真实首字体验

运营入口收拢为两张看板：`st-model-overview`（经营核心）与 `chat-first-token-manual`（真实点击到可见token）。其他4个旧链接保留迁移说明，不再执行查询/变量查询。旧表和历史缓存保留，11个旧全历史cron退出。不要再整体启用旧缓存任务。

## 口径与开销

- 请求按每条生成history记录计，包含重试/重新生成；不是筛掉旧revision后的故事轮数。余额拒绝不计。
- 用户是当日发起聊天的不同用户；全局单独COUNT DISTINCT，不能把型号人数或每日人数相加当作周期独立用户。
- 成本只展示已记录美元成本（计费真实成本优先，再按已保存供应商标量补充）。缺报不填0，真实0计已记录；未交付的其他上游尝试可能另有成本，因而是下界。原始样本与记录率并列，不自动按小样本排名。
- 星尘取已终态扣费记录，充值实收取completed支付订单的paid_at/amount_cents。不同币种与确认时点不直接计算毛利。
- 一个聚合缓存，明确overall与model两种grain，保存近14天；默认看7个自然日。每30分钟只重算今天/昨天，先按created_at日范围过滤，再关联唯一charge/provider键；不扫描全历史账本或用户生命周期。极晚回报和更旧时段不自动重算，需明确目的后单日补算。
- cron每条SQL执行最多5秒、锁1秒、禁并行；事务advisory锁防止竞争。任何异常回滚保留上一份快照，刷新时间与记录率对用户可见。旧日报冻结、新表未采集的日期不补0。

## 交付与恢复

源：`20261026_grafana_light_core.sql`、本目录JSON。JSON数据源`${DS_POSTGRES}`发布时绑定现有生产只读数据源`fg1oltvmm56v4b`。

真实本地PG测试：`bash scripts/test-grafana-light-core-local.sh`。验证聚合、北京日界、原型号、缺报/0、支付和星尘分离、失败原子性、权限和同批SQL超时。

TEST与生产依次通过Database Migration workflow执行单文件。迁移只建轻量对象并退出旧job，不做全历史回填，新job首次关闭。以调用方5秒上限逐天引导近14天，生产当天必须通过实测后才能启用`grafana_core_recent_30m`。缓存和看板读取验证后发布。旧看板/cron定义保存在本次执行环境`/private/tmp/*-before-light.json`与`st-grafana-legacy-cron-backup.json`，不包含密钥/业务行。

恢复：关闭新cron即可停止维护，原始业务/钱包/历史对象不变；旧重查询不能因为恢复旧面板而自动重新启用。上线记录见Trellis任务10-26-grafana-light-core，不以源码声明代替远端验收。
