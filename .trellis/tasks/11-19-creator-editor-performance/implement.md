# 角色创作兼容性与编辑器首屏优化：执行与验证

## 启动条件

1. 用户在最终规划摘要之后明确批准。
2. 独立校验三项meta；再start本子任务，父任务仅协调。按inline使用trellis-before-dev，不派发implement/check子代理。
3. 复核当前git状态/最新提交，保留用户修改；读取本任务引用规范与总研究。未review/start不写产品代码。

## 执行清单

- [x] I1 先抽取现有createConversationRequestId的兼容算法成小helper，由原出口重导出并切换已确认的直接调用；保留现有测试证明SSE/idempotency行为不变。
- [x] I2 edit模式只启用detail，owner由其DTO获得；new仍读list。将千行editor按已有功能边界拆到现有dialogs/documents/presets等相邻模块，执行复杂度收紧。
- [x] I3 补有限API标签及现有exporter/classifier回归；复用creator fixture覆盖旧WebView、draft/owner切换、封面回流和失败恢复。
- [x] I4 实际JSON日志/敏感字段及受影响失败路径验证。
- [x] I5 整体回归、复杂度基线收紧、对应module-updates内容审核。

## 回归风险与新增测试决定

不默认新增测试文件；优先扩展既有测试和固定UI fixture。只有已审查风险无法通过既有边界验证时再回规划确认。

## 可执行验证

```powershell
pnpm --filter @miniapp/frontend test -- src/lib/api/conversation-stream.test.ts src/components/creation/character-editor.test.ts src/lib/api/creator-characters.test.ts src/lib/perf/grafana.test.ts src/lib/perf/api-timing.test.ts
pnpm test:ui --grep @creator
pnpm --filter @miniapp/frontend typecheck
pnpm lint:complexity
pnpm -r typecheck
pnpm --filter @miniapp/shared test
pnpm lint:imports
pnpm lint:backend-logging
pnpm --filter @miniapp/frontend build
```

跨包执行pnpm -r typecheck及适用build；Backend无独立build脚本，以typecheck/部署构建验证，不伪造命令。若遇Next standalone Windows junction，按frontend spec先核验路径并移至workspace output快照，不递归删除链接树。新增单元测试均使用mock/本地虚构fixture，不读生产业务行。

## 失败路径与consumer验收

- 旧WebView无randomUUID、存储拒绝、草稿冲突、owner切换、detail失败、网络取消、附件解析、保存重试、审核拒绝；允许日志仅长度/结果和链路字段

固定场景：无randomUUID/仅getRandomValues/无crypto；new/edit现有稿、owner切换、IndexedDB拒绝/冲突、本地恢复未完、封面回流、保存失败重试、附件重复；旧版本导出继续可用。

## 本地与发布后验收

这是完整流程/复杂恢复优化，纳入packages/ui-tests已有@startup/@chat/@creator/@image对应分组；扩展已有fixture，不建一次性后端。真机、键盘、真实供应商、生产CDN与发布恢复另验，模拟场景不替代。

正式上线需单独授权和环境确认。发布后按新release/route/platform/相同定义观察24—48h，N<100延至72h；复核P95/N、error/stall/left与Sentry，不能据本地测试宣布达标。未运行项写验证记录。回滚规则见design。
