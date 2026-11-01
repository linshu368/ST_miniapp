# CDN A/B 遥测与看板设计

## 基线与范围

基于origin/dev `18f21ba6517e810ff577ae89ce5230935dc0ab16`；当前origin/main为`6e5068f350277d05b1eceaba229f762c09b38ca4`。主工作目录落后主线且存在无关修改，实施只在隔离工作树`codex/drama-cdn-grafana-ab`内进行。模块影响：`frontend.business.drama-experience`、`frontend.infrastructure.client-ui-foundation`。

现有线上UID `st-engineering-drama`有24个面板，含启动、卡顿、慢诊断和首张画面。只追加CDN区，不重写其他区或旧SQL看板。云端发布前重读最新版本并比对，保留期间他人改动。

## 复用调研与选择

- `packages/shared/src/api/drama.ts:DramaDeliverySchema`：复用experimentId/group/provider/reason；不新增HTTP契约或浏览器用户标识。
- `packages/frontend/src/lib/perf/drama-timing.ts:DramaPlaybackTiming.report/playbackState`：复用delivery绑定和原final/elapsedMs；不改计时owner、终态和重试状态机。
- `packages/frontend/src/lib/perf/drama-observer.ts:mirrorEngineeringTiming/mirrorDiagnostics`：扩展现有投影，给实际有delivery的启动终态/耗时/阶段和诊断加维度。start未得到delivery保持unknown，不事后伪造带组start。
- `packages/frontend/src/lib/perf/grafana.ts:safeAttributes/beforeSend`：沿用两次白名单重建，增加受限属性；不使用任意字符串透传或自动SDK身份meta。
- `packages/frontend/src/lib/perf/drama-media.ts:observeDramaMedia/flushQuality/rebufferAttributes`：复用每src的观察器与成对增量窗口；绑定本次源的delivery快照，避免旧源flush读取新源身份。
- `docs/grafana/st-engineering-drama.json`：追加实验变量和分区，复用现有LogQL的kind/event_data/context格式与合法窗口筛选。
- `ops/observability/local-test/faro-loki.mjs`、现有grafana/observer/media测试：扩展固定虚构样本和既有文件，不建立第二套mock/查询框架。
- `packages/backend/src/features/drama/delivery.ts`、`ops/drama-cdn-rollout.md`、`compare-drama-cdn.ts`：分桶权威与用户级核验继续由既有服务端实验日志承担，不复制HMAC到浏览器。
- 后端repository、数据库函数和SQL看板已检索：本方案不复用落表路径，不恢复`record_drama_playback_observation`或历史导入器，不创建数据库对象。

## 数据流与安全边界

现有/play响应delivery → 当前timing对象 → 原final投影/每src质量窗口 → 原Faro出口 → 原Cloud Loki → 现有UID新增CDN区。

拟增加安全属性：

- `cdn_experiment`：只接受DramaDeliverySchema允许的实验ID（64字符、固定字符集）；出口最多保留8个不同ID，其余归other。无值为unknown。不能接受URL、UUID身份或任意正文。
- `cdn_group`：bunny/supabase/unknown。
- `cdn_provider`：bunny/supabase/unknown。
- `cdn_reason`：assigned/disabled/unavailable/unknown。
- `cdn_budget`：within_5s/over_5s/not_started/unmeasured/background，仅启动final使用。

这些值作为受控日志属性，不新建Loki索引标签或Prometheus指标维度。实验专用去重码、observation/video/session/user ID、路径、签名与媒体地址不进Faro。已有后台诊断正文策略保持。

属性helper放在已有drama-observer或grafana文件，按实际引用选择最小局部导出，不建立通用实验层或新状态源。

## 指标定义

### 主指标与时间起点

沿用现有`drama.startup`的单次播放触发→首帧且playing，使用原始`report.elapsedMs`判定：playing且耗时有限非负、<=5000为within_5s；playing且>5000为over_5s；其他前台终态为not_started；无合法耗时/证据的playing为unmeasured。background单列。

主比例=within_5s/(within_5s+over_5s+not_started)，限定已归桶、已收到的新投影启动final，默认排除retry；分母0不出值。左滑/退出属于该尝试未开播，但不算供应商网络错误。unmeasured/后台/未知归属另有计数，不悄悄充当成功。分类与outcome同条terminal事件，不能拿一个measurement流的分子除另一个event流的分母。

该指标不是“用户从打开MiniApp起5秒内看到视频”，也不是包含重试间隔的累计等待。`entryElapsedMs`和`recovery.cumulativeMs`继续保留原诊断，不能与本次P95混用；独立起点在面板说明中明确。5秒是观察预算，不修改任何超时。

### 辅助与护栏

