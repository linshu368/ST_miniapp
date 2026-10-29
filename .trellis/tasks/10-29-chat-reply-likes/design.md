# 设计

## 复用与范围

已检索 shared conversations、ConversationHistoryRepository、conversations routes、消息 footer/分支/重新生成、character_social migration和现有ui-tests。没有既存的真实回复点赞事实；角色卡直接点赞与回复点赞分别保存，角色卡总数聚合两类真实记录。扩展既有会话API/repository/footer；只新增小按钮组件、一个迁移，不增加社交体系、计数器、队列或分析平台。

## 数据归属与不变量

experience.chat_message_likes 维护“会话主人喜欢该会话里某个固定回复版本”的事实，属于核心互动反馈状态（归属流程第2步），用户端运行时需回读，不是analytics。PK(session_id,message_id)，message_id为实际chat_history ID；FK分别到同schema sessions/history，删除级联。新增只读跨域依赖：miniapp_features.get_character_socials调用experience批量计数accessor，不直接读取互动表。created_at记录首次点赞，取消删除；不复制正文、prompt、角色点赞数或计费事实。随功能/会话生命周期删除，软删会话后禁止新写。唯一权威写入口为service-only RPC，table开启RLS，service_role只有SELECT，anon/authenticated/PUBLIC无权。

set_chat_message_like(p_user_id,p_session_id,p_message_id,p_liked) 返回 {session_id,message_id,liked}。短事务锁定用户拥有的未删除会话，session_chat_history验证当前可见且success/有正文的锚点（含固定继承）；true INSERT ON CONFLICT DO NOTHING，false DELETE。显式目标值天然幂等，无需请求UUID。无效/外人会话P0002；无效回复P0423→reply_like_not_allowed(409)。锁与语句有限等待，不调用模型/钱包；角色总数在既有读取时聚合，不双写角色直接点赞。重生成切换实际history ID，旧反馈保留于旧版本，不串入新版本；分支表不复制点赞。

session_chat_history视图仅末尾追加liked布尔（两个leg各按session+historyID主键EXISTS），保持原列/权限/security_invoker。消息显示投影读取liked，上下文不选择它，避免额外HTTP或每条消息查询。不改current_chat_history，不产生聊天轮数/会话排序更新。每个可见回复最多一行，不建立额外热度计数表/排行榜；数据库主键与会话归属限制写入面。

## 契约与交互

ChatMessage.liked?: boolean（旧响应缺失=未赞）；SetMessageLikeRequestSchema=strict({liked:boolean})；SetMessageLikeData={session_id:string,message_id:string,liked:boolean}。PUT /api/v1/conversations/:id/messages/:messageId/like，Telegram鉴权、UUID验证、no-store、5秒repository预算，前端10秒有限等待、不自动重试。日志仅ID/布尔/耗时。

用ThumbsUp小图标、至少48px按钮，放在操作行最右侧，以轻微留白区分；选中低饱和主题色填充，轻微active反馈、可用时复用useHaptic。保留aria-label点赞这条回复/取消点赞和aria-pressed，不靠颜色单独表达。请求中保留点亮反馈，锁当前按钮避免重复；失败回退并行内轻提示，不影响输入/其他消息。组件/缓存按session+message身份隔离，历史分页的显示也更新，迟到响应不得污染别的会话或新revision。不新增成功toast、红点、回复旁人数或点赞确认。

## 演进与验证

当前仍是未发布分支功能上的增量；保持既有origin/dev基线和其他未提交改动。迁移顺序20261029_conversation_branches.sql → 20261029_chat_message_likes.sql → Backend → Frontend。应用回退可忽略liked并保留表/权限，不回填旧消息、不改旧generation函数。测试在本地隔离PG17，复用分支migration harness增加喜欢/取消/幂等/权限/继承与revision隔离断言，明确不是线上联调。鉴权/契约回归扩展本次尚未提交的conversations-branch.test.ts和已有history tests；UI扩展既有chat.spec.ts/fixtures，不另搭一次性环境。运行shared、受影响backend/frontend测试、全部消费者typecheck和两端build；浏览器固定场景覆盖320/390。

独立评审补充：message_id单列索引保证FK级联定位；显式撤销默认service权限后只授SELECT；与重生成共用session行锁并设置有限lock_timeout。依赖迁移顺序固定，追加liked后不能重跑试图删除末列的旧分支迁移；只验证当前点赞迁移重复执行。

用户最新口径：大厅角色卡like_count=直接卡片点赞数+所有手动回复点赞记录数；liked仍表示本用户的直接卡片开关。experience.get_character_reply_like_counts(uuid[])一次处理最多40个角色，只返回角色ID/数量。旧版本、不同会话与分支手动赞都计入，重复同目标幂等，取消删除并减回；分支本身不复制反馈。字符social既有RPC复用该accessor，保留返回结构与权限，先有character_social/branches，再执行本迁移。
