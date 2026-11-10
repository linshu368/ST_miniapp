# 近七天生产页面性能审计

> 后续补充：两页故障和部署关联见 ../11-10-characters-chat-root-cause/report.md。已找到独立CORS WARN来源，504条均为vercel.app；490条OPTIONS 500中442条为HeadlessChrome。上一版“缺Origin无法判断”的限制已补齐，不能将这些拒绝都视作正式入口故障。另查得同源大厅请求独立计时有453次Android timeout，不属于本报告37次api_logical_v1超时集合。

观测窗口：2026-11-03 16:20:05—2026-11-10 16:20:05，Asia/Shanghai。Grafana 固定该窗口；Railway 指标为查询时最近168小时（与固定窗口相差数分钟），HTTP 明细按固定窗口提取，525条与指标总数一致。Sentry 为查询时最近7天，错误级事件另加固定结束时间。

## 结论

- 较突出：短剧详情导航 Android P95 11.29s、iOS 9.69s；聊天会话5.23s/5.69s。角色大厅导航1.45s/1.34s，但文档冷启动8.90s/6.05s。
- Grafana页面终态 ready=7069、error=40、page_left=234，卡住477次（4秒仍未ready，可随后成功；不是477次打不开）。已知终态错误占比40/(7069+40)=0.56%，仅为已接收终态，不等同全量用户失败率。起点7315与终态7343受窗口边界/缺报影响，不能直接算缺报率。
- 客户端普通API记录37次timeout，聊天详情16次最多。aborted 单列，不认定为超时或服务端故障。
- Railway共187594次HTTP、525次5xx（0.2799%）、1160次4xx。完整提取521次500、4次503，无502/504；490次OPTIONS 500，占5xx的93.33%。应用日志大量Not allowed by CORS；缺Origin字段，不能断言正式域名CORS配错或量化其正式用户影响。
- Sentry已查到真实前端错误：聊天null.get 15次、findLast不兼容7次、大厅iOS parallelRoutes.get异常6次；区别于slow_request/page_stall告警。

## 口径与限制

1. 主表为Grafana Faro engineering_v1、production、全部release、前台成功、st_page_navigation（用户站内点击到内容可用）的全窗口P95，不是每日P95平均；单位秒，单元格为P95 / N。N<100只作低样本线索，不判稳态。—为无对应样本，不能写0。
2. 失败/卡住为全部平台、全部导航类型的工程事件数量；与主表成功样本范围不同，不能以主表N直接算失败率；卡住可随后ready，不与失败相加。0表示本次查询未记录该事件，不证明页面绝无问题。
3. 冷启动 st_page_launch 与挂载 st_page_ready 分开；自动pageload span会受资源/生命周期影响，不能代替内容可用。
4. Sentry当前可见错误最早2026-11-06 13:43:43，不能证明11月3日至6日无错。Issue列表occurrences存在生命周期统计差异，本报告异常计数使用search_errors窗口聚合，未使用issue详情累计数。
5. Sentry production标签内存在Preview URL；Grafana页面安全投影无Origin维度。本报告为production标签样本，不能保证全是app.themijing.com正式访问；正式域名异常另由事件URL核对。
6. 全窗口含多个release，不能等同当前版本。后台、混合可见性排除在P95外；遥测关闭/丢报/页面在采集前崩溃无法据此排除。
7. 覆盖27个登记MiniApp业务页面及根入口记录。仓库Admin未检索到同套Sentry/Faro页面可用埋点，不能列出其可信页面P95。未访问数据库业务行。

## 各页面站内导航P95

