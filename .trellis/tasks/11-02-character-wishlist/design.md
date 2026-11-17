# Design

## 授权与复用调研

用户确认方案并要求做一版；初始范围为本地完整流程与预览。2026-11-02用户确认效果并授权测试通过后经dev正式上线，包含本次必要迁移。已检索 character-gallery、created-characters、creator-analytics、character-editor、creator hooks/contracts/repository、notifications routes/shared/message detail及SQL约束。
复用现有API client、React Query、抽屉、创作发布AI审核、消息中心与UI fixtures。无需引入依赖。单textarea沿用已有controlled form + Zod，不新增表单库。

## 数据归属与不变量

miniapp_features 下character_wishes、character_wish_supports、character_wish_responses。权威写入由认证backend通过限定service_role函数；用户身份来自服务端。引用app_core.users/characters；功能生命周期是用户发布/撤回、支持和公开作品回应。所有心愿只能匿名公开，API和数据库拒绝private；公开DTO不含作者身份。支持唯一(wish,user)，回应唯一(wish,card)。角色和现有奖励/会话字段不变。

## 最小充分方案与可靠性

统一shared contracts后实现routes/repository和手机页面。创建由客户端UUID保证重试，支持用明确布尔。回应和现有notifications在数据库事务内，business_key去重。原卡公开发布流程保持，wish_id仅可选发布元信息；关联失败返回已发布但未关联状态，用户可单独重试。不上队列/认领/排行榜。数据库调用超时，网络错误原稿保留，单用户按钮忙态防连点；服务端必须验证权限及并发，不信任前端。
首页分页每页12，单详情有作品链接；固定请求上限。没有外部模型调用、计费变化或自动补偿任务。日志仅ID/结果/耗时，不打印心愿正文。

## 演进与恢复

新增迁移，不修改历史；本地Postgres验证RLS/权限/约束/通知。正式顺序为测试库迁移验证→生产迁移→backend→frontend；本次迁移只新增心愿域对象并扩展通知类型。停止条件：作者身份泄漏、重复通知、干扰原发布。回滚页面/路由后保留新表数据；迁移文件附回滚说明。
