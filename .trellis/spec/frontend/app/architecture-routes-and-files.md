# Frontend 架构、路由与文件职责

## 根配置与入口

- `package.json`：Next 14/React 18、React Query、Zustand、RHF/Zod、Telegram SDK、Sentry、Radix/shadcn、Tailwind、Markdown sanitize；命令为 dev/build/start/test/typecheck/lint。
- `next.config.mjs`：standalone、monorepo tracing、转译 shared、API URL 环境推导、Sentry 构建；修改需验证 preview/production。
- `tailwind.config.ts`、`app/globals.css`：设计 token、暗色主题、安全区、聊天/语音动画；全局样式只能放真正跨应用规则。
- `vitest.config.ts`：当前主要为 Node 环境逻辑测试；增加 DOM 组件测试前应最小化补足 jsdom/RTL，不虚构现有基础设施。
- `instrumentation-client.ts`、`lib/sentry/*`、`app/global-error.tsx`：监控初始化、脱敏、用户关联、replay 和全局恢复。
- `app/layout.tsx`：根 HTML/viewport/主题并挂载 `Providers`；`providers.tsx`：QueryClient、Telegram 初始化、敏感 launch 参数清理、Sentry 用户、支付回跳、渠道/邀请上报、用户设置与 Zustand hydrate。

## App Router 页面

| 路由                                     | 文件与职责                                                     |
| ---------------------------------------- | -------------------------------------------------------------- |
| `/`                                      | `(main)/page.tsx`，大厅；角色 gallery                          |
| `/chats`                                 | `(main)/chats/page.tsx`，历史会话/收藏 tab                     |
| `/create`                                | 创作入口；`/create/wish` 提交和跟踪许愿                        |
| `/profile`                               | 我的页、余额/签到、设置、社区入口                              |
| `/profile/recharge`                      | 套餐选择和下单；`/[orderId]` 支付等待/轮询/回跳                |
| `/profile/orders` / `/profile/spending`  | 订单分页与消费流水                                             |
| `/profile/messages` / `/profile/support` | 通知中心与站内客服                                             |
| `/profile/invite`                        | 邀请中心、统计与分享                                           |
| `/chat/[characterId]`                    | 自研聊天主页面；会话选择、历史分页、SSE 发送/重生成、工具/语音 |
| `/chat/[characterId]/voice/[messageId]`  | 指定消息的自定义语音二级页                                     |
| `/api/lobby-characters`                  | Next route handler；大厅角色代理/缓存边界，带就近测试          |

`(main)/layout.tsx` 负责主区底部导航可见性；聊天页在主布局外，避免底栏干扰沉浸交互。页面组件负责组装和路由状态，不复制 API client、数据转换或通用 UI。

## 目录职责

- `components/characters/`：大厅角色卡、画廊、详情 Sheet、收藏按钮、精选框。
- `components/chat/`：聊天顶栏、消息列表/气泡/Markdown、composer、重生成、会话抽屉/行操作、模型/生成/语音设置、工具 Sheet、splash 和布局/展示纯函数。
- `components/payment/`：套餐卡等支付表现组件；不直接下单。
- `components/profile/`：个人中心复用 UI（当前社区 Sheet）。
- `components/nav/`：BottomNav 及未读提示；`components/ui/`：项目内 shadcn/Radix primitives；`icons.tsx`：支付图标；`examples/` 不作为生产业务入口。
- `lib/api/`：唯一网络/React Query 层；`stores/`：跨组件持久客户端状态；`lib/telegram/`：SDK、initData、launch URL、用户；`lib/sentry/`：监控；`lib/utils/`：纯格式化/映射；`hooks/` 与 `use-visual-viewport-height.ts`：浏览器交互 hooks。
- `__tests__/eslint-import-guard.ts`：依赖边界守卫；测试通常与实现同目录。

## 新文件放置规则

route 页面只组合；业务组件按域目录；通用 primitive 才进 `ui/`；服务器请求和 query key 进 `lib/api/<domain>.ts`；跨页面 UI 状态进 store；无 IO 计算进 lib/组件旁纯函数。只有真实复用才抽象，禁止 generic hooks/utils 堆积。
