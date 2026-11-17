# 11月14—15日卡住、页面/API失败原因分析与整改方案

分析窗口：**2026-11-14 00:00—2026-11-16 00:00，Asia/Shanghai**。UTC 为 `2026-11-13T16:00:00Z ≤ timestamp < 2026-11-15T16:00:00Z`。

本文承接[两天性能统计](./report-2026-11-14-15.md)和[统计聚合证据](./evidence-2026-11-14-15.json)，追加固定窗口的 Sentry 事件、启动阶段、API分段计时、Railway脱敏日志摘要及 Git 源码核对。新增证据见[分析证据](./analysis-evidence-2026-11-14-15.json)。**本轮交付分析和整改建议，没有实施产品代码、改生产配置或部署。**

## 1. 先给结论

主要问题有四组，整改应分别处理：

1. **卡住数量首先集中在文档冷启动。** 434次工程卡住中，267次为 document 冷启动，占61.52%；会话列表和大厅合计288次，占66.36%。两个同次启动样本确实在重定向/最终文档发起前消耗约4.8—5.1秒，其中一个样本脚本全部命中缓存。入口跳转、最终文档及脚本加载链应先于泛化的“所有组件再懒加载”处理。
2. **客户端排队是已测到的等待段，但各接口差异很大。** 成功尝试中角色详情queue P95 3.48秒、settings 3.46秒、增长读取2.95秒；会话列表0.88秒；混合了分组请求的“conversation_detail”组仅0.019秒。不能把所有慢请求归结为同一个排队问题，也不能将这些独立分段P95相加。
3. **存在真实后端依赖失败，也存在取消被记成异常。** 首token回报、身份查询、按角色列表、历史读取都有失败样本；但抽查聊天详情AbortError的栈明确来自 socket close 后的 `controller.abort()`。131条此类Sentry事件不等于131次SQL超时或131次HTTP500。
4. **有两个可以直接落地修复的代码适配缺口。** 新会话落地页的列表/分组请求没有显式首屏优先级；`/groups`还被指标分类器归为会话详情。创建角色页面也有未经能力检测的 `crypto.randomUUID()` 调用，与旧WebView实收异常相符。

目前不能为434次卡住逐条分摊“网络占多少、数据库占多少、渲染占多少”。抽查trace返回0个可用span，Sentry工具将inflight明细显示为`[Object]`，历史DB cause也有缺失。下面明确区分证据强度，避免把待验证解释写成事实。

### 证据等级

| 等级                           | 含义                                                | 本次例子                                                                |
| ------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------- |
| A：已确认机制                  | 固定窗口事件/阶段数据与实际上线代码对应             | 两次冷启动的重定向区段；onClose触发AbortError；浏览器randomUUID不可用   |
| B：已确认代码缺口/高相关贡献项 | 代码行为可验证，也有对应慢/失败信号，但未逐访问配对 | 分组首屏请求落到normal；增长排队挤占5秒预算；分组失败降级不覆盖普通500  |
| C：待验证深层原因              | 缺少同请求、服务端或数据库执行证据                  | 数据库锁/慢SQL/连接池耗尽、CDN误删旧chunk、具体Telegram跳转链中的慢节点 |

## 2. 434次卡住主要发生在哪里

这里的“卡住”指同一次页面访问在扣除已知后台时间后，**4秒仍未content ready**的事件；可随后成功，不等于永久打不开。不能与58次页面error相加计算失败率。

| 页面                      | document冷启动 | SPA导航 | mount |    合计 | 占全部卡住 |
| ------------------------- | -------------: | ------: | ----: | ------: | ---------: |
| 会话列表 `/chats`         |            138 |      13 |     2 |     153 |     35.25% |
| 角色大厅 `/characters`    |            124 |      11 |     0 |     135 |     31.11% |
| 聊天 `/chat/:id`          |              1 |      61 |     4 |      66 |     15.21% |
| 剧场列表 `/dramas`        |              1 |      21 |     0 |      22 |      5.07% |
| 个人中心 `/profile`       |              0 |      20 |     0 |      20 |      4.61% |
| 创作空间 `/creation`      |              0 |       9 |     0 |       9 |      2.07% |
| 创作数据 `/creation/data` |              0 |       8 |     0 |       8 |      1.84% |
| 短剧详情 `/dramas/:id`    |              0 |       6 |     0 |       6 |      1.38% |
| 放映 `/watch`             |              1 |       5 |     0 |       6 |      1.38% |
| 角色编辑                  |              0 |       3 |     0 |       3 |      0.69% |
| 创作者主页                |              0 |       3 |     0 |       3 |      0.69% |
| 创建角色                  |              1 |       1 |     0 |       2 |      0.46% |
| 邀请                      |              1 |       0 |     0 |       1 |      0.23% |
| **合计**                  |        **267** | **161** | **6** | **434** |   **100%** |

