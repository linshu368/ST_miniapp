# 回复点赞数据库验收

2026-10-29，仅本地 PostgreSQL 17 隔离容器与合成数据。没有远端访问、生产迁移、真实聊天读取、模型调用或扣费。

## 实现与归属

新增 `packages/shared/migrations/20261029_chat_message_likes.sql`，按任务设计将个人回复反馈放在 experience。PK 为 `(session_id,message_id)`，实际 history ID 固定版本，两个同域 FK 均删除级联，message_id 另有索引。引用继承消息不复制源点赞；重新生成的新 ID 不继承旧反馈。

service role 仅可读表，写入通过 `set_chat_message_like(p_user_id,p_session_id,p_message_id,p_liked)`。会话锁与重生成保持一致，3 秒锁等待预算；仅接受本人未删除会话中当前可见、success、非空的回复。显式目标状态可幂等重复；返回 JSON 与请求身份一致。P0002 表示会话不可用，P0423 表示回复不可操作。

没有新增跨域写入、生成/账务行、会话排序或统计触发器。新增experience只读批量计数accessor，由既有角色social RPC聚合总数，不直接跨域查互动表。原分支迁移文件保持不变。

## 复用验收

```sh
bash scripts/test-conversation-branches-migration.sh
```

仍由原脚本建立无网络、无主机端口、无外部数据卷的 PG17 容器；保留原基础函数和实际后处理迁移。按依赖顺序执行分支迁移两次，再执行点赞迁移两次；不在已追加 liked 后重跑旧 view。全部用例继续放在原 `packages/shared/migrations/tests/conversation_branches.sql`。

最终执行退出 0，输出：

```text
PASS: sequential conversation branch and existing generation contracts
PASS: reply likes (idempotency, permissions, revision/branch isolation, session independence, cascades, context projection)
PASS: character totals combine direct card and all explicit reply likes without copying feedback
PASS: conversation branches and reply likes PG17 (context, revision, independence, windows, auth, idempotency, concurrency, accounting isolation, account cascade)
```

新增验证：

- 点赞/取消/重复 true/false、首次点赞时间不被重复写改动，回读 liked 正确。
- 直接 service_role 写表被拒绝；anon/authenticated 不可读写表或执行 RPC；RLS、owner、安全搜索路径与时间预算符合约束。
- 跨用户、跨会话、空参数、失败/流式/空回复、旧 revision 均拒绝。
- 原会话与分支相互独立；嵌套分支不复制点赞；普通及继承末轮重新生成均保持新版本未赞、旧反馈保留。
- 点赞不增加真实 history，不修改会话统计、更新时间或排序字段。
- 源软删除阻止原会话反馈写入；独立分支可继续点赞。history/session 物理删除及完整账户删除不会留下悬空点赞。
- 四个独立连接并发 true 均成功、返回一致，只留下一个反馈事实。
- EXPLAIN 确认上下文选择旧字段、不选择 liked 时，计划不读取 chat_message_likes。

`bash -n scripts/test-conversation-branches-migration.sh` 和 `git diff --check` 同样通过。

## 发布与限制

这是数据库级本地验证，不替代浏览器手感验收或远端环境迁移核验。应用需使用同一次历史读取的 liked 投影，无额外逐条 API。EXPLAIN 使用合成数据，仅证明未选择反馈时可裁剪其读取，不声称已做生产规模性能压测。

正式顺序：分支迁移 → 点赞迁移 → Backend → Frontend，仍需独立发布授权。回退本次点赞 UI/API 时保留表与反馈即可；分支自己的恢复边界继续适用。

## 最新计数口径与补充验收

大厅角色总赞=原角色卡直接赞+该角色所有手动回复赞。每条记录累计；同回复重复true不增加，false减回，分支不自动复制；不同会话/分支手动赞及旧revision反馈保留累计。既有get_character_socials通过experience.get_character_reply_like_counts批量accessor读取，仅角色ID/数量跨域，不返回聊天或用户身份。原liked直接卡片开关、收藏和评论计数保持原语义。

原PG harness新增实际character_social迁移，验证直接赞、多回复累计、重复、取消、分支不加数/手动加数、重生成前后累计、批量不串角色与accessor权限。最终复验退出0，包含原全部用例和新增角色聚合用例。正式前置增加已部署的character_social迁移；没有修改该历史文件。
