# 设计

## 本轮范围（2026-11-02 用户确认落地）

从已确认的五块手机预览接入真实只读数据。创作入口略加强，首页作品/奖励/反馈各最多3条；全部面板服务端分页（每页4条），选卡面板分页；保持暖黑金色及原有信息层级。本次仅发布创作数据，不改奖励结算。

## 复用调研

复用CreationHub、Sheet、React Query/apiClient、Telegram鉴权、Prisma单例、封面签名resolver、公开评论匿名mapper和packages/ui-tests固定验收。现有creator.list限200且不含统计，不作统计权威源；现有social RPC包括自用且限制可见性，不直接复用。preview假数据移入ui-tests fixture，生产组件只消费shared契约。

## 数据不变量

- app_core.character_creations限定登录作者，任何请求不接收作者ID；单卡外人或不存在均404。不读取完整draft，只取名称及封面元数据。
- experience.chat_history按session_id+turn_index合并所有success revision，先取最早成功时间再筛日期；不读分支展示view、不用session.message_count，排除branch_inherited_turns内的继承轮重生成。作者自用排除。成功聊天才计玩家。
- 同一卡期间>=10轮/跨>=2个北京时间自然日分别计深聊及回访玩家，跨卡汇总按人去重。
- billing.character_creator_rewards真实credited_amount正到账与reversal_recovered_amount负调整按各自时间统计，允许负净额；不改账本。私密/归档不丢历史。历史作者归属固定，奖励总览按creator_user_id，不按当前visibility。
- 当前获赞=卡点赞+回复点赞，当前收藏排除作者；不能虚构已取消互动的历史曲线，UI明确当前值。反馈仅未删除公开评论，沿用匿名展示，排除作者。
- 近7/30天包含今天，Asia/Shanghai自然日，截止时间服务端产生。每页snapshot截止时间保持分页稳定，客户端只可指定过去截止时间。

## 最小充分实现与可靠性

一个只读GET /api/creator/analytics，以section=overview|works|rewards|feedback|characters分支；shared Zod校验query与response，page<=1000000/page_size<=20，默认summary3/list4。参数化SQL只在creator repository；所有源按owner约束。查询用只读事务、statement_timeout 6s、事务8s，cover签名在事务外，最多一页并行；不建表/RPC/事件队列/缓存/cron。错误返回可重试503，不伪装成0；前端query隔离用户/范围/分页，不沿用上一张卡的数据。只读无需幂等或补偿，不自动无限重试。日志仅section/period/page/耗时/状态，不含对话正文和玩家身份。

## 验证与恢复

安全与汇总误导风险需要新增聚合/路由回归，用现有无网络Postgres容器与creator脚本真实表验证SQL，再扩展creator.spec验收首页3条、全部翻页、窄屏、筛选、空/失败重试。跨包typecheck/build/shared tests及相关backend tests。无数据库迁移；先backend后frontend兼容发布，回退移除入口/路由即可，账务数据不变。用户现已授权验证通过后提交并经dev上线；生产只发布该功能，保留main既有代码，不整批发布其他dev功能。
