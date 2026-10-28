# 短剧契约层与 backend API

> 方案来源：`docs/短剧视频接入方案.md` §4、§5.2、§5.3；父任务 `10-21-drama-video-integration`。  
> **依赖**：子任务 `10-21-drama-archive-access` 验收通过（service_role 能读所需的 `drama_archive` 数据、PostgREST 暴露生效、`DOMAIN_SCHEMAS` 已含 `drama_archive`）之后才能开始实现；本任务不擅自扩大权限。  
> **本次优化目标**：用户第一次点击一部尚未观看过的短剧后，尽可能快地出现**第一帧**。优先减少点击后的串行请求、避免不必要的批量签名、复用 CDN 已缓存的同一签名 URL；不是以重复播放或节省存储空间为首要目标。

## Background

`drama_archive`（test 库）已有 `dramas`/`videos`/`ai_results`/`pipeline_tasks` 四张表，`ai_results` 目前可能为空。backend 需要组装列表和详情元数据，并为**当前选中**的视频按需提供私有桶 `drama-videos` 的临时播放 URL。

字段回退规则来自 `telegram-video-archive/SUPABASE_PIPELINE_DESIGN.md` §5（已核实原文）：

> 标题：原始标题非空则使用，否则 AI 标题；标签：原始标签非空则使用，否则 AI 标签；简介：原始简介非空则使用，否则 AI 简介；集数：`videos.episode`；播放：`object_path` 对应的短期授权链接。字符串 trim，空串视为缺失；标签去空项、去重。两边都缺时标题/简介为空，标签为 `[]`。逐字段回退，不整行替换、不自动混合标签、不覆盖原始字段。仅 `upload` succeeded 且路径非空的条目提供播放；AI 未完成不影响原始信息齐全的视频展示。

## Goal

1. 在 `packages/shared/src/api/drama.ts` 新建 `DramaSummary`、`VideoItem`、`DramaDetail` 和 `DramaPlayback` 契约；不出现 Telegram 定位字段、`object_path` 等内部信息。
2. 在 `packages/backend/src/features/drama/` 新建 `repository.ts`（最小字段投影）、`assemble.ts`（逐字段回退及播放就绪判定）、`signed-url.ts`（单视频签名、短期复用、失败降级）。
3. 在 `packages/backend/src/routes/drama.ts` 注册以下**三个**鉴权接口并保留 `@frontend-ready` 注释：

- `GET /api/dramas`：短剧列表，仅元数据，不签名。
- `GET /api/dramas/:id`：详情及视频元数据列表，**不批量签名**，不返回 `play_url`。
- `GET /api/dramas/:id/play`：获取**一条**当前视频的 `DramaPlayback`；可选 `video_id` 查询参数，未指定时选择该短剧第一条可播视频。可以在列表项被点击时直接请求该接口，避免必须先请求详情再请求播放地址。

4. 用 test 环境真实数据完成接口、首次播放及性能验收，并将前端需要配合的约束移交 `10-21-drama-frontend-ui`。

## Non-Goals

- 不做搜索、筛选、分页优化、多集/剧集导航。
- 不做正式埋点或大厅推荐排序接入；允许为本次首帧验收记录临时性能数据。
- 不默认新建测试文件（除非失败路径或性能回归需要）。
- 不重新设计 `drama_archive` 的权限/暴露（依赖前置任务）；如播放状态依赖的字段尚不可读，先验证数据来源和最小权限，再处理前置依赖。
- 不在本次 backend 子任务中实现 frontend、修改归档脚本或批量转码 MP4；但在本计划中记录明确的联动要求与验收项。

## Constraints（硬性规则）

