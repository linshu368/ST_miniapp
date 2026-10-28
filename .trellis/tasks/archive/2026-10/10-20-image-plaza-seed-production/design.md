# 技术设计（待审核）

## 2026-10-20 Storage 执行修订（用户已授权，覆盖历史候选方案）

- 当前根目录为 `G:\JobLib\ST_miniapp`。复用既有 manifest、dotenv 和 Node 原生 fetch/crypto/fs，不引入依赖；新增单用途离线脚本，不修改应用/RPC/schema。用户要求使用 `.env`，因此改用 Storage REST API 而非未安装的 rclone/S3。
- 两端 URL 精确校验固定 ref；私有桶实测均允许三种图片 MIME 和 50 MiB。直连 ECONNRESET，通过已有 Windows 本地代理成功；不关闭 TLS、不输出代理/密钥/响应正文。
- 默认 6 路 worker，每个对象先本地下载/hash，再只新增上传、生产回读/hash。先代表性 12 张（含最大文件及三种 MIME）canary，通过后同批继续。下载、上传、回读各请求 120 秒，单操作最多 3 次；已用时超过 270 秒不再发起下一轮重试，但当前轮最多三个请求仍有各自期限，因此不是 400 秒硬截止。429 停止新任务，其他瞬时错误退避。每个 worker 按序处理，内存有界于 6 路×50 MiB 文件及读取/上传/校验缓冲副本。
- POST 使用 x-upsert=false；已有对象必须全量回读与本地 SHA-256/大小/MIME 一致才跳过。上传结果未知时先查目标，不盲目覆盖；唯一路径与 Storage 原子拒绝重复保护并发。不存在跨对象事务，失败保留已验证进度，停止派发新对象并等待在途请求结束。
- 本地临时文件成功后才 rename，hash sidecar 绑定 manifest；恢复重新核验本地 hash，生产已验收对象仍回读确认。单实例锁防止本机重复运行；异常退出的锁仅在 PID 不存在时人工移除。生产/源路径不可由其他写入方改写。
- 不执行 SQL，不创建 bucket，不改权限，不删除任意远端对象。回滚即暂停并保留图片，后续清理另批；业务仍不可见直至独立 SQL 导入。
- 原导出已经被历史提交跟踪（与原规划不符），恢复 ignore 保护新增图片/日志，不自动删除历史或改写 Git。manifest CRLF 规范化后 hash 匹配，SQL/payload hash 及 8032 路径一致；原始文件不修改。
- 风险要求本地隔离 mock 回归：重复、内容冲突、缺失、上传结果不明、MIME/大小不符、超时/429、损坏本地缓存。先运行脚本语法、回归及相关既有验证再生产 canary。全量结束前不能声称迁移成功。

## 复用调研

### 2026-10-21 已批准的仅补传续跑

- 用户明确要求跳过历史已验收对象的远端复核。复用 `stageObject` 本地 hash/manifest/MIME 校验及既有 sidecar，增加显式 `--resume-verified`；默认完整回读不变，不增加状态源、依赖或公开 API。无组件/hooks/contracts/schema 变化。
- 仅接受同一清单、匹配 byte_size/MIME、合法 SHA-256、有效且非未来的 production_verified_at、已知成功 outcome 的 receipt；本地缓存仍快速校验。缺少验收时间继续原上传/回读流程，非法验收记录停止，不静默视为完成。历史 receipt 由固定 TEST/PROD 脚本产生，不引入可配置目标。
- `prior_verified` 单列计入 completed/bytes，`verification_mode` 明确累计验收口径；不改写跳过项的原验收时间。风险是无法发现验收后被外部改写/删除的远端对象；不声称本轮全量实时回读。仅用于本批可信本地记录。
- 原有限超时/重试、429 停派、无覆盖、单实例锁、在途上传未知结果回读对账不变。Windows 当前 worker 通过定向终止切换，先确认 PID 退出再归档锁；当前仍为只读复核，无业务事务/补偿。保留历史报告与失败记录。恢复默认方案只需去掉选项，禁止删除对象。
- 在既有测试文件追加成功/无凭证/清单及大小不符/无效时间等失败回归；语法、既有脚本测试、backend typecheck、shared/backend 测试和格式检查后启动。实况验证 prior_verified 快速推进且新上传对象仍回读；监控消费者兼容 completed/bytes 并保留模式字段。无部署/契约/数据库行为变更，不重复无关 frontend build（已有缺依赖故障记录）。

