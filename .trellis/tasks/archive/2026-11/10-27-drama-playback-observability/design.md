# 短剧启动监控方案（已审核主路径）

## 1. 主方案与边界

现有播放器事件 + 能力受限的真实媒体Resource Timing + 首帧处理证据 → 既有鉴权遥测入口 → miniapp_analytics轻量观察表 → 现有Grafana PostgreSQL数据源。Railway保留诊断与后端分段日志。不改变视频交付、缓存、播放策略，不新增采集服务。现状证据见research.md；主路径已获审核，本地实现与远端门禁状态见verification.md。

第一步先用指定视频在iOS/Android Telegram及常规浏览器核对真实瀑布与PerformanceObserver，验证TAO、重定向、连接复用、Range是否独立成条、条目何时交付。分为细节可读/只有粗条目/不可见。TAO放行不保证no-cors的状态/字节数可读；0值不能直接判为缓存或TAO失败。

Resource Timing没有原始Range头，不保证每个底层Range独立上报，长请求在首帧时可能尚无条目。故不能承诺纯前端自动解释“bytes=0-1的7秒”。字段缺失标GAP，用指定样本网络工具/供应商日志补证据；需新增代理/CDN时交用户另行决定，不能自行扩范围。

## 2. 计时口径

### 体验主线

同一页面单调时钟、同一观察t0：

- 首帧等待 = first_frame - t0；frame_method分组，timeupdate降级属近似口径。
- 启动完成 = max(first_frame, playing) - t0；保持现有成功规则。
- 进入至设置源 = source_set - t0；导航/地址预取在内部并行，展开查看，不能直接相加。
- 媒体信息等待 = metadata - source_set。
- 当前画面数据准备 = loadeddata - metadata。
- 数据可用至首帧回调 = first_frame - loadeddata。
- 首帧后启动尾段 = max(first_frame, playing) - first_frame，捕获首帧已到但尚未playing的等待。

只有marks齐全且顺序合法才算差值。事件任务调度不保证loadeddata/canplay/playing/frame固定全序；异常顺序单列，不截成0伪装正常。保留旧字段及粗口径。不能将阶段P95相加，不能混合不同样本覆盖。瓶颈贡献用同一观察中最大的互斥主线区间及占比，它是阶段分类，不是根因分类。

### 媒体网络证据：针对设置源至元数据慢

PerformanceObserver被动观察实际src条目，以完整URL+source代际+时间窗口在内存关联，不以“最后一条video”猜测；不上报URL/路径/token，不增加探测fetch或URL随机参数。每次最多16条摘要，显式记录截断及关联质量。

有真实字段才记录相对fetchStart、DNS、连接/TLS、requestStart、responseStart、responseEnd、可见字节与协议/连接复用证据。TTFB=responseStart-requestStart，是响应首字节，不能称为视频payload第一字节；连接时段可能包含TLS，不重复相加。多请求可并行，以区间展示，不累计为总等待。

这些证据回答：src后何时出现媒体请求、是否连接慢、是否等响应慢、首响应后是否仍有多次请求/元数据等待。TTFB包含网络/边缘/源站等待，不能单独定位其中一方。条目responseEnd不是首帧准备完成；字节字段不当视频总大小，不据两字节请求计算带宽。无头部证据时Range区间/CDN命中均unknown。

final立即发，不等资源条目。独立网络尾观察最多延续终态后5s，且不晚于source_set后60s，切源/后台/卸载立即释放；有新增条目最多补一次phase=network，只补网络证据，不改终态/总耗时。仍在途或无条目记pending_or_unavailable，其覆盖率必须展示。

### 帧与调度证据：针对元数据至首帧慢

沿用media.events和snapshot，增加首个有效帧的processingDuration、presentationTime、expectedDisplayTime、回调执行偏移、尺寸，规范化单位且允许缺失。processingDuration仅对应该帧处理，不能用40秒差值反推纯解码。

支持时被动Long Tasks observer仅汇总启动窗口与metadata→frame重叠任务的数量/总时长/最大值；不记录脚本/页面内容，终态takeRecords后释放。不支持则unknown，不轮询/逐帧上报。

metadata→loadeddata长表示当前位置画面数据尚未可用，候选包括后续媒体获取、解复用与解码准备；loadeddata→frame长需结合帧处理、主线程、缓冲、paused/seeking、play结果判断。suspend不是单独网络故障证据，缓冲秒数不是字节数，相关性不是因果；人工暂停和autoplay_blocked分组。