- **对外契约统一**：先定义 `packages/shared/src/api/drama.ts`，backend 不得私定同形状响应或透传数据库行。
- **敏感字段不外泄**：`videos.source_id/message_id/media_id/object_path`、`pipeline_tasks` 原始行不得出现在 backend 响应或前端可见日志；服务端也不得记录完整签名 URL、Token 或 service_role 密钥。
- **只读域边界**：backend 使用 `getDomainDb('drama_archive')` 和自身 service_role；不复用、不触碰 `drama_worker`。
- **播放就绪判定**：仅在有可靠证据证明 `upload` 成功且 `videos.object_path` 非空时 `VideoItem.playable=true`。原方案指定依据 `pipeline_tasks.stage='upload' AND status='succeeded'`；但“仅查三张表/不读 pipeline_tasks”与该条件冲突。实现前由 T2 核实实际表关联、是否有等价可信的 `videos` 字段、当前读权限；若必须读 `pipeline_tasks`，只取视频关联键和 `stage/status` 的最小投影并通过前置访问任务确认最小权限，绝不透传整行；不能验证时**不得猜测上传成功**。
- **元数据与签名解耦**：列表和详情无 Storage 签名等待；一次播放请求最多为被选中的一个视频签名；不存在、非本短剧的视频或不可播视频不得签名。
- **签名短期复用、不落库**：`storage.createSignedUrl` 有效期初期 3600 秒；backend 内存缓存 TTL 最多 1800 秒，且须预留至少 60 秒过期安全余量；相同对象在**经过本次请求权限校验、共享同一观看权限范围**的前提下复用**原 URL 原 Token**。缓存键包含对象及授权范围，禁止跨授权范围复用；同 key 并发签名应合并为一次（single-flight）。多实例仅保证实例内复用，MVP 不新增 Redis。
- **签名响应**：`DramaPlayback` 包含 `video_id`、`playable`、`play_url`、`expires_at`（ISO 时间或 null）；未就绪、签名失败时返回 `playable=false`、`play_url=null`，且不让整个列表/详情接口 500。`VideoItem.playable` 是持久上传就绪状态，不因临时签名失败而被永久标为不可播。
- **失败与安全**：播放接口复用现有 `X-Init-Data` / `requireTelegramAuth`，校验短剧及视频归属和观看权限；签名结果响应 `Cache-Control: private, no-store`（防止代理缓存凭证，backend 内存签名复用不受影响）。对 401/403 或临时签名失效，frontend 最多重新请求一次播放 URL，不进行无限重试；外部查询、签名必须设超时。
- **前端协作要求（交给 frontend 子任务）**：列表可在后台、非阻塞地**预取最多 1–2 个最可能被点击的可见项的播放 URL**，不批量下载 MP4；若未预取，点击时直接调用 `/api/dramas/:id/play`，详情元数据并行加载。拿到 URL 后立即为当前 `<video>` 设置 `src` 并触发播放，不等待简介/标签/其他视频数据；不要对全部列表视频使用 `preload="auto"`。
- **媒体交付前置检查**：用真实签名 URL 验证 MP4 可用 HTTP Range 获取部分内容（如 `Range: bytes=0-1023` 返回 206 和 `Content-Range`）；检查 MP4 的 `moov` 是否在 `mdat` 前（faststart），若不满足，记录为归档/转封装链路的独立整改项；不擅自在本任务中修改原始文件。
- **避免误判 cacheControl**：归档脚本可在独立任务中将不再变动的视频设置 `cacheControl: '3600'`，主要提升浏览器**重复播放**，不是首次首帧优化的前置条件；Supabase CDN 命中主要靠复用相同签名 URL，并需用 `cf-cache-status` 验证。
- **既有数据规则不变**：逐字段回退；`ai_results` 为空则 `tags: []`、`description: ''`；每个 Fastify 路由注册附近保留 `@frontend-ready` 注释。

## Acceptance Criteria

- `shared/api/drama.ts` 定义四个契约；`VideoItem` 仅含元数据和 `playable`，不含 `play_url`，`DramaPlayback` 才含 `play_url/expires_at`。所有公开响应不含 `source_id/message_id/media_id/object_path`。
- `GET /api/dramas` 返回真实已归档短剧；`GET /api/dramas/:id` 返回视频元数据、原始/AI 逐字段回退结果，**均不会调用签名 API**；空标签/简介分别是 `[]`/`''`。
- `GET /api/dramas/:id/play` 未带 `video_id` 时选第一条可播视频，带 `video_id` 时只签该短剧对应视频；身份、归属或未就绪校验有效；返回有效的临时 `play_url`、`expires_at`。
- 同一授权范围内重复请求同一视频返回相同 Token（在缓存 TTL 内）；并发请求签名只发生一次；到期安全余量内重新签发；跨授权范围不复用。
- 签名失败、存储响应异常或超时：播放接口降级为 `playable=false`、`play_url=null`，详情/列表不受影响；客户端可重取一次，不把瞬时失败写成数据库永久不可播。
- curl/httpie 在 test 环境验证首次播放 URL 的有效性，且实际请求 `Range: bytes=0-1023` 获得 `206` 和合法 `Content-Range`；记录 MP4 faststart 检查结果，失败时明确归档端整改责任。
- 前端子任务验收：点击列表项不先串行等待详情数据，当前视频拿到 URL 后即发起播放；最多预取 1–2 个候选的**签名地址**，不预下载完整视频；统计点击到 `loadeddata`/首帧（优先 `requestVideoFrameCallback`）的 P50、P95，并记录网络条件、签名耗时与 `cf-cache-status` 的 HIT/MISS（不记录 Token）。在真实 Telegram WebView 和亚洲目标网络条件下测试，而非仅桌面浏览器。
- 明确确认 `playable` 所需的上传完成证据与可读权限，检查并记录 `pipeline_tasks` 是否被最小查询；响应和日志均不泄露内部定位字段、完整签名 URL。
- `pnpm --filter @miniapp/shared typecheck`、`pnpm --filter @miniapp/backend typecheck`、现有 backend 测试（可运行时）通过；人工保留关键验收数据而非 Token 明文。
- 三个路由注册附近有 `@frontend-ready: true — MVP：标签/简介为占位，标题/播放已可用` 注释。
