# 执行与验证计划

开始条件：用户明确批准本版规划后，执行 `task.py start`；此前不编辑产品代码。实施不委派子代理、不提交、不部署。

1. 扩展 generation 返回/错误中的安全诊断及受取消的正文读取，保留原接口消费者兼容。仅携带长度、usage、有限finish_reason/status，绝不携带正文到错误。
2. 在 compress-job/text 增加阶段化 attempt 摘要，修正预精简真实上限；将 too_long 后的下一次尝试改为档案精简，目标80%→60%；不增加调用次数或放宽校验。观察回调异常隔离。
3. worker 改按需领取、最多三条；逐块跟踪已提交进度和范围；finish失败/lease_lost真终态，保留原Sentry告警策略。
4. safe-log精确允许字段，必要中文事件名称；同步现有运行文档、README、架构与模块事实候选。无新运行时配置/SQL/共享契约。
5. 扩展 compress-chunk.test.ts、story-memory.test.ts、logger.test.ts；风险要求新增 generation/story-memory-compress.test.ts 与 story-memory/worker.test.ts，避免真实网络/数据库/通知。

## 失败矩阵与消费者验证

- 真实Pino stdout：output=6000，hard=5000，validation=4250，target=3250，over=1750均存活；正文/昵称/密钥/原始错误自由文本完全不输出，未知usage省略。
- 第一次即成功；两次超长后精简成功；三次均超长；修复缺分区/思考；超长候选不被坏修复覆盖；emoji/空白/围栏口径；空输出和异常缩水仍拒绝。
- 预精简成功/too_long/上游异常回落与日志；预精简在硬上限以内但超过实际85%线，记录正确拒绝线。
- 401/403/429/5xx/无body/非法JSON/256KiB超限/finish_reason=length/取消/静止body超时。无网络快速重试；reader必须被取消/释放。
- worker领取上一条时只领1条、前一条收尾后才领取下一条；空队列退出、最多3条、配置不可读仍收尾；不改模型并发。
- 第一块提交后第二块失败：第一块进度出现在摘要，覆盖不回退，下次从新覆盖终点继续；commit异常不伪造成功；finish抛错/lease_lost不报成功；第三次失败告警一次。
- 未改变shared API，所以无Frontend/Admin契约消费者变更；类型检查所有受影响 Backend 调用方、replay脚本。日志SDK现有安全投影测试照常运行。

## 命令

```powershell
python .trellis/scripts/logging_planning_gate.py --task .trellis/tasks/11-20-story-memory-stability
pnpm --filter @miniapp/backend exec vitest run src/features/story-memory src/features/generation/story-memory-compress.test.ts src/platform/observability/logger.test.ts
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/shared test
pnpm lint:backend-logging
pnpm --filter @miniapp/backend logging:validate
pnpm lint:complexity
pnpm lint:imports
git diff --check
```

若抽取/修改基线超长函数，先拆小后执行 `node scripts/complexity-budget.mjs update` 并复核基线只收紧。本仓库Backend没有build脚本；没有跨包/部署改动时不伪造build成功。依赖安装/环境导致无法运行的检查必须列出。

人工回归：TEST虚构长档案与大量新剧情、上游失败保留旧版、下一轮正常聊天不等待压缩、跨副本ownership冲突、新消息不重置退避、连续失败告警；人工操作不得在本轮偷偷调用生产模型。复杂后台失败恢复建议复用现有本地@chat验收，以固定记忆已就绪/压缩失败旧记忆保留场景扩展fixture；真实模型质量、跨副本与迁移退避仍需独立验证，不用UI模拟代替。
