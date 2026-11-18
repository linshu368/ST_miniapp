# 执行与验证

1. 合并全部冲突及文档，保留双方有效行为。
2. 在上游repository拆分边界整合视频feed、快照、attempt hydration、参考图映射和错误处理；运营配置走admin-client统一入口。
3. 运行pnpm install --frozen-lockfile --ignore-scripts、pnpm -r typecheck、shared/frontend/admin/CLI既有测试、Backend影像与观测测试、test:ui:fixtures、@image/@creator移动端验收、lint/build和冲突扫描。
4. 失败路径复用既有测试覆盖报价失效、越权参考图、幂等冲突、并发429、queue未知、退款、轮询恢复、视频同款和图片回归；不触发付费任务或远程数据写入。
5. 输出最终文件清单、差异摘要、检查结果和未覆盖边界，供最终人工审查；不自动提交或推送。

Android/iOS及接口P95无本次可见样本，基线为null，目标沿用原视频规划：工作室1500ms、接口800ms；真实模型耗时单列。发布后24小时在正确环境复查，不填零或推测。

本地持续验收复用packages/ui-tests的@image与@creator，涵盖视频提交、终态、重生成和参考图恢复；真实供应商、Telegram下载与系统键盘仍需工程师验收。
