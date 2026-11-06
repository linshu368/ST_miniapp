# 执行与验证

方案依据上一轮用户认可，当前“开始改吧”授权执行；本轮只本地。

1. Backend agent：shared契约、鉴权路由、repository、受限迁移与隔离验证；记录失败路径。
2. Frontend agent：卡片互动/详情同层介绍评论/聊天入口/评论UI和草稿；仅编辑组件。
3. Fixture agent：既有虚构场景与roleplay回归，读取成功、失败、丢响应、分页、窄屏。
4. Root：API hooks/收藏count接线、跨端review、移动视觉验收与验收记录。

命令：pnpm --filter @miniapp/shared test；frontend/backend/ui-tests typecheck；相关frontend/backend测试；pnpm test:ui --grep @roleplay（含390/320）；受影响聊天定向回归；frontend lint/build。DB权限/并发/幂等专项需要回归，确认本任务风险评估授权新增该类测试；普通布局扩展旧spec。
人工核对卡片点击区、数量可读、已收藏过滤取消后的失败、面板焦点/关闭、聊天生成持续、软键盘收缩模拟、错误草稿、空列表。模拟不等于真实Telegram键盘或线上数据库验证。
