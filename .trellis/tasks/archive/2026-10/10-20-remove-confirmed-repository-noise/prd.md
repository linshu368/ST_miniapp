# 清理已确认的仓库噪音

## 目标

删除已经确认没有运行时消费者的源码、资源、依赖、配置与过期文档，并完整移除已无产品入口的许愿池功能，降低仓库中的错误架构信号和维护成本。

## 需求

- 删除审计中确认的 Frontend、Backend 孤儿文件、死动画、死环境变量和对应依赖。
- 删除根目录孤立头像副本、7 张旧 Mock 角色图和已经退场的 Batch Lab 部署文档。
- 删除许愿池的 Frontend 页面/API、Backend route/repository、Shared DTO/export 和现行文档/spec 描述。
- 保留历史 migration 和现存数据库对象；本任务不连接或修改 TEST/Production 数据库。
- 复核 GHCR workflow 的仓库内、部署配置和可见远端消费者；确认没有消费者后删除 workflow。
- 删除三个已由现行实现取代的方案文档。
- 清除 Trellis spec 中乱码或完全重复的 changelog，修复本轮触达的失效链接与事实漂移。
- 不创建兼容层、替代功能或新测试文件。

## 约束

- 不修改历史 migration、已部署数据库对象、线上配置或业务数据；允许删除已退场功能的 Prisma 应用层映射。
- 不删除 schema-split 快照、Trellis archive、支付告警 worker 和计费补偿能力。
- 不提交、不推送、不部署。
- 依赖与 lockfile 必须使用 pnpm 更新。

## 验收标准

- [x] 所有明确授权的文件、依赖、环境变量和文档已删除，且无残余引用。
- [x] 许愿池应用层代码及注册入口已完整删除，migration/数据库历史仍保留。
- [x] GHCR workflow 只有在确认无消费者后才删除，并记录核验依据。
- [x] README、ARCHITECTURE、ops 与相关 Trellis spec 不再描述已删除能力。
- [x] 全仓 typecheck、测试、lint/legacy guard 和构建通过，或明确记录与本变更无关的既有失败。
- [x] 最终 diff 只包含本任务范围内的清理。
