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

## 审计整改验证（2026-11-13）

针对用户确认的六类缺口完成五个代码提交：子 logger 安全边界、遗留错误及告警字段、受控诊断字段、HTTP 等级、别名 transport 与后台上下文/CI。未新增依赖、运行时配置或公开 API，未改数据库、业务重试和资金流程；Railway 捕获与默认关闭告警保持不变。

- 全量无凭证 Backend：156 文件 / 1697 项通过，沿用 `--exclude '**/*.integration.test.ts' --maxWorkers=2 --testTimeout=15000`。
- 后端 typecheck、全后端 ESLint、复杂度（34 文件 / 104 函数存量基线）、`git diff --check` 通过。
- `node --test scripts/check-backend-logging.test.mjs`：3 项通过；AST 日志门禁覆盖 311 个运行时文件，通过。
- 专项覆盖：嵌套/后加子绑定、父子隔离、实际 Pino JSON 的安全错误码/有限 cause、无 event error/fatal、公开码与内部码区别、状态/耗时别名、关闭后无通知、HTTP 正常及裸响应的 401/403/409/429 等级、畅聊行情成功/超时且无新增重试、重叠任务独立根上下文/跳过/失败终态。
- 模块知识载荷校验通过；运行说明和 backend spec 同步。此次仅后端内部日志与 CI 检查变动，没有前端/shared 契约或构建配置变动，未重复两端 build；最近一次合并验证记录中的两端构建仍可追溯。

真实 Feishu/Railway 查询、供应商/数据库环境集成与发布后 Android/iOS/API P95 未执行，不能据本地测试宣称通过。静态 guard 不承诺识别任意高阶别名或第三方 SDK 内部请求；已登记的底层日志 transport、通知 adapter 和离线导入例外各自有明确边界。

## 日志接入规划门禁验证（2026-11-13）

原有运行时代码日志 AST 门禁存在，规划阶段没有日志接入声明的硬校验。本次补齐 `meta.logging_integration`：新任务默认 pending，所有任务（包括旧任务重新启动）在 start 写状态/活动指针/执行 hook 前校验；Quality Gate 校验 base..HEAD 触及的活动任务规划。AGENTS、workflow、PRD 模板及专题 spec 同步明确新增/修改功能必须接入或验证复用，纯非运行行为改动才可说明理由后不适用。

- `python -m unittest discover -s scripts -p test_logging_planning_gate.py`：8 项通过，涵盖创建默认值、完整/不适用声明、占位及非法字段、缺失声明、两种会话模式下无副作用、降级启动、CI 选择与基线失败。
- 当前任务的独立 logging planning gate 与模块知识载荷校验通过。
- 工具提交 `eee9f3b9` 后，用本轮起点 `ff7dfe3a` 以及本地 `origin/dev`、`origin/main` 引用分别运行 `--base`，均选中并通过当前任务，验证真实 Git diff 路径；这些本地引用检查不代表远程 CI 已执行。
- `node --test scripts/check-backend-logging.test.mjs`：3 项通过；`pnpm lint:backend-logging`：311 个运行文件通过。
- 本轮只变更 Python 工具、CI 及规划规范，没有修改应用包、依赖或运行时配置；不重复前轮已通过的应用 typecheck/build。Python 语法检查及变更文件格式检查通过。

门禁检查结构完整性，不会自动判断理由真实性或证明业务日志覆盖。CI 不追溯未触及/已归档规划，也不要求每个仅改源码的 PR 都有任务文件；功能变更仍需遵循先规划、再实现并验证日志接入的项目流程。未执行远程 CI、push 或部署。