- 成功启动P50/P95和有效N：同一measure、outcome=playing、同实验和分层，keep有限分组字段后再unwrap；禁止平均不同桶/时间窗P95。
- 成功耗时分布：0–1、1–2、2–5、5–10、10秒以上，图上明确互斥边界且与5000ms达标边界一致，按各桶成功样本归一化；展示成功N，不能代替失败率。
- 结果构成：playing/error/unplayable/autoplay_blocked/left/switched/background分别统计，不能把自动播放拦截解释为CDN故障。
- 卡顿占比：同一批合法成对窗口Σrebuffer_ms/Σ(playing_ms+rebuffer_ms)，分组/过滤一致；不平均窗口比例，不把窗口数当人数。
- 节点归属：按cdn_group看实验效果；按cdn_provider和cdn_reason看原桶回退，disabled时原Bunny桶实际Supabase不得标Bunny节点成功。

## 看板结构与筛选

追加独立row「CDN A/B 对照」，约7个面板：口径说明；已归桶/未知归属终态与结果构成；5秒达标率与有效N；成功启动P50/P95趋势与N；成功耗时分布；卡顿占比及窗口N；原桶→实际节点/原因。

新增`cdn_experiment`筛选，默认本轮已观测实验ID（允许选择其他合法实验或unknown）；原始桶同时展示，不默认只选Bunny。可增加实际节点下钻筛选，但默认保留回退，不用实际节点过滤形成主结论。

环境/release/平台/网络/页面等共同维度沿用。入口/缓存/帧方式只用于确有对应字段的启动面板，不能假装过滤质量窗口；首张画面、目录和既有全站面板不受CDN筛选。未知归属面板独立展示：没有实验ID不能强绑定所选实验，须标为同时间/版本的新投影未知总体；不能据此精确计算该实验缺报。

历史日志没有新标签，不回填、不推断。新版可通过cdn_budget/显式unknown识别“新投影但未归桶”，历史无新投影标签不混进未知样本。

## 真实故障模型与可靠性

- 超时/重试：保持现有Faro3秒/单次发送、有界队列；不增加网络请求、定时器或重试。遥测异常继续no-op，不影响播放。
- 幂等/并发：复用一次final与每src窗口清零；不重复投新的终态，不把slow/network合入分母。旧源清尾用旧身份。
- 事务/补偿：不写业务或数据库，无事务/补偿需求；遥测丢失不能通过补值伪造恢复。
- 限流/容量：受原64信号队列、2KiB信号限制与原SDK批队列约束；白名单增加的维度有限，LogQL聚合前keep有限标签，不把数值/时间戳变成中间series维度。
- 降级：无delivery、SDK禁用/加载失败、平台不支持首帧/网络字段均保留unknown或unmeasured；不取媒体URL猜provider。
- 可观测性：沿用source_invalid/dropped/transport_failures与Collector健康，但不把累计快照相加为全站送达率。缺归属、缺时间及结果构成必须与主图并列。

## 最小充分与拒绝的扩展

预计3个产品源码文件（grafana/observer/media）、1份看板JSON、3个既有单测文件、1个本地合成验证文件及相关说明/spec，约10–13个文件；不改播放器组件或API合同。若为了unknown补组而需要改取址错误契约/用户身份或新增Backend汇总，这是范围变化，先回到用户拍板。

不新增分析库、独立实验SDK、复杂配对/去重缓存、前端HMAC、通用插件或全量请求日志。用户级SRM和显著性继续已有服务端离线核验，现看板只提供描述性已观测结果。

## 发布、停止与恢复

代码、TEST/真实浏览器、生产应用发布和Grafana发布分别留证。先本地/TEST验证实际Faro字段和查询，再准备现有UID增量更新；生产部署与云看板写入须另行审核具体版本/操作，不自动merge/push或改环境变量。

采集字段上线前的新图允许无数据，不把旧样本当实验基线。上线起点记录release和时间，旧新版分开。前端不需要新Backend接口，旧客户端缺字段仍正常播放。

如果出现敏感字段、遥测导致播放阻塞、丢弃/查询基数显著上升或原面板被改坏，停止发布；回退前端版本/增量看板变更即可。保留已收数据，不回滚分桶、删除旧日志或恢复SQL写入。

## 验收与人工场景

扩展既有grafana.test.ts、drama-observer.test.ts、drama-media.test.ts与本地Faro→固定Alloy→Loki脚本，不新建测试框架。虚构两桶、4999.9/5000/5000.1ms、失败/退出/后台、retry、disabled回退、无delivery、旧数据、非法experiment、敏感字段、0分母、空桶；成对窗口使用不同时长确保“加权”与“平均比例”会产生不同结果。

真实Telegram iOS/Android：正常首播、滑动/换集、先拦截后手动播放、暂停/seek/后台/重试；同一release回查两桶字段及有限Cloud聚合，确认不输出个人身份。复用@drama流程与现有fixture，增加遥测断言时也不建立临时mock后端。Cloud查询可执行、本地通过均不替代真机或生产效果。
