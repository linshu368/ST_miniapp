# 本地验收 2026-10-29

已完成：回复点赞保存/取消、角色累计数量联动；左侧语音（Volume2小喇叭）和分支，右侧重新生成和点赞。点赞48px，语音/重新生成44px，320px窄屏自然换行。

通过：shared 188项、backend相关85项、frontend相关19项、fixture 6项；全部包typecheck、前端和运营端构建。`pnpm test:ui --grep @chat-like` 5项通过，含320/390触区、失败恢复、刷新、返回大厅累计数量、历史回复/分支/重生成隔离。数据库聚合/幂等/权限验证见database-verification.md。

最后左右分组与喇叭图标是UI小改，仅在现有预览复看320/390并检查差异格式，未重复整套构建。截图位于output/playwright/reply-actions-final-mobile.png及reply-actions-final-narrow.png。

仅本地虚构场景与隔离PG验证，尚未执行远端迁移、提交或发布。后续简单UI调整复用预览即可，不新增测试脚本或扩展功能范围。
