# 实施与验证记录（2026-10-27）

## 交付位置与范围

隔离工作区 `/Users/qj/.codex/worktrees/drama-playback-monitoring/ST_miniAPP`，分支 `codex/drama-playback-monitoring`，基于最新抓取的origin/dev 39a3f799；原main与用户未提交的短剧时间修正未修改。用户审阅通过主方案，明确短剧独立新看板，不混入已有经营/首token看板；UI固定短剧组/文件体检/告警/离线补传未纳入。

实现：v1兼容/v2契约，轻量start、被动资源和帧/长任务摘要、有界网络尾报告；可选短超时分析持久化、SQL原子合并/ACL/保留期；独立Grafana JSON `st-drama-playback`；有界dry-run导入；发布与真机runbook。环境开关默认false，未改视频交付和播放策略。

## 本地已通过

- Node v22.20.0、pnpm9.15.9，独立安装锁定依赖并生成Prisma Client，未修改lockfile。
- shared全量17文件/180 tests；Frontend全量58文件/451 tests（后续新增观察器故障/长任务裁剪回归另跑相关三文件）；Backend全量105文件/984 tests。
- 相关Frontend/Backend回归覆盖40秒等待、首帧先于playing、能力缺失、迟到网络、src隔离、冻结快照、观察器故障清理、开始延后、持久化失败/并发帽与导入白名单。最终Frontend相关三文件46 tests通过，随后Frontend生产build再次通过；导入器合成NDJSON dry-run通过（1记录、0无效），未写远端。
- `pnpm -r typecheck`通过shared、ui-tests、reply-renderer、backend、admin、frontend。
- Frontend lint、全仓import guard、migration文件命名检查通过。既有img告警/Browserslist提示未扩范围处理。
- `pnpm -r --if-present build`通过：有build脚本的Frontend与Admin；Backend没有build脚本，以typecheck验证。Admin既有chunk大小提示保留。
- 本机Docker未运行，改用隔离本地PG17 cluster，不接触远端数据。`bash scripts/test-drama-observability-local.sh`验证重复迁移、并发start/final、重复/冲突终态、NULL/0/逆序、网络补充、保留期、匿名拒绝/reader只读。
- 全部看板与变量SQL在5万条合成观察上按真实reader执行、每条5s预算通过；这是合成容量检查，不是生产性能结论。未启用cron。
- Trellis模块载荷校验通过，模块更新作为module-updates.json待最终归档；文档/迁移源与看板独立UID已同步。

## 远端状态与明确缺口

- 未推送、未创建PR、未运行远端migration或部署。TEST与production必须独立核验shape/权限/容量；开关启用前后ack语义见runbook。
- Supabase MCP对配置中的TEST ref返回Project not found；用本地既有TEST连接只读核验时连接未成功，未执行DDL/DML、未读业务行。故没有伪造目标schema实况。
- Grafana Cloud插件现已连接指定stack。已核对PostgreSQL数据源UID fg1oltvmm56v4b，连接数仍为1；reader非superuser/非BYPASSRLS，角色连接上限3。只读catalog检查确认生产新表/视图均不存在，未读播放业务行、未修改数据源。
- 已创建独立线上看板 https://ea3213527545.grafana.net/d/st-drama-playback ，UID st-drama-playback、version 1、folder ag1okgop6om4gb；overwrite=false。已有经营看板摘要一致，未改其他看板。
- 线上为标注“待部署接入”的骨架：12个统计面板暂未带业务targets，查询变量暂为静态；空白不表示0。读回配置成功，结构就绪面板SQL经Grafana /api/ds/query返回两个“待迁移”。正式查询仍以docs/grafana/drama-playback.json为准，需迁移发布后逐一启用、查询与验收真实渲染。尚未确认浏览器渲染，不宣称线上采集闭环完成。
- 用户确认可以协助真机，具体步骤已在docs/grafana/drama-playback-runbook.md。待本分支TEST/Preview部署后，由用户执行；iOS/Android TAO/Range可见性仍未验证，状态unknown是实现要求，不据本机结论冒充真机。
- 未导入生产旧24h数据；导出完整性须核验后用manifest声明，不能用截断日志抽查代替全量。

