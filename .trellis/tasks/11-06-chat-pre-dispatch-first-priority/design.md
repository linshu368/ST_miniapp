# 设计

复用 fetchModelCatalogSnapshot、getOrCreateDbUser、requireSession 和原配置预算。目录与用户身份并行，身份成功后即启动一次归属检查，双方在同一准备截止内合流。晚到的身份不得在预算到期后再发起会话读取。仅调整既有读取的发起顺序，不移动写入或增加重试。

沿用 Fastify 的请求入口单调时间作为诊断起点，并为每次请求记录 route_setup、settings、turn_open、context、dispatch_gate。派发门禁完成时沿用成功分段指标与慢日志。提前结束时记录一次 generation.pre_dispatch，含 outcome=incomplete、stage、elapsed_ms、total_ms；继续使用 Alloy 现有白名单，身份与内容不进事件。SSE server_elapsed_ms 也使用该诊断起点。预算计算继续走原业务时钟。

开轮、陈旧恢复、额度、快照、取消及结算继续使用现有事务/CAS 和收口。请求级状态体积固定，终态单次记录；采集失败与业务隔离。无迁移，后端单独回滚即可，旧面板仍按版本比较。线上池等待或错误抬升时回滚并核对。
