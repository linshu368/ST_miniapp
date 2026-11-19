# 本轮证据与边界

冻结窗口：2026-11-17 15:10:52—2026-11-19 15:10:52，北京时间；UTC 2026-11-17T07:10:52Z—2026-11-19T07:10:52Z。生产标签，全部release。

## 原始报告

- 用户指定 D:/JobExe/ST/sentry/module-business-comparison-2026-11-14-15-vs-17-18.md 与 report-2026-11-14-15-vs-17-18.md 已读取；两份文件不修改。
- 周末A=11/14 00:00—11/16 00:00；周二周三B=11/17 00:00—11/19 00:00。原对比导航3.395→3.012秒（-11.3%），冷开8.118→8.443秒（+4%），错误终态占比0.79%→1.57%。不能当成本轮新48h数据。
- 周一e87d8d37已包含根rewrite、首屏critical、60秒详情复用与250ms summary；禁止重复实现，不能把旧文档“本地候选”当成现在未部署。

## 最近48h页面

P95单位ms，ready/foreground/engineering_v1；N是成功测量，不是用户。Android含android_x（本窗未观察到该类单列），iOS独立。† N<100；无数据不补0。

| 口径   | route                         | 平台    | P95 ms   | N    |
| ------ | ----------------------------- | ------- | -------- | ---- |
| 冷打开 | /characters                   | android | 9031.28  | 278  |
| 导航   | /characters                   | android | 1976.00  | 542  |
| 冷打开 | /characters                   | ios     | 6560.30  | 80†  |
| 导航   | /characters                   | ios     | 1522.80  | 88†  |
| 冷打开 | /chat/:id                     | android | 8041.00  | 9†   |
| 导航   | /chat/:id                     | android | 3866.00  | 1301 |
| 冷打开 | /chat/:id                     | ios     | 7135.50  | 3†   |
| 导航   | /chat/:id                     | ios     | 3797.60  | 168  |
| 冷打开 | /chats                        | android | 8627.80  | 601  |
| 导航   | /chats                        | android | 1795.55  | 546  |
| 冷打开 | /chats                        | ios     | 7645.40  | 117  |
| 导航   | /chats                        | ios     | 1331.70  | 99†  |
| 导航   | /create                       | android | 5222.04  | 22†  |
| 冷打开 | /create                       | ios     | 2293.00  | 1†   |
| 导航   | /create                       | ios     | 2270.40  | 35†  |
| 冷打开 | /create/studio/:id            | android | 12259.10 | 1†   |
| 导航   | /create/work/:id              | android | 2607.95  | 11†  |
| 导航   | /create/work/:id              | ios     | 960.50   | 23†  |
| 冷打开 | /creation                     | android | 1285.55  | 2†   |
| 导航   | /creation                     | android | 2028.56  | 348  |
| 导航   | /creation                     | ios     | 1429.40  | 57†  |
| 导航   | /creation/characters/:id/edit | android | 3861.20  | 31†  |
| 导航   | /creation/characters/:id/edit | ios     | 270.00   | 1†   |
| 导航   | /creation/characters/new      | android | 1898.48  | 43†  |
| 导航   | /creation/characters/new      | ios     | 7961.00  | 6†   |
| 导航   | /creation/data                | android | 3521.52  | 37†  |
| 导航   | /creation/data                | ios     | 1241.00  | 1†   |
| 导航   | /creators/:id                 | android | 2467.34  | 12†  |
| 导航   | /creators/:id                 | ios     | 1519.00  | 1†   |

工作室只有挂载样本：Android1416.425/N66、iOS561.4/N65；没有成功导航样本，不用挂载替代导航。完整51个页面分组见evidence.json。

## API分段

成功ok、同窗口。队列、headers、body、total的独立分位数不能相减/相加。

| 口径       | api_route           | 平台    | P95 ms  | N     |
| ---------- | ------------------- | ------- | ------- | ----- |
| 排队       | conversation_detail | android | 48.50   | 13117 |
| 逻辑总等待 | conversation_detail | android | 2042.60 | 13117 |
| 排队       | conversation_detail | ios     | 11.00   | 2002  |
| 逻辑总等待 | conversation_detail | ios     | 1963.70 | 2002  |
| 排队       | conversation_groups | android | 32.57   | 1747  |
| 逻辑总等待 | conversation_groups | android | 1953.17 | 1747  |
| 排队       | conversation_groups | ios     | 12.00   | 258   |
| 逻辑总等待 | conversation_groups | ios     | 2595.95 | 258   |
| 排队       | conversations       | android | 813.27  | 3683  |
| 逻辑总等待 | conversations       | android | 2133.78 | 3683  |
| 排队       | conversations       | ios     | 950.00  | 521   |
| 逻辑总等待 | conversations       | ios     | 2236.00 | 521   |
| 排队       | image_plaza         | android | 12.57   | 724   |
| 逻辑总等待 | image_plaza         | android | 1752.02 | 724   |
| 排队       | image_plaza         | ios     | 10.00   | 622   |
| 逻辑总等待 | image_plaza         | ios     | 1206.80 | 622   |
| 排队       | image_plaza_detail  | android | 1.68    | 3†    |
| 逻辑总等待 | image_plaza_detail  | android | 1388.50 | 3†    |
| 排队       | image_plaza_detail  | ios     | 1.00    | 10†   |
| 逻辑总等待 | image_plaza_detail  | ios     | 533.75  | 10†   |
| 排队       | image_plaza_feed    | android | 9.61    | 124   |
| 逻辑总等待 | image_plaza_feed    | android | 1850.79 | 124   |
| 排队       | image_plaza_feed    | ios     | 7.00    | 41†   |
| 逻辑总等待 | image_plaza_feed    | ios     | 1532.00 | 41†   |
| 排队       | settings            | android | 2809.42 | 4998  |
| 逻辑总等待 | settings            | android | 3720.38 | 4998  |
| 排队       | settings            | ios     | 4098.40 | 835   |
| 逻辑总等待 | settings            | ios     | 5306.75 | 836   |