| 页面 / 路由                               | Android P95秒 / N | iOS P95秒 / N | 失败error / 卡住≥4秒 |
| ----------------------------------------- | ----------------: | ------------: | -------------------: |
| 根入口记录（当前重定向至大厅） `/`        |          0.12 / 9 |      0.10 / 3 |               1 / 31 |
| 角色大厅 `/characters`                    |        1.46 / 528 |    1.34 / 131 |              8 / 196 |
| 聊天会话 `/chat/:id`                      |        5.23 / 317 |     5.69 / 75 |              22 / 84 |
| 消息语音 `/chat/:id/voice/:id`            |          0.98 / 1 |             — |                0 / 0 |
| 会话列表 `/chats`                         |        1.17 / 212 |     1.73 / 54 |                2 / 5 |
| 影像广场 `/create`                        |          3.90 / 8 |      3.18 / 3 |                1 / 1 |
| 影像工作室 `/create/studio/:id`           |                 — |             — |                0 / 1 |
| 影像作品详情 `/create/work/:id`           |          0.78 / 6 |             — |                0 / 0 |
| 创作空间 `/creation`                      |        1.92 / 259 |     1.21 / 46 |               0 / 12 |
| 角色编辑 `/creation/characters/:id/edit`  |         2.44 / 28 |             — |                0 / 1 |
| 创建角色 `/creation/characters/new`       |         2.13 / 26 |             — |                0 / 2 |
| 创作数据 `/creation/data`                 |         4.63 / 37 |      1.90 / 7 |                0 / 6 |
| 创作者主页 `/creators/:id`                |         3.17 / 18 |      2.19 / 5 |                0 / 0 |
| 剧场列表 `/dramas`                        |        1.69 / 301 |     1.11 / 70 |                0 / 7 |
| 短剧详情/播放 `/dramas/:id`               |        11.29 / 87 |     9.69 / 34 |               2 / 56 |
| 个人中心 `/profile`                       |        2.02 / 755 |    1.41 / 149 |               1 / 60 |
| 邀请 `/profile/invite`                    |          1.71 / 7 |      1.45 / 2 |                0 / 0 |
| 消息列表 `/profile/messages`              |         0.37 / 59 |     0.15 / 15 |                0 / 0 |
| 消息详情 `/profile/messages/:id`          |          0.02 / 1 |             — |                0 / 1 |
| 订单列表 `/profile/orders`                |          0.89 / 3 |             — |                0 / 0 |
| 充值套餐 `/profile/recharge`              |         0.40 / 46 |      1.04 / 2 |                0 / 2 |
| 充值订单/支付等待 `/profile/recharge/:id` |                 — |             — |                0 / 0 |
| 消费明细 `/profile/spending`              |         2.92 / 33 |      0.84 / 2 |                0 / 1 |
| 客服 `/profile/support`                   |         2.01 / 68 |     1.37 / 23 |                3 / 2 |
| 会员 `/vip`                               |          0.03 / 6 |             — |                0 / 0 |
| 放映视频流 `/watch`                       |        1.79 / 295 |     1.80 / 78 |                0 / 8 |
| 心愿列表 `/wishes`                        |         1.78 / 26 |      1.32 / 4 |                0 / 1 |
| 心愿详情 `/wishes/:id`                    |          1.53 / 6 |      0.95 / 1 |                0 / 0 |

## 冷启动（文档开始到内容可用，独立口径）

| 页面                               | Android P95秒 / N | iOS P95秒 / N |
| ---------------------------------- | ----------------: | ------------: |
| 根入口记录（当前重定向至大厅） `/` |         7.07 / 96 |     3.84 / 27 |
| 角色大厅 `/characters`             |        8.90 / 546 |    6.05 / 132 |
| 聊天会话 `/chat/:id`               |          2.32 / 1 |             — |
| 会话列表 `/chats`                  |          1.83 / 1 |             — |
| 创作空间 `/creation`               |          4.50 / 2 |             — |
| 个人中心 `/profile`                |          0.58 / 1 |      0.95 / 3 |
| 放映视频流 `/watch`                |         11.58 / 1 |             — |

## 挂载到可用（辅助口径，不包含点击后等待路由组件的全部时间）

