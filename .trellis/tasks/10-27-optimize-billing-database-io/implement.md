# 执行计划

1. 核对 upstream/release migration、最终 follow-up 和当前分支差异；计算 Git blob SHA-256。
2. 只读采集 TEST/Production 索引 valid/ready/定义、Production 账本和等值 EXPLAIN。
3. 监控 Railway main 发布至终态，检查主服务健康、启动日志与发布后短窗口数据库慢日志。
4. 记录验证结果和剩余风险；运行 Trellis validate、migration lint（对权威上游内容）与 `git diff --check`。
5. 对账生产 sync job 新基线与两条扫描 EXPLAIN；确认没有新增索引证据。
6. 在现有 repository 增加 OpenRouter 批量读取；在 sync job 增加 3 路行处理、状态指纹退避、无变化不写与汇总日志。
7. 扩展现有测试文件，覆盖批量读取、并发上限、退避/状态变化/stale 例外和未完成计费短路。
8. 运行 backend 相关测试、typecheck、lint、build、Trellis validate 与 `git diff --check`；不执行 DDL、不部署、不 push。

失败路径：批量读取失败按 OpenRouter 分支失败隔离；单行 provider/DB 失败保留下一轮重试；退避 Map 超限淘汰最旧项；业务指纹变化立即取消退避；stale streaming 永不延迟。索引无效/shape 不符、checksum 漂移、发布失败、健康检查失败或发布后仍出现同类新慢查询时停止，保留现有线上版本并基于具体失败进入 forward-fix；不盲重跑 migration。
