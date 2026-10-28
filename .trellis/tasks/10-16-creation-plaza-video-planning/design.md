# 技术设计：图片广场扩展视频 + `media_plaza` schema

状态：实施中（2026-10-27 合并图片 M1 已完成事实）。仓库：`D:/codeReposity/wq/ST_miniapp`，分支 `feat_video_park`。

证据等级：

- SRC：已读源码（含 2026-10-26 对照的 feed / studio / sentry 路径）
- MIG：migration 文本；图片 M1 与 PostgREST 暴露的 TEST、Production 实况由用户于 2026-10-27 确认，视频 M2/M3 仍不得据本地文件推断为已执行
- DOC：Venice 公开文档（见 `research/venice-video-evidence.md`）
- 待验证：实施期需核实

## 1. 现状与复用调研

| 对象            | 位置（SRC/MIG）                                                                                                                                                                       | 结论                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 广场契约        | `packages/shared/src/api/image-plaza.ts`                                                                                                                                              | 扩展：feed query 加 `media`、`tags`；条目用 media 判别联合；视频 DTO 放在新文件 `video-plaza.ts`                                               |
| feed/详情/点赞  | `features/image-plaza/repository.ts` 中的 `listWorks/listSortedWorks/hydrateWorks`。按 like_count、initial_feed_order、published_at、id 排序；标签匹配为 `snapshot->>prompt_zh ILIKE` | 扩展：works 加 `media_type`，图片和视频共用一张投影表；视频专属字段通过 `video_artifact_id` 关联                                               |
| 游标            | `feed-cursor.ts` + `ImagePlazaFeedCursorSchema`（filter 为 64 位十六进制哈希）                                                                                                        | 复用：把 media 和 tags[] 并入 filter 哈希，游标结构不变                                                                                        |
| worker          | `features/image-plaza/job.ts`：setInterval 驱动，`claim_image_plaza_jobs` 租约，`markStaleDispatchedUnknown`                                                                          | 复用模式：新建 `video-job.ts`，拆成 submit/poll 两个阶段，各自独立 claim                                                                       |
| Venice HTTP     | `platform/venice-http.ts` 的 `veniceFetch`（ProxyAgent）；`upstream.ts` 的错误类和响应头采集                                                                                          | 复用：新建 `video-upstream.ts`                                                                                                                 |
| 存储            | `storage.ts`：私有 bucket、签名 URL LRU（2000 条）、签名超时；当前视频签名已复用稳定 URL，但 `signVideoPath` 尚未像图片签名一样接入 inflight map                                      | 扩展：新增 bucket 参数、mp4 校验；把视频签名纳入有界 single-flight，并按 4,000 视频 + poster 的工作集复核缓存容量                              |
| 短剧播放        | `features/drama/signed-url.ts`、`routes/drama.ts`、`components/drama/drama-player.tsx`、`lib/api/drama.ts`、`lib/perf/drama-*`                                                        | 复用行为：5s 签名超时、稳定 URL、同 key single-flight、点击/临近播放地址预取、换签保留位置、旧 src 释放、首帧与缓冲分阶段观测；不复制短剧 UI   |
| 计费原语        | `billing.apply_wallet_debit` / `refund_wallet_debit`（MIG 20260921）                                                                                                                  | 复用：视频的预扣和退款 RPC 在这两个原语外面包一层                                                                                              |
| 图片结算        | `billing.settle_image_plaza_generation`：成功后扣费，余额不足时置 failed                                                                                                              | 不改（决策 D2：图片维持现状）                                                                                                                  |
| 首次分享与返利  | `billing.share_image_plaza_artifact` 写 `app_core.miniapp_user_settings.image_plaza_first_share_completed_at`                                                                         | 扩展：视频分享 RPC 复用同一字段和同一锁顺序                                                                                                    |
| generation 边界 | `features/generation/` 下已有 `image-plaza-prompt-translate.ts`、`image-plaza-tagging.ts`                                                                                             | 不新增。视频关闭自动优化（D9），视频链路不调用 LLM                                                                                             |
| 配置            | `features/image-plaza/config.ts`（6 个 key）；admin 的 `configSchemas.ts`、`ImagePlazaConfigEditors.tsx`（模型目录、价格公式、标签编辑）                                              | 扩展：新 key `image_plaza_video_model_catalog`；标签加 `media_types`；DB 侧 `admin.validate_*` 同步修改                                        |
| 前端            | `create/page.tsx`、`studio/[conversationId]/page.tsx`、`work/[workId]/page.tsx`、`components/image-plaza/*`、`lib/api/image-plaza.ts`                                                 | 扩展：按 media 分支 + 4 小组件（§5）；**性能**：接线已有 `prefetchImagePlazaFeed`、创作预取 config、quote debounce/复用、轮询退避（§5.2–5.3）  |
| 列表请求链      | feed：runtime_config → listSortedWorks(1～2) → hydrate(artifacts∥likes) → 并发签名≤20；pageSize20、stale60s、缩略图720/72、签名 LRU                                                   | 视频混排保留该链；列表只签 poster、DTO 裁剪、tag-counts 解耦；后端 feed p95≤500ms / 前端≤800ms                                                 |
| 创作请求链      | studio：config∥conversation → quote → POST attempts(202) → 会话固定2s 全量轮询；`image_generate` 受理反馈与 `image.display.duration` 分离                                             | 视频同模式；轻量 attempt 轮询+退避；worker/Venice 耗时不进 standard API p95                                                                    |
| Sentry          | 前端 `lib/perf/action-tracker.ts`、`page-tracker.ts`；后端 `lib/perf-metrics.ts`；规范见 `10-21-sentry-ux-monitoring`                                                                 | 扩展：`video_generate` + 视频事件；看板按列表/创作分图（§8.1）                                                                                 |
| seed 导入       | `seed-import.ts`、`scripts/import-image-plaza-seed.ts`；`20261019_image_plaza_seed_bootstrap.sql` 已有“先 Storage、后受审 payload、对象 metadata 前置检查、RPC 幂等导入”的模式        | 扩展：视频 parser 独立；上传程序与 SQL 生成程序物理分离；SQL 复用既有 video seed RPC 和 migration 账本，不保留“单条上传后立即 RPC”的旧执行模式 |
| 运行镜像        | `ops/docker/Dockerfile.backend`：运行层基于 `node:20-bookworm-slim`（第 116 行），第 121 行用 `apt-get install --no-install-recommends` 安装 tini/wget/openssl                        | 在同一条 apt 命令里加 `ffmpeg`（Debian 包自带 ffprobe），并加 `RUN ffmpeg -version && ffprobe -version` 构建期断言（D10）                      |

拒绝的方案：

- 通用媒体插件框架
- 消息队列或 Redis
- 为未来 CDN 提前创建空映射表、引入 HLS SDK 或双写两个点播供应商
- 前端直连 Venice 或 download_url
- 独立的视频会话表（违背决策 D5）
- 转码/HLS / MediaSource + fMP4（本任务 mp4 progressive 即可；MSE 需碎片化封装，Telegram WebView 兼容与转码成本都不划算）
- 以 `fetch()` 拿到 `ReadableStream` 再 `blob()` / `createObjectURL` 作为播放主路径（整文件下完才赋 src，无法边下边播）
- 兼容视图（双名字会导致写入歧义）
- 重命名 `image_plaza_*` 表（改动面大、收益小）

## 2. 数据库：`media_plaza`（需求 1）

### 2.1 ADR：为什么新增第九域（需要架构评审）

规范规定“不得为单功能新建 schema，扩域须单独做架构决策”，本节即该决策。

- **业务真相**：用户创作的图片/视频内容、创作会话、公开作品，以及作品互动（点赞）。
- **为什么离开 `experience`**：
  - 广场已是独立产品面，表从 9 张增至约 13 张。
  - 发布节奏、seed 容量、生命周期都与聊天 experience 明显不同。
  - 用户明确要求单独 schema（决策 D1）。
- **为什么点赞迁入**：点赞只用于广场作品，随功能共生共灭，满足功能删除测试。
- **为什么钱不迁**：“钱归 billing”是更高层不变量。`billing.image_plaza_share_rewards`、`wallet_ledger`、预扣/退款 RPC 都留在 billing。
- **影响面**：
  - `packages/backend/src/lib/supabase.ts` 的 `DOMAIN_SCHEMAS` 加入 `'media_plaza'`。
  - `ops/schema-split/postgrest-expose-{test,prod}.sql` 的 `pgrst.db_schemas` 加入该 schema。
  - `.trellis/spec/database/supabase/schema-and-object-conventions.md` 八域地图加一行（改为九域）。
  - `docs/ARCHITECTURE.md` 域表同步。
  - 检查 `scripts/check-legacy-references.mjs`、`scripts/export-image-plaza-seed.mjs` 中的 schema 字面量。

### 2.2 M1：迁移现有对象（已完成前置，`20261027_media_plaza_schema_move.sql`）

```sql
SET lock_timeout = '5s';
CREATE SCHEMA media_plaza;
REVOKE ALL ON SCHEMA media_plaza FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA media_plaza TO service_role, postgres;
ALTER TABLE experience.image_plaza_conversations SET SCHEMA media_plaza;
-- messages / quotes / reference_assets / attempts / artifacts / works 同理
ALTER TABLE miniapp_features.image_plaza_likes SET SCHEMA media_plaza;
ALTER FUNCTION experience.claim_image_plaza_jobs(TEXT, INTEGER, INTEGER) SET SCHEMA media_plaza;
ALTER FUNCTION experience.set_image_plaza_like(UUID, UUID, BOOLEAN) SET SCHEMA media_plaza;
ALTER FUNCTION experience.import_image_plaza_seed_work(...) SET SCHEMA media_plaza;
-- 同文件内：CREATE OR REPLACE billing.settle_image_plaza_generation / billing.share_image_plaza_artifact，
-- 把函数体内的 experience.image_plaza_* 改为 media_plaza.*
```

