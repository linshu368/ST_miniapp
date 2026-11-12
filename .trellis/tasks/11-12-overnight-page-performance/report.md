# 11月11日19点后生产页面性能审计

观测窗口：**2026-11-11 19:00:00—2026-11-12 10:09:24，Asia/Shanghai（北京时间）**，共15小时9分24秒。截止时间固定为开始统计时的当前时间，查询及写报告期间不滚动延长；不是“最近24小时”。

Grafana、Sentry与Railway HTTP明细均按上述固定窗口查询。Railway资源汇总另用查询时最近16小时，范围差异单独注明。格式参考[近七天报告](../11-10-seven-day-page-performance/report.md)，本次数据重新采集，未沿用旧窗口计数。

## 结论

- **优先关注聊天导航、Android个人中心导航和大厅冷启动。**聊天导航Android P95 **7.53s / N51**、iOS **6.47s / N12**；Android个人中心 **4.57s / N107**；大厅冷启动 **8.31s / N115**、**7.38s / N25**。除Android个人中心导航、Android大厅冷启动外，上述分组均为低样本。
- 短剧详情导航Android **6.26s / N7**、iOS **8.50s / N5**；iOS消息列表 **8.17s / N4**。均需继续积累样本，不能据此宣布稳定退化或改善。大厅导航 **0.24s / N80**、**0.50s / N29**，也不能用导航快说明文档冷启动快。
- Grafana页面终态 **ready=1210、error=4、page_left=23**；卡住 **74次**（4秒仍未ready，可随后成功）。已知成功/错误终态中的错误占比 **4/(1210+4)=0.33%**，不是全量用户失败率。错误分布为大厅Android1次、聊天Android1次和iOS2次。
- 与旧报告相同的Grafana `api_logical_v1`口径记录 **4次timeout**；Sentry `api.request.duration`独立记录 **86次timeout**，其中大厅同源请求52次、聊天详情14次。两套覆盖和测量边界不同，**不能相加，也不能把4次当全站超时总量**。
- Railway固定窗口共 **26776次HTTP，0次5xx、193次4xx（0.72%）**；4xx含26次OPTIONS 403、73次499、65次404。未见5xx不代表客户端没有网络失败、取消、超时或CORS拒绝。
- Sentry本窗口error/fatal记录为 **4次AbortError**：聊天详情3次、`/watch`1次。未检索到旧报告中的null.get、parallelRoutes.get或findLast异常；这只描述本窗口实收，不能作为问题永久修复的证明。另有慢请求254次、慢启动30次、page_stall及action_stall各9次告警。
- 服务端普通HTTP直方图中，角色润色 `POST /api/creator/polish` P95约 **101.83s / 估计N44.4**；属于业务操作长请求，不能当页面加载或聊天首字P95。应与图片引用/广场等低样本长尾分开跟进。

## 口径与限制

1. 主表沿用Grafana Faro：`engineering_v1`、`production`、全部release、成功`ready`且`foreground`、`st_page_navigation`。P95为**整个窗口合并样本的分位数**，不是小时/每日P95平均；单位秒，单元格为P95 / N。
2. **N<100均为低样本线索**；本次导航主表只有Android个人中心达到100个样本。—表示本窗口没有对应成功样本，不能写0；0次错误/卡住仅表示本次未记录相应事件。P95通常保留两位小数，极小正值保留三位，避免四舍五入成0。
3. 失败/卡住统计全部平台和全部导航类型，与主表Android/iOS成功前台样本的范围不同；不能用主表N计算失败率，卡住不能与error相加。页面started=1231、terminal=1237，存在窗口边界、迟到或缺报影响，不能直接算缺报率。
4. 冷启动`st_page_launch`是文档开始到内容可用，挂载`st_page_ready`是组件挂载到内容可用；Sentry `startup.shell_ready.duration`是壳可展示的另一指标。三者不得互换，不用自动pageload span代替内容可用。
5. Sentry SDK distribution与Grafana为独立上报。Sentry挂载分布没有与Grafana相同的visibility筛选，接收、聚合和样本数也可能不同；仅作交叉证据，不混合样本。
6. Sentry查询保留两个固定timestamp条件；工具曾把一次查询改成最近2天，已丢弃该结果。异常次数使用窗口聚合，不使用issue生命周期累计数；告警受各owner的覆盖、节流与投递影响，不能代替全量页面终态。
7. production标签不等于已核验全部来自正式域名；正式入口包括用户已确认的`st-miniapp-frontend.vercel.app`，不能按Vercel后缀自动排除。Grafana页面投影无Origin维度；本次未逐事件核对全部来源。
8. 窗口内存在多次部署，不能等同单一当前release。后台、混合可见性不进入Grafana页面P95；关闭遥测、丢报、JS未启动即失败的访问无法据此排除。
9. 按原报告保留27个登记业务页面及根入口记录；根入口、语音、创作者主页、订单列表本窗口未查到Android/iOS成功页面测量。Admin仍无本次可列出的同口径页面P95。未查询任何数据库业务行。
10. 与旧七天报告窗口长度、流量、版本及样本构成均不同；本报告不据两个P95直接判定发布因果或优化收益。

