# 技术设计

## 复用与最小方案

- 复用PaymentReconciliation的两个trigger、现有claim与退避、gateway.queryOrder、PaymentSettlement幂等结算；不新增扫描服务或第二调度源。
- 两个自动任务共用的RECONCILE_WINDOW_MS从7天改为8小时，继续向原claim传入windowStart，不增加配置key或接口。领取时清理早于windowStart的任务；每单派发前再核验created_at年龄，避免领取后等队列跨过8小时还发请求。仅停止新派发，已开始并确认paid的结果仍允许结算。
- 复用billing.payment_reconcile_jobs作为唯一运行真相；总attempts保持原义。拟增unpaid_confirmations（0..3）与last_unpaid_claim_at（去重检查点）两个真实列，属于billing×J，同现有任务写入模块/时机/生命周期，不在payment_orders加调度列。
- 原地扩展claim_payment_reconcile_jobs，保持参数与SETOF payment_orders签名兼容，仅领取unpaid_confirmations<3。达到3的任务保留至8小时/结算清理，防止删除后被回填重新入队。超过8小时与三次有效未付是独立停止条件。
- 新增内部billing.record_payment_reconcile_unpaid(order_id, claimed_at) RPC，在行锁内核验本次last_attempt_at和last_unpaid_claim_at后递增一次并返回计数/是否停查。以已有批次now作为领取标识，不引入通用租约框架。
- 每次已确认unpaid、完成本轮原有过期判断后，调用权威RPC记录；该写入失败不宣称已停查，保留错误和下一次机会。已付仍原幂等结算，未知结果不计数。
- 不改公开API、CLI页面或配置，单文件/函数遵守500/120预算；长测试和migration按真实职责组织，不改历史migration。

## 数据落位与历史

已读CONTRACT及registry：billing.payment_reconcile_jobs active，性质J；ops.payment_events active，性质O且保留365天。新增计数及去重检查点只进入J，权威写入为上述记录RPC；读者为claim/对账repository，沿用同order_id级联关系，不新建跨域FK。

新增一个前向migration：新增任务列/约束，原地替换claim，创建具名RPC（固定search_path、撤销PUBLIC/anon/authenticated、只给service_role），登记registry owner/note与后台回填reads。RPC同时核验本次权威订单expires_at已到期，未到期的unpaid不递增。不新建表、JSON键或ops业务权威。

存量回填仅遍历仍在8小时内的现存对账任务，关联expires_at后至迁移截止的event_kind=fast_reconcile/expiry_reconcile、stage=query、source=gateway、outcome=unpaid事件，按event_key去重后封顶3。未到期或超过8小时不回填，不拿paid/failed/尝试次数填数；旧任务由新的领取窗口清理。回填是一次性迁移/后台聚合，不放到产品请求路径；预检匹配索引及容量，锁超时停止，不无界扫描或自动重跑未知提交。

本次修订依据见research.md：当前6个报错订单均超过8小时，且已有至少6次到期后的明确unpaid；任一规则都足以在生效后停止这批无效查单。8小时为用户明确的新要求，与到期后三次停查组合。

## 日志与告警

复用PaymentOperationEvents、observation.emit显式level能力以及每轮summary，保留所有基础stdout事件及trace/span/business_key。仅fast/expiry的query阶段外部provider_unavailable/network/timeout/rate_limited等经确认可恢复类别显式warn，仍outcome=failed、outcome_known=false；不输出原始上游msg、URL或密钥。

本轮统计增加准确未付/失败/停查数量及安全错误分类，选择现有summary为单一业务汇总，取消等价重复业务摘要，不删基础operation事件。已付未履约、金额/身份不一致、配置错误、DB/RPC/计数写失败继续error。停查记录一次payment.reconcile.unpaid_limit_reached（info，count=3）。补集中中文标签和实际JSON投影测试，不能只在logger传未允许的字段。

ops.payment_events仍逐次存真实结果，PaymentAlertMonitor继续按事实计算；不把降级日志当故障恢复、不关闭P0/P1规则。降噪不能掩盖当前6笔业务code500，它们不计未付次数，仅降低重复报错等级并给轮级摘要。

## 可靠性

- 超时/重试：保留5秒外呼、25秒派发、30秒轮间隔及现有有限退避；DB读取/结果RPC明确期限，写结果未知只能以同领取键恢复，不盲增计数。
- 幂等/并发：原claim的SKIP LOCKED；结果RPC按order_id行锁、领取时间CAS及去重检查点；第三次与回调结算交错只影响任务，绝不改变资金事实。
- 崩溃/部分成功：调用前已排下一次，崩溃后不会同轮热循环；DB计数提交但响应丢失，同键重放不多算；三次停查状态留在表内跨进程持久。
- 事务/补偿：调度计数与钱分离，资金仍原事务；历史回填与DDL一事务、有锁和语句预算。恢复旧7天策略需同时回退窗口常量、派发守卫及claim过滤；8小时窗口已移除的自动任务不会凭空恢复，需另行审阅有界重建任务行。保留新列/RPC兼容，不删订单或改钱包。
- 降级/容量/限流：日志/告警旁路失败不阻止支付；计数失败继续error、允许后续保守多查，不能假装已停。仅现有≤30单批次增加至多一笔结果RPC/有效未付，评估DB共享资源，保持并发上限。

## 发布与观测

隔离DB验证→TEST前向迁移→Backend/两个任务服务→实际日志与回调/主动查单回归；生产迁移通过仓库工作流单独审核执行，先DB后新应用。数据库新字段默认0、旧应用兼容但不会累计新计数；DB 层也用 greatest(p_window_start,p_now-8h) 限制旧调用方；三次计数依赖两个任务完整更新。切换前暂停/排空自动任务，避免回填与旧节点在途结果交错；两者更新并验证前不能宣称三次停查生效。生产写/部署不包含在当前规划操作中。

停止条件：计数重放、误停付费恢复、权限漂移、失败事实丢失或停止后任务仍被领取；停止发布并回滚claim或forward-fix。Android/iOS页面和HTTP入口不改，P95不适用，无样本不填零；验收保留共享DB容量、回调与主动查单路径。
