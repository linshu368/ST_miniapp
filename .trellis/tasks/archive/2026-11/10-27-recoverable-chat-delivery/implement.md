# 执行与验证

规划已按用户明确端到端实现/测试/上线授权自审。先契约/SQL，再后端交付/恢复/结算，前端生命周期，Grafana口径及文档。先复用已有测试；新PG/恢复测试因计费并发和跨页面故障必要。

- shared合约和单migration：策略隔离、preview、ready、报告与取消/结算资格；ACL仅service_role/postgres。
- backend：第一token立即放行，延后身份确认但结算等待；checkpoint一次、内存增量恢复、可靠发送标记。
- frontend：超时不取消；hidden/page_left非失败；接收后不因视口截止；恢复消息/思考不混revision。
- 测试：扩展fallback/execute/lifecycle/observation/hooks与真实PG套件；控制时钟覆盖4/2/10和慢DB、两种取消竞争、重放。
- pnpm -r typecheck；shared/backend/frontend tests；frontend lint/build、admin build、lint:imports/migrations、git diff --check。
- 测试环境真实上游与浏览器返回恢复；DB TEST/production shape与ACL分别核验；GitHub CI→dev/test→production→main管理员合并按用户既有授权。
- 生产核对Railway SHA/健康、Vercel真实域名SHA、轻量业务读取及零重复扣费。发布产物与限制记录release-review。