## 各页面站内导航P95

| 页面 / 路由                               | Android P95秒 / N | iOS P95秒 / N | 失败error / 卡住≥4秒 |
| ----------------------------------------- | ----------------: | ------------: | -------------------: |
| 根入口记录 `/`                            |                 — |             — |                0 / 0 |
| 角色大厅 `/characters`                    |         0.24 / 80 |     0.50 / 29 |               1 / 43 |
| 聊天会话 `/chat/:id`                      |         7.53 / 51 |     6.47 / 12 |                3 / 7 |
| 消息语音 `/chat/:id/voice/:id`            |                 — |             — |                0 / 0 |
| 会话列表 `/chats`                         |         1.08 / 38 |     1.68 / 20 |                0 / 0 |
| 影像广场 `/create`                        |         3.93 / 10 |      1.67 / 1 |                0 / 1 |
| 影像工作室 `/create/studio/:id`           |                 — |             — |                0 / 0 |
| 影像作品详情 `/create/work/:id`           |          1.31 / 4 |             — |                0 / 0 |
| 创作空间 `/creation`                      |         1.44 / 53 |      0.64 / 7 |                0 / 0 |
| 角色编辑 `/creation/characters/:id/edit`  |          2.94 / 3 |             — |                0 / 0 |
| 创建角色 `/creation/characters/new`       |          0.50 / 4 |             — |                0 / 0 |
| 创作数据 `/creation/data`                 |          4.14 / 4 |             — |                0 / 1 |
| 创作者主页 `/creators/:id`                |                 — |             — |                0 / 0 |
| 剧场列表 `/dramas`                        |         2.07 / 52 |     1.25 / 15 |                0 / 0 |
| 短剧详情/播放 `/dramas/:id`               |          6.26 / 7 |      8.50 / 5 |                0 / 5 |
| 个人中心 `/profile`                       |        4.57 / 107 |     0.17 / 27 |                0 / 9 |
| 邀请 `/profile/invite`                    |                 — |      1.66 / 1 |                0 / 0 |
| 消息列表 `/profile/messages`              |          1.79 / 9 |      8.17 / 4 |                0 / 1 |
| 消息详情 `/profile/messages/:id`          |                 — |             — |                0 / 1 |
| 订单列表 `/profile/orders`                |                 — |             — |                0 / 0 |
| 充值套餐 `/profile/recharge`              |          0.49 / 8 |      0.06 / 1 |                0 / 0 |
| 充值订单/支付等待 `/profile/recharge/:id` |                 — |             — |                0 / 0 |
| 消费明细 `/profile/spending`              |          0.56 / 1 |      1.38 / 1 |                0 / 0 |
| 客服 `/profile/support`                   |          0.48 / 6 |      3.30 / 5 |                0 / 0 |
| 会员 `/vip`                               |          0.03 / 2 |             — |                0 / 0 |
| 放映视频流 `/watch`                       |         3.26 / 56 |     1.25 / 15 |                0 / 5 |
| 心愿列表 `/wishes`                        |          4.15 / 9 |             — |                0 / 1 |
| 心愿详情 `/wishes/:id`                    |          1.68 / 3 |             — |                0 / 0 |

## 冷启动（文档开始到内容可用，独立口径）

只列本窗口有Android/iOS成功前台样本的页面，其余页面没有对应样本。

