# 复用调查与设计约束（2026-11-18）

只读工作区源码、迁移与规范；未连接TEST/production数据库或读取业务行。初始工作区干净，本轮只新增Trellis规划文件。

## 可复用能力

- 组件：保留PlazaCard的固定aspect-ratio、缩略图与失败回退；扩展PlazaVideoPlayer的真实帧和生命周期观测，保留Stream/HLS、一次换签及位置恢复。
- hooks：useImagePlazaFeedQuery保持唯一服务器数据源、60秒缓存、失效分页清理、10秒有限等待及无自动重试；useMobilePerformancePolicy继续控制首屏/追加预算；image-plaza-return保留筛选和位置恢复。
- helper/contracts：feedFilter、cursorFilter保持媒体/搜索/标签隔离和bigint字符串精度；shared/api/image-plaza.ts是DTO和v1游标唯一来源；loadHlsMediaSource保留ABR/Apple分支。
- repository：listSortedWorks复用liked/zero/latest、limit+1和数据库分页前筛选；hydrateFeedWorks继续只返回封面，不向feed加入播放签名。
- DB：现有可空唯一bigint initial_feed_order及索引；视频种子导入函数未写排序值。优先复用列，不因派生排名另向实体表加列；如需新对象，先按CONTRACT登记归属。
- telemetry：复用page-tracker、api-timing、grafana工程出口和Sentry净化；参考短剧真实帧确认方式，不污染drama事件。后端复用HTTP终态、image_plaza.feed.completed、video.delivery.playback、video.playback.observation。
- 验收：扩展ui-tests的@image和现有单测；fixture不替代Stream、Telegram或生产P95。必要回归文件按最终规划审核后新增。

## 设计必须解决

1. initial_feed_order历史Never renumber与本次混排冲突：设计选择派生排名旁表，保留旧列供过渡；明确存量回填、导入后维护、游标revision及首屏恢复，不能只修当前单页或改写历史迁移。
2. 建议每模型按source_heat降序取名次，再轮转相同名次，使热度1000与10的不同模型都能获得展示；样本不足模型耗尽后其余继续。全量混排再过滤单类型应保留各模型内部热度次序。
3. 不把全目录拉到Node/浏览器，也不在每次feed请求重排全目录；排序维护与索引读取分离。排序重建需锁/超时/容量上限、原子性及唯一值交换安全。
4. 最短列分配稳定追加；加载闸门保留isFetching、invalidated、error、filter身份约束。修复整体底部触发造成的长短列差异，不通过无界预取掩盖。
5. onLoadedData/playing不能直接等同首帧；requestVideoFrameCallback优先，fallback要有可识别测量版本。详情入口到首帧、播放意图到首帧分开，后台/离页不得混进成功P95。
6. 切artifact/source隔离迟到回调；暂停/后台/卸载释放；一次有限换签，不因遥测失败阻断播放。复用Playback POST的2KiB、30/min和最多8次会话报告预算，不逐帧HTTP请求。
7. 新Sentry/Faro测量名称、媒体/排序/阶段等维度必须进入有限白名单；同一浏览器观测器投递一致结果；后端仍以request/trace关联，不能将业务ID变为指标标签。
8. 发布后比较environment/release/platform/窗口/计时定义，成功P95与error/stall/left同审。新指标没历史样本必须标null，不能拿短剧或其他页面替代。
9. 旧模块文档的MP4事实已落后于源码；只同步本次涉及事实，不改变现Stream/HLS交付。
