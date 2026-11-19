# 角色创作兼容性与编辑器首屏优化：技术设计

## 1. 证据、范围与复用

读取prd.md和[总证据](../11-19-mobile-performance-round2/research/evidence.md)、[复用/风险审查](../11-19-mobile-performance-round2/research/reuse-and-risk.md)。

- `packages/frontend/src/components/creation/character-editor.tsx`
- `packages/frontend/src/components/creation/character-editor-documents.tsx`
- `packages/frontend/src/components/creation/character-wishes.tsx`
- `packages/frontend/src/lib/api/creator-characters.ts`
- `packages/frontend/src/lib/perf/api-timing.ts`
- `packages/frontend/src/lib/perf/grafana-schema.ts`
- `packages/frontend/src/lib/api/conversation-stream.ts`

## 2. 最小方案与顺序

1. 先抽取现有createConversationRequestId的兼容算法成小helper，由原出口重导出并切换已确认的直接调用；保留现有测试证明SSE/idempotency行为不变。
2. edit模式只启用detail，owner由其DTO获得；new仍读list。将千行editor按已有功能边界拆到现有dialogs/documents/presets等相邻模块，执行复杂度收紧。
3. 补有限API标签及现有exporter/classifier回归；复用creator fixture覆盖旧WebView、draft/owner切换、封面回流和失败恢复。

### 草稿与可用语义

edit仅用现有detail DTO中的owner_user_id；new继续以认证list获取内部owner。不可在身份未确认前读取其他owner的IndexedDB稿件。localReady失败保持原可恢复提示；不得把空壳或父组件query结束当草稿已可编辑。若修复现有提前ready，单独标示测量定义边界与新旧release，不宣传为耗时下降。

## 3. 数据流与契约

页面/hook→现有shared DTO→统一API→路由/feature/repository→既有数据访问；应用不互相导入。不新增HTTP endpoint、数据库对象/列/jsonb键或运行配置key；若实证表明必须扩大契约/迁移，先回到规划审核，不临时塞public/metadata。Frontend不使用数据库行类型。

## 4. 可靠性、容量与过度设计边界

- 旧WebView无randomUUID、存储拒绝、草稿冲突、owner切换、detail失败、网络取消、附件解析、保存重试、审核拒绝；允许日志仅长度/结果和链路字段

详细超时/重试/幂等/并发/事务/降级/补偿/限流/容量/观测设计逐项见总复用审查，适用关系均已确认。只复用既有owner；不增加新缓存服务、并行监控出口、全局状态源或依赖。修改基线超长文件必须按功能拆小至500行/120行预算，再update复杂度基线。

## 5. 日志与观测

按task.json.meta.logging_integration复用现有HTTP/transport/job事件、request/trace上下文和安全err输出。前端Sentry/Faro与服务端日志分工不变；真失败保留，正常取消不可伪装成功。补有限creator等API分组白名单只作用新样本，历史other不重分类。

## 6. 性能、演进与恢复

代表new Android1898.48/N43、iOS7961/N6；edit Android3861.2/N31、iOS270/N1；data Android3521.52/N37，均不能宣称稳态。creator API被白名单归other，无可信独立历史P95，因此api baseline null。

数值目标写task.json，均是待发布验证目标。依赖顺序：兼容UUID helper与旧导出先行，后edit请求裁减及新遥测；保留所有存量IndexedDB格式。

开发候选不自动部署。获准发布后以新release观察至少48h；权限、计费、丢稿、重复生成/发布异常立即停止；充分样本同口径P95回退>10%且>200ms或真实错误率明显上升时回滚本批，保留服务端失败证据。无schema变化，直接应用回滚；不回滚用户数据。