| 页面 / 路由                      | Android P95秒 / N | iOS P95秒 / N |
| -------------------------------- | ----------------: | ------------: |
| 角色大厅 `/characters`           |        8.31 / 115 |     7.38 / 25 |
| 聊天会话 `/chat/:id`             |          6.66 / 1 |             — |
| 消息详情 `/profile/messages/:id` |         17.98 / 1 |             — |
| 放映视频流 `/watch`              |          2.30 / 1 |             — |

大厅Android冷启动8.31s有115个成功样本；iOS7.38s仅25个。聊天、消息详情、放映各只有1个Android样本，不能视为稳定分位数。消息详情17.98s属于单次观测，仍需保留作为排查线索。

## 挂载到可用（辅助口径，不包含点击后等待路由组件的全部时间）

| 页面 / 路由                               | Android P95秒 / N | iOS P95秒 / N |
| ----------------------------------------- | ----------------: | ------------: |
| 根入口记录 `/`                            |                 — |             — |
| 角色大厅 `/characters`                    |        1.45 / 256 |     1.30 / 95 |
| 聊天会话 `/chat/:id`                      |        2.61 / 128 |     1.64 / 62 |
| 消息语音 `/chat/:id/voice/:id`            |                 — |             — |
| 会话列表 `/chats`                         |         0.85 / 57 |     1.69 / 25 |
| 影像广场 `/create`                        |         1.73 / 23 |      0.83 / 2 |
| 影像工作室 `/create/studio/:id`           |         0.14 / 17 |     0.004 / 1 |
| 影像作品详情 `/create/work/:id`           |          0.01 / 4 |             — |
| 创作空间 `/creation`                      |         0.66 / 81 |      0.44 / 7 |
| 角色编辑 `/creation/characters/:id/edit`  |          1.78 / 3 |             — |
| 创建角色 `/creation/characters/new`       |         1.78 / 14 |             — |
| 创作数据 `/creation/data`                 |          3.15 / 4 |             — |
| 创作者主页 `/creators/:id`                |                 — |             — |
| 剧场列表 `/dramas`                        |         1.38 / 52 |     0.75 / 15 |
| 短剧详情/播放 `/dramas/:id`               |          5.51 / 7 |      7.39 / 5 |
| 个人中心 `/profile`                       |        0.02 / 123 |     0.01 / 36 |
| 邀请 `/profile/invite`                    |                 — |      1.63 / 1 |
| 消息列表 `/profile/messages`              |         0.25 / 12 |      0.01 / 7 |
| 消息详情 `/profile/messages/:id`          |          0.71 / 3 |      1.67 / 4 |
| 订单列表 `/profile/orders`                |                 — |             — |
| 充值套餐 `/profile/recharge`              |         0.93 / 17 |      0.74 / 4 |
| 充值订单/支付等待 `/profile/recharge/:id` |          0.27 / 1 |     0.001 / 1 |
| 消费明细 `/profile/spending`              |          0.55 / 1 |      1.36 / 1 |
| 客服 `/profile/support`                   |          0.45 / 6 |      3.29 / 5 |
| 会员 `/vip`                               |         0.02 / 13 |      0.01 / 2 |
| 放映视频流 `/watch`                       |         1.45 / 58 |     1.21 / 15 |
| 心愿列表 `/wishes`                        |          0.92 / 9 |             — |
| 心愿详情 `/wishes/:id`                    |          1.26 / 3 |             — |

Android个人中心挂载P95约0.02s，而导航P95约4.57s；聊天挂载约2.61s/1.64s，而导航约7.53s/6.47s。说明只看挂载指标会漏掉导航前段等待。各分布未逐次配对，**不能相减得出路由下载、网络或主线程的耗时**。

短剧详情挂载后仍为5.51s/7.39s，问题线索不只在路由前段；样本分别7/5，需结合播放器成功首帧和实际播放证据排查。

## Sentry交叉核对

Sentry Metrics `page.ready.duration`为挂载开始的SDK distribution；单位原始为毫秒，下表换算秒，保持与Grafana样本分开。

| 路由           |    平台 | 挂载P95秒 |   N |
| -------------- | ------: | --------: | --: |
| /characters    | android |      1.52 | 293 |
| /characters    |     ios |      1.33 | 108 |
| /profile       | android |      0.02 | 132 |
| /profile       |     ios |      0.01 |  36 |
| /chat/:id      | android |      2.75 | 136 |
| /chat/:id      |     ios |      1.72 |  65 |
| /dramas/:id    | android |      5.87 |   7 |
| /dramas/:id    |     ios |      8.47 |   5 |
| /creation/data | android |      3.43 |   6 |
| /creation/data |     ios |         — |   — |

