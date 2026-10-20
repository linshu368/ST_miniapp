# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status  | Task                                              | Files / Scope                   | Depends On | Verification                                        |
| --- | ------- | ------------------------------------------------- | ------------------------------- | ---------- | --------------------------------------------------- |
| T1  | Done    | 确认种子范围并创建任务                            | PRD/任务元数据                  | -          | 用户明确同意规划预检                                |
| T2  | Done    | 核验重新导出产物                                  | Git 忽略的导出目录              | T1         | 8032 条，四类 hash、清单、数量通过                  |
| T3  | Done    | 本地配置和工具存在性检查                          | 不输出 secret                   | T1         | TEST 匹配；PROD URL 无效；PATH 缺工具               |
| T4  | Blocked | 准备有效生产 DB 与 S3 受限配置                    | 用户本地安全配置                | T3         | 目标校验、TLS、权限验证                             |
| T5  | Todo    | 只读生产结构/账本/bucket/冲突预检                 | 生产只读连接                    | T4         | shape、ACL、checksum、排序状态及聚合                |
| T6  | Blocked | 准备工具与隔离演练                                | rclone/psql/PostgreSQL          | T3         | 版本完整性与失败路径矩阵                            |
| T7  | Todo    | 规划审核及独立生产写入审批                        | design/implement                | T5,T6      | 来源、恢复、容量、费用、窗口确认                    |
| T8  | Doing   | 小批与全量 TEST 本地暂存/hash、上传、生产回读验收 | Storage API 与受限本地目录      | 本轮独立 Storage 授权 | canary 12/12 通过；全量 6 并发运行，最终报告待验收 |
| T9  | Todo    | seed.sql 导入及提交核验                           | 生产两表/RPC                    | T8         | 新增+跳过=8032、无部分写入                          |
| T10 | Todo    | consumer 人工验收、排序顺序及留档                 | 广场与运维文档                  | T9         | 详情/筛选/用同款/点赞/大图                          |

## Execution Log

- 2026-10-21：用户改为要求交付 SQL 文件自行执行。复用已校验的 8032 条原始 seed.sql，手动交付文件只增加事务内 Storage 验收标志和说明，不更改数据/导入逻辑；文件位于 `G:\JobLib\ST_miniapp\ops\exports\civitai-1792484619774\manual-import`，保持 Git 忽略。生产 TLS 预检失败 SELF_SIGNED_CERT_IN_CHAIN（系统 CA 同样失败），结构/冲突预检及隔离演练未完成；未执行生产业务 SQL，手动交付不代表门禁通过。
- 2026-10-21 02:14:08 北京时间：Storage 累计验收完成。最终 `full-report.json`：success=true、completed=8032、failed=0、bytes=16637199531、verification_mode=cumulative_receipts；7195 项沿用历史生产验收，835 项本轮新增上传并回读，2 项本轮已有内容回读通过。02:14:17 触发完成弹窗，monitor-result success=true/exit_code=0；进程正常退出、migration.lock 已释放。按用户要求未重新远端复核历史验收项，不证明其验收后未被外部改写；未执行 SQL，签名访问及业务 consumer 验收仍独立待办。报告目录 `G:\JobLib\ST_miniapp\ops\exports\civitai-1792484619774\storage-staging`，保留缓存/receipts/历史日志，不提交数据。
- 2026-10-21 01:51:17 北京时间：仅补传模式已恢复，监控 PID 8168、迁移父进程 PID 39284。实况约 11 秒沿用 7193 项验收，无重复远端回读；01:51:39 累计 completed=7200、bytes=14958409129、prior_verified=7193、created=5、existing=2、failed=0，确认已进入剩余补传及回读阶段。日志为 `G:\JobLib\ST_miniapp\ops\exports\civitai-1792484619774\storage-staging\resume-20261021-015117.log`。语法/10 项回归/格式/typecheck/git diff --check 已验证；无 SQL、无提交/push。
- 2026-10-21 01:49 北京时间：用户要求不再重复远端复核，改为仅补传。定向终止 lock PID 11788，当时 completed=2100、created=0，尚处只读复核阶段。确认 worker/父进程/监控均退出后归档旧状态、失败证据及残留锁，再清理锁。加入显式 `--resume-verified`，保留本地 hash 校验与未验收对象生产回读；已验收对象按 prior_verified 计入累计报告，不冒充本轮远端验收。10 项脚本测试、语法、Prettier、Backend typecheck 通过；Shared/Backend Vitest 启动因 node_modules 缺少 @jridgewell/sourcemap-codec 失败，未修依赖。恢复监控同时持有子进程 Handle，避免 ExitCode 丢失为 null；旧 monitor-result/report 必须按 started_at 区分，不作为本轮状态。
- 2026-10-20 22:33:59 北京时间：按用户要求恢复 6 并发/system-proxy 全量迁移。独立 PowerShell 监控 PID 39252、迁移父进程 PID 26892；启动门禁确认无同脚本 Node 实例且无残留 migration.lock，未删除锁。历史 full-run.log 保留，新日志为 `G:\JobLib\ST_miniapp\ops\exports\civitai-1792484619774\storage-staging\resume-20261020-223359.log`。22:36 检查两进程存活，重新生产回读 725 项、756038998 字节、0 失败、尚未新增，不能与上轮 2739 项相加。
- 停止通知：受限暂存目录内 `resume-with-monitor.ps1` 每 30 秒检查迁移父进程，退出后严格检查本轮 full-report 的时间/成功/8032 项/0 失败/16637199531 字节；失败或完成均 Windows 弹窗并留 monitor-alerts.log。10 分钟日志无增长也提醒，但脚本有心跳，日志新鲜不等于对象推进。已执行 3 秒弹窗测试（返回 notification_test_ok），迁移 9 项既有回归再次通过。通知只覆盖本机在线登录且监控未被关闭的会话，不保证关机、注销、监控被杀时通知；未配置 Telegram/手机推送，不承诺聊天主动通知。不自动重启、不执行业务 SQL。
- 2026-10-20 当前会话：用户已授权立即进行 Storage 独立阶段，使用 `.env` 和 MCP、有限并发；不含 SQL。两端 Storage API bucket GET 200、private、50MiB、三种 MIME；本地系统代理可用，直连 ECONNRESET。G 盘约 444GiB 可用。现有导出已被 Git 跟踪，恢复 ignore 仅保护新文件。执行方案以本轮 design/implement 顶部修订为准。
- 2026-10-20 12:40–12:41 UTC：6 并发 canary 完成 12/12，117930537 字节，12 个新增，0 失败，耗时约 68 秒，最大文件 47296429 字节。每项均已生产回读验证；无 SQL。报告在 `G:\JobLib\ST_miniapp\ops\exports\civitai-1792484619774\storage-staging\canary-report.json`。
- 2026-10-20 12:41 UTC：启动 8032 全量、6 并发，沿用 canary 本地文件；进度日志 `G:\JobLib\ST_miniapp\ops\exports\civitai-1792484619774\storage-staging\full-run.log`。最终以 `full-report.json.success=true` 且 completed=8032/bytes=16637199531 为准，不得以进程启动宣称完成。
- 本地验证：离线迁移 9 项隔离 mock 测试通过；Shared 16 文件/169 测试通过；Backend 91 文件/723 测试通过；全仓 `pnpm -r typecheck` 通过。build 结果另外记录。本轮没有重跑原 importer、没有改 bucket/ACL、没有执行 migration/SQL、没有提交或 push。
- build 验证：Admin 成功；Frontend 的 Next.js 安装依赖报 `Cannot find module './impl'`（来自 node_modules 的 webpack-build），全仓 build 因此失败。未修改前端/依赖锁文件，不为离线迁移顺手重装依赖。脚本语法、9 项测试复跑、Prettier 和 git diff --check 均通过。该构建问题不影响已单独运行的 Node Storage 迁移，但不能宣称全仓构建通过。

