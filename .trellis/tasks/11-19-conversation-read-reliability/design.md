# 聊天详情取消分类与会话读取可靠性：技术设计

## 1. 证据、范围与复用

读取prd.md和[总证据](../11-19-mobile-performance-round2/research/evidence.md)、[复用/风险审查](../11-19-mobile-performance-round2/research/reuse-and-risk.md)。

- `packages/backend/src/routes/conversation-detail.ts`
- `packages/backend/src/lib/user.ts`
- `packages/backend/src/lib/user.test.ts`
- `packages/backend/src/routes/conversation-folders.test.ts`
- `packages/frontend/src/hooks/use-chat-session.ts`
- `packages/frontend/src/hooks/use-conversation-turn.ts`

## 2. 最小方案与顺序

1. 在registerConversationDetail的onClose与catch之间建立明确的取消来源判定，只处理已销毁传输的已知abort，使用现有HTTP观测一次终态。
2. 以现有detail阶段耗时为诊断入口；身份shared-inflight不绑定某个等待者abort，避免一人离页取消他人的身份读取。
3. 扩展既有route/identity/会话hook测试验证取消、5秒deadline、真500、并发共享和恢复；真实慢依赖保留err及cause。

## 3. 数据流与契约

页面/hook→现有shared DTO→统一API→路由/feature/repository→既有数据访问；应用不互相导入。不新增HTTP endpoint、数据库对象/列/jsonb键或运行配置key；若实证表明必须扩大契约/迁移，先回到规划审核，不临时塞public/metadata。Frontend不使用数据库行类型。

## 4. 可靠性、容量与过度设计边界

- 客户端关闭、SDK deadline、身份RPC失败、会话不存在/越权、恢复失败、旧版本请求、并发singleflight；真实错误不吞、不重试写入

详细超时/重试/幂等/并发/事务/降级/补偿/限流/容量/观测设计逐项见总复用审查，适用关系均已确认。只复用既有owner；不增加新缓存服务、并行监控出口、全局状态源或依赖。修改基线超长文件必须按功能拆小至500行/120行预算，再update复杂度基线。

## 5. 日志与观测

按task.json.meta.logging_integration复用现有HTTP/transport/job事件、request/trace上下文和安全err输出。前端Sentry/Faro与服务端日志分工不变；真失败保留，正常取消不可伪装成功。

## 6. 性能、演进与恢复

导航代表/chat/:id Android3866/N1301、iOS3797.6/N168。API代表conversation_detail Android2042.6/N13117、iOS1963.7/N2002；groups iOS2595.95/N258，list iOS2236/N521另验。Sentry CC82只是问题规模，不代表82个已证明正常取消。

数值目标写task.json，均是待发布验证目标。依赖顺序：Backend错误分类兼容先行，Frontend可单独回归；不以client关闭终止既有后台生成。

开发候选不自动部署。获准发布后以新release观察至少48h；权限、计费、丢稿、重复生成/发布异常立即停止；充分样本同口径P95回退>10%且>200ms或真实错误率明显上升时回滚本批，保留服务端失败证据。无schema变化，直接应用回滚；不回滚用户数据。
