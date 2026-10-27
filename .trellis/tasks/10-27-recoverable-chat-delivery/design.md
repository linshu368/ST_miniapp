# 设计

## 调研与复用
复用 FirstTokenObservation、useConversationTurn、SSE客户端、useConversationQuery 1.5秒有界活动轮询、ChatHistoryRepository 与同一 chargeId 结算。复用 first-token-fallback 实际POST时钟、已有110秒生命周期。当前代码/生产相同；部分旧spec写“6秒仅观察”与代码10秒主动终止冲突，以当前实现与本需求为准并更新。

## 状态边界
1. 服务端控制生成截止与主动停止；浏览器可见测量只报告，不反向杀生成。收到首 token 即停止网络等待截止，但继续测真实显示；后台或离页标记不可观测。迟到显示保留实际耗时，不能被供应商时延替代。
2. 首token选择立即通知会话编排停止首字定时器并开始传输；兜底意图/选择写入按身份顺序执行，与传输并行，最终结算前必须确认。失败不旁路计费，不重新调用模型。
3. experience.chat_history 新增有界 first_token_preview：仅首次有效正文/公开思考检查点；experience.chat_generation_requests 增加 recoverable_delivery 策略位(旧false、新backend显式true)和server_first_token_ready_ms。新增 experience.record_chat_delivery_preview 由service_role写，history-first锁顺序、同revision/终态CAS；不在analytics保存正文。
4. 活动生成的正文/思考在进程内有界快照，仅复用会话详情查询返回，认证与会话所有权先行；同进程返回能继续看到增量，跨实例/重启使用一次首字检查点和最终持久化回复。无新公共API、无新轮询任务、无逐token数据库写。
5. 计费仍要求原冻结报价、自然完成有效正文或明确手动停止。新策略不以page_left/background/missing免单：后台完成可取回按正常规则结算。真正系统超时/前台无接收且超过总限报告免单；已经收到但视口不见不免单。旧策略及历史终账不变。旧客户端first_token_timeout在新策略不能取消任务；真实deadline由服务端负责。
6. 新测量v3独立于旧v1/v2；显示后可更新此前不可观测/超时报告，保留是否跨后台，deadline超限由真实时长识别；不会覆盖用户主动停止或已终结账单。Grafana轻查询兼容v3，继续分别显示覆盖率和实际可观测业务等待。

## 可靠性/简洁
首token检查点最多一次、终态仍现有落库；快照有容量/长度/生命周期上限，不使用Redis或队列。SQL写入有5秒锁与30秒语句预算；请求内调用5秒且不自动重发模型。详情查询原权限不变，跨用户/会话/revision隔离。最终落库/身份失败不收费，现有恢复兜底。内存不是持久真相，跨实例只承诺持久检查点与最终结果。

## 发布
先本地真实PG与跨层场景，再单一additive migration TEST、dev部署/TEST真实流验收、生产migration、main后端/前端/Grafana。旧backend不会启用新策略。旧frontend取消新轮被保护。回滚保留新增对象/历史账单，回退应用不追扣；DB错误forward-fix。无回填、全表扫描、新cron/索引。1%需上线后同口径观察，测试不能宣称达到。
