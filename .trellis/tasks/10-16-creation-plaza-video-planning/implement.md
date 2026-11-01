# 执行计划（执行中）

参考：design.md（§ 编号）、prd.md（R 编号）、task.md（任务 ID）。
2026-10-26：补充列表加载 / 创作页生成的性能门禁与验证（R8.A/B/C，design §5.2–5.3、§8.1）。
2026-10-28：补充创作输入卡图片/视频联动修订（D25，design §2.6/§5.4），覆盖来源默认类型、参考图保留、视频 ready 操作和图片结果转视频。

## 0. 开工门禁

- [x] PRD/design 审核通过，ADR（design §2.1）通过架构评审（用户 2026-10-27 明确批准开始执行）。
- [x] B-MODEL-1 → D8：Seedance 2.0 R2V 映射到 `seedance-2-0-reference-to-video-basic`。
- [x] B-OPT-1 → D9：视频关闭自动优化提示词。
- [x] B-FFMPEG-1 → D10：安装 ffmpeg。P3 里记录镜像体积和构建耗时的前后对比。
- [x] B-ENV-1 → D12：先在 test 执行。每次执行前在记录里核对连接目标，并采集结构快照（只读，不读业务行）。
- [x] B-SEED-2 → D14：视频提示词不设字数上限，图片不变。
- [ ] B-SEED-1：main/Production 私有 bucket 的实际剩余配额、出网/存储成本与 4,000 组资产上传授权已确认。源 Top 4,000 已估 40.599GiB；仍须用 10 条 canary 的真实处理倍率外推视频 + poster + 恢复余量后再次确认，不能只按源 Content-Length 开跑。
- [x] 当前在 `feat_video_park`，已合并最新 `dev`；PR 目标为 dev。
- [x] 测试文件范围：本任务涉及计费、并发、契约、迁移，规划确认**需要**回归测试，清单见 §3。审核批准后才创建测试文件。
- [ ] P0 性能基线已写入任务记录（feed / studio ready / image_generate），否则不得将“退化 ≤10%”当作门禁。

## 1. 分阶段交付

### P0 证据与基线（T1）

- 用 Venice test key 对 6 个模型的 t2v/i2v/r2v 各调用 1 次 quote，整理成价格矩阵草案。
- 每个模型做 1 次 queue canary，实测以下内容：
  - 耗时；
  - 返回的是 `download_url` 还是 mp4；
  - 输出编码，以及能否被 ffprobe 解析；
  - 拒审路径。
- **性能基线（纯图片，对照 design §8.1）**，Telegram iOS/Android 各测，冷/热各 ≥20 次，记录 p50/p95：
  - 列表：`GET /api/image-plaza/feed` 前端 `api.request.duration` + 后端 `http.server.duration` + `/create` 的 `page.ready.duration`；
  - 创作：studio `page.ready.duration`、`action.feedback.duration(image_generate)`、`/quotes` 与 conversation GET；
  - 注明是否命中 feed/config 缓存、签名 LRU 冷/热。
- 同步确认：`prefetchImagePlazaFeed` 仍未接线（实施落在 P5）、会话轮询仍为固定 2s（P5 改为退避）。

### P1 契约（T2）

- `shared/src/api/video-plaza.ts`，以及 `image-plaza.ts` 的兼容扩展（design §4）。
- 运行 `pnpm --filter @miniapp/shared test` 和 `pnpm -r typecheck`。

### P2 迁移（T3）

- M1、PostgREST 暴露与 `DOMAIN_SCHEMAS` 扩域已在 TEST、Production 完成；保留已执行 SQL 原文，不重跑、不纳入本次视频回滚。
- 后端图片、视频 repository 与 seed 工具统一通过 `getDomainDb('media_plaza')` 直连，删除 `plazaDb()` 探测、双读和旧 schema 回退。
- TEST 先只读核验 M1 shape、权限/RLS、3 个 RPC 与图片关键读写，再逐文件执行 M2、smoke、M3；每一步记录前后 shape、权限、锁耗时和关键读写。Production 的 M2/M3 另行审批。
- 新增独立 M4 forward migration：reference asset 增加 `source_image_artifact_id` FK/唯一索引和 service-role-only 幂等 RPC；禁止改写已执行的 M1/M2/M3。TEST 验证重复/并发/越权/非 ready/ACL 后，Production 单独审批。

