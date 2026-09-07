# CS Platform API、React Query 与鉴权

## API 单入口

- `src/api.ts` 统一 URL、JSON、headers、错误和 `csApi`；组件只能调用它暴露的方法。
- DTO 来自 `@miniapp/shared` 的 `api/cs-platform.ts`、`api/support.ts` 等；外部契约先改 shared，再同步 backend 和本包。
- `VITE_API_URL` 是默认回访 API；`VITE_CS_TEST_API_URL`、`VITE_CS_PROD_API_URL` 分别定义客服环境。变量缺失回退行为属于当前实现，生产部署必须显式配置并核验。

## 鉴权与隐私

- 使用 backend 规定的 `X-CS-Admin-Token` 和 operator headers；不得随意改名或复制构造逻辑。
- **当前实现**通过 `src/api.ts` 将 token/operator 写入 `localStorage`，这会扩大 XSS 后的凭据暴露面；在认证方案迁移前不得把这一行为描述成“仅内存”。**新增安全约束**：新凭据不得继续扩散到其他 storage，后续改造优先采用短期服务端会话/可信身份；任何迁移必须保留登录 UX 和失效处理。
- 无论当前存储方式如何，禁止将 token/operator 放入 console、URL query、analytics、导出和可提交 fixture。
- 401 清理登录上下文；403 明确权限不足；错误信息不得回显上游敏感响应。

## 当前已识别的服务端风险（设计新改动时必须重新核对）

以下是对当前 backend CS 链路的风险记录，不表示本次文档任务已修改上游行为：

- operator ID 由客户端 header 提供，现有共享 token 模式下审计归责有限；涉及审计/权限改造时应由服务端认证主体派生身份。
- 群发互斥若仅依赖进程内状态，扩容/重启无法保证唯一执行；扩大群发能力前必须评估持久任务和逐目标幂等，而非直接增加客户端重试。
- Telegram 外部调用应有明确超时，所有异常路径应将 `pending` 收敛到终态；否则不得宣称可恢复。
- idempotency key 必须代表稳定发送意图，冲突应可返回既有结果；时间戳/随机 key 不能解决“结果未知后再次点击”。
- webhook 入站应按稳定 update/message 身份去重；轮询读取若带“已读”写副作用，必须在契约和测试中明确，避免后台轮询静默清零。

这些风险必须结合真实 route/migration 再设计；不得仅凭本文直接添加队列、任务表或数据库约束。

## React Query

- query key 使用数组并包含域、资源 ID、环境和影响结果的筛选条件。
- `enabled` 防止缺少 token/ID 时请求；轮询仅对活动会话启用，窗口隐藏或离开业务流时停止。
- mutation 成功后精确 invalidate/setQueryData；不得全局清缓存掩盖依赖不清。
- AbortSignal 应传到 fetch 以取消过期请求；环境/选择变化后的迟到响应不得覆盖当前状态。
- 自动重试仅用于幂等读取且次数有限；429 尊重退避。发送/群发/状态写入默认不自动重试，除非接口提供幂等语义。
