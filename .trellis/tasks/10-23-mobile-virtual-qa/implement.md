# 执行与验证

1. 独立审阅PRD/design/task，记录结论后task.py start；实现前读上下文。
2. Backend agent仅修改MiniappWalletRepository及其现有测试：先复现漏明细，再最小查询修复；不触碰钱包写入。
3. API agent仅修改image-plaza.ts及现有cache测试：复用queryFn比较，覆盖ready/失败/重入/分享刷新；补现有Telegram保存mock测试。
4. Layout agent仅修改聊天composer/preferences、既有布局helper/tests、studio必要样式；可视高度变化重算并限制总预算。
5. Root运行移动320/375/390宽和键盘压缩高度的本地预览；检查参考图、长文、偏好、按钮和保存fallback，记录可见证据。
6. 执行pnpm -r typecheck、pnpm --filter @miniapp/frontend test/lint/build、backend钱包及image-plaza测试、适用import guard。独立最终diff审阅。
7. 更新task.md验收事实和限制；明确虚拟结果不替代真实生成、扣费和相册落盘。未获新增发布指令，不stage/commit/push。
