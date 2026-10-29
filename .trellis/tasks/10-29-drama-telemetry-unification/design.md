# 设计

## 复用调研与差异证据

基线0ca35182是最新origin/dev 37ad8663的后继，包含已上线但未合回dev的播放质量提交。主工作区main 88cd811b有无关dirty，独立worktree保护它。
已检索DramaPlayer、drama-home、api/drama query hooks、drama-timing、drama-media/resources/observer、grafana、shared DramaTimingReportSchema/dramaTimingLogFields、telemetry路由、timing-repository/processor、record_drama_playback_observation及drama_playback_facts、两张源JSON及runbook。
复用上述owner；扩展shared中现有API文件，不新建通用框架。历史SQL只服务legacy历史，禁止修改。Pino详细报告维持32KiB/12queries/4attempts/32events/16resources边界，避免将ID作为Faro维度。

## 主路径与工作量

约4步，15–22个现有实现/测试/配置/说明文件：

1. shared集中有效阶段及definition/route/diagnostic-purpose兼容字段；tracker绑定路由/起点，保持旧marks/时钟。
2. observer投影到统一Faro，补低基数诊断摘要、统一release、增加明确legacy/unified切换；统一模式按5%快成功和100%慢/失败保留Pino详细诊断，Backend对diagnostic-purpose永不enqueue数据库。
3. 工程源JSON扩展分层、新定义过滤/分段与能力面板；旧板只加历史入口说明，SQL保留。
4. 扩展既有测试、全消费者检查/build、更新README/架构/spec/runbook及迁移核对清单。

## 可靠性与最小充分

超时/重试：复用Faro3s单次、专用上传5s无重试，资源尾观察5s/60s上限；无新外部调用。
幂等/并发：沿用一次启动终态与网络最多一次补报；slow/network不重复startup。旧DB RPC保留原子合并；diagnostic-purpose绕过DB，无新事务/补偿。快成功按观察ID确定性采样，slow/final/network决策一致；不新增ID持久集合。
降级：开关默认legacy，Faro配置关闭/非法则保持legacy；Faro失败不改变播放，不做无限重发或自动数据库回写。
容量/限流：保留旧限流；新Faro字段有限枚举、duration有现有上限；详细日志采样只影响排障覆盖，工程统计不采样。
观测：全量started/terminal与诊断能力分开；不把窗口计数声称配对覆盖率。network的final快照和tail分别标phase，不能合计成观察数。
拒绝：新采集器、DB/cron、自动阈值、全链路追踪、逐帧采集、为未来抽象通用接口。

## 演进、切换、恢复

Backend兼容字段先发布，再Frontend默认legacy；新定义drama_v3只用于工程统计，report.version=2继续表达兼容报告结构。旧数据不回填。
TEST/Cloud核对同一尝试的起止/单位/新阶段/能力/详细日志，以及现有播放窗口；再取得生产启用授权切unified。当前交付只实现门禁，不修改线上开关。随后独立核实旧消费者与旧客户端，关闭DRAMA_TIMING_PERSIST_ENABLED；旧表/历史SQL/清理任务先保留。日志诊断不能声称SQL已等价替代。
回滚Frontend构建模式legacy并复用同一release来源；Backend保持兼容；无数据回滚。停止条件：口径偏移、字段泄露、diag缺失、重复终态、上传争用播放或缺报。
