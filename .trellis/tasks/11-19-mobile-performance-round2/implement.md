# 总执行计划

1. 审核四个子任务和研究材料；后续用户批准最新摘要后逐个start，不start父任务代替子任务。
2. 重读当前分支与相关spec；保留用户并行修改，inline单代理串行实现共享文件。
3. 聊天取消分类及真错误回归；角色兼容/owner裁减及草稿回归；影像调度/交付及租约回归；冷启动诊断与证实的最小关键链修复。
4. 每批执行子implement的现有测试/typecheck/lint/UIfixture；跨包及最终集成执行下列命令。
5. 性能/恢复后验收必须分开本地虚构、TEST真实和生产真实，未获发布授权不操作生产。

```powershell
pnpm -r typecheck
pnpm --filter @miniapp/shared test
pnpm lint:imports
pnpm lint:complexity
pnpm lint:backend-logging
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin build
pnpm lint:db-contract
```

无产品修改的规划阶段只运行三项规划验证、文本/路径和任务关系校验；应用检查留到实际变更后，不能写成已通过。新增测试文件仅两处高风险回归（conversation-detail.test.ts与video-delivery-job.test.ts），其余扩展既有测试/fixtures。

必要人工场景：真实Android/iOS冷启动、弱网和后台恢复、编辑器草稿/封面回流、对话取消/重入、TEST SIGTERM视频续传；真实支付/模型/签名和生产P95不能由mock代替。验收保留N、来源和窗口。

最终按trellis-check检查全部scope，trellis-update-spec评估知识变化；module-updates.json只描述已完成事实。人工审查最终diff/digest与文件列表前不stage/commit，绝不自动push。各批回滚点见子design。