| 页面                                      | Android P95秒 / N | iOS P95秒 / N |
| ----------------------------------------- | ----------------: | ------------: |
| 根入口记录（当前重定向至大厅） `/`        |        0.82 / 105 |     1.12 / 30 |
| 角色大厅 `/characters`                    |       1.52 / 1485 |    1.56 / 363 |
| 聊天会话 `/chat/:id`                      |        2.66 / 760 |    3.05 / 176 |
| 消息语音 `/chat/:id/voice/:id`            |          0.02 / 1 |             — |
| 会话列表 `/chats`                         |        0.91 / 337 |     1.45 / 76 |
| 影像广场 `/create`                        |         1.75 / 23 |      2.01 / 3 |
| 影像工作室 `/create/studio/:id`           |         1.54 / 26 |      0.44 / 1 |
| 影像作品详情 `/create/work/:id`           |          0.01 / 6 |             — |
| 创作空间 `/creation`                      |        0.69 / 449 |     0.68 / 49 |
| 角色编辑 `/creation/characters/:id/edit`  |         1.34 / 30 |             — |
| 创建角色 `/creation/characters/new`       |         1.11 / 90 |      0.70 / 2 |
| 创作数据 `/creation/data`                 |         2.08 / 39 |      0.53 / 7 |
| 创作者主页 `/creators/:id`                |         1.90 / 18 |      1.56 / 5 |
| 剧场列表 `/dramas`                        |        0.96 / 301 |     0.72 / 70 |
| 短剧详情/播放 `/dramas/:id`               |         9.53 / 87 |     9.28 / 34 |
| 个人中心 `/profile`                       |        0.34 / 914 |    0.51 / 190 |
| 邀请 `/profile/invite`                    |          1.64 / 8 |      1.42 / 2 |
| 消息列表 `/profile/messages`              |         0.03 / 95 |     0.01 / 21 |
| 消息详情 `/profile/messages/:id`          |         1.39 / 37 |      1.04 / 6 |
| 订单列表 `/profile/orders`                |          0.85 / 4 |             — |
| 充值套餐 `/profile/recharge`              |         0.53 / 75 |      1.63 / 8 |
| 充值订单/支付等待 `/profile/recharge/:id` |         0.38 / 11 |             — |
| 消费明细 `/profile/spending`              |         2.33 / 33 |      0.82 / 2 |
| 客服 `/profile/support`                   |         1.65 / 68 |     1.29 / 23 |
| 会员 `/vip`                               |         0.03 / 74 |     0.01 / 19 |
| 放映视频流 `/watch`                       |        1.31 / 296 |     1.41 / 78 |
| 心愿列表 `/wishes`                        |         1.19 / 28 |      1.29 / 4 |
| 心愿详情 `/wishes/:id`                    |          1.61 / 7 |      0.55 / 1 |

个人中心Android挂载到可用约0.34s，而导航约5.02s，说明只看组件挂载指标会漏掉导航前段等待；尚不能确定具体网络、chunk或主线程根因。短剧详情挂载后仍需约9.53s/9.28s，问题不局限路由前段。

## Sentry交叉核对

Sentry Metrics page.ready.duration 是挂载开始的SDK distribution，与Grafana独立上报且过滤/接收存在差异，样本不得混合。下面只作交叉证据。

| 路由           | 平台    | 挂载P95秒 |    N |
| -------------- | ------- | --------: | ---: |
| /characters    | android |      1.83 | 1660 |
| /profile       | android |      0.36 |  916 |
| /chat/:id      | android |      3.09 |  782 |
| /characters    | ios     |      1.67 |  394 |
| /profile       | ios     |      0.52 |  194 |
| /chat/:id      | ios     |      3.93 |  180 |
| /dramas/:id    | android |      9.95 |   85 |
| /creation/data | android |      4.04 |   45 |
| /dramas/:id    | ios     |      8.51 |   19 |
| /creation/data | ios     |      0.84 |    7 |

