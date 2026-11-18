# 影像广场排序、瀑布流与视频加载设计

状态：用户确认后已于2026-11-18启动并完成本地实现；最终代码待人工审核，远端迁移与发布窗口尚未执行。

## 1. 需求与复用结论

遵循prd R1–R7 / R4a；目标是同一服务端推荐序列支持全部、图片、视频，列表稳定追加，浏览器真实耗时能进入Sentry/Faro。复用调查见research/current-behavior.md；以现源码为事实，文档中的旧MP4描述不复用。

继续使用ImagePlazaFeedRepository、现有DTO/hydrate、React Query、PlazaCard、PlazaVideoPlayer、loadHlsMediaSource、mobile-performance预算、page-tracker/api-timing及Sentry/Faro出口。不新建HTTP服务、播放器、通用推荐框架或遥测系统。

## 2. 相对热度与三种媒体视图

### 2.1 明确的映射

- 模型键使用规范model_id，并与media_type组合，避免图片/视频同名模型误并组。存量缺model_id时回退model_name；两者均空时归该媒体的unknown组。不把供应商ID另建映射状态。
- 有正外部热度的作品在每模型中按source_heat DESC、id DESC得到唯一名次r。相对优先档就是r；需要解释分值时等价于1/r，但不存浮点分数、不用模型样本量或最大热度改变曝光份额。
- 先取所有模型的第1档，再取第2档，依次轮转；同档模型键用固定C排序。等热度用ID保持确定性，避免一组同分作品挤占整档。
- source_heat=0与缺热度均是最低热度档，不得压过有正热度的作品；在其内部按模型轮转并以ID决胜。用户作品不因新分享时间获得推荐加权。
- 将完整序列映射为唯一正bigint initial_feed_order。此键只决定零赞区；有赞始终在前，按like_count DESC、id DESC决胜。
- 全部视图合并全部模型轮转；单类型先按media过滤同一序列。删去另一媒体不会改变本媒体模型之间的相对次序，故无需维护all/image/video三套排名。
- 搜索/标签只过滤已确定顺序，不在过滤后临时创建另一套热度尺度。极小候选集无法保证每个模型都有作品，不补造条目。

### 2.2 最新视图

继续从works按published_at DESC、id DESC keyset分页。此路径不读取排名、不等待排名重建。推荐的同分键不再使用分享时间，避免以时间变相给新分享加权。

## 3. initial_feed_order演进与数据库落位

### 3.1 为什么需要兼容的派生索引

历史works.initial_feed_order是一次性图片目录编号，源码约定Never renumber。直接原地重写会使滚动发布中的旧后端/旧游标悄悄跳页。逐请求计算整个目录则会让P95承担持续窗口排序成本。选用一个可重建的派生旁表保存新权威排名，沿用initial_feed_order键名/bigint语义，保留历史列供旧消费者过渡。

该旁表是新推荐读路径的唯一排名来源，不双写历史列。不增加三套视图排名、后台队列或定时任务；历史列的删除另做有证据的contract，不在本任务扩张。

### 3.2 CONTRACT §2.2归属卡

- 对象：media_plaza.image_plaza_feed_scores，性质D，已有业务域内的可重建排名索引。
- 列：work_id UUID主键（同域关联works）；initial_feed_order BIGINT非空、正数、唯一；ranking_revision UUID非空。每次完整重建的所有行使用同一revision。
- 权威写入模块：backend/src/features/image-plaza的受控导入/排名维护入口；唯一DB写入口rebuild_image_plaza_feed_order。读取者为推荐feed仓库；不向外部系统直接授权读表。
- 生命周期：与广场目录同生共灭；只保存当前一代排名，不保留历史观测。物理删除作品可同域级联清除；软删除由读路径过滤，下一次重建清除。无跨域FK、资金、任务或观测数据。
- 另增两个内部函数：media_plaza.rebuild_image_plaza_feed_order（维护原子排名）和media_plaza.read_image_plaza_recommended_feed（有界推荐读取、revision校验）。函数归属同一media_plaza业务不变量，不建包装链。
- table RLS开启；不授予anon/authenticated读写。函数固定安全search_path、限定参数、仅service_role执行，PUBLIC EXECUTE撤销；维护函数不暴露HTTP/运营配置入口。
- 同PR更新docs/db/registry.yaml，补充旧列过渡说明；迁移唯一源packages/shared/migrations，新增20261118_media_plaza_feed_ranking.sql，不改历史迁移。

