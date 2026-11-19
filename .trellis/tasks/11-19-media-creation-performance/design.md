# 影像创作首屏与视频交付恢复优化：技术设计

## 1. 证据、范围与复用

读取prd.md和[总证据](../11-19-mobile-performance-round2/research/evidence.md)、[复用/风险审查](../11-19-mobile-performance-round2/research/reuse-and-risk.md)。

- `packages/frontend/src/lib/api/image-plaza-feed.ts`
- `packages/frontend/src/lib/api/client.ts`
- `packages/frontend/src/components/image-plaza/use-plaza-gallery.ts`
- `packages/backend/src/features/image-plaza/video-delivery-job.ts`
- `packages/backend/src/features/image-plaza/video-delivery-repository.ts`
- `packages/backend/src/features/image-plaza/video-stream-upload.ts`
- `packages/backend/src/app.ts`

## 2. 最小方案与顺序

1. 在现有options factory增加调用用途的内部优先级参数，不加query key维度；prefetch已在途时复用同一请求，不因导航升优先级取消重发。
2. 将upload里的取源和分块分开，一轮内复用Buffer并逐块fence；原2并发和源文件上限保持，最大在途Buffer量不新增。20秒预算内不再起新块；内部helper可选signal保持旧调用兼容；15/60/120秒原单次超时仍是后备，超预算中断后按已知/未知结果裁决，不能强制把未知写入当失败。
3. stopVideoPlazaGenerationJob/stopVideoDeliveryJob返回可等待的有界停止结果，由app.onClose await；未知外部写入留原状态，安全release复用现有checkpoint。

### 交付状态与停止

实现复核决定：20秒只控制已知TUS会话的连续起块，取源和非幂等创建继续沿原有有限超时；不使用一轮剩余几毫秒的预算取消创建POST，避免人为制造未知创建。已在途分块可在原60秒期限内结束，之后不再起新块；shutdown仍主动中止并最多等待30秒。只读编码校验采用20秒期限。此区别也写入运行说明和回归测试，不能将整轮含下载描述成硬20秒。

queued→creating→uploading→encoding→published沿原RPC/checkpoint。creating有外部POST未明确确认、publish响应未知、未完成的网络操作均不释放保护。uploading仅在已知同一TUS会话、网络已结束、lease仍持有时checkpoint。graceful停止先禁止领取，最多30s等待/中断；强杀继续原五分钟保护。预算/四块限制不增加全局并发或任意重试。

## 3. 数据流与契约

页面/hook→现有shared DTO→统一API→路由/feature/repository→既有数据访问；应用不互相导入。不新增HTTP endpoint、数据库对象/列/jsonb键或运行配置key；若实证表明必须扩大契约/迁移，先回到规划审核，不临时塞public/metadata。Frontend不使用数据库行类型。

## 4. 可靠性、容量与过度设计边界

- 弱网/空闲预取取消、无缓存、筛选恢复、源hash变化、HEAD/PATCH响应丢失、租约竞争、SIGTERM、创建未知、发布未知、强杀、上游排队；未知写结果不重复创建/扣款

详细超时/重试/幂等/并发/事务/降级/补偿/限流/容量/观测设计逐项见总复用审查，适用关系均已确认。只复用既有owner；不增加新缓存服务、并行监控出口、全局状态源或依赖。修改基线超长文件必须按功能拆小至500行/120行预算，再update复杂度基线。

## 5. 日志与观测

按task.json.meta.logging_integration复用现有HTTP/transport/job事件、request/trace上下文和安全err输出。前端Sentry/Faro与服务端日志分工不变；真失败保留，正常取消不可伪装成功。

## 6. 性能、演进与恢复

/create导航Android5222.045/N22、iOS2270.4/N35；工作室无导航样本，挂载Android1416.425/N66、iOS561.4/N65不能代替导航。feed API Android1850.795/N124、iOS1532/N41，queue仅9.61/7ms，不宣称队列就是当前慢因。昨晚Wan第二任务发布中断后等5分钟租约为单任务证据。

数值目标写task.json，均是待发布验证目标。依赖顺序：先共享后台停止行为的局部回归，再兼容Backend worker，后Frontend调度；客户端请求契约不变。

开发候选不自动部署。获准发布后以新release观察至少48h；权限、计费、丢稿、重复生成/发布异常立即停止；充分样本同口径P95回退>10%且>200ms或真实错误率明显上升时回滚本批，保留服务端失败证据。无schema变化，直接应用回滚；不回滚用户数据。
