# Frontend 应用规范

适用于 `packages/frontend`。当前架构是 Next.js 14 App Router 自研 MiniApp UI；`docs/ARCHITECTURE.md` 明确 SillyTavern、iframe、postMessage bridge 已退场。`packages/frontend/CLAUDE.md` 中“阶段二 iframe/bridge”属于历史规则，不得据此新增 `lib/bridge`、ST mirror 或兼容层；其 React/TypeScript/数据获取/状态/表单/样式规则仍有效。

## 专题导航

| 文档                                                          | 必读场景                                  |
| ------------------------------------------------------------- | ----------------------------------------- |
| [架构、路由与文件职责](./architecture-routes-and-files.md)    | 所有 Frontend 任务                        |
| [页面、组件与使用规范](./pages-components-and-ui.md)          | 页面、聊天、大厅、支付、个人中心、UI      |
| [API、数据流与状态管理](./api-dataflow-and-state.md)          | React Query、SSE、Zustand、Telegram、表单 |
| [测试、质量、性能与部署](./testing-quality-and-deployment.md) | 测试、可访问性、性能、Sentry、Vercel      |

## 不可谈判规则

1. React 18 函数组件 + Next.js App Router + TypeScript strict；禁止 class、Pages Router 和 `any`。
2. 服务端数据通过 `src/lib/api/` 的 React Query query/mutation；业务组件不得直接 `fetch/axios`，不得用 `useEffect` 取服务端数据。
3. 对外 DTO 来自 `@miniapp/shared`；不得使用数据库行类型或 import 其他应用包。
4. 状态职责：局部交互 `useState/useReducer`；跨组件客户端状态 Zustand；服务器缓存 React Query；表单 React Hook Form + Zod；URL 可分享状态放路由/search params。
5. 样式用 Tailwind 和现有 shadcn/Radix；除 `app/globals.css` 等既有全局入口外不新增 CSS/SCSS。先复用已有组件，不引入 Redux/MUI/AntD/styled-components/GraphQL/Socket.io 等替代栈。
6. ST bridge 已退场。不得新增 iframe、`postMessage`、`platformAction`、`useSTEvent` 或 `@repo/bridge-protocol`。
7. 未经需求明确，不重做 UX、文案、布局或视觉。关键交互必须覆盖 loading/error/empty/disabled/success 和移动端安全区。

## 最低质量检查

```bash
pnpm --filter @miniapp/frontend typecheck
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
```

按改动规模运行；跨 shared 契约需同时运行 shared tests 和 Backend/其他消费者 typecheck。视觉变更必须人工验证 Telegram WebView、常规移动浏览器、窄屏、软键盘与 reduced motion。
