# 冷启动复核与最小改动（2026-11-19，本地候选）

数据来自父任务冻结的最近48小时窗口，单次事件字段见 `../../11-19-mobile-performance-round2/research/evidence.json`。下表均为毫秒；这是六个慢样本的解释，不是分组P95，不能推广为所有用户的耗时比例。

| 样本     | 平台/入口           |    TTFB |   建连 | 连接结束到请求发出 | 请求等待 | 最大脚本加载 | Providers执行 | SDK初始化 | 判断                                            |
| -------- | ------------------- | ------: | -----: | -----------------: | -------: | -----------: | ------------: | --------: | ----------------------------------------------- |
| 071fab28 | iOS /chats          |    5228 |      0 |               5135 |       90 |           27 |          5483 |         4 | 大部分等待在请求发出前；不能归因后端API或SDK    |
| 1fbb7297 | iOS /characters     |    5256 |      0 |               5168 |       88 |          227 |          5574 |         3 | 同类请求前空档；无法仅凭Timing确认宿主调度原因  |
| 8c147057 | iOS /chats          |     214 |      0 |                172 |       31 |         3084 |          5221 |         7 | 文档接收1656，脚本加载慢；阶段相互重叠          |
| c196b3ae | Android /chats      | 11137.2 | 4223.9 |                0.3 |    302.8 |       4201.1 |       15396.1 |      14.4 | 建连和脚本均慢；early HTML shell已在11716.9就绪 |
| efcab4f5 | Android /characters |    1003 |  463.9 |                1.2 |    169.3 |         7361 |        8540.8 |      11.8 | 脚本加载明显；early HTML shell在5289.8就绪      |
| 2b8b5cc2 | Android /chats      |  5232.4 | 5127.4 |                0.4 |     89.1 |        616.7 |        6009.9 |       2.3 | 主要可见空档在建连；SDK本身很短                 |

HTML early-ready与Providers属于两条可能交叠的时间线。不能把独立阶段P95相加，也不能将shell时间当作完整列表可用时间；保留原有page.launch、page.navigation和startup计时。

现网只读HEAD复核见 `production-headers.json`：无cookie根入口为200、`X-Matched-Path: /characters`；landing=chats根入口和直接/chats均为200、匹配/chats；三者均CDN HIT。当前没有证据支持新增重定向优化或修改公共缓存。该探测经过本机网络/代理，不代表Telegram中国移动网络体验。

构建静态依赖证据见 `existing-build.json`：已有root layout chunk包含`/api/users/settings`。Providers静态导入的设置同步器只在backgroundReady及导航安静窗之后才允许请求，属于首屏不需要执行的依赖。本轮将整个同步器移入现有DeferredEntryEffects后台chunk，继续使用同一个React Query hook/key、profile store、路由条件和安静窗；没有新建加载链或延后核心列表。最终构建再确认根chunk移除了该端点。已有产物未核验构建提交，因此其字节数只说明依赖位置，不用作受控前后性能收益。

这项小改动不能解决iOS请求发出前约5秒空档或所有建连问题。4秒目标仍需发布后按新release、平台、入口观察48小时，每组N≥100；iOS不足延长72小时。真实Telegram、物理遮罩消失和网络抓包仍属于发布验收，不能由本地fixture替代。

最终生产构建通过，`final-build.json`中的所有root layout初始chunk均不再含`/api/users/settings`。layout应用chunk为22843字节、gzip 8169字节。旧产物为22816/8229字节但未确认构建提交，因此不做受控体积收益或P95改善结论；本次证明的是可选依赖移出根入口，整体性能仍需实测。
