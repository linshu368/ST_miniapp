# 实施计划

1. 记录删除前基线并复核 GHCR 消费者。
2. 删除 Frontend 孤儿源码、角色图、死动画、Mock 环境项和对应依赖。
3. 删除 Backend 孤儿源码、Upstash 配置层及相关运维声明。
4. 删除许愿池 Frontend/Backend/Shared 全链路及注册、导航和文档/spec 引用。
5. 删除孤立资源、Batch Lab 文档、三个过期方案文档和确认无消费者的 GHCR workflow。
6. 清理 Trellis 乱码/重复 changelog，修复本轮确认的文档漂移。
7. 使用 pnpm 更新 lockfile，执行格式化和残余引用扫描。
8. 运行受影响包测试/typecheck、全仓 typecheck、lint、legacy guard 和构建；修复由本变更造成的问题。
9. 更新任务记录和模块事实，展示最终 diff 与验证结果；不提交、不推送。

## 停止条件

- 发现待删对象仍有运行时/部署消费者；
- 删除需要修改数据库或线上资源；
- 验证显示删除影响授权范围外的业务。

出现停止条件时保留该对象，记录证据，其余独立清理继续。
