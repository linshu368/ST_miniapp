# Civitai seed：TEST 数据导出与生产初始化

## 2026-10-20 当前 Storage 执行入口

用户已授权独立 Storage 阶段；以下历史“未复制”和 S3 候选步骤不表示本轮进度。当前目录为 `G:\JobLib\ST_miniapp\ops\exports\civitai-1792484619774`，使用 `G:\JobLib\ST_miniapp\scripts\migrate-image-plaza-storage.mjs` 从本地 backend `.env` 读取固定 TEST/PROD 配置，无通用配置 fallback。MCP 仅核对生产项目与 catalog；实际文件通过 Storage API 下载到本地后上传，并逐项回读 SHA-256/大小/MIME。运行状态以暂存目录 receipt/report 为准，未完成全量时不能视为 Storage 已验收。SQL 未执行。

```powershell
node "G:\JobLib\ST_miniapp\scripts\migrate-image-plaza-storage.mjs" --execute --canary --concurrency 6 --system-proxy
node "G:\JobLib\ST_miniapp\scripts\migrate-image-plaza-storage.mjs" --execute --concurrency 6 --system-proxy
```

仅在本机确已配置可信 loopback 系统代理时使用 `--system-proxy`；当前 Node 24 支持原生环境代理。默认 6 路、最大 8 路；429/永久错误停止新任务，不覆盖/删除现有对象，不建立 bucket，不执行 SQL。单请求 120 秒、有限退避最多三次，上传结果不明先回读确认。保留 `storage-staging` 原图及 sidecar，重跑会核验本地 hash 和生产内容，不重复下载已有合格 TEST 副本。锁异常残留时先确认记录 PID 已退出再人工处理，不同时启动多个迁移进程。

新图片/日志已恢复 Git ignore；三个历史导出文件已被既有提交跟踪，与原文“整体被忽略”冲突，不能以新 ignore 消除历史。未经授权不改写历史；本轮不提交任何导出、图片或凭据。

2026-10-20 22:33 北京时间恢复记录：本机受限目录 `G:\JobLib\ST_miniapp\ops\exports\civitai-1792484619774\storage-staging` 中的 `resume-with-monitor.ps1` 包装原脚本，使用带时间戳的续跑日志，保持历史日志；独立监控每 30 秒检查子进程，退出时核对本轮最终报告并弹窗，日志 10 分钟无增长也弹窗。通知写入 `monitor-alerts.log`，进程信息见 `monitor-state.json`。该临时操作脚本及状态均 Git 忽略，不属于应用部署。弹窗测试已通过；仅本机开机、登录且监控仍运行时有效，未接入 Telegram/聊天推送，不提供重启后守护或自动恢复。迁移每 30 秒输出心跳，所以日志增长不能代替 completed/bytes 推进检查；完整验收仍以最终报告为准。

## 本次交付和边界

2026-10-21 02:14:08 北京时间，Storage 本批累计验收完成：`G:\JobLib\ST_miniapp\ops\exports\civitai-1792484619774\storage-staging\full-report.json` 为 success=true、8032/8032、failed=0、16637199531 字节。模式 cumulative_receipts：7195 项沿用历史回读验收、835 项本轮新增并回读、2 项本轮已有对象回读通过；不表示本轮重新远端验证全部对象。监控确认 exit_code=0、成功通知已触发、锁已释放。SQL 未执行，签名访问/业务端验收仍需独立完成；本地副本与证据继续保留。

2026-10-21 用户批准仅补传：原迁移命令追加 `--resume-verified`，或本机监控脚本追加 `-ResumeVerified`。该选项保留本地 hash 校验，但对匹配清单且有合法生产验收 receipt 的对象不再远端回读；报告以 `prior_verified` 单列历史完成数，`verification_mode=cumulative_receipts` 表示累计验收，不表示本轮重新检查全部远端对象。未验收项仍使用无覆盖上传和生产回读 SHA-256/大小/MIME 校验。默认不带该选项仍全量复核。仅在本批记录可信且接受远端对象验收后变化不可检测的限制下使用；不得用该模式授权 SQL。

2026-10-19 只读 TEST（`zoqelpfhurwehlvypryl`）成功导出 8,032 个有效作品及对应图片元数据，软删除作品 0 个。图片总字节 16,637,199,531（约 15.49 GiB）。**没有写入 TEST/Production，没有复制图片，也没有验证生产结构。**

本次产物目录：`D:\codeReposity\wq\ST_miniapp\ops\exports\civitai-1792391831356`：

- `seed.sql`：含实际数据的单事务初始化 SQL，约 28.55 MB。
- `storage-manifest.json`：8,032 个待迁移对象的路径、MIME、大小、尺寸；不包含图片二进制或图片 hash。
- `summary.json`：导出时间、源环境、数量、字节、文件 SHA-256 和 TEST 列结构。

