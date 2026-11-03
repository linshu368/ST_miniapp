# 设计

## 复用

- 复用 `FirstTokenObservation.dispatched/reportNetwork`、现有 `roleplay.network`/`roleplay.delay` 上报与 Faro 白名单；`network_status` 枚举已存在（短剧资源测量在用），直接复用取值。
- 复用短剧 `drama-resources.ts` 的单次 PerformanceObserver 模式（observe buffered、takeRecords、disconnect、超时释放）。不新增全局观察器、状态源或公开 API。

## 方案

- `dispatched(url)` 时为本次请求挂一个 resource 观察器，只保留 name 等于本次 URL 且开始时间不早于点击的条目。
- `reportNetwork()`（流结束后 1 秒）先 takeRecords 并断开，再查整页缓冲区；优先用观察器条目，其次缓冲区条目。
- 新增属性：`network_status`（available/limited/no_entry/unsupported/unknown）、`rt_buffer`（hit/miss：整页缓冲区是否也有）。

## 可靠性

- 观察器、查找、上报全部 try/catch，失败只丢测量。180 秒上限释放，避免报告不运行时观察器常驻。
- 每轮一个观察器，回调只做 URL 字符串比较，开销可忽略；不清空整页缓冲区，不影响 Faro 等其他读取方。
- 归因规则不变：证据不全仍算我方。

## 发布与回滚

- 纯前端，新旧版本可并存；回滚即回到旧包，只是重新失去证据。无迁移、无配置。
