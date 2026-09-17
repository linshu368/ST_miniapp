# Batch Lab 集成验收、发布与 Spec 收口

## 1. 目标

完成全链路验收、容量安全与故障恢复、Vercel/CI发布回滚及全部Spec/module facts收口。本任务是父任务的“跨子任务集成与知识收口”交付单元，必须独立实现、验证和归档。

## 2. 前置依赖

- 其余六个 Batch Lab 子任务均完成并提供证据

依赖不是目录层级的隐含顺序；依赖任务的契约、迁移或证据未完成时，本任务保持 Blocked，不用临时 mock 冒充集成完成。

## 3. 必须交付

- 父 PRD S/C/G/P/D/R/E→子任务→证据→owner 全量矩阵
- test SQL→冻结→A/B单/多轮→失败恢复→结果→reuse→JSONL E2E
- 50条单轮/3轮容量、TOAST、SQL/worker/export硬限额与线上延迟
- kill/restart/双worker/过期lease/重复start/retry/unknown故障演练
- migration→Backend feature-off→CI→Vercel SPA→worker/feature-on发布和回滚/停止演练
- Vercel Preview API base、SPA rewrite和Backend CORS联调证据
- 新增 Batch Lab spec、module facts并更新既有规范、README、ARCHITECTURE

## 4. 明确不做

- 新增或偷补产品功能
- 生产样本合规、脱敏、审批或自动启用流程
- 破坏性清库
- 用文档掩盖未通过验收

不得借本任务增加父 PRD 和 HTML 原型没有的功能。若实现发现父需求冲突，返回父规划评审，不静默扩面。

## 5. 通用约束

- 应用包之间只通过 HTTP/shared contract 协作；浏览器不使用数据库 row、service-role或密钥。
- 所有外部调用有明确超时；重试有限且仅用于安全操作；关键写入以数据库约束/事务/幂等键裁决。
- 来源环境由Backend部署配置决定并写入事实；V1不包含生产合规、脱敏或审批流程。
- 原始错误以 `{ err }` 记录；日志只含 allowlist 摘要、内部 ID、环境、状态和耗时，不记录 SQL敏感值、完整 prompt/回复或 token。

## 6. 验收标准

- [ ] 父 PRD每项有自动或可重复人工证据且无未归属缺口
- [ ] 普通会话/计费/所有shared consumers回归通过
- [ ] 停止条件、worker drain、应用回滚和数据库 forward-fix 演练完成
- [ ] 独立Vercel静态部署、CI test/build、Preview API base/CORS和SPA rewrite通过
- [ ] 来源只读连接写入负测通过，环境业务数据零写入
- [ ] Batch Lab新 spec、既有module facts、modules-index、README/ARCHITECTURE与实现一致
- [ ] 失败、空、部分成功、超时、重复提交与环境错配路径均有自动测试或可重复人工证据。
- [ ] 受影响消费者、文档和 module facts 已按本任务责任更新或向最终收口任务提供审核 payload。
