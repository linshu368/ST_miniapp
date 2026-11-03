# 实施计划

1. 记录现有逐条配对证据，完成规划审核后启动任务。
2. 添加向后兼容的型号→两优先供应商契约、发布校验和运行时解析；复用已有目录配置。
3. 运营台兜底界面增加两项供应商与固定首字延迟优先说明，模型切换保存各自名单。
4. Backend冻结名单并仅在兜底尝试应用策略，覆盖首发为同型号时的现有顺序重试；保留两路截止/计费。
5. 以最少字段扩展现有终态遥测，拆分出站阶段。验证订阅开销、上下文隔离、缺失字段与异常隔离。
6. 在同一任务记录可证明的前置读取复用收益；没有独立证据的持久化变更不进入补丁。
7. 运行shared/backend/admin相关现有测试与全消费者typecheck，build及Admin/聊天界面回归；检查实际请求体，不只mock配置对象。
8. 整理具体文件差异、测试结果、上线顺序与回滚。最终内容审核后提交；先合dev再TEST/生产，main改动回同步dev，保留别人未上线功能。

## 验证

pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/admin test
pnpm -r typecheck
pnpm --filter @miniapp/frontend build（backend为tsx源码运行，无独立build脚本）
pnpm --filter @miniapp/admin build
pnpm test:ui --grep @chat
按实际改动补充既有upstream/first-token-fallback/execute/配置schema测试，不为实现机械新增测试文件。

## 发布边界

本文件不是生产已修复声明。观察上线后的真实业务数据，供应商latency只做分段诊断。

## 本地完成证据（2026-11-02 16:36 北京时间）

- Shared 231项、Admin 135项、Backend全量1218项通过；全部消费者typecheck通过。
- Admin/Frontend build通过；改动文件ESLint、迁移命名与diff检查通过。
- 本地PG17完整首字/竞争/扣费/免费额度/重放/并发回归通过，新供应商迁移执行两次且OID/ACL保留；未执行远端迁移。
- 真实本地HTTP测并发隔离、发送完成、慢响应头和取消缺失阶段；冻结诊断对象异常不影响fetch。
- 固定Alloy v1.21.0配置验证与真实本地OTLP往返通过，新字段/指标保留，私有属性被剔除。Cloud两条代表性PromQL语法通过，无新部署样本不能宣称Cloud摄取已验收。
- 24项移动端@chat通过。第一次运行被会话中断留下本任务预览进程，复跑等待服务超时；确认归属后仅关闭本任务残留并重跑通过。Admin浏览器实际操作验证默认对、换型号清空、重复提示和切回原对；截图存/private/tmp/st-fallback-provider-admin.png，临时页面/服务已清理。
- 初次Backend全量与多项构建同跑触发3项5秒测试超时，前一项遗留调用污染后一项；未改产品代码或测试时限，以2 workers重跑全量通过，最终1218项通过。
- Production仅2秒上限只读pg_proc结构检查：既有validator为IMMUTABLE/SECURITY INVOKER、注入锚点唯一、新guard尚未上线。不读聊天内容。
- 模拟余额200ms与上下文300ms重叠，避免原额外200ms；不将模拟数据当线上改善。
- 待最终文件审核后commit/push、先dev再TEST验证/生产发布，main自身改动同步dev；不带入无关dev功能。
