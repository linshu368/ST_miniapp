# 验证记录

## 产物

- 周报：`D:\JobExe\ST\sentry\2026-11\2026-10-26 至 2026-11-01 周性能报告.md`
- 主环境：Sentry `wangqiao/st-miniapp`、`production`。

## 查询验证

- 逐一查询 7 个 48 小时重叠整窗，边界均按 Asia/Shanghai 转换为 UTC 右开区间。
- 页面导航与 pageload：Sentry `spans`，分别过滤 `span.op:navigation`、`span.op:pageload`。
- 普通接口：仅 Sentry `span.op:http.server`；已从普通接口表排除聊天 `messages/regenerate`。
- 错误：Sentry Logs `api.request_failed`、Errors count、`http.server` 4xx/5xx 分路由聚合。
- 依赖：Sentry `span.op:http.client AND span.status:internal_error`，按 `span.domain` 聚合。
- release：按 `http.server` span 聚合并与本地 Git 提交元数据交叉核对。
- Trace Metrics 清单在目标周仅发现 `http.server.duration`，未发现 `sse.stream.duration`；切换实现 `a01f5f63` 的提交时间为 11 月 2 日，超出报告窗口。

## 限制与处理

- Sentry 技能自带 issue 查询因令牌 issue 权限不足返回 403；报告没有把权限失败写成“无 Issue”。
- Error Dataset 聚合明确返回 0，但 Logs、4xx/5xx 和失败 span 非零；报告将其归类为可观测性问题。
- Grafana 登录看板本次重新读取超时；只引用 10/30、10/31、11/01 已保存日报中的已验证 24 小时结果，并明确不与 Sentry 48 小时 P95 混算。
- 所有缺日报、未上线指标或查询无行均写“无可见样本”，没有补零或推断数值。
- 相邻 Sentry 窗口共享 24 小时，报告已在趋势分析中说明相关性与故障移出窗口效应。

## 文件检查

- 报告包含窗口、release/SSE 口径、页面导航、首次加载、普通接口、日志、4xx/5xx、依赖失败、Grafana 补充、峰值/拐点/恢复、P0/P1 与验证指标。
- 本任务不修改产品代码、数据库、依赖或运行时配置。
