# 最小设计与复用

## 研究证据

复用first-token-fallback.ts的流预读/replay、FirstTokenAttemptStore、GenerationObservationRepository、experience.chat_generation_attempts及原observe/select RPC。execute.ts已只有一条选中response→tap→settleOnce，不另建结算器。generate.ts仍有“兜底已启动则为首发额外抓供应商元数据”的旧逻辑，删除以减少额外I/O。

select_chat_generation_delivery已有锁和单delivery_attempt_id CAS，但阻止fallback_triggered后primary回赢；迁移只移除此限制，保留身份归属/业务状态/单赢家冲突。TEST/PROD函数hash与ACL经只读结构核验一致。Grafana角色现对attempts整表SELECT，增加诊断片段时必须改为明确旧指标列授权，诊断不入facts/view。

## 策略

首发实际dispatch后到配置阈值启动不同型号兜底，首发继续；前置过慢时沿现有fallback_timeout_ms预留预算提前启动兜底。两路共享原绝对总截止，取消fallback2秒硬终止。字段名/默认2000保留兼容，界面改称兜底预留时间。同型号不并发发第二个请求；明确失败可顺序重试一次。无三次请求。

一次内存赢家闩锁在有效正文/已开启公开思考出现时同步裁决，先查原始signal与绝对deadline，再锁定、立即abort并cancel败方、清首字timer。DB仍负责持久化单赢家CAS；primary胜不等待无关fallbackPrepared，fallback胜只依赖自己的意图。赢家数据继续走现有replay和单charge_id结算，用户离页不取消服务器，显式停止仍全停。

败方只捕获停止前已收到的有界展示文本/公开思考片段，合并到既有attempt终态观察写；不tee/drain，不为排查继续生成，不新建任务/队列。每attempt至多一份诊断终态，异步写有限超时且不阻塞获胜首字。只读指标角色不得读取新文本列；正常用户API与prompt无入口。按现有request/attempt生命周期保存，不新增清理cron。

## 不变量与故障

保持10秒业务首字上限、原价格/权益/quote/charge_id；真实客户端超时免扣不变。两attempt最多两条上游网络调用；双失败立即收口；慢DB不影响首字，但结算仍要求赢家身份持久。迟到headers、读取挂起、同步race、aborted stream均需已附异常处理且能清理，不留后台悬挂流。败方可能已产生少量输入/在途token成本，立即取消减少后续生成，不能承诺供应商零费用。

## 数据域/发布

experience拥有attempt排查事实；billing只消费单winner绑定。仅现有attempt添加有界诊断列、原RPC兼容替换及收窄Grafana列授权，不新增表/索引/扫描/回填。先本地PG与TEST迁移→dev应用→实际SSE计费→生产迁移→main应用/Admin→Grafana文案，先dev后生产。迁移5秒锁/30秒语句上限，失败停止、查账本、不盲目重跑；回退应用保留新列和账务事实，指标权限不扩大。

## 慢意图写入的最终核对

primary胜不等fallbackPrepared，意味着fallback意图可能在primary已选中甚至已完成后才到库。prepare RPC因此仅记录已发生的调用事实：固定请求冻结fallback型号，触发时刻必须在原总预算内且非负，最多一个fallback；同ID重放无UPDATE，异ID返回PT409。历史已结束/超时/取消不阻止合法迟到事实落表；此RPC不改变winner、业务终态或计费，也不触发上游、恢复任务或额外补费。由运行时signal/绝对deadline决定是否派发，不能再把此异步记录当作派发许可或让赢家等待它。CHECK采用NOT VALID，因为新nullable列的旧行均为NULL，新写仍受约束，避免持锁扫描旧数据。
