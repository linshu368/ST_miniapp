# 实施与验证计划

## 审核前已完成

- [x] 读取根规则、相关spec、模板与G1–G5报告；只读更新上游引用并核对任务/实际commit。
- [x] Sentry五组详情重新核验；G4静态依赖HEAD当前200/MIME正确，未误判CDN根因。
- [x] 基线Frontend4文件53项通过；reply-renderer32项中25通过、7项失败，记录于verification.md。
- [ ] 用户明确批准最新PRD/design/本实施计划。
- [ ] 批准后在隔离origin/dev分支运行task.py start；当前禁止提前实施。

## 审核后的执行顺序

1. 再核远端相关diff，建立codex/sentry-g1-g5-remediation隔离分支/工作区，复制审核规划和输入报告引用；保留原工作区及prompts.md修改，不merge旧feature覆盖上游。若上游已修同问题，改做验证。
2. G5先扩展first-token-reports/client.retry既有测试，覆盖>3秒但<10秒、总预算含排队、10秒超时、断网、未知响应与reload/owner隔离。复用apiClient totalTimeoutMs；Backend回执handler只补必要安全失败日志，不动500/recorded语义或SQL。
3. G4扩展既有reply-renderer lifecycle测试：active/idle error、下个任务重建、旧generation迟到、ready前错误/永不ready、终止/卸载。只修失效Worker缓存，现有fallback与Sentry错误保持。
4. G1锁定初始化失败后最多一次被动重试、成功后幂等、非Telegram、SSR、老WebView；一份局部init.test.ts允许按风险新增。改inited状态与一次脱敏诊断，若SDK时序需改early-ready则停止扩大范围。
5. G3扩展request-timing/client测试，使用真实QueryObserver→removeObserver→body拒绝时序；精确本请求取消才改误报分类，独立网络/HTTP/期限错误保留。无法复现全局拒绝不能标Issue已修。
6. G2复用@roleplay返回定位/封面缩放与尺寸变化；无可复现布局循环，不改observer。需新组件测试文件或重构超长gallery则先补明确风险/范围审核。
7. 检查所有consumer（Frontend/Admin共用reply-renderer、回执producer/Backend、原文/choice安全）与复杂度，保留附近@frontend-ready。改到>500/120的基线运行文件先局部拆小；不为无关失败扩大修复。
8. 更新research/evidence、verification、Issue证据链与修复汇报；本地通过仅写未提交/待上线，保持G1–G3根因缺口和G5 DB等待未确认。
9. 使用trellis-check做全范围质量审核；必要时用trellis-update-spec捕获新契约。任何Git暂存/提交/推送、生产操作与Issue关闭均不执行。

## 可执行命令

按实际改动先相关再包级；下列命令在实施后执行，不将规划基线误写成修复验证。

```powershell
python .trellis/scripts/logging_planning_gate.py --task .trellis/tasks/11-24-sentry-g1-g5-remediation
python .trellis/scripts/task.py validate .trellis/tasks/11-24-sentry-g1-g5-remediation
pnpm --filter @miniapp/frontend test src/lib/api/first-token-reports.test.ts src/lib/api/client.retry.test.ts src/lib/perf/request-timing.test.ts src/lib/telegram/hooks.test.ts
pnpm --filter @miniapp/reply-renderer test
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/shared test
pnpm -r typecheck
pnpm --filter @miniapp/frontend lint
pnpm lint:imports
pnpm lint:complexity
pnpm lint:backend-logging
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin build
pnpm test:ui --grep '@startup|@roleplay|@chat|@creator'
```

若测试有真实DB/供应商依赖，先确认环境与脚本安全，不用本机env偷连生产；不执行真实收费测试。必要的受控本地集成基于既有fixture，不能临时搭新mock服务或关闭失败断言。现有7项富回复失败不得通过改变现行状态栏/记忆栏展示契约消除，须先定位上游行为与fixture契约。

## 失败路径与人工场景

- G1：HTML ready先于SDK、init失败/重入、宿主接收器清理、普通浏览器、iOS旧/新Telegram与前后台，真实有效ready/身份不可伪造。
- G2：Android滚动恢复、懒加载图片尺寸、封面缩放、快速切页；记录可点击与卡顿，不只看错误是否停报。
- G3：已知controller取消与独立SDK/HTTP失败竞态、body晚拒绝、QueryObserver释放、新建/返回/草稿恢复和未完成保存；原请求结果和UI终态均核验。
- G4：Worker入口/依赖404、错误MIME、构造异常、5秒不ready、idle崩溃、取消/卸载和旧回调；输入保留、安全原文可读、choice不越权。
- G5：排队超时、identity慢、RPC3秒失败、服务端已提交而响应丢失、重复/并发receipt、离线/账号切换/重载、达到4次/24小时/20条；不得假成功或重新生成收费。

建议扩展现有@startup/@roleplay/@chat/@creator fixture固定上述可模拟流程，复用其本地API/浏览器隔离。真实native桥、iOS键盘/后台、CDN历史响应、供应商和生产账务无法被fixture覆盖；新release同范围48–72小时、有效曝光及采集健康仍是发布验收。

## 回滚与停止

分批回退应用代码、保留所有用户内容/receipt与服务器幂等；不执行数据库恢复SQL。发现费用/身份/权限/数据丢失立即停止；发现本计划外契约/数据库/宿主桥需求先回审核。typecheck/build或相关测试新增失败未解释时不进入发布建议。
