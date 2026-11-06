# 最小设计（按用户最新指示修订）

复用既有 POST /api/telemetry/drama-timing 的 strict shared schema、Telegram鉴权与限流；仅终态达到五秒的完整诊断及其迟到network报告，通过既有OTLP日志队列进入Cloud Loki。无需新数据库、迁移、采集服务或浏览器凭证；不新增五秒定时快照。已有十秒legacy报告不应重复计入启动结果。

日志正文保存受控JSON，观察ID只用于日志查询，不作为指标label；日志仍受body大小、队列、超时与原采集条目上限约束。无离线保证；limited/no_entry/unsupported如实显示。关闭原短剧分析写入但不删历史表/权限/数据；不影响经营、计费或首字回执。

必须先读取已上线73be9210中的导出器限额和对应spec，确认最小接入点；不复制采集器、不并入整套工程监控代码。当前origin/dev缺少该出口，用户已明确批准以73be921作为本次基线。发布/配置改动单独门禁。

## 可靠性与验收

日志正文复用strict v2白名单并在出口再次校验；每条上限32KiB报告，256项既有队列、2秒出口预算、既有丢弃/失败计数。观察ID和数组仅放正文，不进入指标或stream label；不改Alloy配置/身份。接收202仅代表已接收，Cloud失败/关闭/重启/页面强退可能丢失，不承诺durable。已收到的final和network以同一ID关联，network不生成第二次成功启动；不新增重试/本地持久队列。无新事务、幂等写或并发状态源，Loki事件不可变，查询按phase区分。删除路由的DB队列构造与enqueue，即使旧flag仍true也不写入；旧repository/导入器/历史表不清理。

回滚应用版本会恢复旧DB路径，因此恢复前需将DRAMA_TIMING_PERSIST_ENABLED=false（配置变更独立授权）；无需数据恢复。发布先Backend，再仅更新原工程短剧看板新增两面板；现有浏览器无需升级。验证扩展原OTLP HTTP receiver测试（真实JSON线缆格式）、原鉴权路由测试、全仓typecheck和相关build；真机/Cloud真实到达待发布后用自然样本验收。