- **随表自动迁移**：`SET SCHEMA` 只改 catalog，不重写数据。索引、约束、RLS、grant、序列随表迁移。FK 按 OID 解析，因此跨 schema FK（app_core.users、billing.wallet_ledger，以及 billing.image_plaza_share_rewards → works/attempts）保持有效。
- **需显式处理：plpgsql 函数体是文本**，运行时才解析表名。
  - preflight 扫描 `pg_proc.prosrc` 中的 `experience.image_plaza_` / `miniapp_features.image_plaza_likes`，以及 `pg_depend` 中的视图依赖。
  - 发现未登记的引用时 RAISE，中止迁移。
  - postflight 断言旧 schema 已无 `image_plaza_*` 对象。
- **锁与执行窗口**：AccessExclusive 锁，`lock_timeout` 5s，低峰执行。执行前先设 `IMAGE_PLAZA_WORKER_ENABLED=false`。
- **当前实况**：TEST、Production 已完成 M1 与 PostgREST 暴露；后端统一用 `getDomainDb('media_plaza')` 直连，不再保留启动探测、双读或旧 schema 回退。
- **恢复策略**：回滚脚本仅作为 M1 执行前设计记录保留。两套环境均已完成切换，视频发布流程不得重跑或回滚 M1；发现差异时停止 M2/M3 并采用 forward-fix。

### 2.3 M2：视频对象（`2026MMDD_media_plaza_video.sql`）

新表（每张表的 8 问说明写在 migration comment 中）：

| 表                            | 真相                                           | 写入方               | 生命周期                 |
| ----------------------------- | ---------------------------------------------- | -------------------- | ------------------------ |
| `media_plaza.video_quotes`    | 服务端权威视频报价（参数 + 星尘），10 分钟有效 | quote 路由           | 过期可清理               |
| `media_plaza.video_attempts`  | 一次视频生成请求及其上游状态机                 | 视频 service、worker | 有流水的行 RESTRICT 删除 |
| `media_plaza.video_artifacts` | 转存后的 mp4 与封面元数据                      | worker、seed 导入    | 被作品引用时 RESTRICT    |

**`video_attempts` 关键列**

- 关联：`user_id → app_core.users`、`conversation_id → media_plaza.image_plaza_conversations`、`user_message_id` / `assistant_message_id → image_plaza_messages`、`quote_id`、`idempotency_key`（与 user_id 组成 UNIQUE）。
- 输入：`prompt TEXT`（不设字数上限，D14；列类型为 `TEXT` 而非图片用的 `VARCHAR(2000)`）、`model_id`、`provider_model_id`、`input_mode CHECK IN ('t2v','i2v','r2v')`、`reference_asset_id → image_plaza_reference_assets`（复用参考图资产，即需求 2.8 的参考图持久化）。
- 参数：`duration_s`、`resolution`、`aspect_ratio NULL`、`audio`、`params_snapshot JSONB`（供编辑/用同款回填）。不设 `auto_optimize`、`optimized_prompt` 列（D9）。
- 计费：`quote_credits NUMERIC(14,1)`、`reserve_ledger_id`、`refund_ledger_id`。
- 上游：`provider_queue_id`、`provider_download_url`（ready/失败时清空，不出 API，不写日志）。
- 状态：`status CHECK IN ('pending','submitting','queued','processing','storing','ready','failed','moderation_rejected','expired','failed_unknown')`。
- 其他：`error_code`、`lease_owner`、`lease_expires_at`、`next_poll_at`、`poll_count`、`deadline_at`、`provider_cleanup_done`、时间戳。
- CHECK 约束：
  - `ready` ⇒ 有 reserve、无 refund；
  - `failed`/`moderation_rejected`/`expired` ⇒ 有 refund，或从未预扣。

**`video_artifacts`**

- 列：`attempt_id NULL`、`origin IN ('generated','civitai_seed')`、`storage_path`、`byte_size ≤ 200MiB`、`mime_type='video/mp4'`、`width`、`height`、`duration_ms`、`poster_path NULL`、`poster_width`、`poster_height`、`source_video_id`。
- 约束：UNIQUE(origin, source_video_id)；generated ⇒ attempt 非空，seed ⇒ source 非空。

**现有表扩展**

- `image_plaza_messages`：
  - 加 `media_type TEXT NOT NULL DEFAULT 'image' CHECK IN ('image','video')` 和 `video_attempt_id NULL`。
  - 常量 default 只改元数据，不重写表。
- `image_plaza_works`：
  - 加 `media_type`（同上）、`video_artifact_id NULL`、`video_attempt_id NULL`、`duration_ms NULL`。
  - `artifact_id` / `attempt_id` 改为 NULLABLE，并加 CHECK：image ⇒ artifact_id 非空；video ⇒ video_artifact_id 非空。
  - 加索引 `(media_type, like_count DESC, initial_feed_order, published_at DESC, id DESC) WHERE deleted_at IS NULL`，以及 latest 排序的对应索引。实施时以 EXPLAIN 决定是否保留。
- `image_plaza_likes`：不变，挂在 works 上，视频自动适用。
- `billing.image_plaza_share_rewards`：`attempt_id` 改为 NULLABLE，加 `video_attempt_id`，CHECK 恰好一个非空。
- `billing.wallet_ledger`：`entry_type` 超集加入 `media_plaza_video_reserve` / `media_plaza_video_refund`；按 `reference_type` 建部分唯一索引，保证每个 attempt 最多一笔预扣、一笔退款。
- Storage：私有 bucket `media-plaza-video`，限额 200MiB，`allowed_mime_types` = `video/mp4, image/webp, image/jpeg`。

### 2.4 RPC

全部 SECURITY DEFINER，只 GRANT 给 service_role 和 postgres。

| 函数                                                   | 行为                                                                                         | 并发/幂等                                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `billing.reserve_media_plaza_video(attempt, user)`     | 锁 attempt 再锁钱包（与 settle 锁序相同），余额足够则 `apply_wallet_debit` 并转为 submitting | 已有 reserve 时返回 already；余额不足时转为 failed（`insufficient_balance`），不产生流水 |
| `billing.refund_media_plaza_video(attempt, reason)`    | `refund_wallet_debit`，回写 refund_ledger_id                                                 | 部分唯一索引保证只退一次；重复调用返回 already                                           |
| `media_plaza.claim_video_submit_jobs(owner, n, lease)` | `FOR UPDATE SKIP LOCKED` 领取 submitting 且租约过期的任务                                    | 后续更新都带 `lease_owner` 条件，实现 fencing                                            |
| `media_plaza.claim_video_poll_jobs(owner, n, lease)`   | 领取 queued/processing 且 `next_poll_at <= now()` 的任务                                     | 同上                                                                                     |
| `media_plaza.publish_video_artifact(...)`              | 单事务：写 artifact，storing → ready，清空 download_url                                      | 已 ready 直接返回                                                                        |
| `billing.share_media_plaza_video(...)`                 | 生成视频作品；以预扣流水为基数发返利；写/读共享首次字段                                      | 锁 `miniapp_user_settings` 行，与图片分享函数锁序一致，避免跨媒体并发首次重复领取        |
| `media_plaza.import_video_seed_work(...)`              | 原子写 seed artifact + work                                                                  | (origin, source_video_id) 唯一，重复返回 existing                                        |

### 2.5 Admin 配置校验（M3：`2026MMDD_media_plaza_video_config.sql`）

- `admin.is_managed_config_key` 加入 `image_plaza_video_model_catalog`。沿用 20261016 reconcile 的包装写法，保留现有白名单。
- 新增 `admin.validate_image_plaza_video_model_catalog`。
- 修改 `admin.validate_image_plaza_tags`，允许可选的 `media_types`。
- 默认不发布视频目录，因此视频入口默认关闭。

## 3. 后端（需求 2.7/2.8/5/6/7/8）

### 3.1 新增文件（最小集合）

```
features/image-plaza/video-repository.ts   # video_* 读写 + RPC
features/image-plaza/video-upstream.ts     # Venice quote/queue/retrieve/complete/download
features/image-plaza/video-job.ts          # submit/poll 两阶段 worker
features/image-plaza/video-catalog.ts      # 视频目录解析、参数校验、provider payload 白名单
features/image-plaza/video-media.ts        # ffprobe/ffmpeg 子进程（超时 20s）
features/image-plaza/video-seed-import.ts
scripts/estimate-video-plaza-seed-size.ts
scripts/import-video-plaza-seed.ts
scripts/reconcile-video-plaza.ts
```

视频路由加在 `routes/image-plaza.ts` 里，复用其鉴权和 hooks。每条路由附近都写 `// @frontend-ready: false`，等前端接入后改为 true。

### 3.2 路由

| 方法 | 路径                                                            | 说明                                                                                                     |
| ---- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| GET  | `/api/image-plaza/feed?media=&tags=&tag=&search=&sort=&cursor=` | 混排。`media` 缺省时只返回图片，保护旧客户端；`tags` 优先于 `tag`                                        |
| GET  | `/api/image-plaza/feed/tag-counts?media=&search=`               | 标签计数，进程内缓存 60s，独立于列表加载                                                                 |
| GET  | `/api/image-plaza/works/:id`                                    | 视频作品返回可播放的 `video_url` 和 `poster_url`（见 §5.1）                                              |
| GET  | `/api/image-plaza/config`                                       | 新增 `video_models`、`default_video_model_id`                                                            |
| POST | `/api/image-plaza/video/quotes`                                 | 服务端按价格矩阵返回 quote_id、credits、expires_at                                                       |
| POST | `/api/image-plaza/conversations/:id/video-attempts`             | 校验 → 写 message 和 attempt → reserve RPC → 202；余额不足返回 402，且不调用上游                         |
| GET  | `/api/image-plaza/video-attempts/:id`                           | 轻量轮询（状态、error_code、ready 后的可播放地址）                                                       |
| GET  | `/api/image-plaza/video-artifacts/:id/playback`                 | 返回/刷新可播放地址（签名 URL 或同域 stream 入口），校验归属或作品是否公开                               |
| GET  | `/api/image-plaza/video-artifacts/:id/stream`                   | **可选同域推流**：鉴权后从私有桶读对象并转发；必须支持 `Range` / `206`；供 `<video src>` 使用（见 §5.1） |
| POST | `/api/image-plaza/video-artifacts/:id/share`                    | 分享并发放返利                                                                                           |

