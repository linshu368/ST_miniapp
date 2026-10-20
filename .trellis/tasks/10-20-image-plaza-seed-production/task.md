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
| T8  | Todo    | 小批与全量 TEST 本地暂存/hash、上传、生产回读验收 | manifest 范围 S3 与受限本地目录 | T7         | 8032 对象 SHA-256/大小/MIME一致，失败续跑与冲突停止 |
| T9  | Todo    | seed.sql 导入及提交核验                           | 生产两表/RPC                    | T8         | 新增+跳过=8032、无部分写入                          |
| T10 | Todo    | consumer 人工验收、排序顺序及留档                 | 广场与运维文档                  | T9         | 详情/筛选/用同款/点赞/大图                          |

## Execution Log

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