仓库根目录：`D:\codeReposity\wq\ST_miniapp`。以下路径相对此根目录。

- `scripts/export-image-plaza-seed.mjs`：复用受限 TEST 目标校验和一致性只读导出，不另造导出器。
- `packages/shared/migrations/20261019_image_plaza_seed_bootstrap.sql`：复用单事务、来源锁、冲突拒绝及原 RPC；不改历史模板、不直接复制主键。
- `packages/backend/src/features/image-plaza/seed-import.ts`：已检查原导入链路；不直接使用它重抓 Civitai，因为需要保留当前 snapshot/标签且复用 TEST 自有图片。
- `ops/image-plaza-seed-migration.md`：复用 manifest 限定、S3 目标校验及 SQL 门禁；该历史说明仍采用远端复制后双端回读。本任务改为 TEST 本地暂存/hash、上传及生产回读，不照搬历史复制命令。复制前 dry-run，不使用 sync，不直接写 storage.objects。
- 已检索 `import_image_plaza_seed_work`、生产环境配置及 rclone 入口；组件/hooks/contracts 无改动需求，不增加 API 或服务层。
- 关联模块为 database.business.conversation-storage、database.infrastructure.schema-security；当前仅规划，无模块行为变更。

## 数据边界与顺序

既有 experience 域作品/artifact 由受限导入 RPC 权威新增，Storage API/S3 写入真实图片及其元数据。沿用作品软删除生命周期、Backend 广场消费者及既有跨域依赖，不新增表/函数/迁移。

核对生产账本及实际 shape → 前置 migration 如有缺失走现有 workflow 逐文件审批 → 代表性小批验证 → manifest 范围 TEST 图片下载到本地并固定 SHA-256 → 缺失对象上传 production → 全量生产回读并比较本地 SHA-256、大小/MIME → 实际 seed.sql → 业务验收 → 初始排序迁移与对应 Backend 发布。

本地暂存位于上述导出目录下的 `storage-staging`，保留 bucket 内完整对象路径；manifest、进度和 hash 记录均留在 Git 忽略的受限目录。下载先落临时文件，成功校验大小后才标记完成；恢复时核验已完成文件 hash，只重试未完成项。本地副本在生产验收及恢复保留期确认前不得删除。生产回读可流式计算 hash，无需长期保存第二份图片；源对象在下载期间禁止并发改写，现有 manifest 无二进制 hash，不能证明导出时点与下载时点字节完全相同。

若 initial_feed_order 已执行，停止排序相关发布决策，明确接受新种子 NULL 排序或另审 forward-fix；不得重跑旧排序迁移。不复制 TEST 配置，生产模型可用性独立审核。

## 可靠性与最小充分方案

- 网络：rclone 连接/操作超时 120s、重试最多 3 次、低层重试 3 次、并发 2；执行前核对所安装版本的参数语义、退避及 429 行为，限流后降并发或停止，不无限重试。
- 幂等：manifest 固定本次范围；已有对象先与本地内容比对，差异停止。仅凭大小/ETag 或 `--immutable` 不足以证明相同；缺失对象才上传，上传后生产全量回读 SHA-256 与本地基线一致。禁止其他写入方并发改写本批源/目标路径；不再为最终校验重新下载 TEST。
- 数据库：单事务、来源 ID 锁、5s lock timeout、15min statement timeout；SQL 失败整批回滚，提交结果不明先核验，不自动重试。
- 容量：图片约 16.64 GB，SQL 28548456 字节；本地需完整副本及临时文件/日志余量，执行前重查 D 盘空间。TEST 出站约 16.64 GB、生产回读出站约 16.64 GB，合计约 33.27 GB（不含重试、既有对象预检和业务流量）。生产 WAL、磁盘和执行窗口独立评估。
- 降级：停在已复制图片阶段，不开放不完整作品；无自动降级写入。补偿仅处理本批实际新增内容，不能删除历史对象。
- 恢复：复制失败保留进度；数据库失败保留图片供重试。提交后需要撤回时，按受限批次记录定位新增作品，经审批软删除；图片待引用检查后另审清理。数据库备份不等于 Storage 图片备份。
- 可观测性：仅输出环境、阶段、数量、字节、耗时、受控错误码和摘要 hash；不输出业务行、凭据、签名 URL、完整原始错误。新增 ID/对象明细仅存 Git 忽略目录。
- 不添加运行时依赖、通用同步框架、后台队列或新的公开接口。优先外部运维工具；若需自定义复制器，重新审核设计及测试后实现。

