# Characters / Chat 故障与发布归因

窗口：2026-11-03 16:20:05—2026-11-10 16:20:05，Asia/Shanghai；监控查询固定UTC 2026-11-03T08:20:05Z—2026-11-10T08:20:05Z。本次仅只读检查，没有修复或发布。

## 结论

主要不是Railway重启切换时的短暂中断。30次页面error全部在真实服务启动前后5分钟之外，280次stall仅14次在该窗口。稳定运行期间仍有数据库访问超时、身份缺失、前端兼容异常、JS/RSC资源加载失败和恢复阶段二次异常。

但需区分：发布切换中断、某次发布引入了持续性代码问题、Vercel前端资源版本问题。这三件事不同；本报告只排除了“Railway切换解释大多数样本”，不排除代码由历史发布引入，也不保证临近启动的14次一定由部署导致。

## Railway部署时间关联

近七天47条部署创建记录，47条Server listening日志。获取最近50条元数据覆盖窗口及更早记录；旧部署REMOVED是被新部署替换，不等于FAILED/CRASHED。

采用真实Server listening时间，分别比较±2/5/10分钟，并另比较部署创建到启动后5分钟。Server listening不是精确网关切流时间，故只用于保守筛查。

| 页面        | error | error在启动±5分钟 | stall | stall在±2分钟 | stall在±5分钟 | stall在±10分钟 | stall在创建至启动+5分钟 |
| ----------- | ----: | ----------------: | ----: | ------------: | ------------: | -------------: | ----------------------: |
| /characters |     8 |                 0 |   196 |             4 |            10 |             18 |                       9 |
| /chat/:id   |    22 |                 0 |    84 |             4 |             4 |              8 |                       4 |

大厅最近一次error距最近启动仍60.3分钟；聊天最近的error距最近启动12.3分钟。这些距离是最近一次启动的绝对距离，不是当前版本已运行时长。

反证样本：11月10日11:38:33服务开始监听；14:13:47聊天page_stall，14:13:50会话详情500和页面error，距启动约2小时35分。11月8日14:14左右ChatGuide异常发生时，Railway从11月6日21:38至11月9日15:53之间没有新服务启动。

## /characters：卡住主要发生在文档冷启动

- 196次stall：document183（93.4%）、spa13、mount0。站内切换和冷启动不是同一类问题。
- 全平台前台成功document样本737，冷启动P95 8.48s，挂载到可用P95 1.99s。183条launch耗时超过4s；相同document分类的ready测量没有超过4s样本。说明冷启动阈值主要受组件挂载前的HTML/JS下载、解析、水合、Telegram初始化与入场等待共同影响，不能简单说成角色列表API跑了4秒。
- 这不是用两个P95相减作归因；这里只比较各自阈值计数及源码时钟边界。每次真实访问缺少关联ID，不能逐次拆出网络、CPU、水合各占多少。
- Providers要先完成Telegram同步初始化和profile hydrate，才渲染业务children；page.launch从文档performance零点开始，而旧Sentry page_stall只从页面挂载开始。因此工程stall196与Sentry大厅告警7不能要求一一相等。

### Android目录截止与失败

Android lobbyRequestTimeoutMs=1800ms，iOS/other=20000ms。bc7b6e1e历史版本同样如此。目录经同源/api/lobby-characters到Vercel代理，再请求Railway；并不是浏览器直接访问Railway目录。

Sentry api.request.duration 对该代理的独立测量：Android成功1186、timeout453、network4、invalid_response2、http_4xx1；iOS成功345、timeout9、network6、invalid_response1。这是请求尝试样本，包含刷新/公共head，不是453次页面失败，也不属于上一报告37次api_logical_v1客户端超时的集合。全部release混合，不能将历史成功P95与当前1.8秒截止作同版本直接比较。

Android timeout多数集中在1.8秒：bc7b6e1e319次，ef3eaa2095次，当前4cd7624b仍19次，说明并非仅上线瞬间。bc7b版本占7/8次大厅error；全部8次error均Android、spa导航。

代码usePageReady将数据层isError转为error；只要公开head或推荐有可用数据就可能降级成功，因此请求timeout远多于页面error。现有8条error事件无错误码，不能证明每条均由1.8秒截止造成。目录超时是已证实的高频故障机制，8次终态的逐条原因仍缺证据。

另一个等待边界：目录先withRequestSlot，获槽后才进入timedFetch并启动1.8秒计时；排队时间在该计时外。推荐入口另有包括排队的5秒deadline。因而“目录设置1.8秒”不保证用户从点击到可用不超过1.8秒。

## /chat/:id：数据读取、身份与路由/渲染链路叠加

84次stall：spa77（91.7%）、mount6、document1。前台成功spa样本428，点击到可用P95 5.36s，挂载到可用P95 3.50s；导航>4秒54条，挂载>4秒17条。路由前段等待和挂载后会话读取都存在，不可仅归因后端。

ready必须满足activeSessionId存在且conversationQuery.isSuccess。带session入口需GET历史；不带session需POST创建，会话建立/读取失败会显示重试并上报error。

### 22次error可追到的证据

| 分类                              | 数量 | 证据与置信边界                                                                                                                               |
| --------------------------------- | ---: | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话详情5xx，后端读历史AbortError |    9 | 页面error与同平台conversation_detail 5xx、Railway读历史AbortError时间相差约0.06–1.32秒，高度吻合；无跨系统唯一访问ID，不冒称全链路逐请求确证 |
| 创建/读取返回401                  |    3 | 11月7日16:47:45Z创建401、11月9日05:55:42Z读取401、13:56:03Z创建401，均与页面error同一秒                                                      |
| 尚不能逐条归因                    |   10 | 部分附近有network/aborted；不能将主动取消计作网络故障，也不能因时间接近就指认根因                                                            |

