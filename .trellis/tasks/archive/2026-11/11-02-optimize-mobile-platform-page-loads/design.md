# 技术设计

## 1. 边界与数据流

新增一个纯前端、只读的移动性能策略 helper，输入现有 `tg_platform`，输出：

- 角色/短剧列表首批数量、增量数量、观察器 rootMargin；
- 首行 eager/high 图片数量；
- 首页海报尺寸/质量与媒体 preload；
- 底部导航后台预取目标优先级。

策略不持有 React 状态、不缓存业务 DTO、不发请求。Android 与 `android_x` 同组，iOS 单独一组，其他平台使用保守默认值。

页面链路：平台读取 → 有界策略 → 现有列表 slice/IntersectionObserver 或图片属性。首页链路：目录摘要 → 独立海报 `<img>` 可见 → 播放地址与 `<video>` 并行加载 → `loadeddata` 后移除海报。

## 2. 分平台方案

### Android

- `/characters` 首批和批次缩小，观察器靠近列表尾部再扩容；首图 high、第二图 eager/auto；卡片启用离屏渲染隔离。
- 首页用较小的关键海报先占满画面，embedded video 用 metadata preload，随后仍由现有 `play()` 驱动媒体；从其他模块后台预取优先角色与首页。

### iOS

- `/dramas` 首批与批次更小，降低 WebKit 同帧图片解码和 React commit；首张海报 high，第二张 eager/auto。
- 后台预取优先 `/` 与 `/dramas` 路由，减少触摸点击后才开始下载 route chunk 的等待。
- 首页同样先展示关键海报，避免导航 transaction 的用户可见阶段被媒体首帧绑住。

### Unknown/desktop

采用介于现状和移动端预算之间的保守值；不依赖 Telegram SDK 成功，读取失败不影响页面。

## 3. 可靠性设计

| 项目      | 设计                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------- |
| 超时      | 不新增业务请求；现有 API/媒体超时语义不变。海报错误由既有关键视觉终态记录，视频仍可继续。               |
| 重试      | 不新增重试；图片/route prefetch 交由浏览器/Next，业务重试按钮不变。                                     |
| 幂等      | 路由预取和关键视觉上报均沿用幂等实现；海报 `onLoad` 与 video `loadeddata` 只会让首个终态生效。          |
| 并发      | 每页最多两个后台 route prefetch，串行且间隔不变；图片只有第一张 high，降低竞争。                        |
| 事务      | 纯读取和展示优化，无数据库事务。                                                                        |
| 降级      | 平台读取失败回退 default；无 IntersectionObserver 时保持现有一次性全量；图片失败仍显示占位与播放器。    |
| 补偿      | 无写入，无补偿。                                                                                        |
| 限流/容量 | 列表挂载量有界；不新增缓存/map；后台预取仍受网络和可见性门禁。                                          |
| 可观测性  | 保留 `page.content`、`page.critical_visual` 与 drama media 指标；海报可见和视频 `loadeddata` 分开解释。 |

## 4. 最小充分方案

- 只新增一个纯策略文件，不新增 provider、store、依赖、API 或缓存层。
- 复用现有 IntersectionObserver、图片 URL helper、关键视觉指标与 BottomNav 预取。
- 不引入通用设备能力评分、复杂自适应调度器、虚拟列表库或 service worker；报告只支持 Android/iOS 三页的定向优化，以上均属过度设计。
- 不改变目录/详情/播放 API 编排，因为普通接口已恢复且播放地址必须在实际意图时确认。

## 5. 演进、发布与恢复

- 兼容：DOM 语义、路由、API、store shape 均不变；只新增海报覆盖层和资源调度策略。
- 发布顺序：一次发布前端；无需 migration 或 Backend 配置。发布后按 release 分割，分别观察 Android/iOS。
- 灰度/停止条件：任一平台出现列表断档、滚动恢复失败、首页黑屏/不自动播放，或错误率上升超过发布前基线，立即停止扩量。
- 回滚：删除策略 helper 并恢复固定常量、原预取顺序和 video poster-only 渲染即可；没有数据回滚。
- forward-fix：若海报达标但视频 ready 仍慢，下一步依据 `drama.media` 的取址、首字节、loadeddata 分段处理 CDN/编码，不把海报指标替代媒体指标。

## 6. 生产验收口径

本地只验证功能、请求上界和构建体积。production 目标必须在发布后连续两个完整观察窗、每个平台每页面样本/估算计数 ≥100 时判断：

- `/`、`/characters`、`/dramas` 导航与 `page.critical_visual` P95 <3s；
- 首页 `drama media loadeddata/canplay` 独立报告，不以海报可见替代；
- 页面成功率 ≥99%，错误率不高于发布前基线；
- 低样本写“待验证”，不补零。