会话详情接口新增 `include_video=1` 参数。不带该参数时过滤掉视频消息，防止旧客户端解析失败。

pino 日志字段：route、attemptId、model_id、media、status、durationMs。**不记录** prompt 全文、download_url、签名 URL。

### 3.3 视频状态机与 worker

```
pending --reserve RPC--> submitting --queue 200--> queued --PROCESSING--> processing --mp4/COMPLETED--> storing --publish--> ready
pending     --余额不足-------------------> failed（无流水）
submitting  --422----------------------> moderation_rejected + 退款
submitting  --400/402/409/413/404/503---> failed + 退款
submitting  --网络超时/5xx（请求已发出）---> failed_unknown（不重投，进人工对账清单）
queued/processing --422------------------> moderation_rejected + 退款
queued/processing --404------------------> expired + 退款
queued/processing --超过 deadline--------> failed_unknown（对账后决定发布或退款）
storing     --转存失败（重试已耗尽）-------> failed + 退款；上游媒体保留，不调用 complete，等待对账
ready       --> 异步调用 /video/complete（失败最多重试 3 次，只记日志）；有 download_url 时同时发 DELETE
```

各阶段参数：

- **submit**：每个 tick 处理 ≤2 个任务，queue 超时 60s，不重试（写操作）。拿到 queue_id 后立即写库，`next_poll_at = now() + max(10s, 预估时长/4)`。
- **poll**：每个 tick 处理 ≤10 个任务，retrieve 超时 30s。遇到 429/500/503 时把 next_poll_at 按 10s→60s 指数退避，不计为失败。
- **下载**：流式读取，上限 200MiB，超时 120s。下载是幂等 GET，最多重试 2 次。
- **完成**：
  - 校验 `ftyp` 魔数后上传 Storage；
  - **边下边播前置条件**：入库前用 ffmpeg 做一次 remux（`-c copy -movflags +faststart`），把 `moov` 挪到文件头；已是 faststart 则跳过。否则浏览器在拿到文件尾部元数据前无法开始解码，Range 也帮不上忙；
  - ffprobe 读取时长和宽高；
  - ffmpeg 执行 `-ss 0 -frames:v 1` 生成 webp 封面；抽帧失败则 poster 为空并发出告警，不阻塞 ready；
  - 调用 publish RPC。
- **deadline** 默认 `30min + 视频时长×60s`，从配置读取。
- **配置**：`IMAGE_PLAZA_VIDEO_WORKER_ENABLED`、`_INTERVAL_MS`、`_LEASE_SECONDS`、`_DEADLINE_MINUTES` 从 `platform/config.ts` 读取。关闭 worker 不影响查询接口。
- **崩溃恢复**：租约过期后任务会被重新领取。
  - 有 queue_id 的任务进入 poll。
  - submitting 状态、没有 queue_id 且租约已过期的任务，视为“请求可能已发出”，标记为 failed_unknown。这与图片的 `markStaleDispatchedUnknown` 处理一致。
- **对账脚本** `scripts/reconcile-video-plaza.ts`（运维用）：对 failed_unknown 任务调用 retrieve 核实结果，然后发布或退款。默认 dry-run。

### 3.3.1 FFmpeg 与文件处理方案（D17，执行前待用户确认）

本节是完整视频下载、FFmpeg 处理和 Supabase 写入的前置门禁。方案获用户明确确认前，只允许 HEAD、xlsx 解析和本地 dry-run；不得下载视频正文、启动 FFmpeg 或写远程环境。

**处理决策矩阵**

1. 下载先流式写入独立临时目录的 `input.mp4.part`，边写边累计字节与 SHA-256；同时用响应头和实际计数双重执行 200MiB 上限。完成后原子改名为 `input.mp4`，全流程不把完整输入/输出同时保留为 Node `Buffer`。
2. `ffprobe` 先读取容器、视频/音频 codec、profile、pixel format、宽高、帧率、时长、码率和起始时间；另用 MP4 顶层 atom 扫描确认 `moov` 是否位于 `mdat` 前，并读取关键帧时间/字节位置，计算首关键帧位置与最大 GOP 间隔。`moov` 本身也纳入启动预算，目标不超过 256KiB；异常大的索引/metadata 不能仅因“已前置”就直通。
3. 分三路处理：
   - 已是 MP4、H.264、`yuv420p`，音频为空或 AAC，`moov < mdat`，首关键帧接近 0、最大关键帧间隔 ≤2 秒、帧率 ≤30fps，且任一 GOP 的字节跨度不超过约 1.5MiB：原文件直通，不重新编码；
   - codec、GOP 与码率可兼容，但 `moov` 在尾部或时间戳需整理：只做 `-map 0:v:0 -map 0:a:0? -sn -dn -c copy -movflags +faststart` remux；remux 不能改变关键帧间隔，GOP 不合格不能走此分支。只清理明确不需要的 global tag，不能误删 rotation/display matrix 与色彩信息；
   - HEVC/AV1/VP9、10-bit/非 `yuv420p`、非 AAC 音频、超过 30fps、关键帧/码率预算不合格或 probe/解码抽检失败：转为 H.264/AAC。建议参数为 `libx264 -preset fast -crf 23 -maxrate 6M -bufsize 12M -pix_fmt yuv420p -profile:v high -level 4.1`，最长边限制 1920 且不放大、帧率上限 30fps，AAC 128k/48kHz/双声道，首帧为 IDR 并约每 2 秒强制关键帧，输出仍加 `+faststart`。6Mbps 上限使 2 秒 GOP 的媒体负载约受控在 1.5MiB，给 10Mbps 参考网络留出 RTT/签名/解码时间。旋转/display matrix 与色彩信息必须保留；HDR/HLG/PQ 输入先停止并抽样评审 tone-map，不能直接压成 SDR。不采用 fMP4/MSE/HLS，避免为当前短视频 progressive playback 引入额外清单、切片和播放器状态。
4. 输出后再次 `ffprobe`，并断言：恰好一个可播放视频流、可选一个音频流、时长/宽高为正、文件 ≤200MiB、`ftyp` 合法、`moov < mdat`、首关键帧接近 0、最大关键帧间隔 ≤2 秒、关键帧索引可 seek、前几秒与 10%/50%/90% 位置均可解码。任何断言失败都不上传。
5. 封面从首个有效画面生成 JPEG；长边限制 960、不放大、质量约 85，并记录实际封面宽高。0 秒黑帧时允许在 0.1 秒重试一次；封面失败使用已有占位图，但视频本身未通过 faststart/解码校验时禁止发布。

**资源与并发**

- 用户要求的总并发为 4 条端到端 lane；禁止再并行启动多个导入进程绕过上限。每条 lane 为“下载 → probe → 处理 → 校验 → 上传 → Storage metadata 核验 → manifest 落盘”，**不连接数据库、不调用 RPC**。
- 下载/remux 最多 4 路；真正 H.264 转码另设 CPU semaphore，当前 16 逻辑核机器先限制 2 路、每路 `-threads 4`，其余 lane 等待，防止 4 个编码器抢满 CPU 反而降低吞吐。
- 临时盘按最坏输入+输出 `4 × (200MiB + 200MiB)` 计算，并要求至少 4GiB 空闲后才启动；当前临时盘只读检查约有 31.8GiB 可用。任务结束或失败都在 `finally` 清理独立目录。
- 下载采用连接/响应头超时与 30 秒 idle timeout，整体上限建议 10 分钟；只对 GET、HEAD、TUS chunk 这类幂等操作做有限指数退避。FFmpeg remux 120 秒，转码按时长动态预算并设置绝对上限，超时终止子进程组。

**上传、缓存与播放**

- MP4 大多超过 6MiB，使用 Supabase TUS resumable upload 的直连 Storage hostname、固定 6MiB chunk、`upsert=false`；poster 使用标准上传。TUS upload URL 最长只按 24 小时恢复，超时后创建新 upload URL，但仍写同一不可变目标路径；相同路径并发完成时把 `409` 当冲突并核验既有对象，禁止用 upsert 掩盖竞态。
- 对象路径固定为 `media-plaza-video/imports/civitai/<safe-source-id>/<bundle-sha12>/video.mp4|poster.jpg`；处理参数或内容改变会产生新路径，不覆盖旧对象。manifest 记录源/输出 SHA-256、字节数、codec/关键帧摘要、处理分支、FFmpeg 版本与配置指纹、TUS fingerprint、目标环境身份和上传核验结果。
- 私有桶保持 `video/mp4` 与 poster MIME 白名单；上传设置 `cacheControl=86400`，与已发布作品 24h 稳定签名 URL 对齐。token 有效期和对象/browser cache TTL 是两套独立时钟；紧急撤权以删除对象为准，不能只等 token 过期。上传后核对 `storage.objects` 的 bucket/path/size/MIME/custom SHA metadata；只把“已上传且核验”写入 main upload manifest。
- Production/main Storage 全量阶段允许 4,000 组对象处于“有对象、无业务行”的受控中间态；失败不自动删除已经核验通过的对象，重跑从 manifest 续传。只有 manifest 中本次创建但未核验的对象进入隔离/清理清单。
- `<video src>` 直接使用可播放 URL，依赖 `Range`/`206`、`faststart` 与 ≤2 秒 GOP，禁止 `fetch → blob`。列表仍为零 MP4；单视频详情/ready 卡在可见后允许对唯一活动视频使用 `preload="auto"` 争取 2 秒快开，离页/隐藏时移除 `src`，开启省流量时降为 `metadata`。
- Supabase 对每个 signed token 使用独立 CDN cache key，因此签名缓存必须复用**同一个 URL**：已发布作品 24h、未分享私有作品 15min，并对同 key 加 single-flight 防止并发签名风暴。现有 2,000 条共享 LRU 小于 4,000 个 poster + 4,000 个 mp4 的工作集；实施时先以有界 10,000 条上限（含图片）做内存基线，若实际 URL 长度导致额外堆内存 >20MiB，则拆成 poster/video 两个有界池而不是引入 Redis。
- 上传到 main 但尚无 DB 行的对象不会获得播放签名，因此 `cacheControl=86400` 不会让它们提前公开；TEST/上线后的撤回仍以删除对象并等待 CDN 失效传播为准。签名 URL、token、object path 不进入业务日志、性能上报或 SQL 结果输出。

