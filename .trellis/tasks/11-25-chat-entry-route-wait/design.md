# 设计与复用评估（已批准，实施收尾）

## 1. 复用检索

- 入口：conversation-row.tsx、conversation-group-row.tsx、character-gallery.tsx及chatEntryPath；复用现有真实Link/地址和来源，不发创建POST来预热。
- 路由：Next App Router的router.prefetch、已有骨架组件及loading边界；不引入路由缓存服务。背景预热复用canPrefetchInBackground、navigation-quiet-window与idle模式。
- 请求：conversationDetailQueryOptions/fetchConversationDetail/useChatSession、apiClient/timedFetch/request-concurrency；保留统一Query key、10秒逻辑GET和正常恢复，不做列表全量历史预取。
- 阶段：entry-phase为文档级且Android quiet-window只覆盖Android；聊天本页以session.ready再加一层放行，复用既有hook，不建立第二套全局业务状态。
- 角色：useCharacterQuery和现有公开摘要lookup；详情权限由后端保证。相同Query key原本可去重，不把多个订阅当作重复网络请求。
- 心跳：use-connection-warmth、warmApiConnection；保留原有限心跳，只调整开始时机，避免首屏/后台多余health。
- 渲染：ChatSplash、ChatMessageList、动态面板、消息动作和choice门禁；保持首屏消息内容。聊天page超过500行且函数超预算，改动时按职责拆出消息操作/附属面板/内容组合，不向长函数继续追加。
- Backend：conversation-detail.ts、detailDiagnostics、ConversationHistoryRepository.recoverStaleStreaming、ConversationHistoryReads及list_chat_message_page；本批保留现状和鉴权，不新增RPC/迁移。
- 观测：page-tracker、api-timing、grafana-schema、Sentry脱敏与Backend conversation.detail.\*；复用出口，不加采集请求、数据库或永久事件表。

## 2. 最小方案

### 2.1 目标聊天路由预热

新增一个聊天域专用预热helper/hook，输入仅来自现有已验证入口。来源列表就绪后空闲预热首个最近会话路由，最多一个候选；意图pointer/focus可温热所指目标。复用网络/可见性/导航保护，使用有界TTL去重和容量上限；仅缓存路由温热状态，不保存私有历史或身份。退到后台/切列表/离页时取消尚未发出的调度。
Next预取已派发后无法可靠撤销，因此预热量保持低；失败只失去预热收益，不挡点击、不增加告警/重试。
背景预热不触发私有详情GET。旧会话仍按原owner校验，新会话仍只有明确进入动作才创建。

### 2.2 页面加载显示与首屏资源

添加/chat/[characterId]的轻量loading边界，复用聊天框架视觉，不读取身份或接口。内容ready仍等待session.ready。
推迟重复返回页预取到内容稳定后，采用现有背景空闲/网络约束。角色完整资料读取默认normal并在当前会话就绪后自动放行；明确打开角色工具保留现有按需加载。若已有缓存/公开摘要可用，仅作展示，不冒充授权历史。
模型、设置、语音、状态等自动加载同时受当前聊天session.ready与既有enrich/background约束；显式用户面板操作保留绕过自动延后的路径。状态面板组件在就绪前不挂载/拉取非必要chunk。
连接保活延后到会话可用，切换会话重新关闭非必要阶段；不放大3槽并发帽。

### 2.3 请求等待与诊断

既有关键GET保持critical，显式信号贯穿10秒总预算。缓存内容可展示与刷新行为保持，避免为了几百毫秒缓存陈旧数据掩盖失败。
在既有page-tracker按同一次visit保存有限的导航到挂载、挂载到ready摘要；优先扩展现有安全观测，保留原总量和定义。API继续输出queue/headers/body/total，和Backend request/trace头配对。不存在的阶段不补零，独立P95不相减，不宣称能精确拆纯网络和CPU。

## 3. 可靠性

- 超时/重试：预热不等待导航、不重试；用户GET沿原截止与有限重试，POST不重放。
- 幂等/并发：预热TTL去重、仅少量目标、取消迟到调度；Query key与session隔离，创建缓存豁免/草稿/历史合并保持。
- 事务/补偿：本批不改变写入、事务、账务或恢复，无新增补偿；GET现有恢复不能当成纯读预取。
- 降级/容量：预热失败/不支持idle/离线/省流回到原点击加载；不抬并发、不增加后台循环。
- 可观测：预热是可选资源优化，不把失败记普通业务error。现有HTTP/详情错误保留；诊断投影失败不得影响业务。
- 隐私：无完整href/query、会话ID、用户身份、token、initData、消息正文或资源URL进入新增遥测/持久化。

## 4. 兼容、演进与恢复

本批以Frontend为主，无API/RPC/环境变量/数据库变更；Backend兼容。功能回退可撤前端提交，历史/用户数据不变。
部署需单独授权；稳定release后48h分平台比较。页面P95回退>10%且>200ms、失败/离页上升或历史/发送异常时停止扩发并回退。B窗29个版本混合只能作观察基线，不作单次发布因果证明。
拒绝：通用预加载框架、私有历史持久缓存、大聚合RPC、提高并发、延长超时、删除恢复、提前ready及无证据SQL改造。

## 5. 风险与验证

最敏感点为抽取聊天长组件、阶段关闭后的显式操作、已有数据刷新和新建会话缓存豁免；优先扩展现有测试。确需新增预热helper测试文件时，将预热不创建/不读取私有历史、隐藏/省流、去重、离页取消作为必要回归理由，不镜像实现。
后续建议将这些场景纳入packages/ui-tests的既有@chat/@navigation流程；本轮遵循不启动本地UI的既有约束，真机和线上P95保留为发布验收。

## 6. 实施中的缓存细化（用户补充方向）

角色列表行与聊天页共用已有 viewer/session detail key 与60秒 freshness，不新增持久缓存。useCachedLobbyCharacters(false)只订阅现有内存，不同步解析整份公开目录的localStorage快照；绑定角色版本的会话不用当前大厅摘要。私有历史原有内存展示、staleTime=0后台校验、新建缓存免重复GET和权限恢复保持，不能以延长私有历史TTL掩盖数据失效。
当前会话session.ready后两次绘制机会才放行自动enrich/background，切换会话或ready失效重新关门；全局文档阶段与Android安静窗继续生效。显式打开模型/偏好仍可即时读取。为遵守复杂度预算，聊天页、顶栏/偏好和观测出口按原职责机械拆小，原写入/失败恢复逻辑不改。
同visit分段仅在成功SPA聊天/列表访问时成对输出；未挂载、失败和离页不伪造ready阶段，沿用page.terminal/page.stall。可选路由预热按30秒去重、8目标保留、10秒最多3个新目标，后台候选只取一个；取消尚未派发的任务，Next已派发预取不能撤销。
