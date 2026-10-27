# 短剧启动看板：发布、历史导入与真机验收

这是操作说明，不代表已完成远端迁移、部署或发布。当前实施/验证状态以 Trellis 任务 `10-27-drama-playback-observability/verification.md` 为准。

## 独立看板

- 文件：`docs/grafana/drama-playback.json`，名称“短剧｜启动耗时与诊断”，UID `st-drama-playback`。
- 只新建此看板；不改 `st-model-overview`、`chat-first-token-manual` 或其余已有看板。
- 导入时绑定既有生产只读 PostgreSQL `fg1oltvmm56v4b`；TEST 绑定已核验测试数据源，绝不因变量选择test就把它当作生产库中真实存在的测试数据。
- 创建前检查UID未被其他看板占用，API创建使用 `overwrite=false`。若UID冲突先核实，不覆盖他人看板。原有数据源连接上限保持不变。

当前线上已创建 [短剧｜启动耗时与诊断](https://ea3213527545.grafana.net/d/st-drama-playback)，version 1，仅展示待接入状态。生产新表/视图尚未迁移，12个业务面板targets与SQL变量暂未启用；结构查询返回“待迁移”，空白不代表零耗时。已有看板与数据源未修改。

正式启用时读回此UID最新版本，将本地JSON的 `${DS_POSTGRES}` 绑定为已核验UID，去除导入专用 `__inputs`；仅更新此独立看板并保留folder/id/version、检查版本冲突。迁移/权限/发布门禁通过后才能启用；逐一执行统计/变量SQL并检查真实渲染。

## 本次发布决定（2026-10-27）

用户明确授权跳过TEST采集验收，直接合main并执行production迁移。本次保留本地整合验证、生产对象/权限预检、默认关闭开关、单文件迁移与发布后验证；没有执行的TEST/真机项目标记未验收。下方是通常顺序，本次TEST门禁按该授权跳过；仅提取监控提交进入main，保留main既有业务改动。

## 顺序与停止条件

1. 本地 `bash scripts/test-drama-observability-local.sh`：需本机PG17，非默认安装可指定 `DRAMA_PG_BIN`。使用全新临时cluster，不读取远端连接。验证重复迁移、并发/乱序、权限、保留期及5万条合成样本下的全部面板/变量SQL，每SQL5秒预算；不代表生产性能。
2. 核对TEST目标shape：miniapp_analytics存在、没有同名异构对象、service_role和Grafana reader属性/已有权限。通过Database Migration工作流逐文件执行 `20261027_drama_playback_observability.sql`，验证table/RPC/view/ACL和目标迁移账本。
3. 先发布兼容Backend。显式开启TEST的 `DRAMA_TIMING_PERSIST_ENABLED=true` 并重新部署，确认遥测200且 `data.persisted=true`；未迁移时保持false沿用Pino日志。再发布Frontend并确认前端release正确。
4. 在TEST数据源验收新看板每个面板的查询和实际渲染，不能只看SQL成功。默认24h/5m刷新，可手动刷新查刚产生的观察。无浏览器/插件访问时这一步保持未验证。
5. 独立生产确认后，重复生产shape/权限/容量、单migration→Backend开关→Frontend→新看板。生产不是TEST的同构假设。上线前实测日N/行大小、写时延/拒绝率与查询预算。
6. `drama_metrics_cleanup_daily` 初始关闭；owner在本环境验证后启用。每天批量最多删除1万过期行、清除1万过期明细，超过该日量需明确调整运行频率/预算，不默认扩大单次扫描。看板/库容量和过期积压需运维观察。

上传4xx/5xx上升、监控挤占播放、SQL超5秒、锁/连接压力、关联错误或字段泄露时停止新路径。关闭环境开关并重新部署，保留Pino；关清理job、先退Frontend再兼容退Backend，保留分析表。不要恢复旧重查询cron。无业务数据回滚，SQL缺陷用独立forward-fix。

## 历史24小时导入

先通过Railway完整导出明确环境与半开时间区间 `[from,to)` 的NDJSON；检查分页、条数限制和每个分段边界，不把工具最近500条当全天。原始导出只放临时安全目录，禁止提交Git。

先 dry-run（以下时间仅示范，按实际窗口调整）：

```bash
pnpm --filter @miniapp/backend exec tsx src/scripts/import-drama-timing.ts \
  --file /private/tmp/drama-export.ndjson --environment test \
  --from 2026-10-27T00:00:00Z --to 2026-10-28T00:00:00Z
```

单文件最多64MiB/5万行/24h，超过即拆窗口，不静默截断。支持Pino JSON、JSON message及Railway attributes数组，仅读白名单并校验shared schema；输出计数、hash和完整性状态，不打印业务行或凭证。

apply必须另提供操作者核验过的manifest：`environment/from/to/complete:true/truncated:false/sourceRecordCount/sha256`，源记录数与文件SHA-256必须匹配；任何坏行阻止apply。manifest是操作者对导出完整性的声明，脚本不能证明供应商未丢日志。无manifest只可作部分样本dry-run。

在相应Backend环境下给上述命令加 `--manifest /private/tmp/drama-manifest.json --apply` 才写分析表；production还要求 `--confirm-production` 及本环境发布授权。目标使用现有数据库配置隔离，target不匹配立即停止；一条报告一个短超时写、顺序执行、不重试，重复导入幂等，冲突final不覆盖，输出冲突计数。保留期外报告拒绝，不重放播放接口。导入不能补回旧日志的网络/平台/release字段。

## 工程师先做的检查

- Railway中确认 `drama.frontend_timing` 的version/context；对应 `drama.timing_persisted`，不能只看HTTP200（开关关闭时200仍只是日志模式）。
- 按observation_id合并start/slow/final/network；网络尾报告不能增加播放样本数。按queries.attempts.requestId查询后端 `drama.request_timing` 的auth/db/sign，upload_request_id不是播放请求ID。
- 检查网络能力、首帧方式、长任务支持/截断；no_entry/limited不算零TTFB，旧版本不填新字段。
- 真机对比资源瀑布与被动条目，确认TAO/Range交付能力；TTFB不等于视频payload首字节，不自动知道Range区间/CDN命中。iOS/Android各自记录结论。

## 用户真机验收（TEST／本分支Preview部署后）

每组记录手机系统、Telegram版本、北京时间、操作顺序；不用发送鉴权数据或视频签名URL。工程师按时间窗口找到观察ID，再回看独立短剧看板。

1. 打开本次TEST／Preview入口，点击一部剧，等画面开始移动。记录点击至看见画面的体感时间。工程师核对start/final各一、首帧与启动完成分开、release与部署一致。
2. 连续切换两集，再上下滑切换短剧。确认旧视频不会继续发声；各次ID独立，旧事件/请求不混到新剧。
3. 若遇自然慢样本，先等超过10秒，不立即重试，尽可能等到成功或错误；记录“黑屏/首张画面已出现/是否转圈”。工程师核对slow与final只算一次，以及主要等待段和可见网络/缓冲证据。未遇40秒异常不代表已修复。
4. 在加载中切到后台约2秒再回来。工程师确认本次以background结束，不把后台时间算慢播放；恢复不补算上一观察。
5. 若出现“点击播放”兜底，记录后手动播放。自动播放受限结果应单列，手动恢复不覆盖原终态。

先完成一台设备，再在另一平台复跑。模拟测试/本机浏览器不能替代Telegram的媒体计时与自动播放限制验证。
