# 技术设计

## 复用调研

- 复用 `CharacterGallery` 现有 `LobbySort` tab、`useCharactersQuery`、返回快照、关键视觉埋点和渐进挂载，不新建列表组件或状态源。
- 复用 `readRoleplayDiscovery`/`rememberRoleplayDiscovery` 保存用户显式选择；给读取函数增加调用方默认值，避免改 shared `DEFAULT_LOBBY_SORT` 后连带影响 `/chats` 摘要与后端非法参数回退。
- 复用 `useMobilePerformancePolicy` 的 Android/iOS 预算，只调整 characters 数值，不在 gallery 内再建一套平台判断。
- 复用 `CharacterCard` 的 eager/highPriority 与渐变/错误降级；不改图片组件公开 API，不新增依赖。
- 复用 Grafana `st_page_critical_visual`/`st_page_ready` 和 Sentry `http.server`；不新增遥测字段、看板或 PII。

## 最小充分方案

1. `readRoleplayDiscovery` 接受可选 `defaultSort`，无存储或存储损坏时由 gallery 传入 `latest`；有效已存选择仍优先。
2. `CharacterGallery` 不再依赖 shared 默认值，fresh entry 使用 `readRoleplayDiscovery('latest')`。详情返回快照仍最高优先。
3. Android/iOS characters 初始挂载量从6降为4；Android eager图从2降为1、批次从6降为4，iOS保留2张eager并把后续批次保持6。
4. 缓存列表后台重校准兜底从固定1.5秒改为平台有界延迟：Android 3秒、iOS 2.5秒、other 1.5秒；首图先结算时仍立即允许重校准。

不改后端排序、契约、缓存格式、图片URL或推荐算法；不为假设的设备型号建立新框架。

## 可靠性设计

- 超时：同源代理已有5秒上游 timeout，本任务不扩大；缓存重校准延迟有界，首图失败/缺失仍按现有路径结算。
- 重试：不新增重试；推荐切换及 query 保持现有有限策略。
- 幂等/并发/事务：纯前端读取与渲染，无新增写入或事务；React Query key 继续按 sort 隔离。
- 降级：local/sessionStorage不可用时默认最新；最新请求失败继续显示既有 error 或缓存，不回退伪造推荐数据。
- 容量：减少首屏组件和 Android eager 图片；后续仍由 IntersectionObserver 有界补齐。
- 可观测性：保留真实第一张头像 loaded/error/absent 终态；不把渐变占位记为 loaded。
- 限流/补偿：无新外部调用；不适用。

## 演进、发布与恢复

- 无 contract/migration/数据迁移。旧 session 中已保存的推荐选择继续生效；无值的新会话默认最新。
- 先发布前端；按 release 和平台观察关键视觉/ready/API。Android/iOS 每个主 cohort N≥100 且两个完整24h窗后才判断目标。
- 停止条件：关键视觉失败率上升、P95高于2秒且较同口径基线无改善、最新接口错误/超时明显增加。
- 回滚：恢复 gallery 默认 recommended、characters 平台预算和重校准延迟；缓存两套 sort 数据可继续复用，无数据恢复步骤。

## 可验证性

- 失败路径：无缓存请求失败、缓存刷新失败、图片错误/缺失、storage不可用、推荐切换失败。
- Consumer：`/chats` 继续使用 shared 默认 recommended，不随 gallery 默认变化。
- 人工：清空 session 后默认最新；手动推荐后模块往返保持；详情返回恢复；Android/iOS 视口首屏4张且继续滚动补齐。
- 命令见 `implement.md`。
