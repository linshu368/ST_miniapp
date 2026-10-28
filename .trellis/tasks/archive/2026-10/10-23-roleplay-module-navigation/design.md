# 设计

## 复用调研

复用 CharacterGallery/CharacterDetailSheet/CharacterCard、React Query 角色与收藏缓存、useConversationsQuery、session-row-actions、ChatSessionDrawer。新增角色模块头部和最近续聊卡；不复制后台、数据库对象或 HTTP client。
现有 /chats 保留但归入角色模块；不迁移会话数据。发现页增加收藏筛选，对话页只承载会话。底部角色入口高亮覆盖 / 和 /chats。

## 导航与状态

chatEntryPath 增加有限来源 discover/conversations，编码为 from；只映射到 / 或 /chats，拒绝任意返回 URL。useChatSession 的 URL 更新和 returnTo 保留来源。顶部返回、Telegram 返回和 Splash 取消/错误返回共同使用该来源。模块最后栏目仅存枚举；列表返回沿用大厅快照，补收藏筛选。保留旧链接无 from 时回发现；abandonSession 同时 reset 创建结果，防失效旧会话重新占位。
接着聊从已加载的有效 message_count>0 会话中按 last_message_at 选取，不宣称全局最近；不新增服务端排序 API。加载/错误明确区分，没有成功取得历史时不静默创建新会话。详情的用户显式新对话仍复用现有创建链路。

## 可靠性与恢复

只改前端编排。既有 API 超时、有限 query retry、mutation 不自动重试继续有效。禁止复制生成/计费、绕过余额或登录。并发进入保留 existing enteringRef，防止多次创建。删除保留确认并提供请求错误反馈；收藏只用共享缓存。无新增事务/补偿/限流/容量服务，因无新增服务端写路径；不新增遥测正文。模块状态存储失败安全回退。
兼容无来源旧 URL；/chats 仍可直接访问。无数据库迁移，无生产环境变更；回滚前端文件即可。现存影像命名调整保留。

## 最小充分性

不创建新路由体系、通用模块框架、全站状态库、后台 API 或短剧占位，不新增会话收藏概念；优先原有置顶与角色收藏。仅为用户已提出的导航场景建立薄组件/helper。

## 规划审核

2026-10-23：只读 roleplay_scope_review 代理复核五项规划门禁通过。用户已同意试用本产品方案，开始实施。

## 追加设计：回复偏好整合

复用调研：复用 ChatReplyPreferences、generation-config query/mutation 与动态 word_count_tiers；迁移 ChatGenerationSettings 的唯一长度功能后删除闲置组件，工具箱只移除 generation 分支。无新依赖、接口或持久化来源。

长度按钮与模块保持一致圆角和主色选中态，三个内容区用留白和细分隔线分层；展开体限制高度并独立滚动。加载、空档位、查询重试与保存失败均保留明确反馈。

并发：本面板所有写入使用既有字段级乐观合并/回滚；每次 mutateAsync 的 finally 清理对应 pending，防止逐次 observer 回调被后续点击替换。相同字段等待期间禁止重复写入。只移动前端，沿用 API 超时与权限，不增加重试、事务、数据库或部署操作。

兼容与恢复：用户级偏好和历史数据不迁移；恢复原组件布局即可回滚。若保存结果相互覆盖或输入框被遮挡，先修正再预览。已由只读审查代理核对上述动态档位/并发/小屏边界；可执行本追加范围。