- 2026-10-20 初始预检：任务保持 planning，未 task.py start。当时未连接生产、未复制 Storage、未导入 SQL。
- 数据目录：`D:\codeReposity\wq\ST_miniapp\ops\exports\civitai-1792484619774`。
- 待补有效生产连接与 S3 凭据；不在聊天收集密钥，不猜测 URL 修复。
- 2026-10-20 后续只读调研：MCP 已确认生产项目健康及 Pro 组织元信息；TEST 不可见不等于删除。生产数据库结构/账本与业务仍未验收。
- 2026-10-20 用户选择“TEST 本地暂存再上传”，要求记录规划并留到明天（2026-10-21）处理；已更新 PRD/design/implement/元数据，未启动传输或生产导入，无自动定时任务。
- 用户报告下载 20.84 Mbps、流量已用约 193 GB、存储约 18 GB；上传、账期和用量口径待核实。费用/时间条件估算见 design，不视为实测迁移或零费用保证。
- Dashboard 文件夹下载报 paths 超过 1000 项；改用固定 manifest 逐对象下载，不拆改源路径。历史 ops 文档仍是远端复制＋双端回读，本任务执行以已选本地暂存流程为准，正式执行留档时再同步运维文档。

## 2026-10-21 恢复入口（非自动执行）

1. 重读本任务五份规划文件，确认仍无下载/生产写入授权，保持 planning 直到整体审核完成。
2. 解决 T4/T6 凭据、工具及隔离演练阻塞；复核空间、上传速度、TEST 访问/归属、双方额度与源对象稳定性。
3. 完成 T5/T7 结构、来源、恢复、费用和独立审批；补审 hash/回读/MIME/进度的实际工具命令或脚本。
4. 获批后约 100 对象全链路样本，按实际吞吐/重试估算全量窗口；通过后继续同一批次，不重复下载已验收 TEST 文件。
5. 8032 个生产对象全量内容验收后另批 SQL 导入；任何冲突/限流/额度不足停止，不绕开门禁。