数据目录整体被 Git 忽略。Hex 编码仅为避免提示词引号/反斜杠/换行导致 SQL 拼接问题，**不是加密**；文件仍需按受限导出保管，不上传 Git、工单或公开网盘。

## 原初始化脚本到底写了什么

`D:\codeReposity\wq\ST_miniapp\packages\backend\src\scripts\import-image-plaza-seed.ts` 调用 `features/image-plaza/seed-import.ts`：

1. Storage API 上传到私有 bucket `image-plaza`。
2. 调用 `experience.import_image_plaza_seed_work`，原子写入：
   - `experience.image_plaza_artifacts`：自有路径/MIME/大小/尺寸/来源。
   - `experience.image_plaza_works`：作品内容，`artifact_id` 指向上表。

新导入同样走原 RPC，**生产生成新 work/artifact UUID 和 artifact.created_at**，不逐字复制 TEST 主键；源 ID、发布时间与内容保持。用户和 attempt 必须 NULL。
保留 tags、完整 snapshot（含 prompt_zh）、标题、模型、来源 URL/热度。不迁移用户、点赞、会话、生成任务、奖励、配置、旧 UUID 引用或孤立 artifact。新作品点赞为 0，来源热度不计入点赞。

## 重新导出（只读）

从已有本地配置读取 **TEST_DATABASE_URL**，不读取通用 DATABASE_URL 或 PROD 配置作为 fallback。支持经校验的 TEST 直连/官方 pooler；连接 20s、查询 120s，使用一致性只读事务。

```powershell
node "D:\codeReposity\wq\ST_miniapp\scripts\export-image-plaza-seed.mjs"
```

可用 `--env-file` 指定受限配置文件、`--output` 指定 `D:\codeReposity\wq\ST_miniapp\ops\exports` 下全新子目录。不要把连接串放到命令行。
缺少 summary 表示导出不完整，禁止使用。每次保留一套完整产物，不混用不同快照的 SQL/manifest。

## 生产 SQL 执行前门禁（本次不执行）

1. 独立确认目标为生产 `wbtsfzozlmurljvglhpn`、审批、备份/恢复窗口、来源授权与内容审核。
2. 逐环境核验以下前置 migration 的实际 shape、RPC、RLS/grant；迁移仍走现有手工 workflow，不能仅依据文件存在判断已执行：
   - `D:\codeReposity\wq\ST_miniapp\packages\shared\migrations\20261012_image_plaza_v2.sql`
   - `D:\codeReposity\wq\ST_miniapp\packages\shared\migrations\20261013_image_plaza_seed_catalog.sql`
   - `D:\codeReposity\wq\ST_miniapp\packages\shared\migrations\20261013_image_plaza_seed_large_assets.sql`
3. 生产模型目录与作品的 model_id、分辨率/比例兼容；价格和 feature flag 通过 Admin 单独审核，不复制 TEST runtime_config。
4. 按下一节迁移并验收真实图片。SQL 只读校验 Storage 元数据，不代替图片下载校验。
5. 用 `summary.json` 核对 SQL SHA-256；在隔离 PostgreSQL 环境演练新增、重复、冲突、缺图和中途失败回滚。**本次机器未找到 PostgreSQL/Docker，未完成实际导入演练，不应直接当作已验收生产脚本。**
6. 本批一个事务、5s 锁超时、15min 语句超时；低峰评估锁/WAL/容量。禁止与其他 seed importer 并发运行；若超出预算停止并重新审核分批方案，不随意删事务或超时。

核对文件 hash（PowerShell，仅输出 hash）：

```powershell
Get-FileHash -Algorithm SHA256 "D:\codeReposity\wq\ST_miniapp\ops\exports\civitai-1792391831356\seed.sql"
```

审批通过后由操作者使用已安全配置的 PostgreSQL service/密码文件连接；不要在命令行放 URL/密码。以下假设已创建并独立核验 `miniapp-production` service：

```powershell
psql "service=miniapp-production" --no-psqlrc --set ON_ERROR_STOP=1 --command "SET app.seed_storage_verified = 'yes';" --file "D:\codeReposity\wq\ST_miniapp\ops\exports\civitai-1792391831356\seed.sql"
```

`app.seed_storage_verified` 只是操作者确认，不是权限系统或自动核验的替代。**不要执行 Git 中的模板** `D:\codeReposity\wq\ST_miniapp\packages\shared\migrations\20261019_image_plaza_seed_bootstrap.sql`，其数据标记未替换，会安全失败；也不要把它当作普通 schema migration 记账。实际数据 SQL 的受控执行审批和 hash 留档独立进行，不为提交 Git 而塞入业务数据。