### 3.3 原子重建与导入维护

1. 重建先取固定命名的事务级排他advisory lock，设置lock_timeout=5s、statement_timeout=60s；候选超过100000拒绝，不能悄悄扩大容量。
2. 数据库内计算全部未删除作品的上述序列。包含当前有赞的作品，取消最后一赞时无需重新排序。无热度作品同样纳入当前代；后续新分享未在当前代时自然进入最低热度尾部，以ID决胜。
3. 同一事务内更换旁表全量排名和revision，读者看不到半代或临时空表；无需修改works历史编号或点赞计数。空目录约定固定空revision，后来有目录重建后得到新revision。
4. 图片/视频现有批量导入完成后各调用一次重建；提供同一功能的显式维护命令便于热度源更新后重建，默认只预览、显式写入参数，必须确认目标环境。生成share不触发全量重建；新分享无热度，不提升到有热度目录前。
5. 不增加逐行全量重算触发器，不自动重试未知提交。导入中断后可以用维护入口重建；导入新增热度作品到重建完成存在短暂尾部退化窗口，完成发布验收必须断言未入排名的正热度作品数为零。

### 3.4 推荐读取与游标

- 新推荐通过一个RPC完成liked→zero拼页、数据库侧media/search/tag过滤和limit+1读取；再复用hydrateFeedWorks的封面/点赞投影。只取最多21行，不下载全目录到Node或浏览器。
- 读函数先取同一advisory共享事务锁，验证当前ranking_revision；锁范围只涵盖有界DB读，不涵盖网络/封面签名。重建与推荐读互斥，普通点赞/分享不被该锁串行化。
- 推荐cursor v2包含filter hash、ranking_revision、partition；liked记录likeCount/id，zero记录initial_feed_order字符串或null及id。排序条件与cursor条件必须逐项一致。latest继续v1时间+ID，不因排名更新失效。
- 读函数返回固定错误码表示过期revision；旧v1推荐cursor明确INVALID_CURSOR，禁止把旧order解释为新排名。frontend收到该码只恢复一次首屏/清除旧链，不无限重试，不在旧列表继续追加。
- filter hash纳入media、search、排序后的tag labels，与既有规则一致。UI query key增加推荐排序版本，防止旧缓存第一页与v2下一页拼接。
- 实时点赞可让作品跨分区，仍采用现有动态feed语义及前端按ID去重；重建有严格revision边界。不引入用户冻结快照来承诺动态场景绝不漂移。

## 4. 瀑布流与资源预算

- 将现有超长/create页面中列表展示、渐进渲染和触底职责拆成有限功能组件/hook；保留筛选、创建、返回恢复与首屏观测归属，不提取通用布局框架。
- 卡片宽度由两列容器实测；预估高度=列宽×height/width+现有卡片固定信息区+gap。信息区若有可变高度，用ResizeObserver补正列尾估算，不能把已分配卡片搬列。
- 遍历服务器顺序，将新卡片追加到较短列；同高优先左列，前两张仍对应critical preview。每卡保留原始排序索引，用该索引判断eager/high priority，不能再按列行反推index。
- 使用增量分配身份（filter/query key +稳定作品ID前缀）保证分页追加不重排旧卡。换筛选/刷新明确重建；列宽变化只在必要布局重置时保持锚点，不能因每次图片onLoad全列表跳列。
- 每列尾部各有轻量sentinel，任一列接近视口即可驱动同一个加载闸门。先释放已有缓存的renderBatch，再请求下一页；同步in-flight guard挡住同一帧的双列重复请求。
- 沿用Android/iOS首屏6项、分批/图片quality和rootMargin，不扩大批量来掩盖高度问题。背景页停止主动预取；错误保留已有内容和刷新入口；无IntersectionObserver保留现有降级能力。
- 懒加载只作用于封面；视频列表不挂video，不预热播放清单或分片。列表返回位置与选中卡片锚点沿用image-plaza-return。