## 下一步

允许推送后创建面向dev的PR，先完成TEST单文件迁移和Preview；用户按runbook真机验证。生产发布/迁移按仓库流程独立确认。Grafana骨架已创建，发布门禁通过后在同一独立UID启用正式配置，先读回当前版本，只更新此看板并逐一验收查询/渲染。

## 生产发布授权与执行（2026-10-27）

用户明确选择跳过TEST采集验收，授权直接合main并执行production迁移；原TEST/真机门禁本次不执行，不将其写成通过。为保持线上业务，仍执行本地整合验证和生产shape/权限只读预检，持久化开关迁移前关闭。生产baseline为main a9881bac，仅cherry-pick监控提交至codex/drama-playback-production，保留上游所有业务行为。

生产预检：miniapp_analytics owner postgres；新表/视图/reader均不存在；grafana_cloud非super/BYPASSRLS；service_role已有BYPASSRLS。Railway production stminiapp追踪main、现有部署SUCCESS，无待应用改动，未设置持久化开关（默认关闭）。数据库写入只涉及本功能新增分析对象，无业务表/FK/触发器改动；清理job初始关闭。

最新main整合复验：`pnpm -r typecheck`、shared 180 tests、Backend 984 tests、Frontend 453 tests及Frontend/Admin生产build全部通过；未改产品代码。发布前production `/health`返回200/status ok。

发布PR #510已合main，commit 1291605c；原PR #509已关闭，避免重复进入dev。production初次迁移run 40508353977失败于UPDATE cron.job权限；BEGIN内未COMMIT，断连回滚，只读确认新表/视图NULL。production catalog确认cron.alter_job存在且postgres可执行。保留失败文件/认领原checksum，以自包含forward-fix恢复，不改历史文件、不伪造成功账本；持久化仍关闭。

## Production 生效结果（2026-10-27T21:14:03+08:00）

- main已合PR #510（1291605c）及cron兼容修复 #513（09da8b01）。修复PR Quality Gate/Docker/Vercel全部通过；自动review仍因上游API402无报告，未记为审阅通过。
- Database Migration run 40509042505成功COMMIT并记账20261027_drama_playback_observability_forward_fix.sql；checksum f97a543117966af3c14527b6df6737a1e9e44a8de6e8ef10e42a047441c1e3c0。原失败run40508353977和认领保留，不改checksum。
- 实际生产对象/ACL核验：table/view存在、RLS开启；Grafana view SELECT=true，INSERT/RPC=false；anon SELECT=false、authenticated INSERT=false；service_role INSERT/RPC=true。
- 生产12面板+6变量SQL全部通过；独立UID st-drama-playback已更新version2，实际Image Renderer已确认有数据渲染；经营看板摘要保持不变。
- Railway stminiapp deployment3b6e3a4c-5718-402d-91d7-1c5d8a519523 SUCCESS（09da8b01）。只核对非敏感配置：DATABASE_ENV/NODE_ENV=production、project ref正确、DRAMA_TIMING_PERSIST_ENABLED=true；前端09da8b01部署成功。
- 后端health200/status ok；实际FRONTEND_URL https://app.themijing.com 的OPTIONS预检204，/dramas页面200；无鉴权遥测POST401。采集失败日志初查0条。
- 初始真实v2观察已入库；最后渲染快照6次观察/5终态/2成功/3autoplay_blocked/1未完成，2成功有完整启动计时；前后端release均09da8b01。只证明采集闭环，不推断性能分布或罕见慢事件消失，不替代用户已跳过的真机验证。
- 发布期间48个5xx均为两个临时Vercel Preview源被既有CORS拒绝的OPTIONS，非播放/遥测失败。诊断时另用未配置的默认Vercel别名探测产生1次相同拒绝；按实际配置域名重验204，未放宽CORS或改业务功能。
- 清理job通过官方cron.alter_job保持inactive；尚未启用定期清理、未导入旧生产日志。后续需按实际容量启用清理并在采样窗口成熟后分析。

本次用户授权的production上线已完成。详细事实先记在本发布分支与PR #513结果区，避免为纯验收文档再次触发生产重部署。