### P3 后端视频链路（T4）

- 编写 `video-catalog.ts`、`video-upstream.ts`、`video-repository.ts`、`video-job.ts`、`video-media.ts`。视频不做提示词优化（D9）。
- Dockerfile 运行层（`node:20-bookworm-slim`）在现有 apt 命令里加 `ffmpeg`，并加构建期断言 `ffmpeg -version && ffprobe -version`。`video-media.ts` 在启动时探测二进制；缺失时报 error 日志，并隐藏视频模型；入库前 remux `+faststart`（D15）。
- 本地开发（Windows）需要 ffmpeg 在 PATH 中，或者通过 `FFMPEG_PATH`/`FFPROBE_PATH` 指定（经 `platform/config.ts` 读取），写入 README。
- 补齐路由（含 playback；按需 stream Range 代理）和 `@frontend-ready: false` 注释，同步 config.ts 环境变量。
- 先用 mock 上游验证失败路径，再接真实 canary。

### P4 读层、分享、Admin（T5、T6）

- feed 支持 media/tags 筛选；**游标** filter 哈希纳入 media/tags；新增 tag-counts（独立缓存，不阻塞列表）；详情支持视频；会话增加 `include_video`。
- **列表无 MP4 + DTO 裁剪**（design §5.2.B）：不返回长 snapshot / `video_url`；hydrate 视频卡只签 poster。
- **签名缓存**（design §5.2.C）：扩展 `storage.ts` LRU 至 `media-plaza-video` 的 poster/mp4；公开资源 24h；playback 重签写回同一缓存；补签名 cache hit/miss 单测。
- 确认 feed 后端 `http.server.duration` 可按 route 拆出；必要时补 pino 字段 `media`（低基数）。
- 视频分享 RPC 接入。
- 增加 `POST /image-artifacts/:id/video-reference`：只接收 path artifact id，调用 M4 RPC 返回 reference DTO；保留 `@frontend-ready` 注释、归属校验、稳定错误码和脱敏 pino 摘要，不接收 URL/storage path/user id。
- Admin 新增视频目录编辑器；标签改为统一图片/视频目录并增加分组、排序与 chip/grid 布局配置，参考价代理。
- Admin 视频目录按 D23 固定产品参数集合，加载旧目录时收窄能力并同步裁剪价格矩阵；不把 720P 补给实际不支持它的 Wan 3.0 Pro/MiniMax。
- 核实签名 URL 的 Range/206；若不支持则启用同域 `/stream`（design §5.1 接法 B）。
- route 的签名与播放源选择收口到 `VideoDeliveryProvider`；当前仅实现 Supabase progressive。DTO 预留 provider/format，保留 `video_url` 兼容；不提前实现 CDN SDK、映射表或 HLS 播放器。

### P5 前端（T7）

