# Frontend 架构、路由与文件职责

## 根配置与入口

- `package.json`：Next 14/React 18、React Query、Zustand、RHF/Zod、Telegram SDK、Sentry、Radix/shadcn、Tailwind、Markdown sanitize；命令为 dev/build/start/test/typecheck/lint。
- `next.config.mjs`：standalone、monorepo tracing、转译 shared、API URL 环境推导、Sentry 构建；修改需验证 preview/production。
- `tailwind.config.ts`、`app/globals.css`：设计 token、暗色主题、安全区、聊天/语音动画；全局样式只能放真正跨应用规则。
- `vitest.config.ts`：当前主要为 Node 环境逻辑测试；增加 DOM 组件测试前应最小化补足 jsdom/RTL，不虚构现有基础设施。
- `instrumentation-client.ts`、`lib/sentry/*`、`app/global-error.tsx`：监控初始化、脱敏、用户关联、replay 和全局恢复。
- `app/layout.tsx`：根 HTML/viewport/主题并挂载 `Providers`；`providers.tsx`：QueryClient、Telegram 初始化、敏感 launch 参数清理、Sentry 用户、支付回跳、渠道/邀请上报、用户设置与 Zustand hydrate、PostHog adapter（Telegram 就绪后）、replay lifecycle owner、支付回跳、渠道/邀请上报、用户设置与 Zustand hydrate。

## App Router 页面

| 路由                                                                | 文件与职责                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `/`                                                                 | `(main)/page.tsx`，短剧沉浸推荐首页，中央播放符号入口                          |
| `/characters`                                                       | `(main)/characters/page.tsx`，角色模块「发现」；角色 gallery、搜索排序与接着聊 |
| `/dramas` / `/dramas/[id]`                                          | 双列剧场/追剧库与本剧专注播放、选集                                            |
| `/chats`                                                            | `(main)/chats/page.tsx`，角色模块「对话」；跨角色历史与会话管理                |
| `/create`                                                           | 影像广场入口；当前已实现图片生成链路                                           |
| `/profile`                                                          | 我的页、余额/签到、VIP 入口、设置、社区入口                                    |
| `/vip`                                                              | 月卡权益、会员身份、开通或续费；保留历史周卡状态展示                           |
| `/profile/recharge`                                                 | 星尘套餐独立下单、VIP权益引导；`/[orderId]` 支付等待/轮询/回跳                 |
| `/profile/orders` / `/profile/spending`                             | 订单分页与消费流水                                                             |
| `/profile/messages` / `/profile/messages/[id]` / `/profile/support` | 通知列表、单条详情与站内客服                                                   |
| `/profile/invite`                                                   | 邀请中心、统计与分享                                                           |
| `/chat/[characterId]`                                               | 自研聊天主页面；会话选择、历史分页、SSE 发送/重生成、工具/语音                 |
| `/chat/[characterId]/voice/[messageId]`                             | 指定消息的自定义语音二级页                                                     |
| `/api/lobby-characters`                                             | Next route handler；大厅角色代理/缓存边界，带就近测试                          |

`(main)/layout.tsx` 负责主区底部导航可见性。当前本地工作树全局导航为「角色 / 创作 / 中央播放符号（首页）/ AI短剧 / 我的」；统一贴底暖黑样式，`/characters` 和 `/chats` 同属角色模块，顶部固定「发现 / 对话」栏目，发现页搜索固定，推荐/最新随内容滚动；收藏入口统一在创作空间。角色入口记住当前浏览器会话中的最后栏目与滚动位置，已有 `/chats` 链接继续有效。聊天页在主布局外，避免底栏干扰沉浸交互。导航和布局共同使用 BottomNav 的隐藏规则，工作室、VIP/充值、消息、客服、短剧详情及首页纯净模式不占导航空间；高度和安全区由 globals.css 的 --app-nav-height / --app-nav-space 统一供内容、短剧固定区及影像作品操作条使用。页面组件负责组装和路由状态，不复制 API client、数据转换或通用 UI。

## 目录职责

- `components/characters/`：角色发现卡片、画廊、详情 Sheet、收藏按钮、精选框；角色详情区分继续已有会话与显式新对话。
- `components/roleplay/`：模块固定顶部栏目与接着聊卡片；接着聊卡片在普通内容区滚动，不占固定顶部。
- `components/chat/`：聊天顶栏、消息列表/气泡/Markdown、终态 `ReplyRenderer` 接线、composer、重生成、会话抽屉/行操作、模型/生成/语音设置、工具 Sheet、splash 和布局/展示纯函数。
- `components/payment/`：套餐卡等支付表现组件；不直接下单。
- `components/profile/`：个人中心复用 UI（当前社区 Sheet）。
- `lib/roleplay-navigation.ts`：有限角色来源、最后栏目、发现条件与滚动标量；`lib/chat-entry.ts` 统一会话入口，`from=discover|conversations` 在新建/切换会话及语音、充值回流 URL 中保留；顶部、Telegram 返回与 Splash 退出统一回来源栏目。
- `components/nav/`：BottomNav 及未读提示；`components/ui/`：项目内 shadcn/Radix primitives；`icons.tsx`：支付图标；`examples/` 不作为生产业务入口。
- `lib/api/`：唯一网络/React Query 层，含文本后处理版本批次读取；`stores/`：跨组件持久客户端状态；`lib/telegram/`：SDK、initData、launch URL、用户；`lib/sentry/`：监控；`lib/utils/`：纯格式化/映射；`hooks/` 与 `use-visual-viewport-height.ts`：浏览器交互 hooks；`lib/telemetry/`：受控 PostHog adapter 与根 Providers 上的 replay lifecycle owner；`lib/payment/`：付费墙 continuation、`pay_url` 短 TTL sessionStorage、外部支付 pending 与回流观察（不得把 `pay_url` 放进 router query）。
- `@miniapp/reply-renderer`：Frontend/Admin 共用 React 展示边界；只接收 artifact/原文/消息身份/可信回调，不拥有 API、React Query、草稿或发布状态。
- `__tests__/eslint-import-guard.ts`：依赖边界守卫；测试通常与实现同目录。

## 新文件放置规则

route 页面只组合；业务组件按域目录；通用 primitive 才进 `ui/`；服务器请求和 query key 进 `lib/api/<domain>.ts`；跨页面 UI 状态进 store；无 IO 计算进 lib/组件旁纯函数。只有真实复用才抽象，禁止 generic hooks/utils 堆积。

本地集成（2026-10-30，未发布）：五入口顺序为“角色 / 创作 / 中央播放符号（首页）/ AI短剧 / 我的”。`/creation` 主推角色创作，图片视频为次入口，下方收藏/我的创作；顶部“＋创作”直达`/creation/characters/new`，本人作品独立编辑入口为`/creation/characters/:id/edit`。旧`/create`及工作室URL不迁移，生成封面通过受限`creator_return`返回原稿；进入编辑器隐藏公共底栏。收藏与本人作品分别以`space`/`created`聊天来源回到对应空间页。创建/保存/发布/切换可见性走`lib/api/creator-characters.ts`，本地IndexedDB按用户和稿件隔离；原`/`与`/dramas`保持独立。已聊详情查询携带session_id，缓存按用户和会话隔离，避免作者新稿覆盖旧聊天显示。页面仍不直接读数据库。
