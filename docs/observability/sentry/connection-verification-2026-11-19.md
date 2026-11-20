# Sentry连接与指定范围取数核验

核验日期：2026-11-19，Asia/Shanghai。使用已授权的Sentry连接，没有新增密钥、SDK、告警或定时任务。

## 已确认

- 组织：`wangqiao`，区域：`https://de.sentry.io`。
- 可读取项目：`st-miniapp`，项目ID：`4511818663788624`。
- 只读调用：`find_organizations`、`find_projects`、`search_errors`，均成功。
- 本地指定窗口：`[2026-11-17 15:00:00 +08:00, 2026-11-19 15:00:00 +08:00)`，共48小时。
- 实际执行UTC范围：`[2026-11-17T07:00:00Z, 2026-11-19T07:00:00Z)`，`statsPeriod: null`。
- 筛选：`environment:production level:[error,fatal]`。
- 实查结果：203条事件，17个去重Issue；按Issue分组返回17行，事件数合计203，与总览一致。
- 抓取时点：2026-11-19 17:12—17:14北京时间；历史补报可能使后续查询计数变化。

[打开本次绝对范围查询](https://wangqiao.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&project=4511818663788624&query=environment%3Aproduction%20level%3A%5Berror%2Cfatal%5D&field=count%28%29&field=count_unique%28issue%29&start=2026-11-17T07%3A00%3A00Z&end=2026-11-19T07%3A00%3A00Z&mode=aggregate)。页面打开时会读取当下数据，可能与本次快照不同。

## 统计边界

这是连接和时间范围能力核验，不是本期正式错误分析报告，也不说明问题均未修复。本次没有改动Issue状态或生成新的产品修复。

203条是`production`标签下的结果，尚未逐事件按正式来源和release核实；预览环境可能使用同名标签，不能直接当作已核验的正式生产故障数。没有额外确认后端或其他项目的完整覆盖。

按Issue查询 `count_unique(user)` 时，部分Issue为0，说明此维度没有识别到用户标识，不能据此宣称无人受影响。本次没有计算完整受影响人数、OS分布、错误率或修复收益。

绝对起止范围通过 `search_errors` 查询里的 `timestamp:>=… timestamp:<…` 指定；工具实际将其落为绝对范围，本次检查了返回的 `executedSearch`。后续每次查询都必须复核，不假设相对period或Issue搜索的period等价于用户指定范围。

## 后续报告安排

用户已确认每周二、周五北京时间15:00，先交付流程和模板、暂不启用自动定时任务。本次已形成[流程](README.md)、[错误报告模板](templates/error-report.md)、[修复情况模板](templates/repair-report.md)和[执行指令](prompts.md)。
