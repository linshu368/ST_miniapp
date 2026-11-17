# 合并与日志接入审计（2026-11-14）

基于本地 HEAD `043c60dc` 与正在合入的 `f25d969b`；没有读取生产业务数据、执行 migration 或部署。

## 冲突处理

- `routes/image-plaza.ts`：保留日志分支提取的唯一 `image-plaza-errors.ts`，把上游新文案移入 helper，删除重复定义。保留已验证的余额不足 402 迁移。
- `routes/models.ts`：采用上游文案，保留本分支已迁移的 MODEL_UNAVAILABLE/409。上游相对于共同祖先只改文案，未改变状态语义。
- `conversation-stream.test.ts`：同时保留 upstream_error/upstream_timeout 的流内错误兼容断言与上游文案。
- `shared/src/index.ts`：保留 backend-errors、drama-survey 两个出口及上游 growth-prompts，消费者不能因冲突处理丢契约。
- `complexity-baseline.json`：保留双方已有拆分，删除不再超限的 community/creator 项，再用 update 收紧；不恢复旧超长方法或扩展例外。

## 已发现和修复的日志遗漏

1. **普通会话没有角色关联**：前一轮绑定误放在 findEmptySession，普通 getSession/requireSession 未覆盖。移到实际 ownership 查询后的记录；新增真实 repository 的纯 mock 回归，避免仅测试注入的 route 字段。
2. **媒体路由参数名遗漏**：:sessionId/:messageId 不能由旧 :id 分支识别。补语音/图片映射；影像创作单独使用 image_conversation_id、attempt_id、work_id、artifact_id，禁止混入聊天 session_id 或角色 creation_id。只从明确路由与 DTO 标量提取，不采集正文。
3. **后台实体不明确**：影像、图片和长期记忆 worker 只有整个 tick 的上下文，供应商/DB 日志无法定位具体实体。逐实体 withBusinessContext 绑定已领取记录的 user/session/attempt 等字段，不增加查询，父任务不残留最后一项身份。
4. **支付/群 webhook 身份遗漏**：支付语义事件保留已有可信内部 user_id，订单仍为摘要；群 webhook 在原 secret/身份校验后绑定 Telegram 身份，原用户匹配成功后补内部 UUID。回跳参数不会获得用户身份或权限。
5. **新增欢迎语直连 fetch**：欢迎语改用现有 clientFetch，维持原 5 秒截止、零重试及异步发送。HTTP 200 只表示 transport，payload.ok=false 保留原 community.welcome.failed 业务事件。
6. **增长/问卷字段输出不完整**：增长数组摘要改为固定布尔，prompt_kind 与 biz/sys kind 分开，recorded/rewarded/with_button 等安全标量入白名单；问卷补稳定成功/失败 event，原始 err 由公共安全序列化器处理。
7. **独立 DB 客户端绕过观测**：共享与大厅 dedicated Prisma 复用同一扩展，保留原连接和事务；pg lease 的 connect/lock/unlock/close 包装原调用。锁竞争、异常、清理与原返回值继续保持；不增加 SQL/连接/重试，不输出 SQL/参数/URI。
8. **规划与指引漏承接**：上游 growth-prompts 任务缺 logging_integration，补齐并保留其原性能样本。Frontend/Admin/Shared/Backend 索引和本地 implement/check 指引接入统一规范，补真实输出、可信来源、SDK 业务结果、并发/出口与合并审查要求。旧缺失日志文档引用改为现行运行说明。

## 可复用性与约束

复用 Pino、ALS、clientFetch、observer、measureDbOperation、现有 repository/DTO 与任务门禁。Prisma 扩展由两个真实消费者共享，没有新通用框架或依赖。新增 UUID 字段统一归一和出口排除；不输出原始用户资料、问卷/聊天/prompt 正文、Telegram API 描述、URL 或凭证。通知默认关闭，无额外日志存储或部署资源。

## 验证边界

自动检查和执行结果集中记入 verification.md。AST guard 检查 fetch/console/定时入口的已知语法，不能证明任意高阶别名、第三方 SDK 内部或所有业务分支的完整覆盖；独立 Prisma/Supabase/pg 接缝另用源码盘点与测试核对。

离线导入、回放、报表 CLI 继续保留现有人读/JSON stdout 协议，是已登记例外。原始 DB/SDK 内部每个网络包、进程强杀后的日志保存、真实供应商和 Railway/P95 不由本地单测保证。发布后按运行说明分环境核验；本次不执行上游新增的两份 migration。
