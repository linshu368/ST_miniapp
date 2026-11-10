# 最小设计

## 复用与归属

复用requireTelegramAuth、getOrCreateDbUser、getDomainDb、requestLogger、apiClient/React Query、Sheet、session_chat_history（含分支和手工编辑），现有conversation branches PG17验收及ui-tests标准聊天。独立小route/repository/hooks避免向超长conversations文件追加逻辑。不建通用反馈框架。

experience.chat_reply_feedback维护本人对会话固定回复/编辑版本的负反馈事实，权威写入方为Backend调用受限RPC；核心互动内容故归experience，不属于派生报表、客服或运营。无现成点踩表。原用户/回复快照在首次提交时固定，原因说明可更新；同一session/message/edit_version唯一。用户销户级联清理；删除会话或源消息保留反馈快照供分析（不设session/message FK，RPC确保初始有效归属），无自动永久删除任务。跨schema仅app_core.users FK，RPC读experience.chat_sessions/session_chat_history/chat_history，不取全量prompt/history，不新增计费依赖。

## API与数据

GET/PUT /api/v1/conversations/:id/messages/:messageId/feedback。GET query edit_version，PUT expected_version + reasons[] + detail。由后端绑定用户与源消息，客户端不得上传模型/角色/正文快照。GET只在打开时发起，React Query按session/message/edit版本缓存，首次打开不中断用户直接提交。UI不因加载旧反馈覆盖已经输入的草稿。旧客户端不调用新接口；不修改history投影或生成入口。

## 可靠性

RPC事务使用现有session锁保证与重生成/编辑边界一致，3秒锁/5秒语句预算；唯一键upsert保障并发/丢响应重试一行。相同目标更新不改变updated_at，已存在版本可重放而不重抓快照。SQL校验有效会话owner/非删除/完整回复/expected_version，分支使用可见源版本。RLS开启，撤销PUBLIC/anon/authenticated权限，仅service_role可select及执行RPC，不可直接写表。受限SECURITY DEFINER固定search_path、postgres owner。数据错误只记录脱敏error元数据、耗时/状态，不输出反馈正文或数据库detail。HTTP 10秒、DB请求5秒，无自动写重试，手动重试保留草稿。首屏无额外查询，GET主键点查、导出按created_at,id索引，写入仅用户主动低频操作；无需队列/补偿/跨设备同步。单个用户每分钟最多30条新反馈，在owner锁下检查；重复目标不新增存储。

## 发布与恢复

新表和两个受限RPC，独立可重放迁移，锁/语句超时，无历史回填或大表修改。本机PG17→TEST→production→Backend→Frontend。必要检查最新commit通过后dev验收，仅独立功能进入main。回滚应用保留已提交反馈，停止入口即可，数据修复forward-fix不DROP。README偏好dev起点与本次用户要求main隔离发布存在差异，以用户已授权发布路线为准。