## 当前证据与限制（2026-10-20）

- 导出目录 `D:\codeReposity\wq\ST_miniapp\ops\exports\civitai-1792484619774`，8032 works/artifacts，8032 条 prompt_zh，软删除排除数 0；hash、数量、清单一致性及 Git 忽略通过。
- TEST 配置目标匹配。PROD_DATABASE_URL/PROD_DIRECT_URL 存在但 URL 解析失败；未尝试连接。PROD_SUPABASE_URL 目标匹配不代表数据库连接成功；PROD_SUPABASE_SERVICE_ROLE_KEY 缺失。
- PATH 无 rclone/psql/docker；默认用户位置及 RCLONE_CONFIG 未找到 rclone 配置，未检查机器所有位置。
- MCP 已确认 production 项目健康、区域 ap-southeast-1、所属组织为 Pro；未通过本地客户端连接生产数据库，未由本任务执行 Storage 下载/上传或 SQL 导入。来源授权、备份恢复、费用容量、隔离演练、生产结构均未验收。
- 历史运维文档指向 10-19 导出目录，本次使用上列 10-20 新目录；历史文档不证明当前生产状态。
- Supabase 官方 Download Objects 文档确认 metadata 与文件实体分离，支持 S3 工具批量迁移：https://supabase.com/docs/guides/storage/management/download-objects 。

## 已选方案与明日交接（2026-10-20）

- 用户确认只记录本地暂存方案，2026-10-21 再处理；整体规划仍待审核，不 task.py start，不代表生产写入批准，不自动定时执行。
- production 属于 Pro 组织 `bgbntnwlpruugttkiajo`，三个可见项目共享组织额度。当前 MCP 看不到 TEST，直接查询返回 Project not found；这不证明 TEST 已删除，其组织/套餐仍未知。
- 用户报告已用流量约 193 GB、存储约 18 GB；所属组织、账期、缓存/非缓存、Storage/数据库口径均待核验。按其为生产组织当前周期非缓存出站及当前文件存储保守估算：250 GB 出站额度剩 57 GB；同组织本方案完成后约 226.27 GB，剩 23.73 GB；不同组织生产约 209.64 GB，剩 40.36 GB，TEST 另需约 16.64 GB 额度。存储约 34.64 GB，低于 Pro 100 GB，但不是零费用承诺。
- 参考非缓存超额 $0.09/GB；文件存储超额约 $0.0213/GB/月并按 GB-hours 计量。执行前复核 Dashboard 用量、Spend Cap、账期剩余天数、日常消耗及最新计费规则。参考 https://supabase.com/docs/guides/platform/manage-your-usage/egress 与 https://supabase.com/docs/guides/platform/manage-your-usage/storage-size 。
- 用户测速下载 20.84 Mbps（约 2.605 MB/s），单遍理论 106.4 分钟；上传未测，测速站不等于 Supabase 实测。上传分别为 5/10/20/50 Mbps 时，本方案纯传输约 10.9/7.2/5.4/4.3 小时，建议预留约 13–15/9–10/6.5–7.5/5–6 小时；不含工具、演练、审批、SQL 与业务验收，限流/断网可超出窗口。
- 用户报告 Dashboard 下载文件夹失败：`body/paths must NOT have more than 1000 items`，属于该请求路径数限制，不是容量或图片损坏证据。改用 manifest 限定的逐对象下载；不拆改源目录、不反复尝试整个文件夹导出。此前手工下载是否产生流量需以实际用量为准。
- 拒绝原远端复制＋双端重新下载：约 49.91 GB Supabase 出站，同组织假设下只剩约 7.09 GB，且无明确速度优势。拒绝来源站重抓：来源 URL 可变化/失效，无法直接证明与 TEST 字节一致，也不重建已有中文 snapshot/标签。
- 明日先复核凭据/工具/可用空间/源对象稳定性、上传测速和费用口径，补生产结构及隔离演练门禁；批准后用约 100 个不同格式/大小的代表性对象跑完整流程并记录阶段吞吐，作为正式批次的一部分保留进度。最终是否全量执行取决于样本结果、额度与独立审批。
