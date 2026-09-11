# Batch Lab 工程骨架、共享契约与部署

## 1. 目标

建立 packages/batch-lab 独立 SPA、共享基础契约、统一 API client、环境上下文、CORS、Vercel 与 CI部署基线。V1不实现用户登录、账号、角色或应用内权限。本任务是父任务的“工程框架与部署入口”交付单元，必须独立实现、验证和归档。

## 2. 前置依赖

- 父任务规划人工评审

依赖不是目录层级的隐含顺序；依赖任务的契约、迁移或证据未完成时，本任务保持 Blocked，不用临时 mock 冒充集成完成。

## 3. 必须交付

- Vite React 18 + TypeScript strict + Ant Design + React Query 包骨架
- packages/shared/src/api/batch-lab.ts 基础 context/envelope/error 契约
- 统一 API client、请求 ID、超时/取消、错误分类与环境 query key
- 权威环境 banner、精确 CORS allowlist与最小公开env example
- 参考Admin/CS Platform的包内`vercel.json`、独立Vercel Project和SPA rewrite
- CI quality gate显式增加Batch Lab test/build；不新增Railway前端service或前端镜像

## 4. 明确不做

- 样本 SQL/冻结
- 数据库业务表 migration
- 实验执行/worker
- 后处理、历史与导出
- 用户登录、账号、角色和应用内权限

不得借本任务增加父 PRD 和 HTML 原型没有的功能。若实现发现父需求冲突，返回父规划评审，不静默扩面。

## 5. 通用约束

- 应用包之间只通过 HTTP/shared contract 协作；浏览器不使用数据库 row、service-role或密钥。
- 所有外部调用有明确超时；重试有限且仅用于安全操作；关键写入以数据库约束/事务/幂等键裁决。
- 来源环境由Backend部署配置决定并在页面显示；V1不提供环境切换按钮。
- 原始错误以 `{ err }` 记录；日志只含 allowlist 摘要、内部 ID、环境、状态和耗时，不记录 SQL敏感值、完整 prompt/回复或 token。

## 6. 验收标准

- [ ] V1无登录/session/角色代码或空入口；API client无需Bearer token
- [ ] 环境context失败或配置缺失时fail closed，样本和实验页面不使用猜测环境
- [ ] 浏览器不含 service-role、数据库连接或供应商密钥
- [ ] 新包可 typecheck/test/build，既有四应用不发生跨应用 import
- [ ] 包内Vercel静态部署、SPA rewrite、Preview API base/CORS和CI test/build有可重复证据
- [ ] 失败、空、部分成功、超时、重复提交与环境错配路径均有自动测试或可重复人工证据。
- [ ] 受影响消费者、文档和 module facts 已按本任务责任更新或向最终收口任务提供审核 payload。
