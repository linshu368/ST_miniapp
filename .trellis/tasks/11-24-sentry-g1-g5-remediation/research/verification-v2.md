# 验证记录

## 最新整体复核（2026-11-24，v2）

基线HEAD b0d30bccab6a1f0d2cf8ad0f7b1ebf738e63b7be，已包含origin/dev 3e5ff99c。产品文件与dev一致，本轮只更新规划/证据/汇报，不修改运行时或测试代码，不把下列结果当修复后或生产验收。

| 命令/检查                                                                     | 结果                 | 范围及限制                                                                                  |
| ----------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| Frontend first-token-reports/client.retry/request-timing/telegram.hooks 4文件 | 53通过               | 12:03；既有本地回执/请求/取消，不证明原Issue恢复                                            |
| Frontend conversation-stream/use-conversation-turn 2文件                      | 97通过               | 12:07；保留最新reset/拒答重写的相关消费链                                                   |
| shared text-postprocess.test.ts                                               | 44通过               | 12:06；包括现行旧块处理契约，非真实Worker/DOM                                               |
| reply-renderer vitest run -t 'worker lifecycle'                               | 6通过/26跳过         | 12:05；定向检查，6项已包含在下行25项中，不重复加总                                          |
| reply-renderer全量                                                            | 25通过/7失败         | 12:06；7项仍期待退役status/memory卡片/Status/details/旧slot；需迁移测试，不能恢复产品旧功能 |
| pnpm -r typecheck                                                             | 通过                 | 8个workspace消费者完成；没有跳过Frontend/Admin/Backend/shared/renderer/CLI/ui-tests         |
| pnpm lint:imports                                                             | 命令失败、未执行lint | PowerShell/CLI把--rule '{}'解析为字符串，不冒充检查通过                                     |
| pnpm lint:complexity                                                          | 通过、有存量增长警告 | 22/22文件、89/89函数基线；本轮未改产品，不更新/放宽基线                                     |
| pnpm lint:backend-logging                                                     | 通过                 | 401运行时文件；静态门禁不替代真实Pino输出验证                                               |

第一次定向Worker命令把--testNamePattern传给pnpm而非Vitest，CLI拒绝后已改用exec vitest run -t，非产品测试失败。一次检索的PowerShell路径通配和错误repository路径未读取成功，已用rg --files和正确infrastructure/repositories路径重查；未将失败检索当无结果证据。

本轮不做build/完整包测试/UI服务：无产品或测试代码变更，采用已有相关测试、全consumer typecheck及适用静态检查复核；后续有补丁必须按implement.md执行build、相关包测试及UI。未运行真实Telegram、历史CDN失败重放、生产DB等待/receipt终态/账务、供应商或计费操作，不能以本地通过替代这些场景。

本轮规划与等价ESLint检查结果将在下方追加。以下为前轮历史记录，其旧基线/候选补丁和目标由research/review-2026-11-24-v2.md及新版规划取代。

### v2规划及静态检查补充

- PowerShell等价ESLint命令：pnpm exec eslint --no-eslintrc -c .eslintrc.json "packages/_/src/\*\*/_.{ts,tsx}" --no-inline-config，通过（退出0）；没有改脚本或eslint配置，原pnpm lint:imports别名失败仍如实保留。
- logging_planning_gate.py --task通过；仅复用现有api/http/db事件，撤回新SDK/receipt重复事件。
- task.py validate通过；上下文增加复核v2引用。3个源文档超过32768字节自动注入上限，执行/审核仍需显式读完整相关章节，不能依赖截断注入。
- mobile_performance_gate与module_knowledge独立字段验证通过；Prettier、Markdown链接、git diff --check通过；原报告及用户暂存v1与index相比未变，packages相对HEAD无差量。结构门禁不表示未知根因已经确认或获得实施批准；任务仍planning、implementation_authorized=false。

## 规划阶段基线（不是修复后验证）

基线HEAD448a092fb4adb69b58e51285c7aa2018ed0d2714，fix_request_speed。原有产品代码未改；与之后origin/dev隔离实施基线区分，实施后必须重新验证。

- 2026-11-24 11:49 +08，`pnpm --filter @miniapp/frontend test src/lib/api/first-token-reports.test.ts src/lib/api/client.retry.test.ts src/lib/perf/request-timing.test.ts src/lib/telegram/hooks.test.ts`：4文件53项通过，约2.31秒。
- 同时段`pnpm --filter @miniapp/reply-renderer test`：32项，25通过/7失败。失败涉及body scope中的status、status/memory相邻、unclosed status恢复、details pointer/keyboard、details初值、固定slot展示偏好、fenced bracket恢复。失败均在本任务改代码前出现。
- 不以修改断言、改变现行状态栏/记忆栏展示契约或隐藏失败的方式“修复”这7项；须检查实际现行契约和upstream fixture。未证明这些失败是G4 Worker加载的线上根因。
- 11:51左右旧静态依赖只读HEAD为HTTP200、JavaScript MIME和immutable缓存；未下载业务内容或改部署，不能据此证明历史失败已恢复。

## 规划质量检查

PRD收敛、自检、上下文、module/mobile/logging声明与Markdown检查结果在执行独立校验后追加。当前无修复后typecheck/build/UI/生产验收结果。

## 未覆盖

真实iOS/Android Telegram native callback、旧WebView、系统键盘/后台、故障时CDN响应、生产DB锁/receipt最终态、账务和供应商行为；没有做生产迁移/配置/调用。原报告未来时段仍未结束，禁止把原49条扩写成完整24小时统计。

## 规划校验结果

- logging_planning_gate.py --task：通过。
- task.py validate：implement/check各9个有效引用通过。三个源文档超过32768字节自动注入上限；实施/审核必须按显式文件和章节再读完整相关规则，不能只信自动注入。记录planned_branch而未创建，实际branch为空。
- mobile_performance_gate.validate_mobile_performance与module_knowledge.validate_module_impact：通过；双端/API可信基线均null，目标与来源/窗口/发布后验收已声明。
- Prettier、规划链接/占位/敏感字段与git diff --check：检查后完成。
- task.json仍为planning，implementation_authorized=false；没有task.py start、产品代码改动或Git提交。
