# 冷启动端到端瓶颈与关键链整改：执行与验证

## 启动条件

1. 用户在最终规划摘要之后明确批准。
2. 独立校验三项meta；再start本子任务，父任务仅协调。按inline使用trellis-before-dev，不派发implement/check子代理。
3. 复核当前git状态/最新提交，保留用户修改；读取本任务引用规范与总研究。未review/start不写产品代码。

## 执行清单

- [x] I1 先重用6个已查询启动诊断做阶段分类并取得可重现响应头；C196... Android script_max_fetch_ms=4201、efca...=7361，iOS两条connect_to_request约5135/5168ms，明确两类独立故障模型。
- [x] I2 核对构建chunk与Providers静态依赖树；仅在证实阻塞时移动可选reader/监控模块到已有afterFirstScreen/enrich点，保留shared query与取消。
- [x] I3 按@startup现有fixture检查root alias/cookie/History/支付回流；同负载构建比较与真机观测分别留证。
- [x] I4 实际JSON日志/敏感字段及受影响失败路径验证。
- [x] I5 整体回归、复杂度基线收紧、对应module-updates内容审核。

## 回归风险与新增测试决定

不默认新增测试文件；优先扩展既有测试和固定UI fixture。只有已审查风险无法通过既有边界验证时再回规划确认。

## 可执行验证

```powershell
pnpm --filter @miniapp/frontend test -- src/lib/perf/page-tracker.test.ts src/lib/telegram/launch-url.test.ts
pnpm test:ui --grep @startup
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend lint
pnpm -r typecheck
pnpm --filter @miniapp/shared test
pnpm lint:imports
pnpm lint:complexity
pnpm lint:backend-logging
pnpm --filter @miniapp/frontend build
```

跨包执行pnpm -r typecheck及适用build；Backend无独立build脚本，以typecheck/部署构建验证，不伪造命令。若遇Next standalone Windows junction，按frontend spec先核验路径并移至workspace output快照，不递归删除链接树。新增单元测试均使用mock/本地虚构fixture，不读生产业务行。

## 失败路径与consumer验收

- HTML/JS下载失败、SDK不可用、History拒绝、邀请/支付参数、后台恢复、startup缺报；不接管生产CDN缓存直到证据充分

固定场景：无/有/错landing cookie、阻塞JS、History受限、邀请/支付回流、旧Android WebView、iOS后台恢复、断网与加载失败；CDN证据不充分则不改公共缓存策略。

## 本地与发布后验收

这是完整流程/复杂恢复优化，纳入packages/ui-tests已有@startup/@chat/@creator/@image对应分组；扩展已有fixture，不建一次性后端。真机、键盘、真实供应商、生产CDN与发布恢复另验，模拟场景不替代。

正式上线需单独授权和环境确认。发布后按新release/route/platform/相同定义观察24—48h，N<100延至72h；复核P95/N、error/stall/left与Sentry，不能据本地测试宣布达标。未运行项写验证记录。回滚规则见design。
