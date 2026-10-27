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
- `ChatTopBar` 在角色名下展示当前引擎胶囊，`ChatModelSwitcher` 从这里展开；`ChatToolsSheet` 提供新对话、语音和图片设置，不再包含模型或生成偏好入口。`ChatReplyPreferences` 在输入框上方统一回复长度、模块开关和自定义偏好；动态长度档位与用户级配置仍只消费 generation-config API hooks，字段级保存与回滚不互相覆盖。展开内容可独立滚动。
- `ChatMessageVoiceFooter`/相关语音组件处理音频状态；页面二级路由承载自定义生成，避免主消息气泡过载。
- `ChatSplash`、typing bubble 和 disabled controls 表达加载/流式状态，不以 toast 代替关键页面状态。

SSE 流消息是临时客户端状态：`start` 建占位，`delta` 追加增量（不是替换累计包），`done` 用服务端终态收敛并更新/invalidate cache，`error` 保留可恢复 UI。发送中阻止同会话重复提交；用户取消与网络断开要区分。

带回复后处理版本的消息在流式阶段仍走稳定的安全 Markdown 增量展示，不为每个 delta 重跑后处理 Worker 或替换整棵富文本 DOM；服务端终态收敛后再一次性挂载 `ReplyRenderer` 并开放可信交互。这样既保留原有打字机效果，也避免流式按钮从禁用态残留到终态。

`ReplyRenderer` 只消费已校验 compiled artifact，不接收 source。artifact 缺失/非法、版本为 `NULL`、Worker 超时或规则失败时必须显示完整原文，不能显示部分转换结果。choice 仅在最新、完整、非流式 assistant 回复上可用；点击后发送明确纯文本，复用正常 `runTurn`、余额/402/缓存刷新与同步防双击，历史消息和生成中消息不得触发发送。

## 短剧播放

- `/dramas/[id]` 直接进入沉浸播放，隐藏主导航。页面只编排换剧路由，播放与选集组件位于 `components/drama/`；返回入口固定回 `/dramas`。
- 播放页控件及明暗遮罩在无交互 3 秒后隐藏；点击画面切换显隐，重新显示后从头计时 3 秒。画面按钮独立处理显隐，父级 click capture 不先强制显示；其他控件点击只显示并重置计时，不能误触显隐切换。选集/简介打开、进度拖动和键盘操作时暂停隐藏；手动隐藏时清理旧计时器。播放错误、缓冲与续集倒计时保留必要反馈。
- 播放页通过 Telegram SDK 暂停原生竖向收起手势，退出恢复之前的状态；普通浏览器/旧客户端降级。简介/选集等按钮允许以滑动换剧，但滑动不能再触发按钮点击，进度拖动和弹层滚动保持独立。
- 上滑切换下一部剧，下滑切换上一部剧；同剧换集通过底部选集 Sheet 或播完后 3 秒续播完成。选集网格以详情 `videos` 的数组顺序编号，不依赖可能为空的 `episode` 字段。
- 列表接口会随机排序，`lib/api/drama.ts` 使用独立 React Query 缓存保存本轮浏览顺序，卡片点击时更新快照；换剧跳过零可播集作品，到边界停止，不循环。直接进入详情没有快照时才加载队列。
- 列表“推荐”保留接口顺序；“最新”按 `first_published_at` 倒序、缺失排最后、同时间按 ID 稳定排序。搜索与分类各自对完整标题／任一标签／完整简介作 trim 后忽略大小写的子串匹配，两条件取交集；不能用卡片截断内容或仅标签等值匹配。点击时浏览队列快照采用当前筛选／排序后的列表，清除筛选保留排序选择。剧级文字与单集原始信息的边界见[短剧目录契约](../../database/supabase/drama-catalog.md)。
- 首集播放请求与详情元数据并行，详情失败不能阻塞已就绪的视频。只有当前视频持有媒体元素；换集、换剧或退出时暂停并释放旧媒体。选集面板滚动、进度拖动与跨剧手势隔离。
- 本轮不持久化观看集数或时间进度，不展示没有真实进度支撑的“继续看”。短期浏览队列缓存不代表观看进度。

## 个人中心、支付、通知与客服

- Profile 组合 settings/wallet/checkin/invite/community/support unread，并展示总额、专项余额和 VIP 入口。VIP 页与充值页的价格、权益和剩余天数只读服务端契约，不写死折扣或金额。编辑成功同时更新 React Query cache 与相应 Zustand 展示镜像，避免双状态漂移。
- Profile优先展示签到与充值；消费明细为余额卡内文字入口。未开通VIP以月卡赠送专项星尘为主利益，已开通则展示金色身份卡、有效期和已生效权益。`VipEntryCard`复用于Profile与充值页；`VipBenefitArt`区分会员身份与开通赠礼。月卡以外的历史会员状态继续正确显示，但不提供周卡购买选项。
- Recharge仅选择星尘商品，VIP单独在`/vip`购买；不自动加购/合单，不共享一组单选。VIP回流到充值时保留经过校验的原始returnTo。两页支付渠道继续消费既有`payment_channels`，不因设计调整新增渠道或变更支付指引。
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

## 输入与连续操作

- `useMemoryDraft` / `memory-draft-store` 仅持有有限生命周期的客户端文字草稿；用户/模块/session隔离，空字符串也有编辑版本，不将文本落盘或送入事件。
- 聊天IME组合输入期间不可提交；影像Enter用于换行，Ctrl/Cmd+Enter提交。异步提交完成只清理原身份、原编辑版本的输入；从历史再生成不清新草稿。
- `ImagePlazaHistorySheet`复用既有历史query；`FavoriteFeedbackNotice`独立于路由及卡片显示收藏错误，不引入通用通知框架。

## 键盘压缩空间回归

聊天输入与展开偏好应共享页面的 visualViewport 高度预算，且仅可视高度变化、没有新增输入时也必须重新约束 textarea；保留发送与偏好收起入口，长内容独立滚动。影像参考图/描述可以内滚，设置/生成操作条不得随输入内容被裁切。虚拟尺寸测试与真实手机键盘实测需分别记录，不能混称通过。
