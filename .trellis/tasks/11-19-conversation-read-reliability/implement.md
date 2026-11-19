# 聊天详情取消分类与会话读取可靠性：执行与验证

## 启动条件

1. 用户在最终规划摘要之后明确批准。
2. 独立校验三项meta；再start本子任务，父任务仅协调。按inline使用trellis-before-dev，不派发implement/check子代理。
3. 复核当前git状态/最新提交，保留用户修改；读取本任务引用规范与总研究。未review/start不写产品代码。

## 执行清单

- [x] I1 在registerConversationDetail的onClose与catch之间建立明确的取消来源判定，只处理已销毁传输的已知abort，使用现有HTTP观测一次终态。
- [x] I2 以现有detail阶段耗时为诊断入口；身份shared-inflight不绑定某个等待者abort，避免一人离页取消他人的身份读取。
- [x] I3 扩展既有route/identity/会话hook测试验证取消、5秒deadline、真500、并发共享和恢复；真实慢依赖保留err及cause。
- [x] I4 实际JSON日志/敏感字段及受影响失败路径验证。
- [x] I5 整体回归、复杂度基线收紧、对应module-updates内容审核。

## 回归风险与新增测试决定

由于取消会影响服务端错误归类和并发等待者，风险评估要求新增`packages/backend/src/routes/conversation-detail.test.ts`隔离锁定：真实关闭/客户端超时断开、SDK期限、真实500和一次终态。其他测试扩展既有文件。

## 可执行验证

```powershell
pnpm --filter @miniapp/backend test -- src/lib/user.test.ts src/routes/conversation-folders.test.ts src/features/conversations/active-delivery.test.ts
pnpm --filter @miniapp/frontend test -- src/hooks/use-conversation-turn.test.ts src/lib/api/conversations-entry.test.ts
pnpm test:ui --grep @chat
pnpm lint:backend-logging
pnpm --filter @miniapp/backend test -- src/routes/conversation-detail.test.ts
pnpm -r typecheck
pnpm --filter @miniapp/shared test
pnpm lint:imports
pnpm lint:complexity
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin build
```

跨包执行pnpm -r typecheck及适用build；Backend无独立build脚本，以typecheck/部署构建验证，不伪造命令。若遇Next standalone Windows junction，按frontend spec先核验路径并移至workspace output快照，不递归删除链接树。新增单元测试均使用mock/本地虚构fixture，不读生产业务行。

## 失败路径与consumer验收

- 客户端关闭、SDK deadline、身份RPC失败、会话不存在/越权、恢复失败、旧版本请求、并发singleflight；真实错误不吞、不重试写入

固定场景：请求离页取消、客户端期限断开与服务端期限独立、身份共享等待者取消、ownership拒绝、recover失败、真500、重入/切换/恢复；生成断连后后台完成与只计一次继续由既有测试覆盖。

## 本地与发布后验收

这是完整流程/复杂恢复优化，纳入packages/ui-tests已有@startup/@chat/@creator/@image对应分组；扩展已有fixture，不建一次性后端。真机、键盘、真实供应商、生产CDN与发布恢复另验，模拟场景不替代。

正式上线需单独授权和环境确认。发布后按新release/route/platform/相同定义观察24—48h，N<100延至72h；复核P95/N、error/stall/left与Sentry，不能据本地测试宣布达标。未运行项写验证记录。回滚规则见design。
