# 实施与验证

1. 共享契约、experience覆盖表/RPC/视图/分支快照，Backend校验与映射。
2. 消息就地编辑、局部删除和滚动保持；复用现有消息操作和React Query。
3. 在既有chat fixture/spec、repository/route单测和分支PG17验收中追加场景；必要迁移专项可新增一个SQL测试文件（权限/并发/分支隔离风险）。
4. pnpm -r typecheck；shared/backend/frontend相关既有测试；pnpm --filter @miniapp/frontend lint/build；bash scripts/test-conversation-branches-migration.sh；pnpm test:ui --grep @chat-edit。
5. 390/320移动尺寸检查，保存失败重试、取消保留原文、无错误扣费、原分支不变。记录未做真机和真实供应商联调。
6. 最终文件清单/摘要交用户看本地效果。本轮不stage/commit/push。

## 多对话抽屉追加执行

仅调整抽屉展示及共享改名组件可选展示参数。扩展现有chat fixture和spec，核对同名/长自定义名/默认及自定义来源分支、菜单不跳转、改名取消/保存、置顶、删除确认取消、原有分支切换。运行frontend typecheck/lint/build、ui-tests typecheck以及@chat-sessions/@chat-branch；本地手机宽度截图复核。无新测试文件，无远端操作。