- 按 design §5.1–5.3 落地：广场、详情、工作室，以及 4 个新组件。
- **列表**：接线 feed 预取；筛选变更换 queryKey 并丢弃旧游标链；卡片只用 `<img>` 封面；网络面板断言零 mp4。
- **创作**：点「去创作」预取 config + studio 路由；quote debounce + 未过期复用；视频 attempt 退避轮询 + 隐藏页暂停；长会话避免固定 2s 全量 hydrate；播放地址走详情/playback 签名，不在列表预取。
- **参数**：Frontend 对运行时旧目录再次按 D23 过滤，默认值回落到过滤后的第一项；清晰度统一显示 720P/1080P，但 quote 保留 provider 原始大小写。
- **类型切换**：composer 顶部固定「图片 / 视频」；图片/视频草稿与设置分离保存。新建默认图片；图片/视频作品「用同款」分别初始化对应类型，query refetch 不得覆盖用户后续切换。
- **视频设置/目录**：设置顺序固定为时长、画面比例、清晰度、生成声音；视频模型只读 Admin 已发布 `video_models`，默认 Wan 3.0 Pro，回退需提示；视频不显示自动优化。
- **参考图保留**：把 reference 改成 retained/active 派生。切到不支持图片的视频模型时保留 preview/id、禁用新增上传并提示，quote/submit 传 null；切回支持模型自动恢复，用户显式删除才清空。
- **图片转视频**：`StudioArtifactCard` 新增按钮和 mutation；先确认存在支持图片的视频模型，再调用 artifact→reference 路由，成功后同会话切到视频并保留现有 video prompt，不自动提交。
- **视频结果操作**：回归编辑、下载、分享、重生成的回填、pending/error、防双击、归属和 Telegram fallback；编辑不提交，重生成必须重新报价。
- 新增 `video_generate` 埋点；核对 `WATCHED_PAGES` 含 `/create`、`/create/studio/:id`、`/create/work/:id`。
- 播放器只把可播放 URL 赋给 `<video src>`；禁止 `fetch`→`blob`/`createObjectURL` 作播放主路径。
- 增加 startup/seek 计时；详情/ready 卡仅对当前可见的单个视频启用 `preload=auto`，列表仍为零 MP4。参考网络下 startup 与 seek p95 都必须 ≤2s。
- 扩展 `packages/ui-tests` 既有 `@image` fixture/流程覆盖切换、图片/视频同款、reference 保留和图片转视频；不建立一次性 mock 后端。该完整创作流程应纳入后续本地重复验收系统。

### P6 种子导入（T8）

- 第一步：`estimate-video-plaza-seed-size.ts`（D13）对原表 5,097 条 `Video URL` 发 HEAD（并发 10），输出总字节数、按模型小计、失败清单，写成 `video-seed-size-report.json`。人工看过报告、确认 bucket 配额够用（关闭 B-SEED-1）之后，才带 `--confirm-size <报告 hash>` 进入下一步。
- 将旧的单体 `video-seed-import.ts` 执行路径拆成三项：纯解析/选样、纯资产处理上传、纯离线 SQL 生成。旧“上传成功后立即 RPC，RPC 失败删除对象”的 apply 路径在新工具完成前必须保持不可用。
- 输入两份文件：原表 `--input civitai_venice_nsfw_videos.xlsx`，翻译包 `--translations 翻译包/video.xlsx`。按 design §7 的 URL 路径对照写入 `prompt_zh`。
- 提示词不设上限（D14），`prompt`/`prompt_zh` 原样写入 TEXT 列。
- dry-run 预期（2026-10-24 实测基线）：命中 5,082 条，不一致 0 条，「已剔除」15 条（`excluded_by_translation_pack`），孤儿 0 条。实际数字偏离基线时停下核查。
- 按 D16 在 audit 后增加确定性选样：目标总量 4,000，模型间用水位填充最大化均匀，模型内 `source_heat DESC, source_video_id ASC`；不可访问 URL 先排除并补位。manifest 输出每模型候选数、配额、cutoff heat 和入选摘要。
- `--offset/--limit` 必须作用于稳定选样后的 4,000 条序列；资产并发参数仍限制为 1–4。补充现有测试覆盖不足模型再分配、同热度 tie-break、排除后补位、少于 4,000 时拒绝。
- 重新对最终 4,000 条执行 HEAD 容量报告并人工确认；在该确认之前，不执行 dry-run 后续 apply，不写数据库或私有桶。
- D17 人工门禁：先提交 design §3.3.1 的 FFmpeg/文件处理方案给用户确认；未确认前禁止完整下载、FFmpeg 和 Supabase 写入。
- 确认后先改造 `prepareVideo` 为临时文件/流式接口，移除“下载 Buffer + input Buffer + output Buffer”叠加；实现 probe 决策矩阵、输出校验、poster 缩放和 2 路转码 semaphore，再接 4 路资产 worker。每条 lane 到 manifest 为止，不连接 DB。
- MP4 使用 TUS 6MiB 分片和 direct Storage hostname，记录可恢复 fingerprint；使用含 bundle hash 的不可变路径、`upsert=false`、24h cacheControl，补对象 hash/size/MIME 核验。
- 从 4,000 条中确定 10 条 TEST canary：覆盖六模型与 direct/remux/transcode/大小/时长边界。TEST 只上传并用生成 SQL 导入这 10 条，不做 TEST 全量。
- TEST 通过后，单独确认 main/Production project identity 与容量；`upload-video-plaza-seed-assets.ts --target production --phase assets` 上传全 4,000 组对象，只产出环境绑定的 main upload manifest，业务表保持不变。
- `generate-video-plaza-seed-sql.ts` 为 TEST 生成 `_test_canary.sql`，为 main 离线校验 4,000/8,000 全 verified 后生成 8 个每批 500 条的 `packages/shared/migrations/YYYYMMDD_media_plaza_video_seed_production_0N.sql`，复用 `import_video_seed_work`；同步增强 migration workflow 拒绝 seed 文件环境后缀错配；另生成 preflight/postflight 与精确 forward-fix 输入摘要。SQL 生成阶段无 Supabase 网络或 secret。
- 复用短剧的签名/播放模式：视频签名接入有界 single-flight 与 hit/miss/inflight 观测；点击只预取 playback 地址；换签保留 currentTime/paused；观测 source→metadata→首帧、seek 与连续缓冲。按真实 URL 内存基线把共享签名 LRU 上限从 2,000 调整到最多 10,000。

