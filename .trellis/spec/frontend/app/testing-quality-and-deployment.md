# Frontend 测试、质量、性能与部署

## 当前测试基础与要求

当前 Vitest 重点覆盖纯逻辑/API parser/store：conversation SSE、会话标题、模型 cache、聊天入口/额度弹窗、composer 布局/回复展示、Telegram hooks/launch URL、Sentry sanitize、通知工具、用户 profile store，以及 Next lobby route。暂无完整 RTL/jsdom/E2E 体系；不能把缺失说成已覆盖。

- 纯函数/转换：边界值、非法输入、时区/金额、空数组。
- API/SSE：headers、envelope、非 2xx、abort、chunk 分割、error/EOF、cache invalidation。
- Store：hydrate 优先级、localStorage 失败、action 不变量。
- 页面/组件新增关键逻辑时优先保持可测试边界；只有测试必要性已确认时才抽取纯函数或引入最小 DOM 测试基础设施，避免为测试制造无业务价值的抽象。
- Bug 修复先在规划/风险评估中确认是否需要复现测试文件，未确认时不自动创建。支付、发送/重生成、删除、邀请/奖励始终至少执行现有相关测试和可重复人工场景。

## 质量命令

```bash
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
```

shared contract 改动追加 `pnpm --filter @miniapp/shared test` 和所有消费者 typecheck。检查组件无直接 fetch、无数据获取 useEffect、无 DB 行类型、无其他应用 import、无新增 `any`/CSS、无 ST bridge 代码。

## 人工验证矩阵

- Telegram WebView 与普通浏览器 fallback；真实/缺失 initData；冷启动和重新前台。
- 320px/常见移动宽度、安全区、横竖屏、软键盘、长文本/长列表、慢网/离线。
- 大厅 loading/error/empty、详情/收藏；聊天首轮/历史分页/SSE/错误/取消/重生成/会话管理；语音播放/生成。
- 充值下单、回跳、pending→终态、重复点击；订单/流水分页；通知/客服已读；邀请/社区失败与重复操作。
- 键盘 Tab、焦点恢复、screen-reader label、reduced motion、对比度。

## 性能、监控与安全

- 列表图片声明尺寸并延迟加载；避免 render 中 O(n²)，音频用 map；稳定 key/memo 只在测量后使用。
- 大组件按功能拆分但不创建无意义 wrappers；重依赖/Devtools/replay 延迟或仅相应环境加载。
- Sentry 事件必须经 sanitize；禁止 initData、token、支付信息、聊天正文、完整 API body。`global-error` 提供 reset，但不暴露内部错误。
- Markdown 始终 sanitize；外链/图片 URL 使用允许协议；不得用 `dangerouslySetInnerHTML` 绕过现有安全层。

## Vercel 部署

- Frontend 部署 Vercel，配置见根/包部署文件和 `next.config.mjs`；`NEXT_PUBLIC_*` 都是公开值，secret 不得使用此前缀。
- Preview/production 的 `NEXT_PUBLIC_API_URL` 必须指向匹配 Backend；构建采用 standalone 并转译 shared。环境变化同时验证 CORS、Telegram Bot WebApp URL、Sentry release/source maps。
- 数据库 migration 和 Backend 部署与 Frontend 解耦；契约演进遵循兼容 producer-first 顺序。
- 发布前 `build` 必须通过；发布后 smoke test 首页、health/API、聊天、支付回跳并监控错误率。回滚 Vercel deployment 时确认 Backend/契约仍向后兼容。
