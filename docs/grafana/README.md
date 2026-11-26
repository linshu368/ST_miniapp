# 轻量经营与真实首字体验

页面体验、角色扮演和短剧工程性能的独立遥测实施见 [工程性能验收](engineering-performance.md)。四张 `st-engineering-*.json` 是待 TEST Cloud 接入验证的源文件，不表示已上线；既有经营/首字/短剧看板和业务事实保持不变。

短剧启动诊断看 `st-engineering-drama`（Loki）。旧 SQL 看板 `st-drama-playback` 及其表、视图、函数已于 2026-11-17 删除（数据库重组 2b）。Loki 链路的发布与真机步骤见 [操作说明](drama-playback-runbook.md)。

运营入口是 `st-model-overview`（经营核心）；首字与兜底监控在 `st-engineering-roleplay`。`chat-first-token-manual` 只剩迁移指引，原 4 个"已合并"看板和 TextBot 系列已于 2026-11-04 删除。旧表和历史缓存保留，11个旧全历史cron退出。不要再整体启用旧缓存任务。

## 聊天成功率与首发失败（2026-11-24）

`st-chat-success.json`（uid `st-chat-success`，Prometheus `grafanacloud-prom`）。数据是后端每轮聊天结束时上报的 `st_chat_turns_total{platform, model, lane, outcome, primary_outcome, rescue}`，口径实现在 `packages/backend/src/features/generation/turn-outcome.ts`，不经 Supabase，没有 2026-11-24 发布前的历史。

- 用户失败（`outcome`）：首发 + 首字兜底 + 出字后重写之后，用户最终仍是报错 / 中断 / 拒答 / 超时。
- 首发失败（`primary_outcome`）：报错＝出字前失败（含由兜底交付）；中断＝出字后卡住、流内错误、断开、被截断；拒答＝正文开头命中运营词池（`chat_recovery_config`，开关关着也判）或供应商内容过滤；超时＝首字兜底真正替它交付，或谁都没出字。
- 余额/VIP 拒绝、用户停止不计。`rescue`：none / fallback（首字兜底交付）/ rewrite（出字后重写成功）。
- 只看在架模型（2026-11-26）：后端每次导出（15 秒）上报 `st_chat_model_listed{platform, model, lane}=1`，名单 = 模型目录里启用的（lane=chat）+ 畅聊快照在架的（lane=free_zone，上游按 `freeModelUpstream`），实现在 `features/generation/listed-chat-models.ts`，标签与 `st_chat_turns_total` 同走 `identity()`。看板每个计数子式（含「模型」变量）在聚合前 `and on (platform, model, lane) (… @ end())`，按时间范围终点那一刻的名单过滤；下架模型的历史不再显示。名单指标 2026-11-26 发版后才有，时间范围终点早于发版时看板为空。后端没上报名单（进程刚起、遥测关闭）时整张看板为空，属预期。
- 计数用「区间末值 − 区间起点值（区间内新出现的组合按 0）」，不用 `increase`：每个标签组合第一次出现时起始值已是 1，`increase` 会丢这一条，发版后标签带新版本号也会重新出现，少见的失败类型会被系统性少算。
- 布局：大盘卡片与走势；视图 1 每个模型的用户失败率 + 救回表；视图 2（横条，`失败类型` 下拉）与视图 3（明细表，调用数 + 四类 + 总失败率）同一行。其下一行按小时看：首发失败率热力表（总览，平台 · 模型 × 小时），下面每个平台 · 模型一张小图（按「模型」变量重复，3 个一行）：每小时首发失败率按四类堆叠，柱高 = 当小时总失败率，红虚线 10%，纵轴固定 0–60% 便于横比（小图太矮时自动刻度会撑到 100%），悬停另显示总失败率和调用数。都跟随「失败类型」「栏目」；「模型」可多选，只决定出哪些小图。「模型」变量用 `query_result` + 正则取值，值是可直接拼进选择器的 `model="…",platform="…"`（依赖 Prometheus 返回标签按字母序），全部 = `platform=~".+"`。按小时的桶用 `offset -$__interval` 往后取，格子画在哪个整点就是那一小时的数，最右一格是当前未满的一小时。

## 状态栏与记忆栏质量漏斗（2026-11-24）

`st-panel-quality.json`（uid `st-panel-quality`，Prometheus `grafanacloud-prom`）。数据是后端每次调状态/记忆模型、每次更新结束时上报的 `st_panel_attempts_total`、`st_panel_updates_total`、`st_status_items_total`，归因实现在 `packages/backend/src/features/status-bar/panel-quality.ts`，没有发布前的历史（补算基线见任务 `11-24-panel-quality-monitor` 的 design.md §7）。

