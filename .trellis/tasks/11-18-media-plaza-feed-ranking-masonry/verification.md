# 本地实现与验证记录

日期：2026-11-18；环境：本地 Windows、Node 22+、pnpm workspace。任务保留 `in_progress`，等待最终人工审核和远端/真机/发布窗口验收。

## 已实现

- 推荐以本站点赞优先，零赞作品按媒体与模型分组的相对热度名次轮转；全部混排、图片和视频在服务端分页前筛选。最新按分享时间与ID倒序。
- 新派生表保存统一 `initial_feed_order`，历史作品列保持兼容。原子重建、revision游标、容量与超时上限、权限隔离和显式环境维护CLI均已实现。迁移文件尚未远端执行。
- 瀑布流所有屏宽固定两列，按实际宽高比向短列稳定追加，旧卡不因追加换列；双列底部共用单飞加载。保留首屏预算、筛选、下拉刷新与详情返回恢复。
- 视频按活动/前台状态控制预加载和资源释放，隔离换签与旧源回调。真实帧、暂停seek、卡顿、后台、离开、失败和超时均有界观测。
- 同一浏览器结果镜像Sentry与Faro，有限维度、身份净化，失败不进入成功耗时分布。复用Pino请求/trace及现有播放观测接口，无新增遥测依赖。

## 验证结果

- `pnpm -r typecheck`：8个消费者全部通过。
- `pnpm --filter @miniapp/frontend test`：78文件、860项通过。
- `pnpm --filter @miniapp/shared test`：25文件、257项通过。
- Backend现有广场feature、feed与播放route、真实Pino logger回归：13文件、119项通过。
- `pnpm test:ui:fixtures`：12项通过；`pnpm test:ui --grep '@image'`：11项通过。覆盖320/390px三页混排、单媒体/最新筛选、追加位置、旧游标只恢复一次、宽屏仍两列及列表零视频清单/分片请求。已查看截图核对两列。复用了现有本地验收场景，新增 `image-masonry` fixture。
- Frontend lint与生产build通过；存在既有的图片标签建议、drama hook、Browserslist和Tailwind非阻断警告。封面保留现有图片资源管线，未为消除建议切换新的代理。
- `pnpm lint:complexity`：通过，超标基线仅移除本次已拆小的3项，没有放宽；`pnpm lint:backend-logging`：384运行文件通过；migration命名通过。
- `pnpm lint:db-contract`：通过，6项既有警告来自未修改的 `20261118_media_plaza_video_production_base.sql`，本次排名迁移无新增警告。
- 日志规划门禁、移动性能声明、模块知识payload校验与正常Git换行配置下的 `diff --check` 通过。

## 本地SQL

执行入口：`node scripts/test-media-plaza-feed-ranking.mjs G:/JobLib/ST_miniapp/output/feed-ranking-sql/node_modules/@electric-sql/pglite/dist/index.js`。PGlite 0.3.14仅安装在本地忽略目录，未修改workspace依赖或lockfile。全部测试数据为合成数据。

通过：跨模型量级差异和图片/视频混排、单类型过滤、静态分页无重复遗漏、LIKE通配符字面转义、正赞优先/取消赞、新分享无时间加权、旧列不变、新revision拒绝旧游标、注入重建失败后整代回滚、ACL与service角色执行、100000容量边界、100001拒绝且保留原代、空目录重建/读取revision一致。

最终合成10万条运行：重建4324ms；10次读取为14/12/13/13/7/7/7/7/12/11ms，受并行本地检查影响，仅记录样本。实际RPC页面SQL的EXPLAIN使用 `image_plaza_feed_scores_initial_feed_order_key`，排名索引读取21条，回归断言该边界。重建同步ANALYZE，避免导入后旧统计信息导致全量排序。

单连接本地引擎不能证明多连接共享/排他锁竞争、生产数据选择性、数据库扩展/RLS现状或生产P95。未用本地耗时替代真实指标。

## 执行环境与剩余验收

- 本轮没有读取远端业务行、执行TEST/production迁移、修改运营配置、部署、暂存、提交或推送。已有build配置在早期标准构建中上传过Sentry sourcemap；最终构建以同进程清空上传凭据的本地入口验证，未再上传，不更改项目发布配置。
- 本地代理曾使Playwright探测localhost返回502；仅在测试命令中为localhost/127.0.0.1设置NO_PROXY后通过，未放宽断言、超时或更换端口。本轮自启3130/3131预览已停止。
- TEST须逐文件核对前后shape、ACL/RLS、实际规模/EXPLAIN、并发锁与失败回滚；通过后才能按运行说明安排production迁移，再发布消费者。新推荐后端依赖该迁移，不能提前部署。
- Android/iOS Telegram、真实Stream/HLS、native controls、首次播放、未缓存seek、后台恢复、换签与离页停止网络仍须真机验收；UI fixture不能替代供应商与系统引擎。
- 当前Android/iOS页面及API基线均为null。发布前后各24h按环境/release/平台/media/sort/measurement采集，N不足100延长72h。目标列表/详情视觉2000ms、工作室ready1500ms、浏览器feed800ms、完整HTTP server500ms、参考网络真实首帧/seek2000ms；本轮不能宣称真实P95已达标。
- 发布顺序、停止条件、回滚/forward-fix与Sentry/Grafana窗口查询见 `docs/media-plaza-feed-ranking.md`。最终人工审核路径与摘要见 `review.md`。
