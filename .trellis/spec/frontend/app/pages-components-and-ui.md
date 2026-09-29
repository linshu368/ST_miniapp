# Frontend 页面、组件与使用规范

## 大厅与角色

- `CharacterGallery` 负责排序、角色查询、最新 badge 与详情选中；`CharacterCard` 只呈现卡片和点击，图片 URL 归一由其 helper 处理。
- `CharacterDetailSheet` 展示角色详情并创建/进入会话；`FavoriteButton` 统一复用 favorite query/mutation；`FeaturedFrame` 仅做视觉装饰。
- 同一收藏状态必须共享 query key/cache，不能每个入口维护本地副本。图片需保留尺寸/占位/失败退化，避免列表布局抖动。

## 聊天组件

- 页面拥有当前 session、消息集合、composer 文本、流式生命周期和历史翻页的编排。
- `ChatMessageList` 管滚动、加载旧消息与消息渲染；`ChatMessageBubble`/`ChatMarkdown` 负责安全展示，Markdown 必须经 DOMPurify，禁止不受控 HTML。
- `ChatComposer` 处理输入、8000 字上限、发送/禁用和软键盘布局；共享布局计算留在 `composer-layout.ts`。
- `ChatSessionDrawer` + `session-row-actions.tsx` 统一会话选择、改名、置顶、删除确认；不可逆删除必须确认。
- `ChatTopBar` 在角色名下展示当前引擎胶囊，`ChatModelSwitcher` 从这里展开；`ChatToolsSheet` 不再包含模型入口。生成偏好和语音设置仍只消费对应 API hooks。
- `ChatMessageVoiceFooter`/相关语音组件处理音频状态；页面二级路由承载自定义生成，避免主消息气泡过载。
- `ChatSplash`、typing bubble 和 disabled controls 表达加载/流式状态，不以 toast 代替关键页面状态。

SSE 流消息是临时客户端状态：`start` 建占位，`delta` 追加增量（不是替换累计包），`done` 用服务端终态收敛并更新/invalidate cache，`error` 保留可恢复 UI。发送中阻止同会话重复提交；用户取消与网络断开要区分。

## 个人中心、支付、通知与客服

- Profile 组合 settings/wallet/checkin/invite/community/support unread，并展示总额、专项余额和 VIP 入口。VIP 页与充值页的价格、权益和剩余天数只读服务端契约，不写死折扣或金额。编辑成功同时更新 React Query cache 与相应 Zustand 展示镜像，避免双状态漂移。
- Recharge 使用 `PlanCard` 做选择，mutation 做下单；订单详情仅 pending 时 2 秒轮询，进入终态立即停止。回跳参数要校验/编码，不将支付凭证放 URL。`pay_url` 只进短 TTL sessionStorage。打开外部支付前先 `enterExternalPaymentPending` 并写入 pending 记录，再 `openLink`。Telegram 冻结恢复时 URL 通常不变，回流由根上 visibility/focus/pageshow 观察，不能只靠 `?payment=returned` / `start_param`。pending 与离开事件都不是支付失败。
- Orders 使用有界 infinite query；Spending 使用流水 query；均提供 loading skeleton、empty、error retry 和终止状态。
- Notifications 按 scope 查询。标记已读必须提交单条消息 id，不能只提交 scope。VIP 到期详情按通知 metadata 展示，当前权益另读 `GET /api/vip/status`，续费不改写历史正文。Support 查询会话、发送、标记已读并合理轮询/前台刷新；输入内容不得写遥测。
- Invite/Community 的绑定、校验、奖励由后端幂等保证；前端可做 session 去重，但不能把 sessionStorage 当业务真相。

## UI、表单与可访问性硬规则

- 使用语义 button/input/label；图标按钮必须 `aria-label`；Dialog/Sheet 保持标题、焦点圈定、Esc/返回关闭和焦点恢复。
- 点击区域适合触屏；颜色不是唯一状态信号；正文/状态满足对比度；图片有有意义 alt 或明确装饰。
- 加载、空、错误、离线/重试、提交中、成功/终态全部设计；mutation pending 禁止重复点击。
- 所有用户输入表单使用 RHF + Zod；若聊天这种高频受控输入因交互模型例外，必须使用明确长度/trim 校验和测试，不能扩散为普通表单惯例。
- 尊重 safe-area、visual viewport 与软键盘；动画遵循 `prefers-reduced-motion`。不得通过 `user-scalable=no` 之外的新增手段进一步妨碍可访问缩放，修改 viewport 需单独评审。