creator/creator_public在api-timing.ts已返回但缺grafana-schema.ts api_route白名单，历史归other，不能给创作接口补造P95。settings队列长尾明显但该组含多类设置操作，需同请求数据归因。image_plaza_feed已经默认critical，队列P95仅9.61/7ms，不能把调度当作当前5秒页面的已证实主因。

## Sentry错误与慢启动

固定窗口error/fatal按issue聚合共17组201次；慢请求警告不等于真实故障，issue详情occurrences是生命周期计数，本报告不使用。

| issue                                                 | 窗口次数 | 已核验信息                                                                                    |
| ----------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| [CC](https://wangqiao.sentry.io/issues/ST-MINIAPP-CC) | 82       | 最新窗内样本指向conversation-detail.ts:54，即onClose触发abort；不证明82次全是正常离页         |
| [CR](https://wangqiao.sentry.io/issues/ST-MINIAPP-CR) | 26       | 身份读取user.ts的失败；需继续分cause，不全部当取消                                            |
| [C8](https://wangqiao.sentry.io/issues/ST-MINIAPP-C8) | 3        | 均9f4614db；其中1条transaction为创建角色、2条未归属；最新窗内事件URL=/creation/characters/new |
| [F4](https://wangqiao.sentry.io/issues/ST-MINIAPP-F4) | 1        | 聊天页React update depth；未有可复现根因，不宣称已修                                          |
| [48](https://wangqiao.sentry.io/issues/ST-MINIAPP-48) | 162      | 慢启动警告，Android /chats85、/characters38；iOS /chats15、/characters11，其余13              |

- C8代码仍存在直接crypto.randomUUID（character-editor.tsx:133/318/518、documents:55、wishes:528），已有SSE/lobby兼容v4算法可复用。
- 90/6J两组slow_request窗口内696/539次是会话配图/旧images config，9b0a0ee4已退役；不得为本轮优化重建这些功能。4K和6F最新详情在冻结结束后，只用于代码定位，不计入此窗口证据。
- 搜索链接：[固定窗口错误聚合](https://wangqiao.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&query=environment%3Aproduction+level%3A%5Berror%2Cfatal%5D&project=4511818663788624&field=issue&field=title&field=count%28%29&sort=-count%28%29&start=2026-11-17T07%3A10%3A52Z&end=2026-11-19T07%3A10%3A52Z&mode=aggregate&yAxis=count%28%29)。production标签可能混入preview；C8详情保留的规范pathname不携带敏感query，主域归属需另核。

## 六条慢启动同次诊断抽样

不是随机样本，不推算总体占比。shell_ready可早于Providers（HTML轻量通知），不能跨指标相减。

| Sentry event                     | route       | 平台    | before_providers ms | connect_to_request ms | 最长script fetch ms | redirect |
| -------------------------------- | ----------- | ------- | ------------------- | --------------------- | ------------------- | -------- |
| 071fab28b0dc49dc9d681822ca51e7af | /chats      | ios     | 5483.00             | 5135.00               | 27.00               | 0        |
| c196b3ae88e944d2b7a6eb263a348f64 | /chats      | android | 15396.10            | 0.30                  | 4201.10             | 0        |
| 1fbb7297fa9544cd9fc0bbbce1d9fffe | /characters | ios     | 5574.00             | 5168.00               | 227.00              | 0        |
| efcab4f5dca34c9c8c9afe870dea2a0f | /characters | android | 8540.80             | 1.20                  | 7361.00             | 0        |
| 8c14705765cc482aa97bf53081ede4fd | /chats      | ios     | 5221.00             | 172.00                | 3084.00             | 0        |
| 2b8b5cc26c4640c6bd665f3e3dd20a47 | /chats      | android | 6009.90             | 0.40                  | 616.70              | 0        |

两条iOS样本connect_to_request约5.1s，Android分别有4.2s/7.36s脚本传输；全部redirect_count=0。SDK仅数毫秒到十余毫秒，不能把SDK当统一慢因。本机PowerShell探测三个正式URL均WebException，暂无可验证CDN响应头，不能以此断言源站不可用或先改Cache-Control。

## 视频交付独立证据

上一轮已核验生产Railway昨晚18:00—次日08:00四个完成任务：Wan总357.715s（上游观察290.859s/交付66.337s）；Wan总503.018s（143.420s/359.087s）；Seedance118.716s；MiniMax95.843s。22:57:04停止旧容器后约23:02:04重领，符合现有5分钟租约；不能将四样本称模型P95。

当前video-delivery-job.ts:195每轮先取源，再uploadStreamChunk；app.ts onClose只同步停timer，没有等待delivery轮次。registry仍把video_delivery_jobs标planned，与实际运行证据存在文档时效差异；本轮不据此改写生产结构事实，不新建表/列/函数。

## 数据与代码边界

- source: Grafana Loki grafanacloud-logs，stream service_name=st-miniapp；页面3项、API2项聚合均成功且未截断，原始安全聚合保存在evidence.json。
- Sentry组织wangqiao、项目st-miniapp、region de.sentry.io；错误查询executedSearch已核对固定起止。pageload span为采样诊断，不代替页面内容ready，未作为性能基线。
- 研究期间用户同步dev，最终工作树代码锚点989cad2c；无覆盖用户源码修改。规划进入实现前再次核对相关提交。
- 只保存聚合、有限诊断和Sentry定位引用，不保存业务行、用户ID、initData、token、正文或真实媒体URL。