## 3. 一次观察与上报完整性

- 沿用observation_id，重试/换集/换剧各自独立，旧src事件不得写新观察。
- v2新增一条轻量start，继续十秒slow和final，网络补充最多一次；最多四次上传。start走background优先级，必须验收不挤占/play。它用于尽力观测开始量，不建立阻塞播放的确认流程。
- version缺失作为legacy；start/network只允许v2。shared严格白名单和上限，Backend先发，旧字段语义不变。
- 同环境+observation只形成一行；start/slow/final/network原子乱序合并，final优先，迟到start/slow不覆盖终态。重复幂等，冲突第二final保留首次合法终态并记冲突，不静默改写。
- 所有到达观察保留summary/marks。>10s、失败、有slow的观察保留100%有界诊断；快速成功按observation确定性保留5%详细事件用于对照。分布/分位/比例仅用全量summary，不受明细采样影响；明细采样政策对用户可见。
- 维度：schema_version、前端release、服务端release、服务端决定的environment、entry、address_source、frame_method、平台/浏览器大版本、视频ID、随机会话ID、capability。会话数不是人数，不存IP、完整UA或Telegram身份。服务端版本不能代替前端release。
- 前端耗时只用performance时钟；后端时间用于first_seen_at/final_received_at，不做跨端时间戳相减。

## 4. 数据归属、可靠性、容量

拟议表miniapp_analytics.drama_playback_observations，依八域第5项归分析域：只用于统计，产品不读取，可随监控下线，不写drama_archive。权威写入方为既有鉴权遥测handler，经本功能repository调用一个受限SECURITY INVOKER原子合并入口；live/import都走它，不做应用read-modify-write。不变量是唯一观察、终态不回退、缺失不补0；客户端自报不作为计费/权限事实。

不跨域FK到用户/视频/账单，后端auth/db/sign仍留Railway按request_id查询，不另建API事实表。Grafana只读审查过的view；RLS，撤anon/authenticated/PUBLIC写入及RPC权限，service_role写，reader仅必要SELECT。analytics若已暴露于PostgREST，也不开放浏览器写入。索引从唯一键和时间开始，视频+时间索引基于查询计划决定，不为每个维度预建。

建议summary保留14天、详细诊断7天，一个每日有界清理任务，初始关闭、验证后启用。无常驻聚合表、无全历史刷新。新表/函数/视图/清理定义在一个受审单migration，生产shape和权限需独立核验。

浏览器沿用5s预算、无离线队列、不无限重试，不等待上报完成再播放。接收路由在独立请求中原子落表后才accepted：拟议DB调用2s上限、SQL写入1s与短锁预算、有限并发、既有频率和32KiB限制。DB失败503、过载429，安全日志保留失败计数。客户端超时后DB可能已提交，唯一键/合并消除重复，无业务补偿。播放API不增加数据库等待。

关闭新持久化/DB失败仍保留原日志。看板显示最后接收/落表与ingest健康；不能从表本身计算全部丢失率，独立接收/失败计数需用Railway同窗核对。start也可能丢失，完全未上报的尝试不可见，不能声称真实总体分母。

容量先测日观察N、平均/最大字节、落表时延和覆盖。模型示例（非实测）：每天1万观察，summary平均1KiB、诊断4KiB且占10%，14天summary约137MiB、7天detail约27MiB，未含索引/TOAST/WAL。1000次每分钟限流不等于长期容量安全；超预算先停明细/降采样并显示覆盖，不无限扩连接。

## 5. Grafana呈现与统计

新增“短剧启动体验”，绑定既有DS_POSTGRES，默认24h、5m刷新、15m趋势桶，最长14天；连接保持每实例1/角色3。多指标合并查询复用结果，固定summary字段统计，JSON只用于单观察钻取。SQL先按时间过滤，超过5s停止评估索引/缩窗，不延时硬跑/恢复重cron。

五块内容：