对应Railway GET会话详情11条500，其中10条总耗时约5.06–6.08秒；后端listMessages在Supabase/PostgREST读取上设置AbortSignal.timeout(5000)，返回AbortError后抛查询会话消息失败。12条应用读历史失败日志跨多天持续发生，均远离部署切换窗口。这里的5秒覆盖数据库访问链路，不能直接断言是SQL慢、索引缺失、连接池或Supabase网络哪一层。

11月9日05:55:42Z样本后端明确记录initData present:false，随后多个鉴权接口401；这是身份上下文未带到请求。不能擅自解释为token过期，更不能认定部署清空了所有用户登录。其他两次401未逐条确认相同原因。

### JavaScript异常与stall

1. [ST-MINIAPP-7C](https://wangqiao.sentry.io/issues/ST-MINIAPP-7C)：ChatGuide第22行直接调用messages.findLast，发生在检查active/visible之前；不支持该方法的Android WebView会在渲染期抛错。至少一条同会话breadcrumb为：11月8日14:14:02.533创建会话200 → 14:14:02.654 findLast抛错 → 14:14:04.068 null.get二次异常 → 14:14:05.575 page_stall。该例API已成功，不是Railway500造成。
2. [ST-MINIAPP-1P](https://wangqiao.sentry.io/issues/ST-MINIAPP-1P)：Android null.get至少在上述样本中是渲染失败后的恢复阶段异常，不能把它当所有22次error的独立首因。
3. [ST-MINIAPP-4](https://wangqiao.sentry.io/issues/ST-MINIAPP-4)：11月10日iOS真实域名Replay：14:39:09进入大厅 → 14:39:49 Failed to fetch RSC payload for聊天 + ChunkLoadError(9298) → 14:40:05起重复parallelRoutes.get，累计6次。是前端路由/资源加载和错误恢复链，不是Railway接口HTTP500的证据。
4. 已查看部署JS的对应列与本地Next14.2.35源码：createInitialRouterState在客户端使用initialParallelRoutes，AppRouter首次使用后将该变量清空；恢复重建时fillLazyItemsTillLeafWithHead对null parallelRoutes访问get与异常栈吻合。这支持“错误恢复阶段二次失败”的定位；初始触发原因仍依事件而异，不把框架源码分析等同完整复现。
5. 全局错误UI只捕获异常，没有主动markPageFailed，因此渲染崩溃可能表现为stall而不进入error终态。8/22是数据层主动上报，不能覆盖全部白屏。

## 纠正CORS与发布错误噪声

前一报告只看到error日志无Origin。本次找到了相邻WARN CORS rejected origin并完整分页：504条拒绝日志的Origin全部是vercel.app域名（包含稳定Vercel别名与部署URL），未见app.themijing.com。

525条HTTP5xx中490条OPTIONS；其中442条使用HeadlessChrome，48条Mobile/Telegram UA。437条5xx处于服务启动±5分钟，其中436条是OPTIONS。这使“部署附近5xx尖峰”看起来明显，但主要由自动化浏览器访问不在白名单的Vercel域名产生，不能据此推断正式入口在切换时宕机。少量移动端访问Vercel域名同样可能失败；不应为了消除数字直接放宽生产CORS。

这也解释为什么总5xx与两页error时间相关性不同：前者大量是发布后自动访问，后者主要发生在稳定运行期。

## 前端发布核对的边界

Vercel连接器在当前可见个人/团队中均未找到对应前端项目，未取得该项目生产部署和资源保留记录。因此不能断言iOS chunk失败来自前端版本切换、旧资源清理或普通网络失败。它访问的是app.themijing.com前端资源，Railway发布历史不能替代Vercel证据。

## 建议

- 优先处理可复现的ChatGuide.findLast兼容与全局错误恢复链；回归旧Android和iOS的RSC/chunk失败后恢复。
- 对会话历史5秒访问超时，先补同请求的数据库访问阶段、连接/网络及查询证据，再决定索引或连接策略，不凭AbortError调整数据库。
- 大厅以冷启动前段和目录缓存/公共head降级为重点；评估1.8秒截止，不能仅延长计时或缩短阈值让报表变好。
- 保留CORS安全边界，将Preview自动化与正式用户监控分开。新增监控字段需单独规划，本次没有修改。
- 复用现有ui-tests @chat/@roleplay及相关导航场景，补旧WebView、身份缺失、会话500、chunk失败、重载恢复；真机和生产P95仍需独立验证。

## 验证与证据

已核对280条stall三页100+100+80、30条error、47个启动时刻、525条HTTP5xx、504条CORS拒绝及31条Sentry事件脱敏投影。Sentry实际事件中的inflight数组已被SDK归一成字符串[Object]，无法从中恢复具体请求；提取后的空对象列表不能当没有在途请求。本次没有逐条归因全部280次，也未运行产品构建/测试，因为没有产品代码改动。

见evidence.json、event-diagnostics.json、read-event-diagnostics.py。监控链接：[Grafana页面](https://ea3213527545.grafana.net/d/st-engineering-pages?from=1793694005000&to=1794298805000&var-environment=production)、[Railway生产](https://railway.com/project/ce38c0c0-88cd-407a-9c04-06124cd42e97?environmentId=f03d6c61-84e3-434d-a81a-0ae209167ef5)、[iOS Replay](https://wangqiao.sentry.io/explore/replays/1eb96f79616b4eeaaa8d81d02eebbccf/)。