### P7 验证、文档、灰度（T9、T10）

- 跑完 §2 的命令和 §3 的场景。
- 同步更新以下文档：
  - README（迁移顺序、seed 命令）
  - `docs/ARCHITECTURE.md`（九域、路由、worker）
  - spec：schema 规范、backend/frontend 模块
- production 按 design §10 执行。

## 2. 命令

```sh
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/admin test
pnpm -r typecheck
pnpm --filter @miniapp/frontend lint
pnpm lint:imports
pnpm lint:legacy
pnpm lint:migrations
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin build
docker build -f ops/docker/Dockerfile.backend .   # 验证 ffmpeg 已安装
pnpm --filter @miniapp/backend video-plaza:estimate-size -- --input <原表xlsx> --report video-seed-size-report.json   # P6 第一步，体积估算
pnpm --filter @miniapp/backend video-plaza:seed -- --input <原表xlsx> --translations <翻译包video.xlsx> --confirm-size <报告hash>   # 仅 dry-run/选样/manifest，不写远端
pnpm --filter @miniapp/backend video-plaza:seed-assets -- --target test --canary 10 --manifest <锁定manifest>                 # D17 批准后；TEST 仅 10 条
pnpm --filter @miniapp/backend video-plaza:seed-sql -- --target test --upload-manifest <test-upload-manifest>              # 离线生成 TEST 10 条 SQL
pnpm --filter @miniapp/backend video-plaza:seed-assets -- --target production --phase assets --manifest <锁定manifest>    # 再次确认 main 身份/容量后；仅上传 4,000 组对象
pnpm --filter @miniapp/backend video-plaza:seed-sql -- --target production --upload-manifest <main-upload-manifest>       # 离线生成 8×500 migration
pnpm --filter @miniapp/backend video-plaza:reconcile                        # dry-run（P3 新增脚本）
```

以上 `seed-assets` / `seed-sql` 是待实施命令，不代表当前仓库已经可执行。backend、shared 没有 build script，不要虚构。完整媒体处理、Storage 写入和 DB migration 都必须逐门禁获得明确授权，不放进单元测试。

