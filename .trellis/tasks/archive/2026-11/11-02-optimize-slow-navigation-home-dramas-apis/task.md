# 可执行任务

- [x] NAV-1（completed）`components/nav/bottom-nav.tsx`：实现 entry-background 后的有限串行路由预热与取消。
- [x] DRAMA-1（completed）`app/(main)/dramas/page.tsx`：分批挂载并兼容滚动恢复、筛选和完整播放队列。
- [x] MSG-1（completed）`lib/api/notifications.ts`、`app/(main)/profile/page.tsx`：共用 query options 并按未读分类预取。
- [x] CHECK-1（completed）审阅全量 diff；Frontend test/typecheck/lint/build 均通过。
- [x] CHECK-2（completed）`@drama`、`@profile`、`@navigation` 现有 UI 回归通过；生产剩余风险已记录。
- [x] CLOSE-1（completed）复核模块知识、形成验证记录并使用 `task.py archive --no-commit` 自动归档。
