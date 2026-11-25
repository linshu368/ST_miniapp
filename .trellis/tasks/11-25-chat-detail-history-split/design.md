# 设计与风险复核

- 复用 `registerConversationDetail`、`listMessages`/`list_chat_message_page`、现有显示映射与 `recoverActiveDelivery` 内存预览。删除读请求对 `recoverStaleStreaming` 的依赖；owner 校验后并行读角色/分页，保持全成功才返回和原有 8 秒预算。身份初始化仍走既有服务。
- 复用 production 已运行的 `chat_history_sync`、`scanStaleStreaming`、`processSyncRecord` 和恢复 CAS；5 秒启动、30 秒扫描、有界批量/并发、无 24 小时下界、稳定游标、依赖失败下轮恢复。Railway 最新样本 worker 正常完成，生产部分索引 valid/ready；成功结束且 recoveredCount=0 的样本不足以证明积压能力。进程重启从头扫，跨实例竞争由原数据库守卫处理。发送或重生成的写路径仍同步校验恢复，保留会话锁与结算顺序。
- `CONVERSATION_ENTRY_MESSAGE_LIMIT=6` 继续使用共享常量、现有 query key 和同一个 HTTP GET。新首屏、刷新、轮询都读最新 3 轮；向前页使用原游标和原分页容量。复用 `useChatHistory` 合并、代际取消和已读缓存。现有消息滚动 hook 增加用户向旧消息方向的触发，滚动到顶/短页滑动/点击复用同一分页入口和锚点。首屏不启用可见即取的 observer，加载失败后用户可再操作。
- 旧聊天客户端传原 limit 仍被支持；无 DB 对象、迁移、额外队列、预算放宽、自动恢复写/额外客户端轮询。后台恢复异常时历史和已存预览仍可读，最新沉睡流可能暂时保持 streaming，原 busy/停止和服务端保护继续生效；实际等待受后台积压影响。账务事务、幂等和补偿由原模块负责，本次无新增写入。独立回滚前后端可恢复原路径，发布先确认 worker 开启与索引有效；若历史错误增多或恢复积压持续，可回滚 Backend。
- 方案复核：两次用户指示明确分离恢复并缩小首屏。代码边界确认后采用最小改动；不把旧业务时钟算作新版效果。任务源码检查先核对并发、分支、短列表及加载失败，发布后按移动端平台和 read_purpose 核对延迟与收口。
