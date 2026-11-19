# 冷启动端到端瓶颈与关键链整改：技术设计

## 1. 证据、范围与复用

读取prd.md和[总证据](../11-19-mobile-performance-round2/research/evidence.md)、[复用/风险审查](../11-19-mobile-performance-round2/research/reuse-and-risk.md)。

- `packages/frontend/next.config.mjs`
- `packages/frontend/src/app/providers.tsx`
- `packages/frontend/src/lib/perf/startup-phases.ts`
- `packages/frontend/src/lib/perf/startup-timing.ts`
- `packages/frontend/src/lib/perf/page-tracker.ts`
- `packages/ui-tests/tests/roleplay.spec.ts`

## 2. 最小方案与顺序

1. 先重用6个已查询启动诊断做阶段分类并取得可重现响应头；C196... Android script_max_fetch_ms=4201、efca...=7361，iOS两条connect_to_request约5135/5168ms，明确两类独立故障模型。
2. 核对构建chunk与Providers静态依赖树；仅在证实阻塞时移动可选reader/监控模块到已有afterFirstScreen/enrich点，保留shared query与取消。
3. 按@startup现有fixture检查root alias/cookie/History/支付回流；同负载构建比较与真机观测分别留证。

## 3. 数据流与契约

页面/hook→现有shared DTO→统一API→路由/feature/repository→既有数据访问；应用不互相导入。不新增HTTP endpoint、数据库对象/列/jsonb键或运行配置key；若实证表明必须扩大契约/迁移，先回到规划审核，不临时塞public/metadata。Frontend不使用数据库行类型。

## 4. 可靠性、容量与过度设计边界

- HTML/JS下载失败、SDK不可用、History拒绝、邀请/支付参数、后台恢复、startup缺报；不接管生产CDN缓存直到证据充分

详细超时/重试/幂等/并发/事务/降级/补偿/限流/容量/观测设计逐项见总复用审查，适用关系均已确认。只复用既有owner；不增加新缓存服务、并行监控出口、全局状态源或依赖。修改基线超长文件必须按功能拆小至500行/120行预算，再update复杂度基线。

## 5. 日志与观测

按task.json.meta.logging_integration复用现有HTTP/transport/job事件、request/trace上下文和安全err输出。前端Sentry/Faro与服务端日志分工不变；真失败保留，正常取消不可伪装成功。

## 6. 性能、演进与恢复

代表基线为/chats page.launch；/characters Android9031.28/N278、iOS6560.3/N80。目标4000是改善目标，长期2秒目标保留；API范围为空，因此API两值null，不新增服务端接口。

数值目标写task.json，均是待发布验证目标。依赖顺序：先证实关键等待与缓存边界，后最小关键链调整；不改变根入口公开/私有身份隔离。

开发候选不自动部署。获准发布后以新release观察至少48h；权限、计费、丢稿、重复生成/发布异常立即停止；充分样本同口径P95回退>10%且>200ms或真实错误率明显上升时回滚本批，保留服务端失败证据。无schema变化，直接应用回滚；不回滚用户数据。
