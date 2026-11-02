# 设计

基线 origin/main 5fffd6ce；不包含未发布 dev 修改。复用 ConversationHistoryRepository/session_chat_history、现有会话锁、Fastify 鉴权/错误映射、React Query详情缓存、ChatMessageBubble/List、Dialog/Textarea、ui-tests fixture和PG17分支测试脚本。

## 数据归属与最小方案

新增 experience.chat_message_overrides：按 session/historyID/role 保存局部编辑或删除及乐观版本号。会话主人唯一写入；生命周期随会话，引用原history事实；只供角色聊天显示、上下文及分支使用，不改计费域或原始生成行。RPC校验会话所属、当前revision、十轮范围、未生成，使用会话行锁串行。session_chat_history附加删除/编辑版本并覆盖文本；旧无覆盖行行为一致。删除不移动轮号或上下文窗口。
分支创建事务复制所选有效范围内的覆盖记录到新会话，既有分支保持独立。重生成使用修改后的user_input，已删除用户输入拒绝重生成。单条修改不重写早期prompt前缀，也不重写后续消息。

## 可靠性

5秒RPC预算、短锁预算、前端禁重复提交；不自动重试。expected_version防覆盖并识别同一目标重试，过期编辑给用户反馈保留草稿。生成与修改复用锁；生成中拒绝写入。会话内精确缓存更新，其他会话不动；失败不作假成功。日志仅ID/耗时，不记录内容。无新队列/缓存系统/供应商调用/退款。

## 发布与恢复

仅本地候选SQL。后续单文件 TEST验证、生产迁移、Backend、Frontend；停用入口不删除覆盖表。旧后端无法完整理解删除状态，使用forward fix。禁止通过旧view回滚使已删内容复活。需要性能查询计划确认session过滤可下推。

## 最终交互

角色编辑作为右侧独立44px铅笔入口，用户编辑收进底部更多菜单；分支和删除也是更多菜单项。删除确认在原位完成。编辑只对角色正文开放，原有附加内容由repository按当前身份读取并保留，RPC乐观版本检查避免并发覆盖。

## 验收隔离

自动验收默认3130/3131，增加ST_UI_TEST_APP_PORT覆盖，fixture地址与出站白名单跟随选定端口；仍严格核对工作目录，禁止复用其他窗口服务。同一worktree不并行跑多套自动验收。

## 多对话抽屉展示规划与自审

复用 ChatSessionDrawer、useSessionRowActions、SessionRenameField/DeleteConfirm、既有查询/改名/置顶/删除mutation；保留服务端排序和身份。默认title没有来源标志，仅空、等于当前角色名或明确默认分支名可日期兜底，其他按自定义名称保留；branch.source_turn_index直接显示，不加1。resolveSessionTitle共享7字限制不改，抽屉局部CSS控制长名。更多菜单只是本地展开状态；沿用失败/禁重复提交/删除确认，未成功不伪造结果。无接口、容量、迁移或重试变动。单独回退抽屉即可恢复旧展示。复用fixture扩展同角色多会话及窄屏流程，自审通过后实施。
