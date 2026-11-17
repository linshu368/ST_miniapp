# 设计与复用审查

## 已证实问题

旧received清除10秒定时器，但displayed等视口且允许timeout/page_left改回observed。58条>10秒样本中45条收到<6.5秒、13条晚收到且曾超时。三条重复计费15分钟各失败30次；4条PK只读核对均已settled、timeout、dedup.failed/0、明细已裁剪、钱包存在。收费函数吞23505后只查被裁剪明细返回空；failed未进入退避。

## 最小方案

1. 复用FirstTokenObservation和use-conversation-turn。新client_committed_v4由hook内React提交阶段确认本request/revision已有可展示文本；received只记诊断。删除视口观察器与hook→page→list→bubble/thinking传递。绝对elapsed>=deadline判超时；首份终态不可改写。
2. 复用既有ReportFirstTokenRequest与报告RPC；兼容扩展method。保留first_token_visible_ms作为版本化存储载体，不新建统计表，界面名称明确客户端首字交付。send/regenerate预先声明v4，begin同一次INSERT写入measurement_method以保留缺报分母。RPCv4首份结果锁定，重复无UPDATE；v4截止按提交时间，收到早但提交晚仍记client_delivery_failed。老协议兼容。
3. 计费不等待屏幕/阅读；使用一次客户端交付结果和已持久化业务终态。不删除超时免费/用户停止报价/缺报保守处理。沿用既有结算与免费预留事务，禁止新增逐次轮询。没有回执不能用供应商latency代替交付成功。
4. 元数据补录携带llm_billing_settled_at，已settled不重复reconcile/金额回写，缺失marker仍修复quota和主表。failed纳入既有有界退避，状态变化立即可恢复。
5. 账务函数先处理已完成明细/永久dedup的幂等结果，再进入尚未完成的交付资格。已归档结果用显式union，绝不伪造完整charge或把null当未扣重扣。未识别的唯一冲突保持明确失败。
6. Grafana默认v4；只用前台已知结果算截止率，成功分布<10秒；离页/缺报单列，旧屏幕观测独立。

## 边界与可靠性

现有4秒首发/2秒兜底/10秒全局配置不延长。离页只中止本地流，生成/持久化继续；迟到回复保留但不更改已超时指标。React提交不是像素确认，名称不谎称实际阅读。身份匹配、ownership、冻结原价、免费权益、并发/幂等由现有事务/RPC负责。只新增迁移文件，保留旧schema字段与ACL；所有新查询按既有索引/最多50条，单次5秒。迁移lock_timeout5秒、statement_timeout30秒，无历史回填/全表UPDATE/新cron。异常有界退避，不靠扩大连接池。

## 数据域

experience拥有请求观测和报告RPC；billing拥有收费/永久去重；miniapp_analytics只读事实/报表。仅扩展既有函数/约束，不新建表。记录终态是权威业务数据，供现有frontend/backend/Grafana读取；历史保留不追溯改价。

## 拒绝方案

不再加入DOM位置/双rAF/浏览器像素确认，不因用户滚走判失败；不把收到网络bytes直接当界面交付；不新增队列、租约、统计轮询或持久化退避表。暂不调整模型阈值与AI调参。

## 发布/恢复

新迁移兼容旧客户端，先TEST迁移与应用场景，再生产迁移→Backend→Frontend/Grafana；先合dev再按生产现状发布。旧方法数据不重写、不混合v4。失败停止扩大发布，回退兼容旧客户端/看板筛选；不DROP对象或回滚账务数据。

## 同批结束与客户端承接

SSE最后一批文字与done/error可能在React提交前一起处理，不能清空已收到的文字，也不能先锁成无字失败。复用StreamingTurn保留已结束片段到同request/revision的服务端终态正文承接；新轮携带尚未承接的前轮片段，真正更高revision权威取代旧片段。仅内存合并和清理，不新增查询、定时器或cache写。切会话先退出旧观测再做新提交裁决。
