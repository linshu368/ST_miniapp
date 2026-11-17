# Task Breakdown

## 2026-10-29 用户批准增补

- Q1 Done：统一客户端平台/网络快照与白名单、既有测试回归通过。
- Q2 Done：短剧成对播放/卡顿时长增量与生命周期回归通过。
- Q3 Done：三板已补两项筛选与三张质量卡，64条LogQL及TEST合成实收核验通过。
- Q4 Release pending：全范围review、602测试、类型/lint/build完成，文档已更新，待正常独立分支推送与固定SHA生产发布；不得将用户暂缓真机复测当作已实测。生产实际交付另记test-rollout。

状态：in_progress。本地实施与基础验证已完成；TEST/Cloud、真实设备、资源开销对照和生产切换仍未完成。Done仅表示该阶段明确列出的内容已验证，不代表已部署。

| ID  | Status  | Deliverable / scope                                        | Depends on            | Verification                                                                       |
| --- | ------- | ---------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| P0  | Done    | 前端/后端/部署现状、业务与纯遥测边界研究                   | 用户建任务授权        | research三份只读报告与官方接入参考                                                 |
| P1  | Done    | PRD/design/implement/task及manifest形成                    | P0                    | 门槛自查、task validate；待用户审核不是实施完成                                    |
| T0  | Done    | 用户批准实施；fetch并验证dev/main同树，分支已建立          | 用户明确批准本规划    | manifest/module impact齐备；生产实际运行SHA仍留上线门禁                            |
| T1  | Done    | 前端Faro、后端显式Meter/Logger，默认关闭                   | T0                    | no-throw/单例/脱敏/队列/401/429/超时回归；无新global tracer                        |
| T2  | Partial | 固定Alloy配置与本机Faro→Loki已验证；没有创建TEST服务       | T0,T1                 | v1.21.0实际validate通过；真实托管入口/凭证/配额/预算待确认                         |
| T3  | Done    | 20页面模板、导航/错误/缓存终态、API排队与全程已实现        | T1                    | 单元回归与手机场景；真实Telegram仍待验证                                           |
| T4  | Done    | HTTP/Prisma/runtime/生成attempt和logical、短剧服务分段投影 | T1                    | 后端107文件1037测试通过；原业务end_reason/计费/恢复保留                            |
| T5  | Partial | 四张工程看板源和口径runbook完成，尚未导入线上              | T2,T3,T4              | 51条LogQL本机执行；页面8成功2失败及P95=1000ms；14条PromQL只验证语法，Cloud样本为空 |
| T6  | Partial | 本地类型/构建/测试与独立review完成，真实TEST未启用         | T5                    | 详见validation.md；资源对照/生产Node运行验证/真机/Cloud需继续                      |
| T7  | Todo    | 单独批准生产、24–48h基线与建议一周双轨                     | T6及生产启用/费用批准 | 同窗版本/样本/覆盖/DB无新增遥测I/O/回滚演练                                        |
| T8  | Todo    | 退役已被替代的纯监控读写、维护说明和模块facts              | T7                    | 业务/首字回执/计费恢复不动，经营看板与历史可用                                     |

## Execution log

- 2026-10-29：用户批准仅建任务与规划。创建本目录并完成并行只读研究；未启动任务实施、未改产品代码、未部署、未改数据库或Grafana。
- 2026-10-29：用户明确批准实施，重点页面/角色扮演/短剧；核验main=eec9f3fd、dev=4e1ed2eb同树后start，分支codex/grafana-performance-observability。
- 2026-10-29：本地实施、固定采集器配置和看板源完成；独立review发现的缓存错误ready、stalled假卡顿、过滤/长度/系统超时分类问题均已修正并补回归。没有提交、推送、发布或创建收费服务。Cloud当日只读查询无st\_\*样本，维持待接入。
