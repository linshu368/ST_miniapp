# 设计、复用与可靠性审查

## 来源与实施授权

基于用户指定设计及明确的本地实施授权。当前HEAD fde375a5已含上轮rewrite等改动，避免重复实现。Sentry wangqiao/st-miniapp只读检索fde375a5未返回release；这不证明未部署，但不能证明24h观测门禁已通过。因此本轮仅准备可独立审查/回滚的A/B/C候选，不发布，不实施依赖真实数据的D预热/E边缘头。用户另行明确允许适度客户端缓存、禁止启动本地UI验证。

## 复用调研与最小方案

- 复用 characters.ts 的characterKeys、已有v5/v4公开目录和public-head快照、CharacterSummarySchema、React Query。新增cache-only读取入口，不改storage schema，不发全表请求。损坏、非法时间和过期快照丢弃；storage拒绝仅使用内存。
- 会话lookup保留pending闸门；缓存可立即展示，无/部分缓存补缺详情等待entry enrich和导航安静窗，显式normal。会话行详情使用既有用户+session key，staleTime为60秒、默认5分钟gc；其他进房详情的默认30秒staleTime、优先级与刷新语义不变。
- 复用ChatFolderRepositoryError、sendChatFolderError及shared既有错误码，不新增公开契约。listGroups只对自身deadline、57014和PGRST003返回可恢复不可用，未知错误保持500；不改变写入错误映射。
- readFolderSummary复用原入口，同时覆盖groups和flat；独立250ms截止，Promise race保证消费者有界并AbortController取消SDK传输。即使下游不遵守signal也不等待；迟到完成/拒绝不替换已返回主体、不造成未处理拒绝。summary不额外重读列表。
- 复用已存在推荐hedge与失败保留旧batch。自动入口明确1500ms总deadline，400兼容请求共用同一controller；手动始终5000ms，不依据action=open误缩手动预算。POST无自动传输重试。
- 按复杂度要求拆出推荐transport与mutation hook，让被修改的useLobbyRecommendation低于120行。保留幂等request_id、旧响应检查和viewer隔离；不建立通用缓存/调度框架。

## 故障、并发与数据边界

不新增外部端点或并发；原3槽帽和排队/取消/重试机制保持。groups请求使用既有transportRetry:false避免503重试后才降级；其他GET原有限重试不变。缓存不提供鉴权或版本真相，历史版本卡不使用当前大厅摘要；detail key保留用户和session维度，会话行60s短期内存，不将列表摘要注入完整detail作为权威。

本轮无数据库对象/迁移、事务、写入补偿或计费变化；原推荐幂等写意图不改，手动重试仍复用request_id。依赖读取超时是已知失败，未知编程/权限错误不隐藏。日志复用Pino安全{err}和HTTP关联头，summary降级及groups unavailable有稳定事件与有限耗时/阶段，禁止记录正文、列表、initData或原URL。

## 发布、恢复与可验证性

各批次独立回退；无存储格式变化或数据迁移。先兼容Backend再Frontend；旧客户端能识别原503，旧Backend仍可能返回500，不能把它混为已支持降级。先满足上轮release/24h样本门禁，再逐批推广，停机条件为错页/身份/支付异常、错误升高或充足样本P95回退>10%且≥200ms。D/E继续等待数据。

本轮风险评估确认需要新增小型回归测试文件：当前没有ChatFolder RPC/summary路由测试、cache-only摘要与推荐transport deadline测试；分别锁定真实超时与未知错误、晚到回调、用户/会话缓存隔离和手动意图。优先扩展现有conversations-entry与shared测试，确有边界缺口才建文件。使用fake timers、真实QueryObserver/SSR hooks、Fastify inject及模拟SDK；不启动本地UI服务器或浏览器，不访问远端DB。

本地通过不等于真实Telegram性能通过；Android/iOS目标和既有生产基线在task.json，缺失阶段不补0。发布后≥24h、分route/platform/release成功N≥100，低iOS延长48–72h，并同时核对error/stall/left。

## 一手资料核对

- [Supabase abortSignal](https://supabase.com/docs/reference/javascript/using-modifiers-abortsignal)：取消信号传给现有RPC，不新增SDK或库升级。
- [PostgREST错误表](https://docs.postgrest.org/en/stable/references/errors.html)：连接池期限PGRST003；SQL57014只在本只读分组边界降级，不全局吞异常。
- 已核对[Supabase changelog](https://supabase.com/changelog.md)，未升级SDK/CLI、未涉及其中Auth/CLI迁移。Supabase技能的验证通过隔离模拟RPC完成；项目禁止业务行读取，不连接生产库。
