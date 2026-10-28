# 可执行任务分解

- [x] P0 核对现状、用户目标和原价一次结算；建立planning任务与feature分支。
- [x] P1 只读研究配置/前端显示/调用与账务/数据库归属；明确完整指标和厂商对照。
- [x] P2 整理PRD、设计、执行/恢复方案与模块影响；确认全局6秒/1%目标。
- [x] P3 用户已在后续消息明确批准最新摘要；按项目流程start。
- [x] S1 shared：阈值与first-token/report契约（依赖P3）。
- [x] S2 database：additive schema/validator/selection与报表（依赖S1与八域设计）。
- [x] S3 backend repository与有限双尝试编排（依赖S1,S2）。
- [x] S4 backend billing/cancel/sync兼容与高风险回归（依赖S3）。
- [x] S5 Admin手动阈值保存/发布/恢复（依赖S1,S2）。
- [x] S6 frontend首token可见测量与鉴权回报（依赖S1,S3）。
- [x] S7 人工24h数据/Grafana导入产物与字段说明（依赖S2,S6）。
- [x] V1 相关现有测试、跨包类型检查、lint/build/迁移检查。
- [x] V2 隔离PG/PostgREST真实权限与事务回归、浏览器可见首token场景。
- [x] D1 README/ARCHITECTURE/spec/module-updates与验证记录。
- [x] D2 呈现最终diff/检查与剩余环境验收；不自动commit/push/发布。

最终验证记录见 verification.md；本期不执行远端迁移/部署、commit/push。模块事实已生成可审阅 module-updates.json，归档时由 Trellis 应用。

- [x] E1 集中兜底配置页与手动参数、既有发布链路。
- [x] E2 可配置型号冻结、执行与数据库分析一致。
- [x] E3 必要回归、构建、文档与本地交付。

## 2026-10-26 修复任务

- [ ] 确认4/2/10口径并补充最小规划/风险审查。
- [ ] 修复可见字检测并以真实浏览器验证长节点/思考滚动/隐藏/空白。
- [ ] 新增可配置兜底2秒快照、10秒默认，保留历史NULL语义。
- [ ] 真实派发起计4秒/2秒，思考不豁免，全局硬限及安全取消收口。
- [ ] 运营/文档/看板口径同步，隔离v1/v2及6秒/10秒。
- [ ] 相关测试、全消费者typecheck/build、迁移与计费回归。
- [ ] 最终审核清单、明确发布配置动作与上线验收。

## 10月26日最终观察重点

主指标为前台完全无字、因首发/兜底/总时间限额截断的比例；其他上游失败单列，缺报不算成功。主分布为点击发送至首个可见token（包括已开启思考）的客户端时间分布，提供分桶和每型号P50/P90/P95。v2与历史独立，附覆盖率。验收证据与待发布顺序见 `budget-fix-verification.md`。
