# 基线与复用调研

## 生产页面基线

来源：Grafana Cloud Loki，production `engineering_v1`，`st_page_navigation`，`outcome=ready`，`visibility=foreground`，2026-10-27 18:00 至 2026-11-03 18:00 Asia/Shanghai。

| route         |  Android P95 / N |              iOS P95 / N |
| ------------- | ---------------: | -----------------------: |
| `/`           | 1069.85 ms / 111 |  946.9 ms / 27（低样本） |
| `/dramas`     | 1382.93 ms / 268 | 637.15 ms / 92（低样本） |
| `/characters` |  4035.9 ms / 808 |         2319.65 ms / 162 |
| `/creation`   |           无数据 |                   无数据 |
| `/profile`    | 4716.73 ms / 656 |          2690.8 ms / 147 |

## 接口聚合基线

同窗 `st_api_total outcome=ok`：dramas Android 3494.03ms(N=552)/iOS 3857.6ms(N=137)；wallet Android 3704.15ms(N=2851)/iOS 2966.4ms(N=599)；other Android 2768.02ms(N=3790)/iOS 2166.2ms(N=669)。当前 `lobby-characters` 与 favorites 被归到 other，因此该组只能用于风险参照，不能当独立端点事实。

## 复用结论

- 复用 `page.navigation`：它已从真实 Link 点击/导航钩子计到 `usePageReady`，符合需求，不建立重复指标。
- 扩展 `/creation` 路由登记和 ready：当前缺失是无样本根因。
- 修正 `/profile` ready owner：页面 shell 已真实可交互，余额只是其中一个异步卡片；继续以钱包作为整页门槛会把 API 长尾误算成所有页面内容均不可见。
- 扩展 characters/favorites/wallet QueryClient prefetch helper：使用现有 query key、fetcher、超时、缓存和去重；不在 BottomNav 直接 fetch。短剧 intent 数据预取在五入口验收中稳定干扰增量列表挂载，因此撤回；`/dramas` 保留 route chunk 预热和既有目录缓存，生产页面基线本就低于 2 秒。
- 复用现有 `mobile-performance` 和后台 route chunk 串行策略，只调优优先级，不建立第二个调度器。
