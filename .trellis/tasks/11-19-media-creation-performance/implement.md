# 影像创作首屏与视频交付恢复优化：执行与验证

## 启动条件

1. 用户在最终规划摘要之后明确批准。
2. 独立校验三项meta；再start本子任务，父任务仅协调。按inline使用trellis-before-dev，不派发implement/check子代理。
3. 复核当前git状态/最新提交，保留用户修改；读取本任务引用规范与总研究。未review/start不写产品代码。

## 执行清单

- [x] I1 在现有options factory增加调用用途的内部优先级参数，不加query key维度；prefetch已在途时复用同一请求，不因导航升优先级取消重发。
- [x] I2 将upload里的取源和分块分开，一轮内复用Buffer并逐块fence；原2并发和源文件上限保持，最大在途Buffer量不新增。20秒预算内不再起新块；内部helper可选signal保持旧调用兼容；15/60/120秒原单次超时仍是后备，超预算中断后按已知/未知结果裁决，不能强制把未知写入当失败。
- [x] I3 stopVideoPlazaGenerationJob/stopVideoDeliveryJob返回可等待的有界停止结果，由app.onClose await；未知外部写入留原状态，安全release复用现有checkpoint。
- [x] I4 实际JSON日志/敏感字段及受影响失败路径验证。
- [x] I5 整体回归、复杂度基线收紧、对应module-updates内容审核。

## 回归风险与新增测试决定

由于涉及租约、外部写未知与并发，风险评估要求新增`packages/backend/src/features/image-plaza/video-delivery-job.test.ts`，固定虚构源与假时钟验证分块/预算/lease/SIGTERM，不访问真实供应商或数据库。其余扩展既有测试。

## 可执行验证

```powershell
pnpm --filter @miniapp/frontend test -- src/lib/api/image-plaza.test.ts src/lib/api/client.retry.test.ts src/lib/api/request-concurrency.test.ts
pnpm --filter @miniapp/backend test -- src/features/image-plaza/video-stream.test.ts src/features/image-plaza/video-upstream.test.ts src/routes/video-plaza-playback.test.ts
pnpm test:ui --grep @image
pnpm lint:backend-logging
pnpm --filter @miniapp/backend test -- src/features/image-plaza/video-delivery-job.test.ts
pnpm -r typecheck
pnpm --filter @miniapp/shared test
pnpm lint:imports
pnpm lint:complexity
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin build
```

跨包执行pnpm -r typecheck及适用build；Backend无独立build脚本，以typecheck/部署构建验证，不伪造命令。若遇Next standalone Windows junction，按frontend spec先核验路径并移至workspace output快照，不递归删除链接树。新增单元测试均使用mock/本地虚构fixture，不读生产业务行。

## 失败路径与consumer验收

- 弱网/空闲预取取消、无缓存、筛选恢复、源hash变化、HEAD/PATCH响应丢失、租约竞争、SIGTERM、创建未知、发布未知、强杀、上游排队；未知写结果不重复创建/扣款

固定场景：20MiB/4块只取源一次、5块跨轮次、20秒预算、HEAD/PATCH丢响应、源hash改变、lease竞争、发布未知、SIGTERM中各stage、强杀恢复、预取join和筛选分页。禁止用真实模型/扣款验证并发代码。

## 本地与发布后验收

这是完整流程/复杂恢复优化，纳入packages/ui-tests已有@startup/@chat/@creator/@image对应分组；扩展已有fixture，不建一次性后端。真机、键盘、真实供应商、生产CDN与发布恢复另验，模拟场景不替代。任务停止/租约故障通过单测，真实SIGTERM在TEST服务单独演练后再生产。

正式上线需单独授权和环境确认。发布后按新release/route/platform/相同定义观察24—48h，N<100延至72h；复核P95/N、error/stall/left与Sentry，不能据本地测试宣布达标。未运行项写验证记录。回滚规则见design。
