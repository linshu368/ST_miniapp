# 本地验证记录（2026-11-13）

基线 98fd5708，分支 feat_log_modules。未 push、未部署、未访问生产业务数据、未执行 migration，也未发送真实飞书通知。

## 已通过

- Backend 全量无凭证测试：149 个文件 / 1619 项。命令：`pnpm --filter @miniapp/backend exec vitest run --exclude '**/*.integration.test.ts' --maxWorkers=2 --testTimeout=15000`。
- 重构后的 Admin/Creator 路由及 Sentry 专项：3 文件 / 39 项。
- Shared：20 文件 / 233 项（`pnpm --filter @miniapp/shared test`）。
- Frontend 流式消费者：1 文件 / 31 项（新旧错误码均保留半截文本）。
- `pnpm -r typecheck` 所有包通过；末次 Backend 改动另跑 typecheck 通过。
- Backend ESLint、`pnpm lint:backend-logging`（291 个运行时文件）、`pnpm lint:complexity` 通过。复杂度基线从最初 38 文件/108 函数收紧到 35/105；不修改无关 Admin 基线。
- `pnpm --filter @miniapp/frontend build`、`pnpm --filter @miniapp/admin build` 通过。存在既有 img/hooks、Browserslist 数据和大 chunk 提示，不作为本次新增缺陷。

初次全量与 Next build 并行时有动态导入超时；旧 console 断言也随迁移失败。更新断言后单独复跑失败文件 47 项通过，再完整运行得到上述 149/1619 全通过。未修改业务截止时间来规避测试失败。

## 覆盖证据

核心：并发与嵌套 ALS、一次终态、执行一次/原结果与原错误、输出失败隔离、敏感字段。HTTP：提前响应、真实 socket 断开、hijack SSE、状态与请求关联。transport：未消费响应正文、未变更 Response/AbortSignal、超时/取消、无自动写重试。支付：既有幂等、未知写入和回调验证。通知：关闭不解析规则、不发送；第一条命中、匹配失败、4并发上限、2.5秒退出、无递归、原 event_id 可回查。

## 仍未验证及兼容保留

未采集真实 Android/iOS 页面或 API P95，未核验 Railway 保存和实际通知投递；task.json 中无样本基线保持 null。应在发布后按24小时窗口验证，样本不足延长。

图片描述公开422、免费试用 INVALID_STATE、尚未单独验证的通用兜底保持兼容，不能宣称历史错误目录全量落地；源码原因与消费者分析见运行说明的矩阵。真实供应商/支付/数据库集成需要目标环境及单独数据验证，普通无凭证单测不替代。

建议复用 ui-tests 的 @chat/@profile/@image 持续验收失败显示、半截文本、余额不足与支付未知状态查询；本次没有更改页面流程，不新增临时 UI mock 系统。

## 合并冲突验证（2026-11-13）

将上游 `05119f25` 合并至日志分支 `26eaa901`，解决 14 个冲突文件。保留上游会话分组、增长入口、畅聊任务、请求调度与 Telegram 签名/有效期/生产 bypass 限制；保留日志上下文、CORS 链路头、默认关闭告警和已验证的超时错误码。复杂度基线沿用双方已完成的收紧，不重新引入已拆分的超长文件/函数。

模块知识载荷重新基于上游会话分组文档生成并通过 `module_knowledge.py check`，避免未来归档覆盖上游说明。鉴权和 CORS 涉及安全与跨域契约，在已有测试文件补充生产 bypass 禁止与链路头暴露断言，没有新建测试文件。

- Backend：155 文件 / 1687 项通过；补充后的鉴权/CORS 专项 2 文件 / 10 项通过。
- Shared：21 文件 / 235 项通过；Frontend 请求计时/流式消费：2 文件 / 42 项通过。
- 全仓 typecheck、Backend ESLint、日志门禁（311 运行时文件）、复杂度检查通过；既有复杂度增长警告保留，不扩大此次冲突处理范围。
- Frontend/Admin 生产构建通过。首次分别被本地 Next.js/lightningcss 包文件缺失阻断，按冻结 lockfile 修复安装后复跑成功；未变更依赖声明或锁文件。保留既有样式、img/hooks 与大 chunk 警告。
- 格式化检查通过。默认 lint-staged 曾遇到索引锁/暂存恢复错误，串行执行 `pnpm exec lint-staged --no-stash --no-hide-partially-staged --concurrent false` 成功；工作区没有未解决冲突。

未执行上游新增迁移、生产操作或真实告警；原任务的线上验证边界继续适用。