**确认后的 canary 与停止条件**

- 先按 6 个模型各取可用样本，覆盖直通、remux、转码三类；生成 codec/处理分支/输入输出字节/耗时清单，经人工复核后才允许 4 路批量处理。
- TEST 私有桶逐项验证未签名访问拒绝、签名 URL `Range: bytes=0-1` 返回 `206`/正确 `Content-Range`、拖动可恢复、同对象重复请求复用同一签名 URL。
- 网络节流验收：参考网络固定为下行 ≥10Mbps、RTT ≤100ms、无丢包；冷缓存点击到首个解码帧 p95 ≤2s，跳转未缓存位置到新画面 p95 ≤2s，列表页 MP4 请求数仍为 0。另做约 1.6Mbps/150ms RTT 观测但不承诺单码率 MP4 绝对 2 秒；若弱网也必须达标，则提前接入 ABR 点播而不是继续压低单文件画质。
- 任一出现输出不可解码、`moov` 未前置、URL 越权、内存随文件大小线性堆积、HDR 未覆盖，或转码/上传失败率 >2%，立即停止批量处理并保留 manifest 供恢复。若 canary 中需要完整转码的比例 >10%，先重新估算总耗时与转码后容量并再次请用户确认，不直接跑 4,000 条。

### 3.3.2 短剧播放链路复用边界（D21）

短剧模块已证明的不是“某个编码参数”，而是从地址获取到首帧的完整控制与观测方式。本任务复用以下语义：

- Backend 签名：显式 5 秒超时；同 path + scope 并发请求共享一个 Promise；缓存命中返回逐字节相同的 URL 与原始到期时间；失败只记录脱敏原因，不记录 URL/token/path。
- 地址预取：用户点击视频卡片时预取 playback JSON，临近自动播放时也可只预取下一条播放地址；feed DOM 生命周期内仍禁止创建 `<video>` 或请求 MP4。预取地址和预取媒体字节必须在指标上分开。
- 播放换源：签名过期或网络恢复重签时，先保存 `video_id/currentTime/paused`，新地址 `loadedmetadata` 后恢复原位置；旧 source 立即 pause、移除 `src` 并 `load()`，迟到事件不能污染新 source。
- 快开/seek 观测：地址阶段记录 API/签名 cache=`hit|miss|inflight`；媒体阶段记录 `source_set → loadedmetadata → loadeddata/canplay → playing + first_frame`，首帧优先 `requestVideoFrameCallback`、旧 WebView 降级为 playing 后 currentTime 推进。另记录 seeking 到新位置首帧、waiting/stalled 与当前位置连续 `bufferedAheadMs`，但不把 `canplay` 或 `play()` Promise 单独算成功。
- 页面策略：列表零 MP4；详情在明确播放意图后使用 `preload="auto"` 争取 2 秒快开，未点击时保持 poster/metadata；隐藏、换作品或离页释放 source。该策略与短剧“临近片尾只预取下一条地址”一致，不做后台无界预加载。

### 3.4 提示词自动优化：视频关闭（D9）

Venice 的视频接口没有优化字段（DOC），用户决定视频不提供此功能：

- 视频的契约、表和 provider payload 里都没有 `auto_optimize`；用户 prompt 原样发给 Venice。
- 前端视频设置不显示该开关；从图片切到视频时不沿用图片的 `auto_optimize`。
- 图片链路的 `auto_optimize` 不变。
- 拒绝的方案：自研 LLM 改写。它会多一次外部调用和失败点，成本无人承担，也偏离用户决定。

### 3.5 Provider payload

`video-catalog.ts` 按 `input_mode` 选择 provider id，然后按白名单组装字段：

- i2v 不发送 aspect_ratio；
- 音频不可配置的模型不发送 audio；
- 永远不发送 safe_mode（视频接口会以 400 拒绝未知字段）。

图片的放置位置：i2v 放 `image_url`，r2v 放 `reference_image_urls[0]`。值使用 60s 有效的签名 URL，或 data URL。

提交前校验：短边像素数、长宽比 0.4–2.5、大小 ≤25MB。

### 3.6 计费（需求 5，决策 D2）

- 报价使用 `price_matrix[duration|resolution|audio]`，单位为星尘。运营在 Admin 中按 `/video/quote` 的 USD × 汇率 × 加价倍率计算并填入，复用图片的价格公式 UI。服务端只认目录中的价格。
- `/video/quote` 仅供运营核价时调用（Admin 中的“刷新参考价”按钮通过 backend admin 路由代理），不放在用户请求路径上。这样能避免供应商延迟和价格波动直接影响用户。
- 提交流程：先查余额（不足返回 402），再做 reserve（RPC 内部加锁并再次检查余额，防止并发透支）。
- 退款统一由 `refund_media_plaza_video` 完成。
- 返利的计算基数为预扣金额；已退款的 attempt 不能分享。

### 3.7 审核拒绝（需求 6）

识别条件：queue 返回 422，或者 retrieve 返回 422 且 `error.type == 'provider_content_policy'`。

处理：

1. 状态置为 `moderation_rejected`，error_code 记为 `video_moderation_rejected`；
2. 调用 refund RPC；
3. 发送 Sentry 计数 `video.moderation_rejected{model}`。

如果响应带有 `recommended_model`，只记日志，不自动切换模型。

## 4. 共享契约（先于消费者修改）

新增 `packages/shared/src/api/video-plaza.ts`，并从 `index.ts` 导出：

- `VideoPlazaInputModeSchema`：`t2v | i2v | r2v`。
- `VideoPlazaModelSchema`（对外公开的字段）：
  - 基本信息：`id`、`name`、`description`。
  - 输入图片方式 `image_input`：`none | optional_first_frame | optional_reference | required_reference`。
  - 可选范围：`durations: number[]`、`resolutions: string[]`、`aspect_ratios: string[]`。
  - 默认值：`audio_configurable`、`default_audio`、`default_duration`、`default_resolution`、`default_aspect_ratio`。
  - 限制：`image_constraints`，包含 `min_short_side?`、`min_ratio?`、`max_ratio?`。不设 `prompt_max_chars`（D14，视频提示词无字数上限，与图片的 `IMAGE_PLAZA_PROMPT_MAX_CHARS` 常量无关）。
- `ProviderVideoPlazaModelSchema`：在公开字段基础上增加
  - `provider_ids: { t2v?, i2v?, r2v? }`
  - `enabled`、`sort_order`
  - `price_matrix: Record<string, number>`，key 格式为 `"<s>|<res>|<0/1>"`
  - superRefine 校验以下三项：
    1. 默认值必须在可选范围内；
    2. 价格矩阵必须覆盖所有组合；
    3. `image_input` 要与 provider_ids 一致。例如 `required_reference` 不能配 t2v，必须配 r2v 或 i2v。
- `VideoPlazaModelCatalogSchema`：`{ default_model_id, models(1..30), standard_prices? }`，默认模型必须处于启用状态。
- 请求与响应：
  - `VideoPlazaQuoteRequest` / `VideoPlazaQuoteData`。
  - `SubmitVideoPlazaAttemptRequest`（`.strict()`）：`prompt: z.string().trim().min(1)`（不设 `.max()`，D14）、`quote_id`、`idempotency_key`、`reference_artifact_id?`。不含 `auto_optimize`，客户端传入时返回 400（D9）。请求体大小仍受路由 `bodyLimit` 约束（沿用图片路由同量级设置），这是传输层保护，不是字数上限。
  - `VideoPlazaAttemptSchema`：`status`、`error_code`、`quote_credits`、`params`，以及 `artifact?`（内含 `id`、`video_url`、`poster_url|null`、`width`、`height`、`duration_ms`）。
- `PlazaVideoWorkSchema`：`media_type: 'video'`、`poster_url`、`duration_ms`、`description`、`model_id`、`model_name`、`like_count`、`liked`、`snapshot`；`video_url` 只在详情接口返回。

`image-plaza.ts` 的兼容修改：

- `ImagePlazaFeedQuerySchema` 增加 `media?: 'all'|'image'|'video'` 和 `tags?: string`（逗号分隔，最多 10 个）。
- `ImagePlazaWorkSchema` 增加 `media_type`，默认值 `'image'`。
- 新增 `PlazaFeedItemSchema`，按 `media_type` 做 discriminatedUnion。请求不带 `media` 时，服务端只返回图片，旧客户端不受影响。
- `ImagePlazaMessageSchema` 增加 `media_type`（默认 `image`）和 `video_attempt`（可为 null）。
- `ImagePlazaTagConfigSchema` 的每一项增加 `media_types`，默认 `['image']`，因此旧配置无需迁移即可解析。
- `GetImagePlazaConfigDataSchema` 增加 `video_models`、`default_video_model_id`，`tags[]` 增加 `media_types`。

## 5. 前端（需求 2.1–2.7、8）

所有业务数据请求都通过 `lib/api/image-plaza.ts` 中的 React Query hooks 发出，组件内不直接调用 fetch。**例外**：`<video>` / `<img>` 的媒体字节由浏览器对可播放 URL 自行请求（含 Range），不经过 React Query，也不在组件里 `fetch` 后再塞给播放器（见 §5.1）。

### 5.1 边下边播：ReadableStream 与 `<video>` 的正确接法（D15）

