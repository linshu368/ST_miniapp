# 本地移动端性能测试机制（暂停）

2026-11-11 用户澄清：仅取消后续开发必须执行本地性能测试的要求，**此前已有门禁要求不受影响**。`11-11-local-mobile-performance-gate` 继续暂停，待重新研究后决定。

## 继续适用的既有要求

- 根AGENTS.md及Trellis原有规划、可靠性、复用、演进、可验证性、模块知识和质量检查门禁保留。
- 新任务继续生成 `meta.mobile_performance`，声明受影响页面/接口、Android/iOS基线与目标、数据来源/窗口及验证安排；无样本填写null并说明，不推测或补零。
- `task.py start` 继续校验既有性能规划声明；pending或不完整时阻断。不适用时须给具体理由。
- 已明确约定的任务验收标准继续适用，不能因暂停本地工具自动标记通过或完成。

## 暂停的新增要求

后续开发不强制连接Supabase TEST运行Android/Chromium、iOS/WebKit固定20样本/P95<=2秒的本地采样；不要求提交该工具报告或开发者性能豁免。11-11新增的采样器、结果/归档/CI门禁继续停用，未启用远端required check。

研究和历史报告保留于 `.trellis/tasks/11-11-local-mobile-performance-gate/`。实现快照位于忽略目录 `output/performance/deferred-20261111/implementation.zip`；恢复前重新确认设计。本文件不替代原有门禁，也不新增强制实测。
