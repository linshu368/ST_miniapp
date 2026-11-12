# 整体优化实施设计

## 已审核方案与版本

用户已审核上一轮13页设计并明确要求实施。该设计保持权威，本文件补充最新代码核对和可执行落点；不新增产品决策。基于origin/dev `0c5977e2`创建 `perf/overnight-page-readiness`，原分支没有被合入，新功能不倒回。main额外两次入口上报提交不在本次改动范围。

## 复用调研及确认差异

- client.ts外层withRequestSlot先等待、apiClientOnce拿槽后才启动timedFetch计时，队列等待无超时。复用timedFetch已有priority队列能力或在client原owner内纳入期限，不新建请求框架。
- query-client.ts已retry=false；上游短剧manifest已有非阻塞修复，保留并运行既有验证，不重复修改。
- client已有critical槽保留，notifications正文、support conversation、creator overview、wishes仍为normal；各hook区分前台与prefetch/附属面板，复用同query key。
- create mutation已向conversationKeys.detail写入服务端session/messages，但useConversationQuery staleTime=0会立刻再GET；以当前创建结果身份控制首次refetch，不能给所有历史会话延长缓存。
- navigation-quiet-window当前只认识主路由，由BottomNav调用；entry-phase只在应用初次入场放行。扩展原owner覆盖Android登记深路由的有效Link/返回，独立于遥测；Providers的延后归因组件不能随导航被卸载重播。
- Next大厅代理已有5秒signal与Server-Timing，catch重新throw可能把错误变成非JSON。返回已有ApiResponse错误形状，保持来源、权限、缓存规则。
- 未改的页面也受公共期限/调度修复覆盖；profile本身已不等余额、gallery首图门槛和媒体ready均不重定义。无需新数据库函数/contract表/队列。

## 最小方案及可靠性

请求保持单次timeoutMs及最多一次安全传输重试；把槽等待纳入原单次期限，backoff在槽外；同步任务延迟计时器时再次检查单调时钟，不允许过期后派发。必要拆出client内部attempt函数，公共API不增加网络字段。长请求原bypass及长预算保持，不把2000ms目标当硬超时。

正文查询优先级只在既有hook设置，预取保持background；不新增服务端数据状态源，不放宽缓存TTL。创建写不重试，已确认缓存可用但一旦失效/失败仍按原逻辑恢复；不改鉴权/生成/账务事务，不读取数据库业务行。

Android导航让路复用generation令牌、四秒兜底、两帧/idle释放。点击监听过滤新窗口、下载、外部/同页链接，取消监听可清理；回退与失败可恢复。只暂停次要enrich/background读取，不阻挡正文；稳定挂载的归因组件沿用启动级信号。iOS保留现有行为，不无证据增加预热并发。

代理取消不记上游故障，期限与网络失败返回不同标准错误；任何错误/推荐选择结果都不进公共缓存；不透传敏感响应或原始错误正文。

## 演进、恢复与容量

首批仅Frontend（含Next服务端代理），不执行迁移、生产配置或部署。无公开DTO变更，旧客户端兼容。逐批回退本次应用代码即可，无历史数据重写或旧遥测回填；保留上游行为。新增鉴权/身份/写入一致性或ready语义异常立即停止，观察原队列长度、inflight、请求数与字节/CPU，不通过更多连接/预取换取报表改善。

## 验证与测试必要性

期限/取消/缓存属于并发和身份风险，必须回归。优先扩展已有client.retry、request-timing、navigation-quiet-window、lobby route、entry-phase与领域测试；只有缺失会话创建缓存的观察者验证时新增一份最小回归文件，禁止为每个页面建同构测试。现有UI场景覆盖13页流程和失败恢复，复用fixture，模拟不证明生产P95或真实账务。
