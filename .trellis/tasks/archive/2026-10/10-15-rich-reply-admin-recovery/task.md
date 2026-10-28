# 轻量任务清单

- [x] T1 Shared 配置、编译、解析、兼容、诊断与回归。
- [x] T2 Admin 编辑预览及 Workbench 持久化，Backend 同源诊断。
- [x] T3 单文件 migration、文档和本地验证。
- [x] T4 消费者 typecheck/build/现有测试，交付说明。

文件范围：packages/shared/src/api/text-postprocess.ts、text-postprocess/{compile,apply,rich-reply,rich-reply-fallback}.ts；Admin TextPostprocessView 与 lib/textPostprocess\*；Backend conversations/generate.ts；既有相关测试；单个 shared migration；README/ARCHITECTURE/相关 spec。

实现与本地验证完成，待人工验收；未 commit/push，未执行远端迁移或发布。