## 3. 验证场景（含失败路径）

| 领域            | 场景                                                                                                                                                                                                                                 | 通过标准                                                                                                                                                                                                                                                    | 自动/人工                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| M1 前置核验     | 8 张表、3 个 RPC、权限/RLS、PostgREST 暴露、旧 schema 残留和图片全链路                                                                                                                                                               | TEST/Production 当前 shape 与 M1 postflight 一致；后端只访问 `media_plaza`；异常停止 M2/M3 并 forward-fix，不重跑/回滚 M1                                                                                                                                   | 人工 + SQL 断言                         |
| 视频 M2/M3      | 锁超时、部分执行、权限/RLS、配置 validator、关键 RPC 和图片回归                                                                                                                                                                      | 任一步异常立即停止；M2 smoke 通过后才能执行 M3；图片回归不退化                                                                                                                                                                                              | 人工 + SQL 断言                         |
| 图片转参考图 M4 | 新列/FK/唯一索引、RPC owner/ACL、重复/并发/未知结果重试、越权与非 ready artifact                                                                                                                                                     | 不改历史 migration；同一 artifact 只返回一个 reference；anon/authenticated 无权限；失败不复制/删除媒体对象、不产生计费或分享                                                                                                                                | migration SQL 断言 + Backend 测试       |
| 契约            | 旧客户端不传 media/tags；旧 tag 配置缺少分组且可能带 media_types；未知 status                                                                                                                                                        | 旧 payload 归入默认组；公开兼容字段仍可被旧客户端读取；非法值在边界被拒绝                                                                                                                                                                                   | shared 测试                             |
| 创作模式初始化  | 普通新建、图片详情同款、视频详情同款、图片结果转视频；初始化后发生 query refetch                                                                                                                                                     | 初始类型分别为 image/image/video/video；来源参数恢复；refetch 不覆盖用户后续手动切换                                                                                                                                                                        | Frontend 测试 + UI fixture              |
| 视频设置/报价   | 5/10 秒、三画幅、720P/1080P、声音；Admin 模型上下架；Wan 默认缺失；快速切换产生迟到 quote                                                                                                                                            | 只显示能力交集；默认/回退符合优先级并提示；只展示当前 key 未过期报价，Backend 拒绝不匹配 quote                                                                                                                                                              | shared/frontend/backend 测试 + 人工     |
| 参考图保留      | 支持图模型 → 不支持图模型 → 支持图模型；required 模型无图；用户显式删除                                                                                                                                                              | reference id/preview 不丢、不重传；不支持阶段 quote/submit 为 t2v+null；切回自动恢复；required 无 active 图不可提交；删除后才真正清空                                                                                                                       | Frontend 回归 + 请求断言                |
| 图片转视频      | 本人 ready 图片重复/并发/未知结果重试；非本人、非 ready、缺失；无支持图片的视频模型                                                                                                                                                  | 同一 source 只产生一个 reference mapping、零媒体复制、零计费；越权/非法稳定拒绝；失败保持图片和草稿；无模型时不调用 RPC                                                                                                                                     | migration RPC + Backend/Frontend 测试   |
| 视频结果操作    | ready 视频编辑、下载、分享、重生成；双击、下载失败、分享失败                                                                                                                                                                         | 编辑只回填；重生成一次报价/一次任务；下载 Telegram 失败降级打开；分享幂等且错误可恢复；所有写操作有 pending 防重                                                                                                                                            | Frontend 测试 + Telegram 人工           |
| feed            | media×sort×search×tags 组合；单/多标签 prompt_zh ILIKE OR；切换 media 后游标作废；计数失败                                                                                                                                           | 无重复、无遗漏；不访问 works.tags；图片视频共用目录；计数显示“—”而不是 0                                                                                                                                                                                    | backend 测试 + 人工                     |
| 标签配置        | 旧配置、分组字段冲突、非法布局、重复/保留 id、草稿发布/回滚                                                                                                                                                                          | Shared/Admin/DB 三层口径一致；旧 media_types 可读但不影响运行时；ACL 不扩大                                                                                                                                                                                 | tests + migration SQL 断言 + TEST 人工  |
| 移动端筛选      | 320px 窄屏横滑、固定按钮、默认全选、取消/恢复、全部展示、chip/grid、媒体切换                                                                                                                                                         | 「全部风格」不滚走；分组和状态符合参考图；切换媒体不丢标签目录；无标签/计数失败不阻塞 feed                                                                                                                                                                  | UI fixture + Telegram 人工              |
| 计费            | 重复提交同一个幂等键；并发两单只够一单；reserve 响应丢失；重复 refund                                                                                                                                                                | 最多扣一次、退一次；不透支                                                                                                                                                                                                                                  | backend 测试（mock RPC）+ test DB 手动  |
| worker          | queue 超时（结果未知）；429/503 退避；进程在 submitting 或 storing 时崩溃；双副本抢同一任务；超过 deadline                                                                                                                           | 不重复调用 queue；租约 fencing 生效；状态可解释                                                                                                                                                                                                             | backend 测试                            |
| 审核            | queue 返回 422；retrieve 返回 422 `provider_content_policy`                                                                                                                                                                          | 状态为 moderation_rejected，退款 1 次，前端显示专用文案，Sentry 记录事件                                                                                                                                                                                    | 测试 + canary                           |
| 存储            | 伪造 MIME；超过 200MiB；ffmpeg/faststart 失败；地址过期后刷新；越权访问 playback/stream；stream 无 Range 或整文件进内存                                                                                                              | 拒绝或降级处理；不泄露 URL；stream 必须流式 + 支持 206                                                                                                                                                                                                      | 测试 + 人工                             |
| complete        | 转存成功后才调用；complete 失败                                                                                                                                                                                                      | 失败只记日志，不影响 ready                                                                                                                                                                                                                                  | 测试                                    |
| 分享            | 图片先分享再分享视频；反过来；两者并发；重复分享；分享已退款的视频                                                                                                                                                                   | 首次分享奖励只发一次；不重复返利；已退款的拒绝                                                                                                                                                                                                              | test DB                                 |
| Admin           | 价格矩阵缺项；默认模型被禁用；`required_reference` 配了 t2v；旧目录含 2K/4K/480P/768P/adaptive/其它时长；发布后回滚                                                                                                                  | 参数收窄为 D23 集合与模型能力交集，价格矩阵同步裁剪；其余非法配置无法发布；回滚后生效                                                                                                                                                                       | admin/shared 测试                       |
| 前端            | 旧目录含超集参数；模型不支持图片时禁用附图；必须附图却没附；切换模型参数被重置；402 时草稿保留；离页后返回；轮询退避；页面隐藏时暂停                                                                                                 | 只显示 5/10 秒、三种画幅和 720P/1080P 的模型能力交集；供应商值大小写不被改写；无静默丢图、无重复提交                                                                                                                                                        | shared 测试 + 人工（Telegram 双端）     |
| 播放            | 点击播放、暂停、拖动；地址预取；地址过期换签并恢复位置；列表页 mp4 请求数；Range/206；未 faststart 或 GOP>2s 对照；签名并发；Supabase delivery adapter；未来 CDN source 契约                                                         | 列表 mp4=0；同 key 并发只签一次；参考网络 startup p95≤2s、未缓存 seek p95≤2s；地址/metadata/首帧/seek 指标分离；未下完即可出画；过期可恢复；页面不依赖 storage_path；切 provider 不改变作品 ID                                                              | 自动计时 + 人工 + curl Range 抽检       |
| seed            | 6 列解析；重复 id；未知模型；URL 失效；超大文件；断点续跑；重跑；翻译包缺行、字段不一致、孤儿行；xlsx hash 变化；超长 prompt；HEAD 失败；配额/tie-break；TEST/main 身份串用；TUS 过期/409；对象已有但 metadata 冲突；部分批 SQL 失败 | Top 4,000 稳定；TEST 精确 10 条且六模型覆盖；main 上传后精确 8,000 对象/0 新 DB 行；manifest hash/环境/对象全部 verified 才生成 SQL；8×500 逐文件账本执行，失败只回滚当批且入口保持关闭；最终 4,000 work/artifact，无扣费返利；重跑不覆盖对象、不产生重复行 | 脚本 + migration + 人工                 |
| 自动优化关闭    | 视频提交请求带 `auto_optimize`；从图片切到视频                                                                                                                                                                                       | 返回 400；视频设置里没有该开关；图片 auto_optimize 行为不变                                                                                                                                                                                                 | shared 测试 + 人工                      |
| ffmpeg          | 镜像内二进制缺失；损坏 mp4；直通/remux/转码分支；10-bit/非兼容 codec；黑帧封面；抽帧或处理超时；4 路内存/磁盘/CPU 压力                                                                                                               | 构建期断言失败；不兼容时 H.264/AAC；输出二次 probe 且 `moov < mdat`；封面失败可占位但视频处理失败不得发布；完整媒体不进入 Node Buffer；转码最多 2 路                                                                                                        | 测试 + canary + docker build            |
| 性能-列表       | 无筛选首屏 feed；切 media/tags 后首页与翻页；tag-counts 失败；热/冷签名                                                                                                                                                              | 前端 feed p95≤800ms；后端≤500ms；**游标**切换筛选后作废且翻页无重复；**列表 mp4=0**；**同 poster path 二次进页不重复打 Storage 签名**（热 LRU）；计数失败不拖慢列表                                                                                         | 人工 ≥20 次 + 网络面板 + Sentry Explore |
| 性能-签名缓存   | 列表封面、详情 mp4、playback 重签；同 key 并发；私有未分享资源；4,000 video + poster 工作集                                                                                                                                          | 已发布资源 24h 稳定 URL/cacheControl；私有仍短 TTL；视频与图片共用 LRU 原语；hit/miss/inflight 可见且无敏感值；并发只签一次；10,000 上限内额外堆内存≤20MiB，超出则拆有界池                                                                                  | 后端单测 + 内存基线 + 人工              |
| 性能-创作       | 有/无 config 预取进 studio；报价连点；提交受理；生成中切后台再回；长会话轮询                                                                                                                                                         | studio ready≤1.5s（有预取）；image/video_generate 反馈 p95≤2.5s；quotes/attempt GET p95≤800ms；隐藏页暂停轮询；Venice 耗时不进 standard p95                                                                                                                 | 人工 ≥20 次 + Sentry                    |
| 性能-回归       | 纯图片 feed / 点赞 / image_generate 对照 P0 基线                                                                                                                                                                                     | 相关 p95 退化 ≤10%                                                                                                                                                                                                                                          | 人工 + 看板对照                         |
| 监控            | 各终态都上报事件；列表与创作分图；metrics 只用低基数 tag                                                                                                                                                                             | Sentry 看板可见两条路径 p95 与视频状态分布                                                                                                                                                                                                                  | 人工                                    |

## 4. 本轮执行验证

- `pnpm -r typecheck` 通过；
- shared/backend/admin/frontend 完整测试分别通过 184/903/122/390 项；
- Admin 与 Frontend production build 通过；
- migration filename、legacy reference 与 import lint 通过；
- Docker CLI 不可用，后端镜像构建未执行；
- 图片 M1 与 PostgREST 暴露已由用户确认在 TEST、Production 完成；视频 M2/M3 的远程状态继续以执行记录为准；本轮 D25 的 M4 与应用修正已于 2026-10-29 完成本地实现和自动化验证，但 M4 尚未连接或执行任何远程环境。Venice canary、Telegram 真机、Sentry p95 与剩余 seed 转存仍受外部门禁约束。