- 看板按两个阶段排，状态栏与记忆栏各自一套：总览（整体成功率、样本量、每小时结果分解）→ 第一阶段（能不能从模型拿到原材料：整体不可用率、首发不可用率、兜底不可用率，按错误码的原因占比与明细）→ 第二阶段（拿到原材料到最终展示）。
- 状态栏整体成功率 = 完美更新 ÷ 全部更新；完美 = 落库且每一项本次写对、面板按样式组件显示。沿用旧值算失败，"暂无"不算失败、单列。记忆栏整体成功率 =（记下 + 没进展）÷ 全部检查。
- 第二阶段四步的分母都是全部更新（检查）次数，`整体成功率 + 第一阶段整体不可用率 + 四步 = 100%`。状态栏四步：① 认不出是状态栏 ② 和模板对不上（有项沿用）③ 写库失败 ④ 显示错位；记忆栏四步：① JSON 解析失败 ② 内容检查不过（含合并超限）③ 写库报错 ④ 写库冲突。每次只归一个原因（模型 > 格式 > 写库 > 对账 > 显示），跨首发 / 兜底按走得最远的一层归因。
- 各步下方的明细按尝试统计（首发、兜底分开），包含被兜底救回的问题，用来指导提示词和规则修改。
- 触发层（2026-11-25）：`st_panel_triggers_total{panel, outcome}`，回复成功后自动更新的判断结果（not_due / not_applicable / started / busy / aborted / check_failed）。应触发未触发率 =（撞上进行中 + 没跑到模型 + 判断时读库失败 + 进程重启丢失）÷ 应触发次数；进程重启丢失 = started − 有结果的自动更新。只统计自动触发，不受「触发」筛选影响；这部分不进入两个阶段的统计。
- 模型错误码（2026-11-25 起）：原来的 incomplete 细分为 truncated 截断、content_filtered 被内容审核拦截、stream_interrupted 流中断、stream_error 上游中途报错、missing_done 结束了但没收到结束标记、unfinished_other 其他；归类规则见 `features/generation/status-bar-model.ts` 的 `unfinishedCode`。`*.primary.failed` 日志另带 finish_reason / native_finish_reason / stream_error 原始值用于核对。
- 计数沿用本目录"区间末值 − 区间起点值"的写法，不用 `increase`。不做告警。

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

数据源连接池每个Grafana实例最多1条连接、闲置连接0条、连接生命期60秒，沿用数据库角色3条连接上限；先排队而非通过扩容连接制造压力。页面验收需确认没有连接超限，SQL成功并不等于所有面板渲染成功。金额和含英文的列名使用明确别名，人民币使用显式¥前缀，避免单位回退为内部名称。

## 首字交付 v4（2026-10-28 修复候选）

`chat-first-token.json` 默认 `client_committed_v4`：点击到首个正文/已开启思考 token 进入 React 已提交消息界面，不检查滚动位置或像素，不称为实际阅读。网络接收时间只用于排查；收到但截止前未提交仍是超时。每轮首份终态固定，迟到恢复不改写成功分布，成功样本严格早于该轮总上限。

前台超时率分母为已知结果（成功交付、时间截断、其他上游错误）；离页/后台、手动停止、缺报单列。新客户端在请求受理时声明版本，沿用既有请求 INSERT 写入 measurement_method，缺报也计在 v4 请求总量中。历史 v1/v2/v3 保持旧数据和定义，用版本选择器独立查看；v4 的 150 样本门槛不借用历史屏幕观测样本。服务端无首字截断另列，不能代替客户端交付数据。

发布前置：`20261027_recoverable_chat_delivery.sql` 后执行 `20261028_client_committed_first_token.sql`，然后 Backend、Frontend、看板。新迁移只替换既有函数、复用既有字段与权限；无历史回填、新表、索引、cron、连接或客户端轮询。5分钟刷新、现有只读连接限制保持不变。数据库保留 first_token_visible_ms 字段名兼容旧版，其含义由 measurement_method 决定。

本地验证复用 `bash scripts/test-first-token-fallback-local.sh`：PG17 实跑重复迁移、一次终态/回执无UPDATE、早收晚提交免扣并释放预留（2026-11-02 起由服务端交付计费取代，见 first-token-fallback.md）、离页与主动停止计费、历史隔离、缺报统计及全部导出看板SQL。仓库修改不代表远端已发布；回退应用/旧版本筛选即可，保留已写v4事实，数据库问题使用forward-fix。

## 首发与兜底竞争策略（2026-10-28）

客户端观测继续使用v4。默认首发派发4秒无首字启动兜底，首发继续，两路共享原10秒总截止；先出有效首字者负责交付，败方立即停止。“首发等待”保留旧列名，现表示启动兜底阈值；“兜底预留时间”对应原 `fallback_timeout_ms`，默认2000ms只用于前置过慢时提前启动兜底，不再是兜底自身的2秒硬时限。

本次只调整看板文案、列名与单位匹配，不改变现有查询逻辑/数量、时间窗、5分钟刷新或只读连接限制。兜底触发率仍统计所有已启动兜底的请求，即使首发最终获胜；实际替代看“已交付样本中兜底占比”，不把两者混用。并发尝试的耗时不相加，业务总耗时仍取同一客户端请求的交付记录。

以实际生产上线时刻分开观察前后窗口。上线前 `fallback_timeout_ms` 仍是旧兜底硬时限，不能因字段值相同而与新预留策略合组；不重算历史、不升级测量版本。败方已收到的诊断片段仅在受控业务存储保留，不加入Grafana视图或指标列权限。源文件完成不代表在线版本已发布。