前三页共354次，占81.57%。其中仅Android的会话列表/大厅document卡住就有121+107=228次，占全部52.53%。这决定了首轮性能整改应集中入口与这三条用户路径。

需要保留三个区别：

- 会话列表的153次卡住以冷启动为主，不能用导航P95仅2.15秒说明其冷启动正常。
- 聊天66次以SPA导航为主，应该看进聊请求、路由准备、正文消费和首屏渲染。
- 个人中心20次均为Android SPA导航。其挂载P95约0.02秒、导航约3.75秒，说明只看挂载会漏掉前段等待；这两个独立P95不能相减定位耗时。

## 3. 哪个版本在运行，commit说明了什么

Railway窗口前11月13日21:21:55与窗口内14日11:14:44创建的部署都使用 `47414e2f`。本次重新按release聚合，Sentry窗口内229次error/fatal全部标记该commit。它能确认本次异常样本对应版本，不能证明所有访问都完整上报。

| 提交 / 时间（北京时间）                                                                                                                                       | 已核对内容                                             | 对本次分析的意义                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [7b59c371 / #741，11-11 17:52](https://github.com/linshu368/ST_miniapp/commit/7b59c371)                                                                       | 上线树已包含历史展示读取、有限重试及分阶段详情读取     | 不能把这些优化当成尚未实现而重复做一遍；需要查实际失败段与投影运行情况                       |
| [f0aa0826 / #771，11-12 13:50](https://github.com/linshu368/ST_miniapp/commit/f0aa0826)                                                                       | 上线树已包含请求槽、首屏分波、onDispatch和准备优化     | 并发帽/阶段计时已经存在，应补消费者适配，不能新建第二套调度器                                |
| [09258916，11-13 11:35](https://github.com/linshu368/ST_miniapp/commit/09258916)                                                                              | 有聊天记录用户从根入口落到/chats；新增按角色归拢和分组 | /chats由次级列表变成冷启动P0，但其新hooks未显式声明critical；旧指标分类器也没识别/groups     |
| [befc10b9，11-13 15:38](https://github.com/linshu368/ST_miniapp/commit/befc10b9)                                                                              | 新增增长弹窗资格读取/事件；5秒预算、background优先级   | 新请求在已繁忙的队列里容易耗掉预算；当前设计已经是不阻断页面、非无限重试                     |
| [47414e2f / #836，11-13 21:21](https://github.com/linshu368/ST_miniapp/commit/47414e2f)                                                                       | 问卷交互样式修正；是本次部署/异常release               | 不因它是最后一次commit就把全部聊天故障归因问卷改动；周末同commit重建也不构成代码修复         |
| [27a6d437 / #837](https://github.com/linshu368/ST_miniapp/commit/27a6d437)、[a18c7a22 / #838](https://github.com/linshu368/ST_miniapp/commit/a18c7a22)，11-16 | 集中日志、cause与链路接入                              | 在分析窗口之后，不能解释或反推周末已具备的日志覆盖；整改应先复核当前已部署能力，避免重复实现 |

**注意squash历史：** 源分支的 `58b7112d`、`f244a603`不是 `47414e2f` 的直接祖先，并不表示对应代码未上线。已通过上线树实际文件以及主干可达的 `7b59c371`、`f0aa0826`核验；性能源提交还可通过可达的`f7621d81`追溯。不能只用一次`merge-base --is-ancestor`下结论。

## 4. 原因拆解

### 4.1 冷启动：确认有重定向前段慢，未证明慢在最终API或Telegram初始化

冷启动大致经过以下链路；4秒看门狗覆盖的是整条内容就绪路径。

```mermaid
flowchart LR
    A[Telegram入口] --> B[入口跳转与最终文档请求]
    B --> C[HTML和脚本加载]
    C --> D[Providers与页面挂载]
    D --> E[首屏API与响应消费]
    E --> F[内容ready]
```

固定48小时Sentry启动分段（各列为独立P95，不能相加；N与Grafana冷启动不同）：

| 页面 / 平台         |   N | document_ttfb | next_script_fetch_union | before_providers | telegram_init |
| ------------------- | --: | ------------: | ----------------------: | ---------------: | ------------: |
| /chats Android      | 482 |         4.41s |                   1.17s |            5.43s |        0.014s |
| /chats iOS          |  84 |         2.94s |                   1.02s |            6.31s |        0.005s |
| /characters Android | 342 |         5.26s |                   4.50s |            8.79s |        0.017s |
| /characters iOS     |  86 |         3.65s |                   2.42s |            8.66s |        0.006s |

iOS均低样本。before_providers与HTML壳展示可能重叠，某些样本Providers晚于HTML壳ready，不能把它作为壳时长的可加分解。

更有价值的是**同一次启动里的成对数值**：

| 同次样本                                                                                                    | 重定向次数 | redirect区段 | 最终请求发出前document_pre_fetch | 最终文档request_wait | 脚本下载并集 / 缓存          |
| ----------------------------------------------------------------------------------------------------------- | ---------: | -----------: | -------------------------------: | -------------------: | ---------------------------- |
| [11-15 23:39:31](https://wangqiao.sentry.io/issues/ST-MINIAPP-48/?eventId=cebd2a2edd904d0eafb2262bc9f16fdb) |          1 |       5.055s |                           5.087s |               0.838s | 2.573s；27脚本，约363KB传输  |
| [11-15 23:33:07](https://wangqiao.sentry.io/issues/ST-MINIAPP-48/?eventId=5d55a92d26ad4e48b2c6218ca8de1bb2) |          1 |       4.841s |                           4.842s |               0.089s | 0.047s；28脚本全部零传输缓存 |

第二个样本即使脚本已缓存，仍在redirect区段等了约4.84秒。因此仅压缩JS或加骨架不能解决这一类等待；这两个样本也不支持“Telegram SDK同步初始化耗了5秒”的解释。

[上线next.config](https://github.com/linshu368/ST_miniapp/blob/47414e2f/packages/frontend/next.config.mjs#L49)确实按cookie将`/`以307导向`/chats`或`/characters`。但Navigation Timing没有给出重定向每一跳的来源与服务端耗时，**尚不能把5秒全部归给这条307处理器**，也不能区分入口域名跳转、Telegram WebView调度、边缘链路等更深原因。

整改方向：先核对真实入口是否直接使用最终HTTPS域名/正确路径，采集有限的入口类别、redirect次数与边缘耗时；保留Telegram启动参数安全处理及有/无历史用户落地规则。确认多余跳转后再删除。不要直接用rewrite替换redirect而破坏URL、路由ready和深链语义，也不要用提前上报ready来掩盖内容未就绪。

### 4.2 会话列表：新P0消费者没有完整接入既有优先级和失败降级

已确认的代码链：

1. [useConversationGroups](https://github.com/linshu368/ST_miniapp/blob/47414e2f/packages/frontend/src/lib/api/conversation-folders.ts#L114)发出`/api/v1/conversations/groups?limit=20&offset=0&summary=1`，只传signal，没有queuePriority。平铺首屏也只传signal。
2. [resolveRequestPriority](https://github.com/linshu368/ST_miniapp/blob/47414e2f/packages/frontend/src/lib/api/client.ts#L152)没有对应带query的列表/分组规则；该实际请求落到normal。
3. [并发帽](https://github.com/linshu368/ST_miniapp/blob/47414e2f/packages/frontend/src/lib/api/request-concurrency.ts#L33)共3槽，非critical通常只能用前2槽，为P0保留的最后1槽不会被normal分组首屏使用。
4. 页面必须等分组/列表data才content ready。后端分组列表、昵称、可选汇总用Promise.all；**可选汇总虽失败可降级，其变慢仍会延迟整个首屏返回**。
5. [分组不可用判断](https://github.com/linshu368/ST_miniapp/blob/47414e2f/packages/frontend/src/components/conversations/use-conversation-view.ts#L48)仅覆盖404/503。后台3秒RPC abort目前可能落为普通500，前端就不会启用现有平铺降级。

这是可以确认的适配缺口；它是否造成某条document卡住仍需配对。不要将153次卡住全部归给normal队列：其中138次是冷启动，前面的入口/脚本阶段同样重要。

最小整改：只把**当前可见首屏**的groups/flat读取显式设为critical，翻页、标签扩展、后台刷新保持适当优先级；不把全站GET升级，也不先调大3槽。将明确的分组依赖超时按稳定契约返回可恢复不可用状态，复用已有平铺降级；未知代码错误继续保留500。降级不改用户保存的“按角色”偏好，不清除已有列表、草稿或滚动位置。可选汇总优先用短预算失败退化，避免为此新建汇总服务或重复列表查询。

### 4.3 API排队、headers和body：已有分段数据支持分别治理

两天成功尝试的分段P95，单位毫秒；只列GET。queue在实际dispatch后才上报，所以**排队即过期的请求不在这张queue分布里**。

| API分类                         |  queue P95 / N | headers P95 / N |   body P95 / N |
| ------------------------------- | -------------: | --------------: | -------------: |
| character_detail                | 3484.76 / 7195 |  1598.81 / 7195 |  203.87 / 7195 |
| conversations                   |  883.39 / 3386 |  1536.38 / 3386 |   48.01 / 3387 |
| conversation_detail（含groups） |  19.31 / 19224 | 1419.24 / 19224 | 901.22 / 19224 |
| settings                        | 3463.77 / 3550 |  1536.38 / 3550 |   26.28 / 3550 |
| growth                          |  2953.20 / 922 |   1567.27 / 922 |    14.35 / 922 |
| dramas                          |    63.78 / 235 |   1849.90 / 235 |   943.50 / 235 |
| support                         |  5566.15 / 621 |   1476.56 / 621 |    20.09 / 621 |

不能把一行三个P95相加得总P95，也不能与服务端P95相减算网络耗时。body包括浏览器响应消费/解析等待，不能单凭它认定后端在流式慢传。

本次还确认一个**统计解释需要修正的地方**：[apiRouteGroup](https://github.com/linshu368/ST_miniapp/blob/47414e2f/packages/frontend/src/lib/perf/api-timing.ts#L26)先用通用`/conversations/单段`匹配，把固定路径`/groups`归为conversation_detail。因此原统计中“conversation_detail GET / 41次逻辑timeout”不能解释为纯聊天详情；按路径分开的Sentry聊天详情183次和groups成功计时更适合各自分析。修复分类时需标明release/分类版本，不能把新旧含义不同的分布直接比较。

增长读取[现有实现](https://github.com/linshu368/ST_miniapp/blob/47414e2f/packages/frontend/src/lib/api/growth-prompts.ts#L18)已有5秒预算、background、禁用自动重试，事件失败返回null。成功样本queue P95约2.95秒说明它在发出前就可能消耗大量预算；这支持“排队是重要贡献项”，**不能证明143次增长逻辑timeout全部未发出**。应新增有界`dispatched/failure_stage`结果、排队过期计数，复用同一时钟及已有onDispatch，不另建请求owner。

大厅同源请求由专用timedFetch调用，当前这组api_attempt分段没有可列出的lobby_characters数据；974次timedFetch timeout与252次逻辑timeout覆盖不同，差值不能解释为“漏了722次故障”。

### 4.4 聊天详情：预期取消的异常噪声与真实依赖失败混在一起

Railway固定48小时`Conversation detail failed`查询返回149条，未触及500条上限：

| 失败阶段 |  日志数 | 已知解释                                                              |
| -------- | ------: | --------------------------------------------------------------------- |
| page     |     133 | 其中131条DOMException；另有2条历史分页读取Error                       |
| owner    |      10 | ConversationRepositoryError，需按业务码区分不存在/无权限，不直接算500 |
| recover  |       4 | 包含AbortError的恢复读取失败，需要区分服务端deadline                  |
| identity |       1 | 身份读取失败                                                          |
| opening  |       1 | 开场白读取失败，具体语义仍需确认                                      |
| **合计** | **149** | **不是149次服务端500**                                                |

[固定窗口AbortError样本](https://wangqiao.sentry.io/issues/ST-MINIAPP-8T)的栈指向[onClose](https://github.com/linshu368/ST_miniapp/blob/47414e2f/packages/backend/src/routes/conversation-detail.ts#L53)：连接尚未正常结束时关闭，触发controller.abort；外层统一catch又记录失败并向上抛。**取消传播本身是正确的，错误分类缺少“连接已关闭”的结果语义。**

但是，连接为何关闭仍可能是用户离页、客户端到期或真实网络中断。应保留客户端超时/页面error指标，不可通过全局忽略AbortError来美化稳定性。只在确认`reply关闭 + 调用方signal取消`时记cancelled并停止写响应；DB自有deadline、仍打开连接上的依赖失败继续记warn/error并返回稳定错误。

实际依赖失败证据：

- [历史分页读取Error，8S](https://wangqiao.sentry.io/issues/ST-MINIAPP-8S)发生在readConversationPage。已有单次最多5秒、总体8秒、仅明确瞬时传输错误有限重试；不能再叠加一次泛化重试。
- [按角色列表失败，BR](https://wangqiao.sentry.io/issues/ST-MINIAPP-BR)来自listGroups的3秒RPC预算。
- [身份读取失败，AJ](https://wangqiao.sentry.io/issues/ST-MINIAPP-AJ)来自app_core用户查询的5秒预算，first-token和community都会经过这条依赖。共享identity inflight能让同用户多个调用同时受影响；不是每个接口各自独立故障。
- 11月15日23:30—23:40的96条error日志中，37条含AbortError，还包括后台任务错误；这些是日志条数，不能视为96个请求或用户。没有取得能证明锁等待、连接池耗尽或某条慢SQL的完整证据。

整改先补请求阶段、已知deadline来源与安全cause code，再基于同request耗时检查identity/owner/recover/opening/page。当前已有投影、精简字段、缓存和有限重试应复用；不得绕过ownership、恢复/计费状态，或在未验证数据库现状前再次创建/执行迁移。

### 4.5 首token回报：真实写入失败与端到端预算不对齐

Railway该路径13次500；Sentry有11次[观测RPC失败AD](https://wangqiao.sentry.io/issues/ST-MINIAPP-AD)，另有2次该路径上的身份读取失败。数量相容，但未逐request配对，不当作一一对应。

[客户端回报](https://github.com/linshu368/ST_miniapp/blob/47414e2f/packages/frontend/src/lib/api/first-token-reports.ts#L97)从排队前启动3秒AbortController；[服务端](https://github.com/linshu368/ST_miniapp/blob/47414e2f/packages/backend/src/routes/conversation-interactions.ts#L102)先取身份，再调用3秒report RPC。身份未命中时本身最多5秒，因此3秒并非该链路有保证的完成期限，队列也会消耗预算。

这个回报参与可恢复交付/结算事实，不能按普通非关键埋点直接丢弃、返回假recorded=true，或取消数据库确认。已有owner隔离、最多20条pending、24小时TTL、每条最多4次尝试和恢复入口，应保留。

方案：即时回报与恢复回报明确不同优先级，恢复保持低并发；统一评审客户端排队+identity+RPC的总预算，服务端操作使用剩余预算，未确认结果继续保留原receipt。依靠同request/revision的已有幂等机制收敛，不能重复扣费。对共享identity Promise只限制本调用等待，不因一个调用取消而全局abort其他等待者。

### 4.6 前端兼容和静态资源：有确定故障，精确调用/网络节点尚有缺口

- **randomUUID缺失：已确认。** [C8](https://wangqiao.sentry.io/issues/ST-MINIAPP-C8)两次事件来自Android 11 Telegram环境；创建角色页面[初始化draft](https://github.com/linshu368/ST_miniapp/blob/47414e2f/packages/frontend/src/components/creation/character-editor.tsx#L120)无能力检测直接调用crypto.randomUUID。该环境会抛错，draft不能正常初始化；由于对应minified帧缺源码映射，不能断言两条事件都精确来自这一行。
- **复用已有UUID兼容实现。** [createConversationRequestId](https://github.com/linshu368/ST_miniapp/blob/47414e2f/packages/frontend/src/lib/api/conversation-stream.ts#L162)已有合法UUID形状的回退。应把小型纯UUID逻辑放到现有lib中供真实消费者共享，避免把整个聊天stream模块导入编辑器。不要使用request-timing的`web-...`关联ID回退替代UUID，它不满足draft的UUID校验；幂等key必须在同一操作重试中保持稳定。该helper不是认证token生成器。
- **Worker加载失败：已确认4次，深因未定。** [34](https://wangqiao.sentry.io/issues/ST-MINIAPP-34)指向静态chunk importScripts失败，涉及/chats及/chat。没有证据证明一定是CDN清理旧版本、跨域策略或弱网中的哪一种。先确认同一部署chunk能否获取、响应类型/缓存一致性及真实WebView表现，保留既有渲染失败降级和用户草稿，禁止自动刷新导致输入丢失。
- **TelegramGameProxy35次、ResizeObserver27次**是实收异常，但不能据异常标题认定它们造成全部页面卡住。需要源码映射和相同访问证据，先分平台复现。

## 5. 相关页面/API整改矩阵

| 页面 / 现象                       | 相关API或阶段                         | 当前可以确认                                                                | 优先动作                                                            |
| --------------------------------- | ------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| /chats：153次stall、6次error      | 冷启动；groups/flat首屏；summary      | 冷启动占138次；P0请求normal；RPC失败有样本；500不触发既有平铺降级           | 入口链核验；仅首屏critical；明确可恢复分组错误及summary短预算       |
| /characters：135次stall、6次error | 入口、静态脚本、/api/lobby-characters | document占124次；大厅timedFetch timeout252次；缺少同源请求的完整attempt分段 | 优先入口/文档链；补专用请求分段，复用缓存与原推荐语义               |
| /chat：66次stall、30次error       | 详情/新建会话/消息/首token回报        | SPA占61次；有预期取消异常和真实DB依赖失败；Sentry详情timeout183次           | 保留ownership和恢复；区分取消与deadline；检查headers/body与首屏依赖 |
| /profile：20次stall               | Android导航、路由准备、钱包/次级查询  | 均为Android SPA；挂载快不能说明导航快                                       | 复用安静窗口、已有route预热；不要把所有profile数据都设为P0          |
| /dramas：22次stall、6次error      | 目录headers/body、路由与播放器        | SPA占21次；目录成功阶段headers约1.85s、body约0.94s                          | 分开目录ready与播放首帧，真实同次证据后再减载                       |
| /creation/data：8次stall          | /api/creator/analytics                | 低样本导航8.88s；服务端约5s长尾，不能只归到前端                             | 按overview/排序分段，先查既有查询与索引，不另建报表服务             |
| 角色编辑/创建：3/2次stall         | 资料读取、draft初始化                 | 编辑低样本8.19s；创建存在UUID兼容缺口                                       | 先修UUID；保留草稿，读取错误可重试                                  |
| 增长提示                          | /growth/prompts、/events              | background、5s；成功queue约2.95s；逻辑growth timeout143次                   | 不抢P0、不扩张重试；先区分排队过期与已发出超时                      |
| 角色润色                          | POST /api/creator/polish              | 服务端P95约99.79s / 估计N168                                                | 独立长业务预算/取消恢复，不套普通页面2秒硬限                        |

4xx还需按业务解释：401为鉴权失败、402为余额不足、409为状态冲突、429为限流，不能统一“修成成功”。265次404中角色详情243次需核对不可见/删除语义；542次499需保留为连接提前结束。本窗口没有OPTIONS 403/500证据，不把CORS作为本轮首要根因。

## 6. 建议执行顺序与最小方案

以下是**待实施方案**，不是已交付修复。每个批次可独立提交/回滚，避免一次合并入口、计费、数据库及所有UI。

| 批次 | 优先级 / 负责人        | 修改范围                                              | 验收重点                                                           | 恢复方式                                         |
| ---- | ---------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| A    | P0，Frontend           | UUID能力回退及调用方复用；保留draft/幂等key           | 关闭randomUUID仍能创建/恢复草稿；重复操作不新增重复业务写          | 回退该应用批次，保留用户草稿                     |
| B    | P0，Backend + Frontend | 预期断连分类；真实deadline保持失败；补缺失cause/phase | 用户离页不误写响应、不触发系统error风暴；真实DB超时仍可查          | 回退分类，不改变业务持久化                       |
| C    | P0，Backend/计费负责人 | 首token回报全链预算及既有receipt恢复                  | 断网、响应丢失、重复回报、并发恢复不重复扣费；未知结果不假确认     | 保留pending receipt和既有终账，必要时forward-fix |
| D    | P1，Frontend           | /chats当前首屏critical；group分类；排队过期可观测     | 最后一个保留槽确实可供首屏使用；其他后台请求不饥饿；旧统计不混口径 | 只回退该优先级/观测批次                          |
| E    | P1，Frontend + Backend | 分组已知超时降级；可选summary短预算                   | 503/404降平铺，未知500仍报错；不串用户/分组，不改持久偏好          | 保留数据库与用户分组，仅回退应用                 |
| F    | P1，入口/Frontend      | 核验并减少多余跳转、最终HTML/脚本链等待               | 真实Telegram有/无cookie、支付回跳、深链及参数清理均正确            | 恢复原307与入口配置，不清用户状态                |
| G    | P1，Frontend + Backend | 关键GET总预算与阶段证据、详情依赖治理                 | 排队/退避/正文同一总截止；只安全读有限重试；取消不重发             | 旧调用默认行为兼容，按调用点回退                 |
| H    | P2，Frontend/相关业务  | 增长后台资格、目录消费、创作分析、Worker失败恢复      | 不扩大关键路径；长业务与页面指标分开                               | 每个功能独立回退，先应用后考虑数据调整           |

### 各批次共同约束

- **复用：** apiClient/timedFetch、request-concurrency、onAttempt/onDispatch、entry-phase、navigation-quiet-window、现有React Query hooks、分组平铺降级、first-token receipt恢复、Pino/observability。不得新建通用调度平台、第二套请求client、Redis/队列/日志存储或额外常驻轮询。
- **超时：** timeout覆盖排队、headers、body与解析；GET每次重试不能重新获得整份交互预算。保留现有timeoutMs的已发布语义，若确需区分单次/整体，只在现有内部请求选项增加一个可选totalTimeoutMs，旧调用默认不变。
- **候选预算：** 普通关键读可评审“客户端整体8秒、后端整体不超过6秒、每个DB调用不超过剩余预算且上限5秒”的安排；这是待实测/评审参数，不是已达成SLA。目标P95仍按下面表，不把2秒目标粗暴变成所有接口2秒强杀。首token回报单独按结算事实链设计。
- **重试：** 只对确认可重放的读/既有幂等回报做有限退避；SQL超时、未知500和关键写不能自动重放。队列过期且未dispatch必须明确记录，不能伪装供应商/DB超时。
- **并发与事务：** 不改会话锁、admission、账务原子RPC、同请求/revision幂等规则；取消本调用不得终止其他调用共享的identity inflight。副作用未知先查结果/保留pending。
- **降级：** 已有安全缓存和同用户旧列表可展示；失败不能伪装业务ready，不以最新回复替代历史版本，不在权限/资金事实缺失时返回成功。
- **容量：** 先修优先级与取消传播，不先提高全局并发帽；后台资格/恢复有界，不增加大列表全量读取或逐行查库。
- **数据库：** 先用既有诊断确认投影覆盖、慢段与真实执行证据；目前没有批准新增表/函数/migration。若后续确需迁移，单文件TEST验证、权限/RLS/锁评估和独立生产发布门禁仍适用。

## 7. 性能、失败率及日志验收

### 7.1 固定本次窗口作为基线

页面使用Grafana成功前台分布，API使用Sentry成功timedFetch分布；不混合两个来源。目标为建议，充分样本且同来源/平台/导航类型比较后才可宣布改善。

| 页面 / 指标               | Android基线 秒 / N | iOS基线 秒 / N | 建议目标                                  |
| ------------------------- | -----------------: | -------------: | ----------------------------------------- |
| /chats 文档到content      |         8.28 / 436 |      6.15 / 81 | 第一阶段≤4s，后续向≤2s；iOS先扩样         |
| /characters 文档到content |         7.96 / 293 |      7.10 / 77 | 第一阶段≤4s，后续向≤2s；iOS先扩样         |
| /chat/:id 导航            |         4.57 / 781 |     3.51 / 128 | 两端≤2s，同时页面error/取消恢复不退化     |
| /chats 导航               |         2.15 / 427 |      1.83 / 65 | ≤2s且已较快分组不退化；iOS低样本          |
| /profile 导航             |         3.75 / 424 |      0.73 / 68 | Android≤2s；iOS保持不退化并扩样           |
| /dramas 导航              |         3.42 / 355 |      2.47 / 81 | ≤2s，目录与播放首帧分开                   |
| /creation/data 导航       |          8.88 / 20 |       2.24 / 1 | 暂作线索；普通读取目标≤2s，先积累足够样本 |

新增双端API基线（同固定48小时，Sentry outcome=ok）：

| API                          | Android P95秒 / N | iOS P95秒 / N | 建议目标                                  |
| ---------------------------- | ----------------: | ------------: | ----------------------------------------- |
| /api/lobby-characters        |      3.154 / 1398 |   5.888 / 270 | 两端≤2s；超时与取消同时复核               |
| /api/v1/conversations/:id    |     2.003 / 15805 |  2.059 / 2141 | ≤2s，不以裁剪必要消息/错误吞没换速度      |
| /api/v1/conversations/groups |      3.206 / 1360 |   3.180 / 189 | ≤2s，分组服务暂不可用时平铺可恢复         |
| /api/v1/conversations        |      1.994 / 3736 |   2.012 / 482 | ≤2s且不退化                               |
| /api/creator/analytics       |        5.956 / 34 |     0.801 / 1 | 低样本；Android向≤2s，iOS扩样并保持不退化 |

身份查询、DB锁/连接池与同次导航阶段当前没有可靠的双端P95，保持未测，不补0。表里的API不是生成完整耗时，也不包含失败样本的等待分布。

发布前后至少各24小时、相同release边界/平台/来源；低流量延长48—72小时，主要分组至少100个成功样本，error、page_left、取消、缺报和资源压力同时核对。不能因为把/groups移出detail分类就宣布聊天变快。

建议停止条件：资金/幂等/权限/草稿丢失问题立即停；充分同口径样本中P95比基线恶化超过5%，或真实业务失败增加时停止扩展并复核。阈值需在实施任务评审中最终确定；不能用告警条数下降代替真实错误减少。

### 7.2 日志与观测方案

| 接缝            | 复用/补充                                  | 允许字段与失败路径                                                                                       |
| --------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| 浏览器请求      | 现有onAttempt/onDispatch和Faro/Sentry计时  | route模板、平台、尝试序号、priority、dispatched、queue/headers/body、有限failure_stage；排队过期也有结果 |
| 页面            | 现有visit/started/terminal/stall           | 导航类型、visibility、cache、失败阶段；不更改4秒看门狗起点，不让骨架冒充content ready                    |
| Backend HTTP/DB | 先核对11-16已有observability覆盖，再补缺项 | request/trace、允许的phase、deadline来源、结果/耗时、受控error code；原错误以{ err }安全投影             |
| 首token回报     | 现有receipt/handler/RPC及终态事件          | 幂等事实、记录成功/拒绝/未知、有限重试及恢复结果；不输出正文或完整receipt                                |
| 入口/静态资源   | 现有startup阶段和资源诊断                  | redirect_count、允许的入口类别、各阶段数值、资源失败类型；不记录完整URL/query/initData                   |

不新增用户ID到Sentry/Faro指标标签，不输出token、完整initData、支付/聊天正文、私有Storage路径。链路关联只复用受控request/trace；高基数关联ID不作为指标label。新增分类要让producer、白名单、查询和consumer一起变更；计时边界改变时版本化，旧数据不重写。现有告警默认关闭策略保持，只有明确新增规则才评审开启；真实依赖error与预期cancel分级，不通过关闭全部error压告警。

### 7.3 验证与本地重复验收

实施后按改动范围运行既有测试；优先补用例到既有文件，不为每个小改新增脚本。安全、计费和契约路径需要回归锁定，具体用例由实施规划确认。

```bash
pnpm --filter @miniapp/frontend run test src/lib/api/client.priority.test.ts src/lib/api/client.retry.test.ts src/lib/api/request-concurrency.test.ts src/lib/api/conversations-entry.test.ts src/lib/api/first-token-reports.test.ts
pnpm --filter @miniapp/backend run test src/infrastructure/repositories/conversation-page-retry.test.ts src/platform/observability/http.test.ts
pnpm --filter @miniapp/shared test
pnpm -r typecheck
pnpm lint:complexity
pnpm lint:backend-logging
pnpm --filter @miniapp/frontend build

pnpm test:ui --grep '@chats|@chat|@roleplay|@profile|@creator|@drama'
```

上述是**未来实施后的验证命令，本轮未运行**。至少覆盖：

- 冷启动有/无landing cookie、直接深链、支付回跳、参数清理、脚本已缓存/未缓存及弱网；验证真实内容ready而非只看骨架。
- 两个normal槽已占满时groups首屏能使用保留槽；后台最终仍有进展；队列超时、退避、body挂起及离页取消不再dispatch。
- groups 404/503、明确依赖deadline、未知500、summary失败和已有缓存；不串分组、不改本机偏好。
- 隐去crypto.randomUUID后创建/恢复角色草稿，编辑/上传/评论等实际UUID消费者；幂等请求重试使用同一key。
- 首token回报响应丢失、重复提交、跨页/恢复、身份慢、RPC慢与多个等待者；钱包结算、退款和回报未知状态不被错误覆盖。
- 取消连接只终结本调用；真正后端deadline仍返回稳定错误且可追踪；旧WebView无需原生AbortSignal.timeout/any也能走已兼容的浏览器期限逻辑。
- Worker加载失败时保留输入与原回复降级，手动恢复不重复提交；Sentry源码映射与实际部署文件对应。
- 真机Android/iOS、Telegram往返切页、系统键盘、真实媒体、支付和供应商另验。fixture只能复现状态，不能证明线上P95、数据库或账务结果。

建议直接将这些失败恢复场景纳入已有`packages/ui-tests`的`@chats/@chat/@creator`等分组；不搭一次性mock后端。当前原有场景覆盖列表、分组、聊天与返回，但不能覆盖真实重定向链、CDN/Worker、系统WebView兼容、生产DB及真实扣费。

## 8. 尚缺的证据与下一步取证顺序

1. **入口每一跳：** 用允许的入口别名/路由模板和边缘请求时序确认5秒发生在哪一跳；不能保存Telegram原始启动URL。已知两次redirect慢，不等于已找到某台服务器的处理慢因。
2. **关键请求未发出还是发出后超时：**补全dispatch状态，尤其大厅专用请求和排队过期；当前queue分布只含已发出成功尝试。
3. **后端深层依赖：** 在当前日志版本上按request定位identity/owner/recover/opening/page、RPC状态及安全cause。已有旧trace0 span，不得补造SQL/锁/池结论；数据库结构/迁移另按环境权限规则核验。
4. **前端源码映射：** 当前C8/Worker的部分帧无法还原，先让发布产物、debug ID、release与source map匹配，再精确归责某行。
5. **阶段互相配对：** 现有Sentry inflight摘要显示[Object]；需要有界可见的阶段摘要，而不是导出原始请求/用户数据。保持同一访问/请求时钟，避免独立P95算术归因。

本轮验证范围是固定窗口、计数、提交可达性与上线源码、证据等级、方案约束和Markdown。没有修改原统计报告，也没有实施上述整改。更完整的错误分类与阶段日志能降低下一轮定位成本，但上线后仍需用真实失败率和双端P95检验，而不是仅看告警数量。
