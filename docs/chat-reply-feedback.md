# 聊天回复反馈

用户在完整角色回复下点击点踩，在「提交反馈」面板直接提交，或选原因、填写最多500字的问题细节。原因可多选且都可空，空原因也是有效负反馈。面板提交失败保留原稿，提交成功关闭；打开面板时按需读取之前的记录，不在聊天首屏逐消息请求。

## 保存口径

唯一事实表：`experience.chat_reply_feedback`。每个 `session_id + message_id + edit_version` 只保留一条记录，重复目标提交不新增记录；修改原因/细节更新 `updated_at`，`created_at` 和首次证据保持不变。不同编辑版本和分支会话独立，历史回复生成版本以真实message UUID固定。

表包含：反馈ID、用户ID、角色ID、会话ID、消息ID、轮次、revision、编辑版本、是否继承、模型ID、供应商/供应商模型（历史缺失为NULL）、当轮用户输入、回复快照、原因数组、问题细节、创建/更新时间。只复制当轮可见输入和回复，不复制整段prompt或思考内容。

原因代码映射由 `packages/shared/src/api/chat-feedback.ts` 唯一维护。当前为 `out_of_character` 不符合人设、`controls_player` 替我说话或行动、`lacks_tension` 没有性张力、`ignores_instructions` 没按我的要求、`repetitive` 重复啰嗦、`dull_plot` 剧情没意思、`slow_or_error` 回复慢或出错、`other` 其他。

这是用户反馈事实，不改变角色评分、点赞数、聊天内容或账单。没有运营管理页面或自动外发通知。删除会话后保留分析证据，用户销户时删除其反馈。

## 批量拉取

使用有权限的生产数据库连接，按时间段分页导出；结果是私有用户内容，不提交Git，也不写入日志。示例中的日期在每次实际拉取时替换。首次收集用 `created_at`，增量更新用 `updated_at`，分析人头数使用 `count(distinct user_id)`，不要把多选原因当作多个人。

```sql
SELECT id, user_id, character_id, session_id, message_id,
       turn_index, revision, edit_version, is_inherited,
       model_id, provider, provider_model_id,
       reasons, detail, user_input, assistant_reply, created_at, updated_at
FROM experience.chat_reply_feedback
WHERE created_at >= timestamptz '2026-11-10 00:00:00+08'
  AND created_at <  timestamptz '2026-11-11 00:00:00+08'
ORDER BY created_at, id
LIMIT 1000;
```

超过1000条按上一页 `(created_at,id)` 游标继续，不使用无界结果。原因多选按要素拆分，空数组单独统计「未填写原因」。模型/角色等UUID不由客户端提供，快照由授权RPC读取，因此不会把后续修改误当反馈发生时的内容。

## 接口、权限与迁移

GET/PUT `/api/v1/conversations/:id/messages/:messageId/feedback` 通过现有Telegram鉴权，服务端绑定用户。GET携带 `edit_version`；PUT仅包含 `expected_version`、`reasons`、`detail`，shared Zod拒绝伪造字段。只在面板打开时读，提交10秒HTTP超时；RPC 5秒超时、3秒锁预算，客户端不自动重试写入。

新表RLS开启，anon/authenticated无读写权限；service_role只读表并执行固定search_path的受限RPC，不可直接写表。SQL对本人非删除会话和完成回复鉴权，与编辑/重答共享session锁。单用户每分钟最多30条新反馈；重复目标不额外占用名额。

迁移 `20261110_chat_reply_feedback.sql` 依赖已有 `20261102_chat_message_overrides.sql`，按TEST→生产→后端→前端顺序执行。没有历史回填或更改旧表/视图，回滚只回退应用并保留反馈数据。

## 验收

- `bash scripts/test-conversation-branches-migration.sh`：隔离PG17，空反馈/重复/并发、分支与编辑快照、越权、RLS/ACL、删会话保留与销户清理。
- `pnpm test:ui --grep @chat-dislike`：复用390/320手机环境、空提交、反馈失败重试、刷新读取、提交栏可见和草稿保留。
- shared/backend对应契约和路由测试，所有消费者typecheck；不以本地虚构数据代替生产迁移或真实用户反馈。