本窗口Sentry异常/告警聚合：

| 类型                                   | 次数 |
| -------------------------------------- | ---: |
| slow_request                           |  254 |
| miniapp_startup_slow                   |   30 |
| page_stall                             |    9 |
| action_stall                           |    9 |
| AbortError: This operation was aborted |    3 |
| AbortError: Fetch is aborted           |    1 |

- [ST-MINIAPP-8T](https://wangqiao.sentry.io/issues/ST-MINIAPP-8T)：聊天详情`GET /api/v1/conversations/:id`发生3次AbortError。
- [ST-MINIAPP-7Z](https://wangqiao.sentry.io/issues/ST-MINIAPP-7Z)：`/watch`发生1次Fetch is aborted。
- AbortError需结合主动取消、路由离开和超时控制器判断；不能单凭异常名称认定为后端超时或页面失败。未回放Replay，也未在真机复现每次异常。
- Sentry page_stall 9次按页面为聊天3、短剧详情3、放映1、大厅1、创作空间1；与Grafana 74次工程卡住事件不是同一集合，不能合并。
- `slow_request`仅为请求计时告警：本次部分是耗时成功，部分为timeout/network等失败；254次不能解释为254次页面打不开。`miniapp_startup_slow`亦为开屏阈值告警。

壳可展示的补充证据：Sentry大厅`startup.shell_ready.duration` Android P95 **6.05s / N138**、iOS **7.91s / N33**；这不是“文档到业务内容可用”的Grafana冷启动8.31s/7.38s，不作替换。

## 客户端API超时

**与旧报告相同的Grafana逻辑请求口径**：`st_api_terminal`、`api_logical_v1`。

| API分类             | timeout次数 |
| ------------------- | ----------: |
| conversation_detail |           1 |
| dramas              |           1 |
| other               |           1 |
| settings            |           1 |

合计4次timeout。全部已接收API终态为ok10699、aborted541、http_error70、error1、timeout4；aborted单列，不能直接当超时或服务端故障。成功测量与终态为不同信号，不要求窗口计数逐项完全一致。

客户端成功逻辑请求P95（全部平台，API分类可能含多个路径）：

| API分类 / 方法          | P95秒 |    N |
| ----------------------- | ----: | ---: |
| conversation_detail GET |  1.92 | 1285 |
| conversations GET       |  2.32 |  566 |
| character_detail GET    |  3.74 |  535 |
| drama_detail GET        |  1.44 |  148 |
| drama_playback POST     |  1.10 |  187 |
| support GET             |  7.04 |  195 |
| wallet GET              |  3.43 |  542 |
| settings GET            |  5.08 |  425 |
| favorites GET           |  2.28 |  549 |
| images GET              |  6.06 |  199 |
| voice GET               |  5.13 |  208 |
| community GET           |  5.17 |  125 |
| notifications GET       |  5.54 |  324 |
| payment GET             |  4.23 |  269 |
| image_plaza GET         |  2.95 |   96 |

`conversation_turn`等可能包含不同请求/流式相关操作，本表不把完整推流时长用于页面打开或首字P95。客户端含排队、重试退避、headers、正文和解析等等待，与服务端处理分布不能直接相减。

**Sentry补充口径：`api.request.duration` timeout**。沿既有timedFetch owner计时，含大厅同源请求；不是上表Grafana逻辑请求的额外互斥集合。

| 请求路由模板                    | timeout次数 |
| ------------------------------- | ----------: |
| /api/lobby-characters           |          52 |
| /api/v1/conversations/:id       |          14 |
| /api/dramas                     |           4 |
| /api/characters/social          |           4 |
| /api/vip/status                 |           2 |
| /api/dramas/play                |           2 |
| /api/notifications              |           2 |
| /api/dramas/:id                 |           1 |
| /api/users/settings             |           1 |
| /api/v1/conversations           |           1 |
| /api/users/onboarding           |           1 |
| /api/characters/latest-seen     |           1 |
| /api/notifications/unread-count |           1 |

合计86次；该指标全部outcome为ok12151、network94、timeout86、http_4xx65、invalid_response3。Sentry慢请求告警中的大厅timeout只有24条，而指标记录52次，说明节流后的告警条数不能代替超时测量次数。大厅、聊天详情应优先结合本次release、客户端网络和后端请求证据核对。

Sentry成功请求的辅助线索：大厅`/api/lobby-characters` P95 **3.47s / N274**，聊天详情 **2.01s / N1201**，影像广场feed **5.67s / N20**。它们与Grafana API分类的覆盖、重试边界不同，不混算P95或N。

## Railway与服务端

生产目标：**gallant-insight / stminiapp / production**，服务来源main。最新已查部署`9716d8a1`创建于2026-11-11 **19:58:08**，状态SUCCESS；窗口内还有19:23、19:26、19:51创建的部署。这里是创建时间，不冒称流量切换完成时刻；部署成功亦不能证明页面可用。

固定窗口HTTP计数：

| 状态分类 |  次数 |
| -------- | ----: |
| 2xx      | 26580 |
| 3xx      |     3 |
| 4xx      |   193 |
| 5xx      |     0 |
| 合计     | 26776 |

Railway统计工具只支持整数小时、无法直接设置固定起止；本次取其16小时分桶中完整落入窗口的**19:12—次日10:08**各桶，得到26526次，再补查19:00—19:12的225条、10:08—10:09:24的25条HTTP明细，总计26776。两个边界查询均未触及500条上限；4xx固定窗口明细193条独立核对一致，5xx固定窗口查询为空。

4xx明细状态分布：

| HTTP状态 | 次数 |
| -------- | ---: |
| 400      |    1 |
| 401      |   13 |
| 402      |   13 |
| 403      |   26 |
| 404      |   65 |
| 409      |    1 |
| 429      |    1 |
| 499      |   73 |

- OPTIONS 403共26次：推荐8、收藏ID7、最新徽标3、会话列表3、角色社交3、onboarding1、幕间入口1。不能仅凭403断言正式入口CORS配错；还需核对允许来源与Origin。本窗口没有旧报告的OPTIONS 500。
- 404中角色详情`GET /api/characters/:id`59次，模型配置4次、会话详情2次；可能与不可见/不存在资源或版本有关，需按接口语义核对，不能一概认定服务器故障。
- 499共73次，表示代理观察到的客户端连接提前结束；它与Sentry AbortError或Grafana aborted不具备逐请求配对，不能相加或视为同一超时数。
- HTTP分桶P95在固定窗口内完整桶中为 **133—16386ms**，最高桶始于11月12日 **05:36**，桶宽16分钟、该桶58次请求。混含OPTIONS、普通API和生成连接，**不是全窗口单一P95，也不是页面P95**；低流量桶容易受长请求构成影响。
- 查询时最近16小时资源汇总（约11月11日18:14—11月12日10:14，含窗口外时段）：5分钟采样CPU平均 **0.0310**、最大 **0.0853**（Railway原始CPU_USAGE单位）；内存平均 **0.325GB**、最大 **0.512GB**。未取得固定窗口的高频资源/限制比值证据，不把它作为“没有短时资源压力”的结论。

Prometheus服务端普通HTTP直方图按本次54564秒`increase`合并bucket后计算P95，过滤`kind="standard"`，排除独立generation类别；这仍可能含角色润色等长业务操作。数值为直方图近似，N为外推估计而非原始请求整数。最慢接口：

| 方法 / 路由                           |  P95秒 | 窗口估计N |
| ------------------------------------- | -----: | --------: |
| POST /api/creator/polish              | 101.83 |      44.4 |
| POST /api/image-plaza/references      |   5.80 |       2.0 |
| GET /api/image-plaza/feed             |   3.90 |      22.0 |
| POST /api/payment/orders              |   2.90 |       2.0 |
| POST /api/v1/conversations/:id/cancel |   1.95 |       1.0 |
| POST /api/creator/covers              |   1.90 |       4.0 |
| GET /api/payment/orders/:id           |   1.85 |       6.0 |
| POST /api/v1/models/select            |   1.62 |      35.0 |
| GET /api/v1/voice/config              |   1.57 |     217.1 |
| GET /api/v1/models/config             |   1.51 |     206.1 |
| GET /api/creator/analytics            |   1.25 |      15.0 |
| GET /api/v1/images/config             |   1.05 |     208.1 |

角色润色101.83s应单独确认完整业务流程、超时和用户取消恢复；它与聊天首字、页面ready不同。图片引用5.80s、广场feed3.90s、下单2.90s均为低样本。角色发布本窗口服务端P95约 **0.41s / 估计N7.0**，未查到5xx；不能直接与旧七天报告的18.23s作发布因果比较。

## 建议顺序与验收

1. 优先核对**大厅同源52次timeout、聊天详情14次timeout**，并与Grafana仅4次逻辑请求timeout的覆盖差异分开说明。固定正式来源、release、Android/iOS及网络层后，再判断请求排队、取消、重试和服务端耗时；不从5xx为0推断客户端健康。
2. 重点分析Android个人中心导航4.57s，以及聊天导航7.53s/6.47s与挂载指标的差异。需要同一次导航的阶段证据，不能相减独立P95归因。大厅导航已较快，仍需单独处理文档冷启动8.31s/7.38s。
3. 继续积累短剧详情、iOS消息列表及其他低样本页，按同release看error/page_left与首帧播放；不可只筛成功样本宣布达标。聊天本窗口3次error仍应按页面失败跟进，不能因Sentry无旧TypeError而忽略。
4. 复核26次OPTIONS 403的实际来源、59次角色详情404的业务语义，以及角色润色101.83s等长业务操作。只读报告不修改白名单、生产配置、超时或发布状态。
5. 建议复用`packages/ui-tests`现有`@chat/@profile/@roleplay`及短剧/创作流程纳入本地重复验收：冷启动、慢导航、请求timeout、离页取消及重试恢复。真实Telegram、旧Android WebView、iOS往返切页、系统键盘、媒体及真实供应商另验；本次统计未运行UI或产品测试。

## 入口

- [五入口导航P95（固定本次窗口）](https://ea3213527545.grafana.net/d/st-five-route-navigation-ready?from=1794394800000&to=1794449364000&var-environment=production&var-tg_platform=android%7Cios)
- [工程页面看板](https://ea3213527545.grafana.net/d/st-engineering-pages?from=1794394800000&to=1794449364000&var-environment=production&var-tg_platform=android%7Cios)
- [二级页面](https://ea3213527545.grafana.net/d/st-secondary-page-latency?from=1794394800000&to=1794449364000&var-environment=production&var-tg_platform=android%7Cios)
- [三级页面](https://ea3213527545.grafana.net/d/st-tertiary-page-latency?from=1794394800000&to=1794449364000&var-environment=production&var-tg_platform=android%7Cios)
- [非流式API看板](https://ea3213527545.grafana.net/d/st-api-latency-non-stream?from=1794394800000&to=1794449364000&var-environment=production&var-tg_platform=android%7Cios)
- [Sentry固定窗口错误聚合](https://wangqiao.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&query=environment%3Aproduction+timestamp%3A%3E%3D2026-11-11T11%3A00%3A00Z+timestamp%3A%3C2026-11-12T02%3A09%3A24Z+level%3A%5Berror%2Cfatal%5D&project=4511818663788624&field=issue&field=title&field=transaction&field=count%28%29&sort=-count%28%29&statsPeriod=2d&mode=aggregate&yAxis=count%28%29)
- [Sentry Metrics（固定时间窗口）](https://wangqiao.sentry.io/explore/metrics/?project=4511818663788624&start=2026-11-11T11%3A00%3A00Z&end=2026-11-12T02%3A09%3A24Z)
- [Railway生产环境](https://railway.com/project/ce38c0c0-88cd-407a-9c04-06124cd42e97?environmentId=f03d6c61-84e3-434d-a81a-0ae209167ef5)
- [脱敏聚合及查询定义](./evidence.json)

采集时Grafana MCP凭证失效，经用户重新授权后已恢复，页面/API/服务端章节均已补齐；未使用失败的浏览器读取结果。Loki聚合返回`resultsTruncated=false`。Sentry曾有一次工具翻译移除固定时间条件，已丢弃；以上仅采用实际执行查询仍保留双timestamp边界的结果。

本任务只新增统计文档，未改变产品、配置、部署或数据库；未运行typecheck/build/产品测试。验证限于固定窗口、查询过滤、路由覆盖、单位、样本数、分项合计及报告与evidence一致性；evidence只保存脱敏聚合，不保存原始日志或用户信息。