文件都是私有桶里的 mp4；服务端负责鉴权与「把可播放地址交给前端」。目标是用户点击后尽快出画，而不是等整文件下完。

#### 结论先说清楚

| 做法                                                                                  | 能否边下边播                                          | 本任务                       |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------- |
| `<video src={可播放URL}>`，URL 支持 HTTP Range，mp4 带 faststart                      | 能（浏览器原生 progressive download）                 | **主路径**                   |
| 同域 `GET .../stream` 代理桶对象，响应支持 `Range`/`206`，仍把该 URL 赋给 `video.src` | 能                                                    | **鉴权需要走自家域名时采用** |
| `const res = await fetch(url); video.src = URL.createObjectURL(await res.blob())`     | **不能**（`blob()` 等整段读完才有 Blob）              | **禁止作主路径**             |
| `fetch` → `res.body`（ReadableStream）直接赋给 `video.src` / 当 `srcObject`           | **不行**（`<video>` 不接受 ReadableStream）           | 不可用                       |
| MediaSource + `SourceBuffer.appendBuffer` 边收边 append                               | 理论上能，但要 fMP4/分片，普通 progressive mp4 不兼容 | **本任务不做**               |

要点：**不存在「把 `fetch()` 的 ReadableStream 传入 `<video>`」这条 API。** 边下边播靠的是「给一个支持 Range 的 URL，让浏览器自己拉」，而不是前端先 `fetch` 再手工喂字节。

#### 播放源抽象与 CDN 点播演进（D18）

- route 不直接拼 Storage URL，只调用单一 `VideoDeliveryProvider.getPlaybackSource(artifact, viewer)`。当前实现为 `supabase_progressive`，内部签私有桶 URL；页面永远不接触 `storage_path`。
- shared playback DTO 以可加字段的描述对象表达：`provider`、`format: progressive_mp4`、`url`、`mime_type`、`expires_at`。当前保留已有 `video_url` 兼容字段；未来增加 `hls`/`dash` source 时为加法演进，不改变作品/attempt ID。
- 前端收口到一个 VideoPlayer adapter：当前把 progressive URL 直接交给原生 `<video>`；未来 iOS/WebKit 可直接接 HLS，其他端按真实需要再引入 hls.js。当前不提前引入 HLS 依赖或 MSE 状态机。
- `media_plaza.video_artifacts` 与私有桶对象继续是 canonical source。未来 CDN ingestion、转码状态、外部 asset/playback ID 用 `media_plaza` 域内的新映射表和单独 migration 承载，不把供应商字段塞进现有 snapshot，也不在本次提前创建空表。
- CDN adapter 需支持异步 ingest、幂等 webhook、状态轮询、删除/撤权和 origin 回退；发布时优先 CDN source，CDN 未 ready 或故障时仅在符合 2 秒 SLO 的情况下回退 Supabase progressive。
- CDN ABR 推荐 2 秒 CMAF segment/GOP 对齐，至少准备低码率启动档与 720p/1080p 档；这样弱网可先起低清晰度再自适应，而不是要求单码率 MP4 在任意带宽下绝对 2 秒。
- D19 明确本次不在 Supabase 私有桶自建 HLS/DASH 或多份 MP4 梯度：避免 4,000 条产生 2–3 倍存储、海量小对象和逐 segment 鉴权复杂度。当前只交付标准 progressive MP4；弱网 ABR 由后续点播平台负责。

#### 推荐接法 A：签名 URL（默认）

1. 详情 / attempt ready / playback 接口返回短时签名的 `video_url`（Supabase Storage signed URL）。
2. 前端：

```tsx
<video
  src={videoUrl}
  poster={posterUrl ?? undefined}
  controls
  playsInline
  preload="metadata"
  onError={handlePlaybackError} // 过期则调 playback 重签一次
/>
```

3. 浏览器会对该 URL 发 `Range`；Storage/CDN 回 `206 Partial Content` 时即可边收边播。
4. 组件**不要**再对该 `video_url` 做带 Authorization 的 `fetch` 再转 blob——那样既丢 progressive，又可能把签名 URL 打进日志。

待验证（实施期）：在 test 对 `media-plaza-video` 签名 URL 用 curl 带 `Range: bytes=0-1` 确认返回 `206` 与 `Accept-Ranges: bytes`。若 CDN 剥离 Range，改走接法 B。

#### 推荐接法 B：同域 Range 代理（服务端读桶推前端）

当签名 URL 在 Telegram WebView 不稳定、或必须把流量落在自家域名时：

1. `GET /api/image-plaza/video-artifacts/:id/stream`（`@frontend-ready` 随前端接入改 true）
   - 鉴权：与现有 plaza 路由同一套（归属或公开作品）。
   - 从私有桶 **流式**读对象（禁止整文件 `arrayBuffer` 进内存）。
   - 必须实现：解析请求 `Range`；回 `206` + `Content-Range` + `Accept-Ranges: bytes` + 正确 `Content-Type: video/mp4`；无 Range 时也可 `200` 整段，但仍应声明 `Accept-Ranges`。
   - 超时与体积上限与转存一致（单文件 ≤200MiB）；pino 只记 artifactId / status / range / durationMs，**不记** storage path 明文以外的敏感信息。
2. `playback`（或详情 DTO）里的 `video_url` 直接写成该同域 stream 路径（可带短时 token query，若 cookie 会话不够用）。
3. 前端仍然：

```tsx
<video src={streamUrl} /* 同上 */ />
```

浏览器会对 **同一个** `src` 发多次 Range；服务端按 range 从桶里切片转发。这才是「服务端读取推送 + 边下边播」。前端不应 `fetch(streamUrl)` 再处理 `body`。

#### 明确的反模式（不要写进实现）

```ts
// ❌ 看起来像「流式」，实际是整文件下完才播
const res = await fetch(videoUrl, { headers: { Authorization: `Bearer ${token}` } });
const blob = await res.blob(); // 内部会读完 ReadableStream
videoEl.src = URL.createObjectURL(blob);

// ❌ ReadableStream 不能作为 video 源
videoEl.srcObject = res.body as unknown as MediaStream; // 类型都不对，运行时无效
```

若未来有「必须带自定义 Header、又不能改成 cookie/query 鉴权」的硬约束，只能上 MSE+fMP4 或改为接法 B；本任务不预建该框架。

#### 入库与契约约束（配合播放）

- worker / seed：上传前 `-movflags +faststart`（见 §3.3）。
- DTO：`video_url` 语义为「可直接赋给 `<video src>` 的 URL」，不是「再 fetch 一次的 API」。
- 列表卡继续只用 `poster_url`，禁止预加载 mp4（需求 2.3）。

**`create/page.tsx`（广场）**

- 类型筛选：在标签行和搜索框之间加分段控件。样式沿用现有排序胶囊按钮（原型只作参考，见 D7）。
- 列表查询：`useImagePlazaFeedQuery(search, tags[], sort, media)`，queryKey 包含 media 和排好序的 tags。
- 标签行：横向滚动的标签保留，行尾固定放一个「全部风格」按钮，点开 `style-filter-sheet.tsx`：
  - 基于现有 Sheet，支持多选；
  - 各标签计数由 `useImagePlazaTagCountsQuery` 懒加载，加载失败显示“—”。
- 视频卡片：
  - 封面用 `<img loading=lazy>`，图片走 transform 缩略图；
  - 角标显示 `m:ss` 时长，叠加播放图标；
  - 卡片下方显示描述、点赞数、模型名，以及「用同款」按钮；
  - 列表中不使用 `<video>`。
- 返回状态：`saveImagePlazaReturn` 需要同时保存 media 和 tags。

**`work/[workId]/page.tsx`（详情）**

- 地址失效：`onError` 时调用 playback 刷新 `video_url` 一次（重签或换新 stream token），再赋回 `src`；不要改走 blob 下载。

**`studio/[conversationId]/page.tsx`（工作室）**

- 输入栏增加「图片 / 视频」切换，切换后仍在同一会话；图片和视频各自保留草稿。
- 视频模式的模型与设置：
  - 模型选择打开 `video-model-sheet.tsx`，复用现有模型 Sheet 的结构，只列视频模型；
  - 设置打开 `video-settings-dialog.tsx`，复用从 `studio-settings-dialog.tsx` 抽出的 `SettingSection`、`ChoiceButton`、`ToggleRow`，包含时长、比例、清晰度、声音四项，不含自动优化（D9）；
  - 默认模型为 `default_video_model_id`（即 Wan 3.0 Pro），声音默认开启；音频不可配置的模型（MiniMax 系列）把声音显示为“固定有声”，不可切换。
- 附图规则：
  - 模型为 `none` 时，附图按钮禁用，并提示“该模型不支持参考图”；
  - 模型为 `required_reference` 且没有图片时，禁止提交并提示补图；
  - 切换到不兼容的模型时，先提示再移除图片，不静默丢弃；
  - 附图旁标注其用途（首帧 / 参考图）；
  - 参数不合法时重置为该模型的默认值，并 toast 提示。
- 提交：报价和 idempotency 的处理与图片相同；后端返回 402 时弹出充值提示，草稿保留。
- 消息渲染：
  - 按 `media_type` 区分，图片用 `StudioArtifactCard`，视频用新组件 `studio-video-card.tsx`；
  - 预览播放同样走 §5.1（`src=video_url`，不 fetch→blob）；下载按钮与播放分离：下载可走整文件拉取或 `requestTelegramFileDownload`，**不得**为了播放去整文件缓冲；
  - 视频卡片的按钮与图片卡布局一致：编辑（回填 `params_snapshot`）、重新生成、复制、下载（`requestTelegramFileDownload`，失败时降级为打开原视频）、分享（复用现有分享 Sheet 和返利角标）。
- 状态提示：
  - 生成中显示“排队中 / 生成中 · 预计 xx 秒”；
  - 审核拒绝时显示专用文案，并提供「修改提示词」入口。
- 轮询：`useVideoAttemptQuery` 的间隔从 3s 开始，每次 ×1.5，上限 15s；页面隐藏时暂停，回到前台立即刷新；到达终态后停止轮询，并让会话和钱包缓存失效。

