# Admin 数据、鉴权与环境规范

## 数据访问边界

- `src/lib/*Api.ts` 是 HTTP/RPC 入口；组件不得直接 `fetch`、拼 endpoint、调用散落 RPC 或解析 transport envelope。
- 跨应用 HTTP DTO 必须来自 `@miniapp/shared/src/api/*`；浏览器端不得导入 backend 实现或数据库 row。
- Supabase 调用必须显式使用预期 schema/RPC，不依赖默认 `public`；数据库权限是最终边界，前端隐藏按钮不是授权。
- helper 应返回稳定领域类型，保留原始错误供安全诊断，但不得把 token/敏感响应打印到控制台。

## 鉴权

- session/token 只能通过既有登录与 client 生命周期管理，不得写入源码、URL、日志或可提交 fixtures。
- 401/403 分别处理“会话失效”和“权限不足”；会话失效应清理当前环境状态并回到登录。
- 切换环境不得复用另一环境 session。登出应清理 client/session 及敏感 UI 状态。
- `VITE_*` 会进入浏览器 bundle，只允许公开 URL、anon key 等公开配置；service-role、数据库 URI 和 admin secret 禁止出现。

## 环境隔离

- 环境枚举、label、base URL 与 Supabase 配置统一由 `lib/environment.ts` 管理。
- 所有 query/mutation 必须绑定当前环境；环境变化时取消/忽略旧请求并清理旧数据，防止迟到响应覆盖新环境。
- 生产环境的高风险操作应有更强确认；不得用测试环境成功推断生产结构相同。
- 环境变量缺失必须 fail fast 并给出变量名，不得静默回落到生产或其他环境。

## 超时、重试与一致性

- 读取可在明确瞬时错误下有限重试；写操作默认不自动重试，除非服务端支持幂等键。
- 发布/回滚等并发编辑应携带版本/时间等并发前提；冲突时重新读取并要求人工确认。
- 缓存只能作为展示优化，发布后的权威值必须重新读取。设计必须说明失败、部分成功、补偿和观察方式。