## Storage 迁移方法（独立步骤，本次未执行）

Supabase 官方明确：数据库 Storage 元数据和文件实体分开存储。**禁止 INSERT storage.objects 或仅复制 bucket 行来冒充图片迁移。**

参考：[下载与批量迁移](https://supabase.com/docs/guides/storage/management/download-objects)、[项目迁移](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)。

推荐操作方法：使用支持 S3 的迁移工具（例如另行安装的 rclone，不是项目运行时依赖），只复制 manifest 的对象。

1. TEST/Production Dashboard → Storage → S3，分别取得 endpoint、region 和最小权限访问凭据。TEST 只读；生产只允许所需 bucket 操作。密钥进入受限工具配置/secret manager，不能贴入本文、URL、命令行或日志。
2. 本地配置两个 S3 remote，分别命名 `seed-test` 与 `seed-production`。先在 Dashboard 和工具配置中复核项目 ref，禁止用项目切换猜测目标。生产私有 bucket `image-plaza` 应由审核过的 migration 建立，至少支持 50 MiB，MIME 允许 png/jpeg/webp。
3. 按 manifest 生成 files-from 文本，每行仅一个对象路径。bucket 名不计入路径；本项目路径本身以 `image-plaza/` 开头，所以不要擅自去掉这层：

```powershell
$dir = "D:\codeReposity\wq\ST_miniapp\ops\exports\civitai-1792391831356"
$manifest = Get-Content -Raw "$dir\storage-manifest.json" | ConvertFrom-Json
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines("$dir\storage-paths.txt", [string[]]$manifest.objects.path, $utf8)
```

4. 首先 dry-run：不要 `sync`/删除源，也不要覆盖目标既有不同内容；有冲突停止审查。

```powershell
rclone copy seed-test:image-plaza seed-production:image-plaza --files-from-raw "$dir\storage-paths.txt" --immutable --transfers 2 --checkers 2 --timeout 120s --retries 3 --low-level-retries 3 --dry-run
```

5. 独立批准存储写入、流量费用和容量后，以同一命令移除 `--dry-run` 执行。复制失败不会写业务表；保留进度，按同一 manifest 重跑。工具配置应保留正确 Content-Type（image/png、image/jpeg、image/webp）；逐对象对照 manifest 的字节/MIME，不能只看对象总数。
6. 真实内容校验：

```powershell
rclone check seed-test:image-plaza seed-production:image-plaza --files-from-raw "$dir\storage-paths.txt" --one-way --download --checkers 2 --timeout 120s --retries 3 --low-level-retries 3
```

`--download` 会读取两端文件比较内容，避免把 multipart ETag 当 SHA-256；本批复制约16.64GB，双端下载验收还有额外流量，先确认费用。对象缺失、大小/MIME/内容不同均停止，不开启 SQL 门禁。测试期间源图片不应被重写；若发生变化重新导出并审核快照。7. 抽样通过生产 Storage 签名 URL 实际加载图片（包含 >20MiB 的大图），验证私有桶访问；签名 URL 不入日志。完成后才进行 SQL 初始化。

## 幂等、验收与恢复

- 相同 source ID 已存在：比较完整内容、路径、格式、尺寸、来源和发布时间，一致跳过；点赞保留生产值。
- 已软删除或任何内容不同：报错，整笔回滚，不复活/覆盖。孤立 artifact 唯一冲突也回滚，需人工调查。
- SQL 未提交：所有 work/artifact 插入回滚，图片保留供重跑。结果未知：先查询本批 source IDs 的存在及内容，确认后再重跑，不盲目强制。
- SQL 提交后：核对 inserted/unchanged、有效作品和关联计数、广场详情、中文 prompt、标签筛选、用同款、点赞；不要只看 SQL 返回成功。
- 撤回优先对**本批实际新增**作品做经审批软删除，不能对全部 civitai_seed 一刀切。不删除已有作品或有用户会话引用的对象；图片清理必须确认所有引用与来源，再独立审批。

## 已完成验证 / 未完成验证

已完成 TEST 只读导出、两表来源/关联检查、源列结构采集、文件生成和 Git 忽略。SQL payload 采用十六进制 JSON，完整保留微秒级 published_at，不输出业务内容。SQL/payload/manifest/模板 hash 和 8,032 项路径/大小校验通过；8,032 条中文提示词完整保留，10 张图片超过 20 MiB。node 语法、migration 命名、shared typecheck、shared 16 文件/163 测试、git diff --check 通过。
未执行生产连接、Storage 复制或真实文件下载；没有本地 PostgreSQL，SQL 实际执行/幂等/回滚演练仍为发布门禁。TEST 列结构并非生产 schema 证明。