**性能（需求 8）概要** → 详见 **§5.2**（列表）与 **§5.3**（创作页）。前端只做本节已列的接线与裁剪，不另起请求层。

### 5.2 列表加载性能设计（R8.A，对照当前图片广场）

#### 现状路径（SRC，必须保留的优点）

```
Tab/入口 → (理想) prefetchInfiniteQuery 默认 feed
         → create/page useImagePlazaFeedQuery
         → GET /api/image-plaza/feed?sort&tag&search&cursor
         → getImagePlazaRuntimeConfig
         → listSortedWorks (1～2 次 PostgREST)
         → hydrateWorks: artifacts.in ∥ likes.in → Promise.all(sign × ≤20)
         → 前端：stale 60s / 过期保第一页 / IO 240px / 前4 eager 其余 lazy
```

硬数字（SRC）：`IMAGE_PLAZA_PAGE_SIZE=20`；feed `AbortSignal.timeout(10_000)`；缩略图 `width:720,quality:72`；签名已发布 TTL 24h、LRU≈2000；单页业务 DB ≈4～5 次 + 冷签 ≤20。

未接线：`prefetchImagePlazaFeed` 已与页面共用 `imagePlazaFeedQueryOptions`，但 `providers` / `entry-phase` **无调用方**（注释写了空闲预取）。

#### 三条硬约束（与 p95 同级）

##### A. 游标分页（复用 `feed-cursor.ts`）

| 规则        | 说明                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 编码        | 继续 base64url + Zod schema；`pageSize=20`，查询 `limit+1` 生成 `next_cursor`                                                                                   |
| filter 哈希 | 现状 `sha256(JSON([search, tag]))`；扩展为纳入 **`media` + 排序后的 `tags[]`**（与单 `tag` 兼容规则：`tags` 优先）。sort/filter 与请求不一致 → `INVALID_CURSOR` |
| 分区        | `recommended`：liked → zero（`initial_feed_order`）；`latest`：时间+id；视频混排后分区键仍在同一 works 投影上，靠 `media_type` 谓词 + 复合索引                  |
| 前端        | `infiniteQuery` 的 `pageParam` 即服务端 cursor；筛选变更换 queryKey 并清空旧 pages；stale 刷新**只留第一页**再 refetch，避免坏游标续页                          |
| 禁止        | offset 分页、客户端合并多筛选项结果、用上一筛选项的 cursor 请求新筛选项                                                                                         |

实施检查：对 `media=video` / `tags` 多选 / 搜索组合各跑一页翻页，断言无重复 id、无回跳；EXPLAIN 游标谓词走 §2.3 索引。

##### B. 列表无 MP4

| 规则        | 说明                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 渲染        | 列表仅用 `<img>` 显示封面，按位置设置 `loading="lazy"` 或 eager 加载                                                   | 禁止 `<video>`、禁止 prefetch/preload mp4 |
| DTO         | feed item **不得**含 `video_url`、storage 原 path、provider `download_url`；最多 `poster_url` + `duration_ms` + 元数据 |
| Hydrate     | 视频行只对 `poster_path` 调签名；图片行保持现有 artifact 图签名；**零次** mp4 `createSignedUrl`                        |
| 详情/工作室 | 进入详情或消息卡可见时再签 mp4；`preload="metadata"` + `poster`；过期走 playback 重签                                  |
| 验收        | DevTools/网络面板：列表文档生命周期内 `mp4` / `video/` MIME 请求数 = 0                                                 |

这样把“重资源”挡在首屏之外，列表 p95 只承担封面图签名与 DB，不承担视频字节。

##### C. 资源走签名缓存（复用并扩展 `storage.ts` LRU）

现状机制（SRC，必须保留语义）：

- 私有桶；已发布作品图 TTL **24h**，私有参考/未分享产物 **15min**。
- 进程内 `Map` LRU 上限 **2000**；键 = `path|expiresIn|widthxquality`；提前 **5min** 视为过期。
- **为何缓存**：Supabase Smart CDN 以完整签名 URL（含 token）为键；每次重签 = CDN/浏览器全 miss + Storage 回源。缓存保证 TTL 内 URL 逐字节稳定。

视频扩展：

| 资源            | 桶                  | 列表是否签名              | TTL / 是否进 LRU                      | transform        |
| --------------- | ------------------- | ------------------------- | ------------------------------------- | ---------------- |
| 图片作品缩略图  | `image-plaza`       | 是                        | 24h / 是                              | 720×72（不恶化） |
| 视频封面 poster | `media-plaza-video` | 是                        | 24h / 是                              | ≤480 宽          |
| 详情/工作室 mp4 | `media-plaza-video` | **否（列表）**；详情/卡是 | 24h / 是（无 transform 或固定原画键） | 无（整文件）     |
| 未分享私有产物  | 对应私有路径        | 否（非 feed）             | 15min / 按现逻辑短链，避免长 TTL 泄露 | 按需             |

约束：

- 新增 `signSharedWorkVideoPath` / `signSharedWorkPosterPath`（名称实施时可调整）必须走**同一套** `read/writeSignedUrlCache`，仅扩展 bucket 与 path assert；禁止“视频每次现签、图片走缓存”的分裂实现。
- 多副本各自 LRU 可接受（与图片注释一致）；不为此引入 Redis，除非 p95 证明跨副本冷签是主因（届时另开任务）。
- feed 一页 ≤20 次签名调用；热缓存命中时应接近 0 次 Storage HTTP；冷启动尖刺计入 p95，但不得改为公开读。
- 播放重签：命中 LRU 直接返回；miss 再 `createSignedUrl` 并回写。

#### 其它增量

| 项       | 做法                                                                         | 拒绝的替代             |
| -------- | ---------------------------------------------------------------------------- | ---------------------- |
| 索引     | works 增加含 `media_type` 的推荐/最新复合索引；EXPLAIN 后决定是否保留旧索引  | 每次翻页重算推荐       |
| DTO 裁剪 | 列表不要完整长 `snapshot`；详情再取全量                                      | 详情字段塞进列表       |
| 标签计数 | 独立 `GET /feed/tag-counts`，≥60s 缓存；失败 UI 显示“—”                      | 每次 feed 同步扫库计数 |
| Prefetch | 接线默认 feed 预取；queryKey 含 media                                        | 进页才首请求且无缓存   |
| 搜索     | 维持 `prompt_zh ILIKE` + 300ms debounce；搜索样本不与无筛选首屏混算 p95 门禁 | 规划阶段另起搜索引擎   |

#### 列表侧耗时分解与门禁归属

1. **后端处理**（鉴权+config+list+hydrate+sign）→ `http.server.duration` p95 ≤ **500ms**（`kind=standard`）。其中签名段应可从日志区分 cache hit/miss（实施期可加低基数计数，禁止打 path）。
2. **端到端 API**（含网络）→ 前端 `api.request.duration` feed p95 ≤ **800ms**。
3. **首屏可交互** → `page.ready.duration` `/create`；以实施前实测为基线，退化 ≤10%。
4. **硬约束验收优先于微优化**：游标正确、列表 0 mp4、公开资源签名走 LRU；三者缺一不得宣称 R8.A 完成。
5. 冷签扇出尖刺计入 p95；不得用去掉签名/改公开桶规避。

可观测：保留现有 `image_plaza.feed.completed` + `durationMs`；视频上线后按 `media` 低基数标签区分（`all|image|video`）；可选 `plaza.sign.cache_hit` count（仅 hit/miss），禁止高基数 tag。

### 5.3 创作页回复生成性能设计（R8.B）

#### 现状路径（SRC，图片）

```
create → startAction(create_conversation) → POST conversation → setQueryData → studio
studio 首屏：config ∥ conversation（全量 messages+attempts hydrate）
设置变更 → POST /quotes（无 debounce）
发送 → quote.mutateAsync → POST .../attempts (202) → startAction(image_generate).feedback（受理）
     → conversation refetchInterval 固定 2000ms（pending/generating）
worker：3s tick / claim≤2 / Venice≤180s / settle RPC → ready
图 onLoad → image.display.duration（结果可见，与受理分离）
```

要点：受理反馈与出图完成**必须继续分离**（10-21）；Venice/worker 耗时进 `video.duration_to_ready` / 图片 display 指标，**不进** standard API p95。

#### 视频与图片共同优化

| 环节     | 优化                                                                                                                                                                           | 指标                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 进入创作 | 点「去创作」/「用同款」时 `prefetchQuery(config)` + studio 路由；会话创建成功继续写穿缓存                                                                                      | `page.ready` studio ≤1.5s（有缓存）                 |
| 报价     | 设置变更 **debounce ≥300ms**；同 model+参数命中未过期 `quote_id` 则复用；提交前再 quote 校验失败则一次重报                                                                     | `/quotes` API p95 ≤800ms                            |
| 提交受理 | 保持 202；校验→写库→（视频）reserve→返回；不在请求内等上游                                                                                                                     | `action.feedback` p95 ≤2.5s；`action_stall` 可告警  |
| 状态可见 | 视频：`GET video-attempts/:id` 轻量轮询，退避 3s→×1.5→cap 15s，`document.hidden` 暂停；图片：逐步从固定 2s 全量会话轮询改为“有进行中才拉取 + 退避”，避免长会话每次全量 hydrate | attempt/conversation GET p95 ≤800ms                 |
| 结果可见 | 视频 poster 优先（签名 LRU）；mp4 仅详情/工作室卡按需签名并写同一 LRU；列表路径零 mp4；图片保持 onLoad 上报                                                                    | `image.display.duration` / `video.attempt.terminal` |
| Worker   | 视频 submit/poll 分 claim；poll 对 429/5xx 退避；单用户进行中视频 ≤2                                                                                                           | 不计入 standard p95                                 |

#### 请求优先级与超时