## 5. 视频加载与测量

### 5.1 加载改动

- 保留现有Stream/HLS、低档起播/ABR及Apple MMS/native分支；只调整广场活动播放器所需的装载/预加载策略，不修改短剧播放器行为。
- 列表通过现有缩略图变换、尺寸占位和首图优先级降低封面成本。进入详情时复用已有work详情查询和受限路由预热，不把带鉴权详情放进公共缓存。
- 唯一活动播放器在可见且非省流量时允许必要的预加载；离屏/后台暂停并释放源/网络资源，回前台按同一artifact恢复。省流量继续metadata/none策略，不强制自动播放。
- 现有一次换签要增加source generation隔离：旧回调不能更新新源；重复错误不能并发消耗刷新次数；网络断开后保持可恢复状态和位置。

### 5.2 观测器与定义

增加广场专用轻量观测器，复用现有clock/env-tags/Sentry/Faro出口。播放器observer抽离到功能文件以控制单函数120行；不复制短剧诊断大对象。

- feed_load：从首次/筛选/翻页query开始到该页完成解析，分first_page/next_page、media、sort、cache；沿用api计时分组补齐image_plaza_feed/detail/playback，观测上传不作为产品API耗时样本。
- poster_visible：从本次列表/详情入口到首批真实封面load/decode并获得绘制机会，错误/absent有独立终态；保留page.critical_visual，不用骨架ready代替。
- video_prepare：详情入口到视频可用/装载就绪，包含work取址等待；它不是首帧。
- video_first_frame：播放意图（浏览器play事件为native controls可观察边界）到第一帧确认；详情入口到首帧另外记录entry_first_frame，其中用户等待点击时间保留独立阶段，不能拿它与纯加载2秒SLO混合。
- seek：记录seek意图到目标附近的新帧；rVFC优先，校验seek身份和目标时间；无rVFC用playing+timeupdate/两帧兜底并标记measurement，paused seek不能因等待playing而永远不结算。
- rebuffer：首帧后waiting到下一次恢复画面，记录持续时间与次数；paused/seek/后台不冒充网络stall。
- 成功首帧优先requestVideoFrameCallback；fallback明确标记，不能仅loadeddata/onPlaying即成功。超时使用观测watchdog而非取消真实播放；迟到成功与截止结果采用同一观测身份去重。
- 每次artifact活动周期有界记录，保持既有后端POST 2KiB、30/min及最多8次报告；高频细节只本地汇总，离页单次终态。遥测抛错、网络失败或限流不影响播放、不重试上传。

### 5.3 Sentry / Grafana白名单

- 新测量前缀plaza.\*，事件plaza.feed_terminal、plaza.video_terminal、plaza.rebuffer；同一观测器先形成一次结果再投递两个出口。
- 允许route模板、media=all/image/video、sort=recommended/latest、stage、outcome、cache、navigation_type、measurement、source_measurement_version、tg_platform、net_type、net_rtt_bucket及release/environment。指标不携带work/artifact/user ID、提示词、URL、签名、initData或Replay ID。
- 浏览器网络API不能证明真实10Mbps/100ms参考网络；只输出已观测的有限网络桶，未知保持unknown。参考网络达标由受控网络验收，生产按可见网络桶分组，不能将unknown伪装成达标网络。
- 扩展grafana-schema有限名称/枚举和Sentry metric净化白名单；既有Faro随机会话头/禁用自动instrumentation规则保持。
- 后端复用HTTP终态、feed完成与video.playback.observation；feed日志增加media/ranking_version及安全结果摘要，失败保留{err}。维护重建通过既有observability记录数量/耗时/revision变化结果，不打印作品行。

## 6. 可靠性、容量与恢复

