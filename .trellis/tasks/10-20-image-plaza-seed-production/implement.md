# 执行计划（待审核，禁止生产写入）

2026-10-20 用户已选择 TEST 本地暂存方案，留到 2026-10-21 继续处理；本次只更新规划，不下载、不上传、不导入、不安排自动执行，任务保持 planning。

## 门禁与执行

1. 用户在受限本地配置修正 PROD_DATABASE_URL（明确生产 session pooler/直连，保持 TLS），准备 TEST/production S3 凭据。不得在聊天、命令行或 Markdown 粘贴秘密。先校验目标再连接，不用通用 DATABASE_URL fallback。
2. 安装/确认 rclone、psql 及隔离 PostgreSQL 演练环境；验证来源、版本、安装包完整性。不因缺少工具改用生产演练。
3. 生产只读事务预检：连接 20s、语句 120s、锁 5s；核对两表列/约束/索引/FK、RLS/ACL、RPC 定义及 search_path/授权，前置迁移账本 checksum、初始排序状态、私有 bucket 50MiB/MIME。MCP 不读取业务行；业务聚合和冲突预检通过已校验本地客户端，结果不输出明文内容。
4. 独立审核模型/分辨率兼容、来源内容权利、低峰窗口、备份恢复点、容量及流量费用；记录本批目标已有作品/对象，供后续区分新增与跳过。重查本地可用空间（至少 16.64 GB 加临时文件余量）、用户 193 GB/18 GB 用量口径、TEST 所属组织/额度、账期剩余天数和日常流量、Spend Cap。补上传测速，20.84 Mbps 下载仅作估算，不能代替真实小批吞吐。
5. 隔离数据库演练本模板新增、相同重复、不同 snapshot/标签、软删除、缺图、孤立 artifact、RPC 拒绝、锁等待/超时、批次中途失败。断言失败零部分写入、已有点赞不变、重复不新增。无需默认创建新测试文件，先复用现有回归入口；若需 harness 另行审核。
6. 规划审阅通过后再 task.py start；执行前另行确认生产写入。S3 remote 校验精确目标且仅操作清单路径，源只读。不自动创建 bucket 或调整权限。
7. 固定同一 snapshot 生成 storage-paths.txt，审核路径无越界及本地路径冲突；保留 bucket 内路径（含原有 image-plaza/ 前缀）。先 dry-run，用约 100 个涵盖不同格式/大小的代表性对象验证下述完整流程，样本计入正式进度，不重复传输；批准全量后顺序执行：
   - TEST → 本地 storage-staging：逐对象下载、核对大小并保存 SHA-256 基线；临时文件不算完成，失败有限重试，续跑核验已完成文件 hash。保持源对象稳定，不用 Dashboard 整文件夹导出，不从来源站重抓。
   - 本地 → production：先读取已有目标对象与基线比较；不同即停止，不覆盖。只上传缺失对象，保留 manifest 对应 Content-Type，不依赖本地扩展名推断作为验收证据。
   - production → 流式回读：8032 项全部校验 SHA-256、大小/MIME；不重新下载 TEST，不把 ETag 当 SHA-256。重复预检/重试额外出站必须计入预算；任一项失败不开启 SQL 会话标志。
   - 保存每阶段数量、字节、耗时、有限重试、失败清单和新增/跳过记录到受限 Git 忽略目录。禁止 sync/upsert/删除/冲突覆盖；SQL 失败保留本地和已上传图片。验收及恢复保留期确认前不清理本地副本。
8. 校验 seed.sql SHA-256 后通过受限 PostgreSQL service 执行；不记为 schema migration，不打印 SQL/业务内容。确认 COMMIT，而非仅凭 NOTICE 判断成功。
9. 验收新增+跳过=8032、作品/artifact关联、标签/中文提示词、已有点赞；签名图片加载含 >20MiB 图、广场详情/筛选/用同款/点赞。实际业务操作使用批准的验收身份，不随意产生账务。
10. 初始排序迁移未执行时按独立审核顺序执行；已执行不重跑。更新运维证据及相关文档，不提交业务数据。

## 可执行命令（有前置门禁，不代表已执行）

```powershell
node --check "D:\codeReposity\wq\ST_miniapp\scripts\export-image-plaza-seed.mjs"
git -C "D:\codeReposity\wq\ST_miniapp" diff --check
Get-FileHash -Algorithm SHA256 "D:\codeReposity\wq\ST_miniapp\ops\exports\civitai-1792484619774\seed.sql"
$dir = 'D:\codeReposity\wq\ST_miniapp\ops\exports\civitai-1792484619774'
$staging = "$dir\storage-staging"
# 仅在 remote、manifest、费用及工具版本已验收后 dry-run；不再远端直拷
rclone copy seed-test:image-plaza "$staging" --files-from-raw "$dir\storage-paths.txt" --immutable --transfers 2 --checkers 2 --contimeout 120s --timeout 120s --retries 3 --low-level-retries 3 --dry-run
# 仅在本地完整性/hash 和目标已有对象冲突预检通过后 dry-run
rclone copy "$staging" seed-production:image-plaza --files-from-raw "$dir\storage-paths.txt" --immutable --transfers 2 --checkers 2 --contimeout 120s --timeout 120s --retries 3 --low-level-retries 3 --dry-run
# 以上只展示候选复制命令，不得直接移除 dry-run 执行完整方案。
# 执行前补审所装工具的 SHA-256 基线、生产流式回读 SHA-256、MIME、断点进度及防覆盖步骤。
# immutable 不是内容验证或并发防覆盖保证；如需自定义脚本，先审核设计和失败路径测试。
# 仅在 Storage 完整验收和独立数据库执行批准后；service 必须事先安全配置并核验
psql "service=miniapp-production" --no-psqlrc --set ON_ERROR_STOP=1 --command "SET app.seed_storage_verified = 'yes';" --file "$dir\seed.sql"
```

## 验证适用性与停止条件

图片样本必须验证：下载中断不记成功、已有本地文件损坏被发现、目标同名不同内容停止、相同内容跳过、目标缺失补传、MIME/回读 hash 不一致停止、429/超时有限重试后暂停、重启仅处理未完成项。完成样本不等于批准 SQL。验证用的失败注入在本地/隔离目标进行，不破坏生产对象。

当前仅规划文档和已存在导出文件验证，无应用/契约变化，不以 typecheck/build 代替真实数据库演练；本阶段不运行无关包测试。如实现脚本、修改部署/数据库行为，则按规范补 shared 既有测试、相关消费者 typecheck、pnpm -r typecheck 和 build，并同步 README/架构/spec。

目标错误、无效凭据、权限漂移、账本不一致、模型不兼容、源变化、内容冲突、超时/限流、容量不足、未知提交状态均停止。不删除事务、不放宽约束、不 force_rerun、不自动删除图片。任何绕开既有门禁的方案必须重新审阅。
