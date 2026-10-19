# 设计与审核

用户已确认上轮的范围、事务化导入、不覆盖、文件不入 Git 和不写生产；以下落实已审核方案。

## 复用调研

- import-image-plaza-seed.ts → seed-import.ts → experience.import_image_plaza_seed_work：复用既有 RPC，保留来源锁/事务，不直接复制 UUID。
- storage.ts：私有 image-plaza bucket，image-plaza/imports/civitai/{id}.{ext}。
- 三份 20261012/20261013 seed migrations：works/artifacts FK、来源唯一性、50MiB 限额。tags/中文 prompt 已在 works，无关系表要搬。
- seed-prompt-translate.ts 已使用 pg；复用 pg/dotenv 依赖，不加载 Backend 服务或 production fallback。UI/hooks/contracts 不适用。

## 最小方案与归属

一个离线 mjs、一个 shared/migrations SQL 模板、一个 runbook。实际数据在强制 Git 忽略的目录。无新增永久对象/API/依赖，不做通用迁移框架。
experience 仍拥有作品和产物真相；写入方为现有 RPC，读取方为现有广场 repository。user/attempt 均 NULL，不复制跨域用户身份。目标重新生成 UUID；业务内容和来源 ID 保留。

## 可靠性

源使用显式 TEST 连接、单连接 REPEATABLE READ READ ONLY、连接20s/语句120s超时、最多20000条，不自动重试或切换环境。核验关联/来源/shape 后输出完整产物，日志仅计数/hash。
目标单事务，锁5s、语句15min；逐来源 advisory lock 复用 RPC，已有内容严格对比后一致跳过，不一致整笔回滚。不覆盖生产的点赞或删除状态。无批量写重试、无数据库外副作用，失败无需补偿。
导入前要求 Storage 验收确认，并检查 bucket/对象元数据。元数据不是文件可读证明，必须另做真实下载/hash。Storage 不由 SQL 写入。模型配置单独核对，不搬价格/密钥。
限流/容量：离线单连接、有界20000条，摘要统计图片总字节；超过预算停止，不自动并发扩容。日志不含业务内容。无上游下载/HTTP调用发生于导出。

## 演进恢复

逐环境核对 migration/shape/RPC → 图片复制和下载验收 → 受审数据 SQL → feed/detail/同款验证。用户本次授权只到文件和只读 TEST，不执行生产。
目标 schema 不假定与 TEST 同构；缺列/约束/函数不符应失败。提交前事务自动回滚；提交后仅审核本批新增 source ID 的软删除，不删除既有行或有引用 artifact。结果未知先对账再重跑。
数据 SQL 不提交 Git，不冒充普通 schema migration；生产执行需独立受控审批，不能绕过现有 schema workflow。