- feed / config / conversation 首屏：沿用现有 critical / 超时策略；feed 10s 客户端超时保留。
- attempts 提交、references 上传：长路径，bypass 繁忙队列；超时与图片同量级（提交短、上传长）。
- 轮询请求不得打满：隐藏页暂停；终态停止；退避上限 15s。

#### 与计费/可靠性的边界

- 性能优化不得削弱：幂等键、reserve/refund 唯一、参数与 quote 一致性校验、402 不打上游。
- 削减 hydrate 字段时，编辑/用同款所需 `params_snapshot` 必须在 attempt/详情中仍可用。

## 6. Admin（需求 2.2、2.6）

- `ImagePlazaConfigEditors.tsx`：
  - 新增 `VideoPlazaModelCatalogEditor`，复用 `PricingRow` 和汇率公式。每个模型维护两部分：duration×resolution×audio 价格表，以及 provider id 映射。
  - 「刷新参考价」调用 backend admin 代理 `/video/quote`，结果只回填到标准价参考列。
- `ImagePlazaTagsEditor`：每个标签增加 `media_types` 多选（图片/视频）。
- `configSchemas.ts`：注册 `image_plaza_video_model_catalog`，用 shared schema 校验；DB 侧由 M3 同步。
- 发布和回滚流程不变。

## 7. 种子数据（需求 3）

- 解析：`video-seed-import.ts` 读取 6 列 xlsx（列定义见 research）。
  - 按 `Civitai Video ID` 去重。
  - `Venice 模型` 字段映射到目录中的 model id。
- 中文译文（D11，参数 `--translations <video.xlsx>`，必填）：
  - 翻译包为单个 sheet，列为 `type, id, model, heat, prompt_en, prompt_zh`。
  - 对照键：`id` 等于原表 `Video URL` 去掉 `https://<host>/` 前缀和 query 后的路径。
  - 一致性校验：命中后还要比对 `model`、`heat`、去空白后的 `prompt_en` 与原表是否一致；任何一项不一致都归为「待修复」，错误码 `translation_mismatch`。
  - 原表有、翻译包没有的行（实测 15 条），归为「已剔除」，错误码 `excluded_by_translation_pack`，对应原型的涉未成年剔除。
  - 翻译包有、原表没有的行，计入 `translation_orphan` 报告，不导入。
  - 写入方式：`snapshot.prompt_zh = prompt_zh`，`snapshot.prompt_zh_source = 'translation_pack'`。标签匹配和搜索沿用现有 `prompt_zh ILIKE` 规则，不再调用翻译脚本。
  - manifest 记录两份 xlsx 的 SHA-256；导入时如果 hash 与审核时不同，就拒绝执行。
- 导入流程，在图片 seed 的做法前新增体积估算步骤（D13）：0. **体积估算（新增，必须人工确认后才能继续）**：对原表 5,097 条的 `Video URL` 逐一发 HEAD 请求（并发度限制，见下方可靠性设计），读取 `Content-Length` 求和；按 model 分组小计；输出 `video-seed-size-report.json`（含总字节数、按模型小计、HEAD 失败/无 Content-Length 的行数清单）。脚本在打印报告后退出，不进入第 1 步，除非带 `--confirm-size <报告文件的 SHA-256>` 参数——这样人工必须先看过报告内容再决定继续，而不是盲目加一个 `--yes` 跳过。
  - 2026-10-27 首轮只读实测：5,097 条中 5,055 条一次成功；42 条重试后恢复 32 条，最终已知 5,087 条共 48.569 GiB，剩余 9 条 404、1 条连续网络失败。报告 SHA-256 与重试报告分别保留在工作目录外，不提交 Git。
  - D16 之后容量门禁改为只统计最终入选的 4,000 条；原 5,097 条报告仅作为候选集证据，不能直接作为实际转存容量。
  - 2026-10-27 D16 最终报告：5,082 个翻译命中候选中 5,073 个 URL 可访问，9 个连续三轮为 404；水位填充后选满 4,000 条，源文件总量 43,593,139,500 bytes（40.599 GiB），平均 10.39MiB。最终报告 SHA-256 为 `f4004258ecd11d91088a7dabc670420e5cb1c10d0fafde8f949fa7c12dd8b1c4`；该值只覆盖源文件 Content-Length，未包含转码大小变化和 poster，D17 canary 后仍需复核最终存储预算。
  1. 默认 dry-run，只输出计数和错误码；审核最终 Top 4,000 selection manifest，剔除涉及未成年和审核未通过的条目。
  2. 用户批准 D17 后，先在本地处理最多 10 条候选并生成处理报告；TEST canary 固定为最终 4,000 的确定性子集，六模型至少各 1 条，其余覆盖 direct/remux/transcode 与大小/时长边界。
  3. TEST 仅上传这 10 组对象，再用同一 SQL 生成器输出 TEST 10 条 migration；验证 Storage 私有访问、Range/206、签名缓存、2 秒启动/seek、SQL 幂等与 DB/Storage 对账。禁止 TEST 全量。
  4. TEST 通过并再次确认 main/Production 身份与容量后，4 路处理并上传全部 4,000 组对象到 main 私有桶；该程序只接受 `--phase assets`，不得初始化 DB client。下载 SSRF 白名单只允许 `image.civitai.com`，单文件 ≤200MiB，有限重试与断点续传。
  5. 生成 `processed-manifest.json` 与环境专属的 `main-upload-manifest.json`：每条必须同时记录 source/workbook/report hash、选择序位、模型、处理分支、输入/输出/poster SHA-256、媒体元数据、不可变 object path、目标环境、上传/metadata 核验状态；manifest 自身再计算 SHA-256 并只读锁定。
  6. 只有 main manifest 恰好 4,000 条、8,000 个对象全部 verified、0 failed/0 pending，才允许离线生成 Production SQL。SQL 生成器不连远端、不读取 service key，仅把 manifest 与翻译数据转成受审 migration payload。
  7. 上线窗口按顺序执行 8 个每批 500 条的 migration；全部完成前视频 seed 入口/目录保持关闭。最后执行只读 postflight，确认 4,000 work + 4,000 artifact、0 缺对象、0 冲突后再开入口。
- 4,000 条选样（D16）：
  - 输入先经过翻译包一致性、重复 ID 和 URL 可访问性过滤，再参与配额计算；不可访问 URL 不占名额。
  - 使用 max-min fair（水位填充）分配：先平均分给 6 个模型，某模型候选不足则全取，并把余量继续平均分给尚有候选的模型，直到总数为 4,000。
  - 当前 5,082 条翻译命中基线在 URL 排除前的配额为：MiniMax H3 Max 711、MiniMax H3 Max R2V 952、Seedance 1.5 Pro 583、Seedance 2.0 R2V Enhanced 682、Wan 3.0 Pro 952、Wan 3.0 Reference 120。
  - 每个模型内部按 `source_heat DESC, source_video_id ASC` 排序；第二排序键是确定性 tie-break，避免同热度数据在重跑时漂移。
  - manifest 必须记录候选数、最终配额、cutoff heat、cutoff 同分数量、入选 ID 摘要和排除原因；若可访问候选不足 4,000 则停止，不自动降低目标。
- 模型目录：推荐由运营在 Admin 中录入并确认价格，迁移不预置。
  - 默认模型 Wan 3.0 Pro，映射见 research。
  - Seedance 2.0 R2V 映射到 `seedance-2-0-reference-to-video-basic`（D8），只有 r2v，必须带图。种子里的模型标签 `Seedance 2.0 R2V Enhanced` 通过 `seed_aliases` 映射到这个 model id，使“用同款”可用。
  - 参数能力按 D23 取产品集合与 provider 约束的交集。共享纯函数负责过滤与默认值回落；Admin 在过滤后同步裁剪价格矩阵，Frontend 对已发布旧目录再做一次消费侧过滤。分辨率显示统一大写，向 provider 提交时保留目录原值大小写，避免 MiniMax/Wan/Seedance 契约分叉。
- 提示词长度：视频不设字数上限（D14）。`prompt`/`prompt_zh` 原样写入 `TEXT` 列，不因长度隔离、不截断；原表 879 条英文超 2,000 字、翻译包 129 条中文超 2,000 字都正常导入。分类四类（已导入/已存在/待修复/已剔除）不含“提示词过长”。
- 排序：外部热度存入 `source_heat`，排序沿用 20261019 的 `initial_feed_order` 规则；不写入本地点赞。

### 7.1 main/Production Storage 与 SQL 发布包（D20–D22）

**物理隔离**

- main 上传前只读核对 `media-plaza-video` 私有 bucket、200MiB 单对象限额与 MIME 白名单。若 bucket/M2 基础对象尚不存在，先走现有 `20261027_media_plaza_video.sql` 的独立 Production 审批与 migration workflow 建立结构；这一步允许建空表和 bucket，但必须保持 seed work/artifact 为 0，禁止为了赶上传而在 Studio 手工建桶造成 migration drift。
- `upload-video-plaza-seed-assets.ts` 只做下载/处理/上传/对象核验，不导入 `getDomainDb`、不调用 PostgREST RPC、没有 `--apply` 或 `--write-db` 参数。启动前从非 secret URL 解析 project ref，与命令中显式允许的 main ref 比较；目标不一致立即停止。
- `generate-video-plaza-seed-sql.ts` 只读 xlsx、selection report、processed manifest 和 main upload manifest，离线生成 SQL；不含网络调用。旧 `importVideoSeedRow` 的“上传后立即 RPC，RPC 失败删除对象”执行模式退役，避免在 main 全量上传阶段误写库或误删已核验对象。
- TEST 与 main 使用相同的不可变相对 object path，但属于不同 project/bucket；manifest 必须带环境身份与 bucket，不能把 TEST 的 verified 状态复制给 main。

**SQL 形态**

