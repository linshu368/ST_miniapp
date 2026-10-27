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
