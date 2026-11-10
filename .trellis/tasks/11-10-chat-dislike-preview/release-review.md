# 发布审阅

范围：聊天回复点踩、可空提交反馈弹层、按版本保存私有反馈及快照、固定验收场景。不包含其他窗口模型选择器改动，不增加运营页面。

数据：experience.chat_reply_feedback；原因、详情、用户/角色/会话/回复/版本、模型与可获得的供应商、同轮输入及回复快照、时间。只允许服务端授权 RPC 写入，RLS 隔离，重试去重。删会话保留分析证据；删除账号级联清理。

验证：所有包 typecheck；shared 233 项、相关 backend 39 项、frontend reply presentation 13 项通过；frontend/admin 生产构建通过；现有移动端验收 6 项通过（390/320 宽和压缩高度）；PG17 migration 重跑、并发去重、越权、编辑和分支快照、删除会话/账号均通过；lint/imports/legacy/migration/complexity 检查。原 backend 测试缺少环境占位配置导致初始化失败，使用 CI 相同非秘密配置重跑39项通过。

真实 Android/iOS P95 暂无样本，不声称已测得。首次进入聊天不新增反馈请求，仅打开弹层读取、提交时写入。

发布顺序：同步最新 main，提交本功能 → dev 验收 → TEST 单文件迁移 → production 单文件迁移 → 独立 main PR → 确认部署。异常先回退应用版本，保留已收集反馈表，不删除数据。
