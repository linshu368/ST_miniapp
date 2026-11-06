# 最小实现与可靠性

复用FirstTokenObservation、reportConversationFirstToken/apiClient、现有report_chat_first_token、client_request_id索引、运营草稿发布、PG/PostgREST harness。新小模块只负责本地未确认回执，既有调用入口不变；不新建通用队列或统计服务。

本地终态只存身份/结果/时长，不含正文或凭证，按Telegram用户隔离；最多20条/24小时、每轮最多4个HTTP尝试（原即时三次+最多一次耗尽后的恢复），每次3秒覆盖排队与body。计数发送前保存；确认立即删；恢复串行且每次最多4条，前台/online事件触发，不用interval，storage失败仅内存降级。新即时结果不等待补发队列，补发background优先级。重复结果保持原payload，不以重进页面创造成功。

无消息身份只允许v4非observed报告，message/revision同时null。现有RPC先通过request_id索引最多取2条并校验user/session，恰好一条才定位、加锁更新；歧义返回false，不猜。已知身份沿原PK路径。首次终态后重复RPC不UPDATE；计费政策不变。通过EXPLAIN（不ANALYZE）核对生产计划及索引。数据查询仍仅现有Grafana视图，不新增监控查询。

producer-first：单文件迁移TEST验证→dev→生产迁移/Backend（兼容旧报告/SSE）→Frontend→只读核对用户已发布的生产版本97（6s/启用型号2s）→Grafana说明。新字段可选、旧报告保持接受；回滚应用保留SQL向后兼容。总限从点击计时，SSE冻结deadline用于旧目录缓存修正，不改首发/兜底竞争算法或传输工程。

风险测试：旧内核、排队/body超时、断网恢复/重载/事件风暴、用户隔离、TTL容量/计数上限、双回报/首终态不改、离页早于身份、未知请求/跨用户/歧义重放、6秒边界与迟到首帧、一次收费和超时免扣。浏览器强制退出且未产生终态仍可能缺报，不能虚构成功。