- 超时：feed保留10秒客户端总截止；DB有界读和重建分别设置statement/lock timeout；签名/刷新沿用现有有限等待，不因重试重置总期限。
- 重试：产品feed retry=false；INVALID_CURSOR仅一次首屏恢复。换签一次；遥测不重试。维护提交结果未知先读revision/计数，不盲重跑。
- 幂等/事务：排名全代替换同事务；同一目录重建结果顺序确定，revision可变化但不会重复发奖/生成/扣款。写操作没有外部补偿需求，失败事务回滚即可。
- 并发：排名读共享锁/重建排他锁；普通点赞/分享继续现有原子RPC；双列加载单飞；artifact/source隔离异步回调。
- 降级：排名函数或迁移缺失时显式错误，不悄悄退回错误热度列表；视频封面/播放失败沿已有可恢复UI。观测完全旁路，不阻断主业务。
- 限流/容量：pageSize20、limit+1；排名上限100000；沿用签名并发/缓存、有限首屏/分批预算、后端观测限流。重建不进入请求热路径。
- 告警：沿用默认关闭；先以失败率、超时、stall和P95窗口判断，不新增通知外部出口。
- 不适用：无新增计费、安全身份、外部支付写入；无需分布式队列、补偿工作流或事务外资金恢复。

## 7. 验证、发布与回滚

- 先本地真实SQL引擎验证新表/RPC、RLS/ACL、空目录/0热度/缺模型、图片视频混排、单类型剪枝、排名重建与旧游标拒绝；普通mock不能替代SQL语义。复用现有SQL harness，只有缺口确有必要时增加最小回归文件。
- 使用虚构1万/10万目录验证重建容量、推荐EXPLAIN/有界结果与索引路径；基准是SQL/机制证据，不能声称生产500ms已达成。
- 自动化矩阵覆盖点赞切区、静态多页、过滤、100000/100001容量、超时/锁冲突、缺迁移、反复INVALID_CURSOR只恢复一次、bigint精度、双列触发、回流位置、帧回调晚到/后台/seek/暂停/换签。
- 本地UI扩展@image：两种宽度、至少三页混合比例视频/图片、慢封面/失败重试、筛选/刷新/回流、列表零清单分片。真实Telegram、系统控件、Stream网络及SLO单独验收。
- 发布顺序：TEST单文件migration→函数/排名/权限/索引验证→Backend v2→Frontend带版本query key→窗口验收。production独立核实shape/容量/权限并人工执行同一迁移；本任务不自动操作远端。
- 因新排名旁表与旧列隔离，旧Backend仍读原序列；新旧滚动不共享游标，v2客户端遇旧Backend期间显式重置/错误而非静默混页。兼容部署要求生产先完成所有Backend副本再切Frontend。
- 回滚先回退Frontend/Backend到原路径，保留派生旁表和函数，不改钱包/资产/分享事实；确认无新消费者后才另审DROP。排名错误可修规则后原子重建，旧revision客户端恢复首屏。
- 停止条件：迁移shape不匹配、候选超过容量、超时/锁等待超预算、权限泄漏、静态分页漏项、图片回归、错误率/stall升高或任一平台P95倒退。停止发布/回退消费者，再forward-fix。

## 8. Android/iOS P95与窗口

已确认：列表/详情critical visual≤2000ms、工作室ready≤1500ms、feed浏览器≤800ms/后端≤500ms；参考网络播放首帧/seek≤2000ms。两个平台分别验收，不能平均P95；当前基线全部null（本任务无可见样本）。

发布前后各24小时，按environment/release/platform/route/media/sort/cache/measurement比较，同屏查N与失败/后台/离开。N<100延长72小时并标低样本。新增视频指标先建立第一代窗口，后续版本沿相同定义比较；不回填或拼接旧drama样本。

产物包括固定Sentry指标名、Grafana LogQL查询模板、窗口起止/分组/N/定义版本记录及人工复测清单，写入本功能运行文档；不自动新建远端仪表盘、告警或发通知。具体有限名称和窗口契约见research/observability-contract.md。
