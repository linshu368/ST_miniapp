# 执行计划与验证

## 实施前门禁

1. 用户于2026-11-27明确“批准并修复”，规划已批准，task.py start已通过。实质方案变化仍按design门槛处理。
2. task元数据module_impact、mobile_performance、logging_integration完整；运行task.py validate及logging_planning_gate.py，结构通过不代表人工审核完成。
3. 保留原报告、当前HEAD及工作区差异；不自动切分支/混入无关修改。按根规则确认实施分支基线dev；如需隔离checkout，先保留本任务未提交文档。
4. 修复本地依赖不完整后，完成既有相关测试基线。未执行断言的启动失败不能写通过。

## 执行顺序

- 先G03/G13输入及G04取消竞态：依托真实composer/既有fixture与流测试定位反馈边；先失败用例再最小修复；保留旧签名映射。
- G10首字专项与G02冷启动专项：先证据关卡和错误所有权，再修实际因果点；资金/身份风险优先，外部和生产验证边界明确。
- G05资源/renderer并行从职责上调查，但本任务单代理串行执行；复用现有worker及chat-edit fixture验fallback结果。
- G08成本专项：安全SQL错误/shape、两条失败SQL的隔离执行、部分成功重跑；不得读取生产业务行或执行生产补偿。
- G11配置、G12公开列表、G09未读代理：分别验证独立消费者与错误传播，不合并不相干根因。
- 全部13组复核：未知3组补证、必要时调整处理方式；每组记录实际改动或明确外部待办，未完成不标修复。
- 运行全范围检查、更新任务技术修复说明和正式修复报告；报告状态按实际发布/验证证据填写。

## 回归测试必要性与文件策略

本次为输入状态、并发取消、成本账务观测和交付/计费边界缺陷，需回归锁定。优先扩展现有文件：

- frontend：telegram/init.test、memory-draft-store.test、conversation-stream.test、first-token-reports.test、generation-config.test，以及既有ui-tests/chat/startup场景。
- backend：covers.test、characters.test、support-cs-proxy.test、MiniappUserSettingsRepository.test、GenerationObservationRepository既有隔离测试、logger.test。
- renderer：既有reply-renderer/worker测试及真实consumer。
  现有纯函数cost规则测试不覆盖raw SQL；若无法扩既有隔离PG用例覆盖真实SQL，允许新增一个有真实故障复现价值的cost SQL回归文件，路径和契约在实施记录里明确后创建；不写镜像实现测试或用mock证明真实SQL可运行。

## 可执行验证

每个实施单元先跑直接相关现有测试；全部相关单元完成后：

```powershell
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/reply-renderer test
pnpm --filter @miniapp/shared test
pnpm -r typecheck
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin build
pnpm lint:imports
pnpm lint:complexity
pnpm lint:backend-logging
pnpm --filter @miniapp/backend logging:validate
git diff --check
```

Backend无传统dist build，使用其typecheck/既有测试；根build脚本/其他consumer按实际改动补齐。跨shared/部署改变必须全仓typecheck与适用build。改到存量超长文件/函数时按规范拆出职责并运行complexity-budget update收紧，不放宽基线。

用户最新要求“后续不进行UI本地测试”，因此不再执行本地UI、Playwright、preview或浏览器测试。批准前4项UI基线只保留历史记录。真实系统键盘、Telegram宿主、供应商、receipt持久事实与收费均保留未验证。

Windows下lint:imports的--rule '{}'参数被CLI拒绝，等效执行不含该空覆盖的eslint。默认高并发测试超时后使用--maxWorkers=2；后端首次动态import需--testTimeout=20000，不改变断言和产品期限。前端构建用Node子进程显式将SENTRY_AUTH_TOKEN/SENTRY_ORG/SENTRY_PROJECT设置为空；本轮首次构建意外上传另见repair-evidence.md。

## 失败路径 / consumer / 人工验收

每组具体可观察行为见prd R1–R7及design证据关卡。重点：草稿跨账号/会话、A→B→A、组件卸载旧通知、新流不受旧abort、worker代际/完整原文、成本两条SQL及部分成功重跑、receipt未知/迟到/并发、偏好子查询失败、私有封面ownership不降级、只读未读超时不影响客服写入。消费者检查包含Frontend/Admin对renderer，Frontend与Backend对shared，Surplus/Relay对成本和job表。

## 交付与回滚证据

任务repair-evidence.md逐组记Issue→故障复现→改动→测试→剩余风险；commit/PR/部署缺失明确写未提交/未上线。主修复报告按模板+prompts生成，只有两张业务表，详细命令留任务。所有报告同名升vN，不覆盖原版。未经用户明确审核最终diff不stage/commit，发布和生产写不执行。