- [ST-MINIAPP-1P](https://wangqiao.sentry.io/issues/ST-MINIAPP-1P)：近7天15次聊天页null.get异常；已查看事件为Android12/Telegram，11月8日22:38最后记录。issue详情累计32次不能当7天数。
- [ST-MINIAPP-7C](https://wangqiao.sentry.io/issues/ST-MINIAPP-7C)：7次findLast is not a function，相关首方位置ChatGuide；事件Android11，1个用户，11月8日18:16最后记录。推测为旧WebView兼容问题，需兼容验证。
- [ST-MINIAPP-4](https://wangqiao.sentry.io/issues/ST-MINIAPP-4)：近7天6次大厅parallelRoutes.get异常；已查看正式域名、iOS18.3.1/WKWebView，11月10日14:40仍发生，release 4cd7624b。issue详情累计10次不能当7天数。
- [ST-MINIAPP-1C](https://wangqiao.sentry.io/issues/ST-MINIAPP-1C)：聊天详情读取AbortError 7次，需区别客户端主动取消与后端超时。Railway另有该路由11次500。
- slow_request是请求慢，不等于整个页面失败；miniapp_startup_slow是开屏阈值告警；asset_load_failed不必然造成整页不可用。Sentry已查看错误事件有Replay，但本次没有回放视频/逐会话复现，不能确认每个异常都导致白屏。

## 客户端API超时

| API分类             | timeout次数 |
| ------------------- | ----------: |
| conversation_detail |          16 |
| conversation_turn   |           3 |
| payment             |           3 |
| settings            |           3 |
| conversations       |           2 |
| other               |           2 |
| wallet              |           2 |
| drama_detail        |           1 |
| drama_playback      |           1 |
| drama_social        |           1 |
| images              |           1 |
| support             |           1 |
| voice               |           1 |

客户端成功请求P95：conversation_detail GET 1.84s/N6995，conversations GET 2.25s/N3508，drama_detail GET 2.09s/N1010，support GET 5.80s/N2322，wallet GET 3.33s/N3463。API分类可能包含多个路由，不能当单一endpoint。SSE完整推流不用于首字或页面打开P95。

## Railway与服务端

生产目标：gallant-insight / stminiapp / production；main来源，最近部署2026-11-10 11:37为SUCCESS。部署成功不是用户页面可用证明。

- HTTP分桶P95范围160–2472ms；最高桶始于11月6日06:24。它们不是全窗口单一P95，且全服务混含OPTIONS、健康检查和生成，不用于替代页面指标。
- 5xx最高错误率桶始于11月6日17:36，49/2643=1.854%。
- 小时采样CPU平均0.0257、峰值0.1012（Railway原始CPU_USAGE单位）；内存平均0.361GB、小时样本峰值1.604GB。没有高频资源/限制比值证据，不能排除短时压力。
- 5xx归一化路由完整聚合如下，525条已分页核对。OPTIONS490、GET23、POST11、PUT1。

| 状态 / 方法 / 路由                             | 次数 |
| ---------------------------------------------- | ---: |
| 500 OPTIONS /api/favorites/ids                 |   71 |
| 500 OPTIONS /api/dramas                        |   70 |
| 500 OPTIONS /api/characters/latest-seen        |   68 |
| 500 OPTIONS /api/v1/conversations              |   63 |
| 500 OPTIONS /api/characters/latest-badge       |   61 |
| 500 OPTIONS /api/characters/social             |   59 |
| 500 OPTIONS /api/telemetry/drama-timing        |   26 |
| 500 OPTIONS /api/characters/recommendation     |   24 |
| 500 GET /api/v1/conversations/:id              |   11 |
| 500 OPTIONS /api/users/onboarding              |   10 |
| 500 OPTIONS /api/wallet/balance                |    6 |
| 500 POST /api/telemetry/drama-timing           |    4 |
| 500 GET /api/dramas                            |    4 |
| 500 GET /api/favorites                         |    4 |
| 500 OPTIONS /api/users/settings                |    4 |
| 500 OPTIONS /api/wallet/checkin                |    4 |
| 500 OPTIONS /api/vip/status                    |    4 |
| 500 OPTIONS /api/payment/plans                 |    4 |
| 500 OPTIONS /api/invite/entry-status           |    4 |
| 500 OPTIONS /api/community/entry               |    4 |
| 503 POST /api/creator/characters/:id/publish   |    3 |
| 500 OPTIONS /api/notifications/unread-count    |    3 |
| 500 OPTIONS /api/support/unread                |    3 |
| 500 POST /api/v1/conversations                 |    2 |
| 500 GET /api/characters/recommendation         |    2 |
| 500 OPTIONS /api/favorites                     |    2 |
| 500 GET /api/creator/characters                |    2 |
| 500 POST /api/admin/cli/session                |    1 |
| 500 POST /api/v1/conversations/:id/messages    |    1 |
| 503 PUT /api/creator/characters/:id/visibility |    1 |

Prometheus服务端直方图按7天increase合并bucket后求P95，是近似值；N为increase估计，非整数不是原始请求数。最慢接口：

| 方法 / 路由                              | P95秒 | 窗口估计N |
| ---------------------------------------- | ----: | --------: |
| POST /api/payment/orders                 | 19.45 |      74.0 |
| POST /api/creator/characters/:id/publish | 18.23 |      71.1 |
| POST /api/creator/covers                 |  9.84 |      62.1 |
| POST /api/telegram/webhook               |  3.81 |      15.0 |
| GET /api/image-plaza/feed                |  3.15 |      34.0 |
| POST /api/image-plaza/references         |  1.93 |       3.0 |
| POST /api/v1/conversations/:id/cancel    |  1.89 |      26.0 |
| GET /api/payment/orders/:id              |  1.84 |     176.1 |
| POST /api/v1/text-postprocess/versions   |  0.95 |     474.3 |
| POST /api/support/messages               |  0.70 |      36.1 |

创建支付订单19.45s、角色发布18.23s、封面生成9.84s均为低样本，且服务端包含失败请求；不能与客户端payment分类成功P95直接比较或相减。角色发布3次503及可见性1次503应独立跟进。

## 建议顺序与验收

1. 先处理可致页面失败的前端路由null.get/parallelRoutes异常和findLast兼容；以正式域名、Android/iOS、同release核对error终态、Replay和真实设备。7天历史出现不表示旧release问题当前仍未修复；iOS大厅异常今天仍有实收。
2. 核对CORS拒绝来源。现有req日志只含method/url/host/remoteAddress等，无Origin，不能将拒绝的Preview或非法来源当正式入口故障，也不应直接放开白名单。
3. 优先短剧详情、聊天、Android个人中心导航和大厅冷启动；各阶段需同一观测关联，不能用独立P95相减进行归因。
4. 单独查支付下单、角色发布/封面调用长尾与503，并结合业务状态恢复，页面已打开不代表交易流程正常。
5. 复用packages/ui-tests现有@chat/@roleplay/@profile及相应创作/短剧场景，补充路由失败、重试恢复、旧Android WebView、iOS多次返回/切页、弱网冷启动。真实Telegram、系统键盘、媒体及支付供应商另验；本次只读审计未运行UI或产品测试。

## 入口

- [五入口导航P95（固定本次窗口）](https://ea3213527545.grafana.net/d/st-five-route-navigation-ready?from=1793694005000&to=1794298805000&var-environment=production&var-tg_platform=android%7Cios)
- [工程页面看板](https://ea3213527545.grafana.net/d/st-engineering-pages?from=1793694005000&to=1794298805000&var-environment=production)
- [二级页面](https://ea3213527545.grafana.net/d/st-secondary-page-latency?from=1793694005000&to=1794298805000&var-environment=production)
- [三级页面](https://ea3213527545.grafana.net/d/st-tertiary-page-latency?from=1793694005000&to=1794298805000&var-environment=production)
- [Sentry Metrics](https://wangqiao.sentry.io/explore/metrics/?project=4511818663788624&statsPeriod=7d)
- [Railway生产环境](https://railway.com/project/ce38c0c0-88cd-407a-9c04-06124cd42e97?environmentId=f03d6c61-84e3-434d-a81a-0ae209167ef5)

原始日志过滤的工具示例@status:500实际不生效，已用CLI帮助核对真实字段@httpStatus:>=500重取并完整分页，错误筛选结果已丢弃。PATH中的Node版Railway wrapper损坏，本地railway.exe尚未认证，最终使用已连接Railway只读工具完成。timeout全文日志空结果不能排除超时，采用客户端明确timeout终态作为证据。

本任务未改变产品、配置或部署，未运行typecheck/build/产品测试；校验限于报告数据与计数一致性。evidence.json仅保存脱敏聚合及查询，不保存原始日志或用户信息。
