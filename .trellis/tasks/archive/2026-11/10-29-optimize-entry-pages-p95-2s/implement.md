# 实施计划

> 当前任务保持 `planning`。以下阶段须评审通过并执行 `task.py start` 后方可实施。

## Phase 0：冻结基线与口径

1. 以当前 production release `98eced4` 和文档中的 Sentry 固定窗口建立对照。
2. 补齐三页关键视觉事件，保留现有 `page.ready/page.fresh`。
3. 验证日志无 URL、token、initData 或个人数据。
4. 部署后收集至少 24 小时/100 样本，确认指标能区分 cold/warm、document/SPA、provider/cache class。
5. 在 Grafana 固化 PRD 4.2 的 p95 面板：页面打开、关键视觉、freshness、API total/stages、终态率和样本量；为发布版本添加 annotation。

门禁：口径经 dashboard 和原始事件抽样确认；`first_visual` 当前只有 4 个成功样本，补足前不能作为达标证据。否则不做行为优化。

## Phase 1：目录缓存与请求调度

1. 为 drama catalog 增加版本化、有限、可校验的本地 cache，并接入 `/`、`/dramas` 的同一 query 数据源。
2. 处理缓存损坏、过期、目录删改、fresh 失败、路由离开和写入失败。
3. 角色列表先延迟背景 refresh；再用 BFF/直连对比决定是否改变链路。
4. 对比 API attempt、headers、page fresh 和关键视觉 p95。

门禁：`/`、`/characters`、`/dramas` 分别满足 PRD 4.2 的 `page_ready`/关键视觉 p95；三页 `page_fresh` p95 ≤ 2.5s；drama `st_api_total` p95 ≤ 2.0s、headers p95 ≤ 1.5s。错误/page-left 不退化；无收益的直连实验删除，不保留双路径复杂度。

## Phase 2：Supabase 图片变体

1. 增加有限的 drama cover transform variants 与 responsive sizes。
2. 校准首页海报、邻近封面、广场首行和角色首屏的 eager/priority 数量。
3. 在 TEST 和 production 小流量观察 `cf-cache-status`、TTFB、transfer/decode、配额和成本。
4. 记录历史对象缓存策略限制；把 versioned path 规则交给对应上传方后续实施。

门禁：关键图片字节数和视觉 p95 显著下降，三页关键视觉 p95 ≤ 2.0s，transform 错误率/配额可接受；`/dramas` 现有 605ms SPA `page_ready` 不得退化 20% 以上。

## Phase 3：Bunny 视频 TEST 证据与生产灰度

1. 完成同对象、同设备的 Supabase/Bunny TEST 对比，满足样本要求。
2. 若改善不足 20%，停止生产化，只保留 TEST runbook。
3. 若通过，环境化 provider/origin/namespace 门禁并完成安全评审。
4. 按 5%→25%→100% 灰度；每级检查 first frame、playing、Range、stall、403、page-left 和 egress。
5. 任何停止条件触发时关闭开关并验证新请求已恢复 Supabase。

## Phase 4：条件式 bundle 收尾

1. 构建并分析 route chunks/long tasks。
2. 只有达到设计阈值才拆 `/dramas` 非默认 tab。
3. 不拆首页播放器和默认首屏路径。

## 验证命令

按实际变更范围运行，至少包括：

```bash
pnpm --filter frontend typecheck
pnpm --filter frontend test
pnpm --filter frontend lint
pnpm --filter frontend build
pnpm --filter backend typecheck
pnpm --filter backend test
pnpm test:ui --grep @drama
pnpm test:ui --grep @roleplay
pnpm -r typecheck
```

另外执行：

- 冷缓存/暖缓存、缓存损坏/过期、fresh 失败、弱网、快速离页人工回归。
- Supabase transformed image HIT/MISS 与 quota 检查。
- Bunny signed URL、Range、过期、篡改、关闭 flag 后回退检查。
- Telegram 真机 iOS/Android 至少各一轮；自动 mock 不替代真实媒体/键盘/网络链路。

## 发布记录

每一阶段记录 release、commit、开始/结束时间、样本量、p50/p95、错误率、timeout/aborted、page-left、回滚结论。Grafana 验收顺序为：

1. release 后 2 小时只做异常和停止条件观察，不宣称达标；
2. 24 小时且每个主 cohort ≥100 样本后做首次合格判定；
3. 7 天滚动 p95 复核长尾是否回弹；
4. 任一页面、冷缓存 cohort 或失败率不合格，则整体不合格。

只有三页分别满足 PRD 4.2，而不是三页平均值达到 2 秒，才宣称目标完成。