- 复用 `20261019_image_plaza_seed_bootstrap.sql` 的成熟模式：每个 migration 自带 `BEGIN/COMMIT`、`lock_timeout='5s'`、`statement_timeout='15min'`、payload hash、数量/重复 ID 检查、私有 bucket 前置检查、`storage.objects` size/MIME/custom hash 核验和稳定 source ID 顺序。
- 每行调用现有 `media_plaza.import_video_seed_work(...)`；它已有 advisory xact lock、`(origin, source_video_id)` 幂等和冲突拒绝。禁止生成绕过 RPC 的 artifact/work 裸 INSERT，避免 SQL 与运行时业务约束分叉。
- TEST 输出一个显式 `_test_canary` 文件；Production 输出 8 个显式 `_production_01`…`_08` 有序文件，每个最多 500 条，全部放在唯一 migration 源 `packages/shared/migrations/`，由 `Database Migration` workflow 一次一个文件执行并记账。实施时同步给 workflow 增加环境后缀拒绝规则，TEST 文件不能选 production、Production seed 文件不能选 test；文件头再写前批依赖、main manifest SHA-256、selection report SHA-256 与 batch 范围，避免只靠人工辨认环境。
- 每批允许“新导入或完全一致的已存在”，但任何 path/source URL/snapshot/metadata 冲突整批回滚；批末断言本批 500 个 source ID 全部存在且引用对象一致。第 8 批再断言完整集合 4,000 条，无遗漏或额外覆盖。
- 同时生成不写库的 `preflight.sql`、`postflight.sql` 与对账摘要。preflight 检查 schema/RPC 签名与 owner/ACL、bucket 私有和限额、8,000 对象、既有 seed 冲突、锁/容量；postflight 检查数量、FK、媒体元数据、模型分布、对象缺失和账务/返利零变化。

**失败、恢复与下线**

- 某批失败只回滚该批；已记账批次不 force-rerun、不改历史文件，修复后生成新的 forward-fix migration。入口保持关闭，因此允许从下一未完成批继续，不要求把已成功的前批删除重来。
- DB 尚未发布时，main 对象由 manifest 管理为 staging-in-place；暂停发布不删除。确认放弃整批后才用精确 manifest 路径生成清理清单，人工复核后删除，禁止按 prefix 递归清空 bucket。
- 上线前若必须撤回，可对精确 source ID 做受保护 hard rollback，但前置必须断言 `like_count=0`、无 like/reward/外部引用且入口从未开放。入口开放后不再 hard delete；生成新 forward-fix 将精确 works 软删除/下架，保留 artifact 与对象，待引用和缓存窗口结束后另行清理。

## 8. 监控（需求 8，遵循 10-21-sentry-ux-monitoring）

### 8.1 两条路径的 Sentry p95 看板（必须单独成图）

沿用现有指标，不新建平行埋点体系。看板按 **列表** 与 **创作受理** 拆开，禁止把 worker/Venice 耗时和 feed 画在同一 p95 门禁上。

| 看板             | 查询                                                                        | 门禁                             |
| ---------------- | --------------------------------------------------------------------------- | -------------------------------- |
| 列表 API（前端） | `api.request.duration` p95，`route=/api/image-plaza/feed`，`outcome=ok`     | ≤800ms                           |
| 列表 API（后端） | `http.server.duration` p95，同 route，`kind=standard`                       | ≤500ms                           |
| 广场首屏         | `page.ready.duration` p95，`route=/create`                                  | 相对基线退化 ≤10%                |
| 工作室首屏       | `page.ready.duration` p95，`route=/create/studio/:id`                       | ≤1.5s（有预取样本单独标注）      |
| 生成受理         | `action.feedback.duration` p95，`action=image_generate\|video_generate`     | ≤2.5s；`action_stall` count 告警 |
| 创作读接口       | `api.request.duration` p95：config / quotes / conversation / video-attempts | ≤800ms                           |
| 视频完成（观测） | `video.duration_to_ready` p50/p95 按 model                                  | 不设发布门禁，用于容量与模型对比 |
| 图片回归         | 上表图片 action + feed + `/create` ready                                    | 退化 ≤10%                        |

基线：P0 在 Telegram iOS/Android 对**纯图片**路径冷/热各 ≥20 次采样，写入 task 记录后再开视频混排对比。

### 8.2 前端事件

- `TrackedAction` 增加 `video_generate`：从点击到显示“排队中”，看门狗 2.5s（与 `image_generate` 同语义：受理反馈，非成片）。
- 终态上报：`sendSentryLog('video.attempt.terminal', {status, model, duration_s, elapsed_ms})`。
- 播放失败上报：`video.playback_error`，只带错误码，不带 URL。
- 快开上报：`video.startup_ms` 从 `play()` 到首个解码帧（优先 `requestVideoFrameCallback`，降级 `playing`）；`video.seek_ms` 从 `seeking` 到目标位置首帧。只带 provider/format/cache_state 等低基数标签，不带 URL。
- 列表/创作相关 `api.request.duration`、`page.ready.duration` 已由通用埋点覆盖；新增路由模板必须进入 `page-tracker` 的 `WATCHED_PAGES`（有测试强制一致）。

### 8.3 后端事件与指标

- 用 `sendBackendSentryLog` 上报事件：
  - `video.queue.submitted`
  - `video.queue.failed{code}`
  - `video.retrieve.status`
  - `video.ready{elapsed_ms}`
  - `video.refund{reason}`
  - `video.moderation_rejected{model}`
  - `video.failed_unknown`
  - `video.complete.failed`
- `perf-metrics` 的 distribution 指标：`video.duration_to_ready`、`video.download_bytes`。
- feed / quotes / attempts 路由继续归类：读接口 `kind=standard`；`POST .../video-attempts` 与图片 attempts 一样归 `kind=generation`（只计量受理段，不含 worker）。
- worker 异常通过 `captureBackendException` 上报。
- 标签只用低基数维度（model / status / code / media）。
- 告警：`failed_unknown` > 0，或 1 小时内退款比例 > 30%，或 feed/受理 p95 连续破坏门禁，走现有飞书通道。

## 9. 可靠性一览

| 风险   | 处理                                                                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 超时   | quote 10s；queue 60s；retrieve 30s；下载 120s；ffmpeg/ffprobe/faststart remux 20s；签名沿用现有 5s；同域 stream 单次 Range 切片读取超时单独设限（建议 ≤30s），避免一次挂死整段播放 |
| 重试   | 只对幂等操作重试：retrieve、下载、complete、签名。queue 永不自动重投                                                                                                               |
| 幂等   | idempotency_key；reserve、refund、publish、share 各有唯一索引；seed 按 (origin, source) 唯一；不可变 hash path + `upsert=false`；SQL 重放只接受逐字段完全一致的 existing           |
| 并发   | 任务用租约 + SKIP LOCKED + lease_owner fencing；钱包行加锁；首次分享锁定同一行；seed 资产 worker 固定最多 4 路、转码最多 2 路；SQL 每文件 500 条并按 source ID 稳定锁序            |
| 补偿   | 失败、拒审、过期自动退款；状态为 failed_unknown 的走对账脚本                                                                                                                       |
| 限流   | worker 每个 tick 有处理上限；对 429 退避；同一用户进行中的视频最多 2 个，超出返回 429；体积估算步骤的 HEAD 请求并发度限制为 10，避免打满出口带宽或触发源站限流                     |
| 降级   | 抽帧失败时用占位封面；ffmpeg 二进制缺失时启动日志报 error，并且视频目录接口隐藏视频模型；complete 失败只记日志；目录未发布时隐藏入口                                               |
| 容量   | 单个视频 ≤200MiB；Top 4,000 源文件已估 40.599GiB，canary 后按真实输出 + poster + 失败恢复余量重算；TEST 只保留 10 组，main 才保留 4,000 组                                         |
| 可观测 | manifest 记录 lane/阶段/耗时/重试/处理分支/字节与错误码；签名记录 hit/miss/inflight 但不含 URL/path/token；播放区分地址、metadata、首帧、seek 与 waiting/stalled                   |

## 10. 发布顺序、停止条件、回滚

1. 架构评审 ADR；确认 B-SEED-1（其余阻塞项已由 D8–D14 关闭）。
2. TEST 只读核验图片 M1 现状：8 张表、3 个 RPC、权限/RLS、PostgREST 暴露和图片消费者直连均符合预期；任何偏差先 forward-fix，禁止重跑 M1。
3. 部署包含 `getDomainDb('media_plaza')` 直连和 ffmpeg 的后端；视频目录发布前，视频路由一律返回 404。
4. TEST 依次执行 M2 → smoke/shape/权限检查 → M3 → 配置校验。每次只执行一个文件，前后各记录一次结构和关键读写。
5. 上线视频路由和 worker（worker 默认关闭），同时上线前端和 Admin。视频入口仅在 `video_models.length>0` 时显示。
6. TEST canary：每个模型的 t2v、i2v、r2v 各调用 1 次；演练拒审退款和崩溃恢复。
7. D17 方案获用户确认后，本地处理 canary；TEST 只上传并导入 10 条，完成 Range、首帧、seek、签名缓存、SQL 幂等与对账验收，禁止 TEST 全量。
8. 单独确认 main/Production project 身份、私有 bucket 与真实容量；先上传并核验全部 4,000 组对象，业务表保持 0 条新增。完成后锁定 main upload manifest。
9. 从锁定 manifest 生成并审核 8×500 data migrations + preflight/postflight；先跑 Production preflight，再在上线窗口逐文件执行。任一批失败保持入口关闭，按 forward-fix 恢复。
10. 八批与 postflight 全通过后再发布/打开 seed 视频入口；目录先只启用 Wan 3.0 Pro，再按播放与错误观测放开其他模型。后续点播 CDN 以 delivery provider 新实现接入，不迁移作品 ID。

停止条件，出现任一即停止：

- 重复扣费或重复退款；
- 越权签名；
- failed_unknown 持续增长；
- 图片功能回归；
- 迁移锁等待超时。

回滚：

- 撤回视频目录发布，入口随之隐藏；worker 继续运行，把存量任务推进完。
- M2、M3 是新增性变更，不回滚。
- M1 已在 TEST、Production 完成，不属于本次视频发布的回滚面；不得重跑或回滚，只能 forward-fix。