1. 采集/结果：已知观察数、start/final到达、成功/失败/受限/退出/后台/无终态、各能力覆盖和最后数据时间。“已知”=至少一条报告到达，不是所有尝试。
2. 用户等待：首帧/启动完成分别给P50/P90/P95，有效N、视频数/会话数和缺失数；N<100标P95不稳定，N<1000默认隐藏P99。这是展示规则，不是置信证明。
3. 瓶颈分布：各主线阶段的条件分位、慢观察最重阶段占比；总等待和重点阶段直方/热图，建议0–1/1–2/2–5/5–10/10–20/20–40/>40秒。不堆叠阶段P95，不把请求数当播放数。
4. 两类诊断：source→metadata的网络覆盖/TTFB/连接；metadata→loadeddata、loadeddata→frame、帧处理/主线程证据。网络统计仅代表可见子集，不外推至所有平台。
5. 最慢/失败观察（最多100条）和单次详情：marks、事件、可见媒体请求区间、十秒snapshot、缓冲/play拒绝，通过observation/request ID查Railway；5%快样本作为对照，不凭小样本自动排名归罪。

分母与缺失：成功样本>10s比例，与所有已知观察中“已知等待≥10s”比例分开；阶段有效样本和达到阶段起点数并列。后台/退出是中断/删失，展示等待下界，不当0、不混入成功分位；无终态是unknown，不臆断timeout。slow与final只算一个观察。

cohort按first_seen_at；最近未成熟观察单列。有start的cohort至少2分钟后看终态到达，这不是播放超时。legacy无start单列。前端release/平台/入口/frame_method分别分层；慢比例可给二项区间，但重复会话/视频不完全独立，需结合来源覆盖。24h不是置信度，罕见40秒事件逐条保留，未再出现不能证明消失。

## 6. 已采集旧24小时如何使用

新字段无法追溯补回。交付一个本功能限定的有界历史导入命令：先dry-run，以明确production和起止时间分段/分页读取drama.frontend_timing，必要时按request_id补读backend日志；核验limit、边界重复和缺窗，不能把最近500条当全天。若导出不能证明完整，就标部分样本。

只映射shared白名单，source=railway_import、version=legacy，复用原子merge幂等；received_at沿用原日志时间、imported_at另记，不伪造start/平台/release。原文仅临时安全保存，不进Git。正式生产导入需执行阶段授权，非本轮操作。旧日志可先算主阶段和metadata/loadeddata/frame差值，网络缺失则只作阶段结论。

## 7. 演进与恢复

规划审核→真机小验证→本地SQL/兼容测试→TEST单migration/Backend/Frontend/看板→独立生产shape/容量/权限确认→生产migration→Backend兼容接收→Frontend→看板/有界导入；清理验证后才启用。无业务数据回填/历史migration改写。

停止条件：上传错误率上升、监控抢占播放、SQL>5s、DB连接/锁压力、字段泄露/错误关联。经现有runtime-config入口的开关关闭新持久化/明细，保留旧日志。先退Frontend，Backend保持兼容；关清理job/撤reader即可停路径，保留分析表，不DROP业务对象，不恢复旧重查询，SQL缺陷独立forward-fix。

## 8. 主路径工作量与待拍板

主路径约4步、12–16个实现/配置文件（不含规划/规范/既有测试增量），第一步后收敛估算：

1. 约半天验证真实媒体/Grafana/留存能力，确定可承诺粒度，避免实现后发现关键字段不可读。
2. 约6–8文件扩展契约/前端观测，保留播放状态机。
3. 约5–7文件完成轻量落表/原子合并/权限/导入/看板，让24h统计可重复并可追查。
4. 扩展既有回归，完成SQL预算、失败/兼容/乱序和真机验收。

待拍板，不默认执行：

- 纳入packages/ui-tests固定验收｜理由：跨端/接口/媒体生命周期，后续易回归｜不做的代价：重复人工构造慢源/切集/离开｜建议：现在做；复用fixture服务/移动端入口，补短剧分组，不能替代真实Range/Telegram验收。
- 指定慢视频的Range/容器/编码体检｜理由：历史TEST有moov尾置证据，可检验反复慢是否与文件有关｜不做的代价：部分根因仍需后续取证｜建议：现在做小样本；不批量下载/自动转封装/修改归档端。
- 自动阈值告警和通知｜理由：持续发现退化｜不做的代价：先人工看板｜建议：暂缓，先建立分平台基线、最小N、持续窗口；不擅自选联系人。
- 离线补传/更强送达、30天以上历史/常驻预聚合｜理由：提高完整性和长期比较能力｜不做的代价：强关流失未知、历史窗口有限｜建议：暂缓，先看实际覆盖和容量，不建通用队列平台。
- 新视频代理/CDN｜理由：底层不可观测时可能提供证据/改善交付｜不做的代价：部分Range/边缘/源站原因须外部取证｜建议：暂缓；改变传输路径、缓存和成本，仅在第一步暴露缺口且用户另选后立项。
