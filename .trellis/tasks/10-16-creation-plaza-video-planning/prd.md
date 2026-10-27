# 图片广场扩展视频创作（规划）

状态：in_progress（2026-10-27 已进入实施；图片 M1 与 PostgREST 暴露已在 TEST、Production 完成，视频 M2/M3 尚未执行）。
证据：`research/venice-video-evidence.md`、`research/seed-and-prototype-evidence.md`；性能基线对照现有图片广场源码（feed / studio）与 `10-21-sentry-ux-monitoring`、归档 `10-19-image-plaza-performance-plan`。

## 目标

在已完成图片广场物理迁移并由后端直连 `media_plaza` 的基础上，让广场和创作页支持视频：发现、详情播放、创作、编辑、重生成、分享、下载。

## 已确认决策

| #   | 决策                                                                                                                                                                                                                                                         | 来源                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| D1  | schema 命名为 `media_plaza`。8 张图片表和 3 个图片 RPC 已在 TEST、Production 完成物理迁移，后端直接访问新 schema；所有新视频表也归入该域。**账务留在 billing**（share_rewards、wallet_ledger）                                                               | 用户 2026-10-24、2026-10-27                      |
| D2  | 视频计费：提交时原子**预扣**星尘；上游失败、审核拒绝、过期、超时都**自动退款**。图片维持现状（成功后扣费）                                                                                                                                                   | 用户 2026-10-24（取代旧 PRD 中“视频成功后扣费”） |
| D3  | 视频上游为 Venice 异步队列：quote → queue → retrieve 轮询 → 本地转存 → complete                                                                                                                                                                              | 用户需求 7/8                                     |
| D4  | 每次视频提交附 0～1 张图片，按模型能力作为首帧或参考图；不支持图片的模型禁止附图并给出提示                                                                                                                                                                   | 旧 PRD 已确认，需求 2.5                          |
| D5  | 同一会话可以交替生成图片和视频，类型由每次提交决定                                                                                                                                                                                                           | 旧 PRD 已确认，需求 2.5                          |
| D6  | 返利规则、返利配置、账户级首次分享资格由图片和视频共用                                                                                                                                                                                                       | 旧 PRD 已确认                                    |
| D7  | 原型只作参考：广场顶部按钮、会话内操作按钮、弹窗样式沿用现有实现                                                                                                                                                                                             | 需求 4                                           |
| D8  | 产品模型“Seedance 2.0 R2V”（xlsx 标签 `Seedance 2.0 R2V Enhanced`）映射到 Venice `seedance-2-0-reference-to-video-basic`，正常启用                                                                                                                           | 用户 2026-10-24                                  |
| D9  | Venice 视频接口不支持提示词优化，因此**视频关闭自动优化提示词**：不显示该开关，不自研 LLM 改写，`auto_optimize` 固定为 false。图片不变                                                                                                                       | 用户 2026-10-24                                  |
| D10 | 后端运行镜像安装 ffmpeg（含 ffprobe），用于读取元数据和抽取首帧封面                                                                                                                                                                                          | 用户 2026-10-24                                  |
| D11 | 种子中文译文来自翻译包 `G:/JobWork/ST/图片广场-全量翻译_1015/翻译包/video.xlsx` 的 `prompt_zh`，与原表按视频 URL 路径对照补充                                                                                                                                | 用户 2026-10-24                                  |
| D12 | 迁移、canary、种子导入一律先在 **test** 执行；production 在 test 验收后单独审批                                                                                                                                                                              | 用户 2026-10-24                                  |
| D13 | 种子导入的 dry-run **先只做体积估算**：对全部视频 URL 发 HEAD 请求，汇总文件总体积并输出报告，人工确认体积可接受后，才能继续执行 dry-run 的后续步骤（解析、分类、生成 manifest）                                                                             | 用户 2026-10-24                                  |
| D14 | 视频提示词**不设字数上限**（不同于图片的 2,000 字上限）；种子导入不因提示词过长而隔离或截断。图片的 2,000 字上限不变                                                                                                                                         | 用户 2026-10-24                                  |
| D15 | 播放体验：mp4 存私有桶，由服务端鉴权后把可播放地址交给前端；**边下边播**依赖浏览器原生 `<video src=URL>` + HTTP Range + `moov` 前置（faststart）。**不以** `fetch().body`（ReadableStream）→ 整文件 `blob:` 作为主路径（会整文件下完才播）。详见 design §5.1 | 用户 2026-10-26                                  |

## 功能需求与验收

### R1 `media_plaza` 前置状态（需求 1，已完成）

- `media_plaza` 已加入域常量并通过 PostgREST 暴露。
- 图片广场现有 8 张表和 3 个图片 RPC 已用 M1 迁入；旧位置不保留兼容表、视图或同名可写对象。
- 后端通过 `getDomainDb('media_plaza')` 直接访问，不保留 `PLAZA_SCHEMA`、启动探测、双读或旧 schema 回退。
- 视频 M2/M3 只在该前置状态核验通过后执行，不重复执行 M1。

验收：

- 图片 feed、详情、点赞、会话、生成、分享、seed 导入在 test 回归全部通过。
- 旧 schema 中不再有 `image_plaza_*` 表。
- 权限、RLS 与迁移前一致：service_role 可用，anon/authenticated 拒绝。
- PostgREST 已暴露该 schema。
- M1 已同时落到 TEST、Production，不再作为视频发布流程中的可回滚步骤；后续异常采用 forward-fix，禁止重跑 M1。

### R2 广场视频（需求 2）

**2.1 类型筛选**

- 标签栏与搜索框之间加「全部 / 图片 / 视频」。
- 与 推荐/最新、搜索、标签取交集。
- 服务端统一混排分页，游标中带上 media 过滤。

验收：

- 3×2×(有/无搜索)×(有/无标签) 组合下无重复、无遗漏。
- 切换类型后游标作废，从第一页开始。

**2.2 标签栏**

- 横滑标签保留。右侧固定「全部风格」按钮，点开为多选面板，标签之间 OR 匹配。
- 面板中显示每个标签的计数；计数加载失败时显示“—”，不显示 0。
- Admin「内容标签管理」新增 `media_types`（image/video/both）。每个类型可以有自己的标签集。
- 原有发布、回滚、tags_feature 开关全部保留。

验收：

- 多选结果 = 各标签结果的并集，然后再与搜索、类型取交集。
- 旧客户端只传单个 `tag` 时行为不变。
- Admin 校验会拒绝重复 id 和保留 id `all`。

**2.3 视频卡片**

- 显示封面、时长角标、播放图标、两行描述、点赞数、模型名、「用同款」。
- 列表中不加载视频正文。

验收：网络面板中，列表页的 mp4 请求数为 0。

**2.4 视频详情**

- `<video preload="metadata" poster=封面 playsInline controls>`，`src` 为可播放 URL（签名 URL 或同域 Range 代理，见 D15 / design §5.1）。
- 页面展示模型、时长、点赞、提示词。
- 播放地址过期时自动刷新一次（重签或重新拉 playback）。
- 边下边播：用户可在文件尚未全部下载完时开始播放；拖动进度条在已缓冲区间内可用。

验收：

- Telegram iOS/Android 上能点击播放、暂停、拖动进度条。
- 弱网下点击播放后，无需等整段 mp4 下完即可出画（网络面板可见 Range/`206` 或部分内容分片请求，而不是单一请求结束后才开始播）。
- 播放地址过期后可以恢复播放。
- 列表页仍不发出任何 mp4 请求（与 2.3 一致）。

**2.5 输入栏**

- 「图片 / 视频」切换，切换后仍在同一会话。
- 视频模式下附图作为参考图或首帧；模型不支持图片时，附图按钮禁用并提示原因。
- 模型选择只列视频模型。
- 默认模型为 Wan 3.0 Pro，默认开启声音。视频模式不提供“自动优化提示词”（D9）。
- 「用同款」复制原作品的模型和参数。
- 设置面板沿用现有 Sheet 样式，提供时长、比例、清晰度、声音四项。

验收：

- 切换模型时，不受支持的参数被重置为该模型的默认值，并给出提示，不会静默发出非法组合。
- 必须带图的模型在没有图片时无法提交。
- 用同款跳转后参数完全一致。若原模型已下架，提示用户改选。

**2.6 Admin 模型**

- 模型目录增加 `media_type`（image/video）。
- 视频模型字段：Venice id 映射（t2v/i2v/r2v）、时长、分辨率、比例、声音是否可配置、prompt 上限、图片约束、价格矩阵。

验收：

- 字段非法时不能发布。
- 默认视频模型必须处于启用状态。
- 旧图片目录读取和报价不受影响。

**2.7 视频操作**

- 编辑：把原 prompt 和参数回填到输入栏。
- 重新生成：用当前设置重新报价后提交。
- 分享：作品进入广场，按返利规则发放返利。
- 下载：走 Telegram 文件下载，失败时降级为打开原视频。

验收：

- 重复分享不会重复发放返利。
- 下载与分享都会校验归属。

**2.8 生成后处理**

- 参考图持久化（可以复用图片参考资产表）。
- 用 ffmpeg 抽取首帧作为默认封面，同时用 ffprobe 读取时长和宽高。

验收：

- 每个 ready 状态的视频都有封面、时长、宽高。
- 抽帧失败时用占位封面并记录告警，不影响 ready。

### R3 种子数据（需求 3）

- 原表 `civitai_venice_nsfw_videos.xlsx` 共 5,097 条（6 列），作为视频广场初始内容导入。导入流程：体积估算 + 人工确认（D13） → dry-run → 审核 manifest → test 小批 → test 全量 → production 单独审批（D12）。
- 视频提示词没有字数上限（D14），导入不因提示词长度而隔离或截断。
- 导入时转存 mp4 和首帧封面，探测时长。
- 中文译文（D11）：翻译包 `video.xlsx`（5,082 行）的 `id` 等于原表 `Video URL` 去掉域名后的路径，按此一一对照，把 `prompt_zh` 写入作品快照。
  - 实测 5,082 条全部命中；模型、热度、去空白后的英文提示词三项全部一致。
  - 原表多出的 15 条在翻译包中不存在，与原型“视频 5097→5082”的涉未成年剔除一致，导入时归为「已剔除」。
  - 实施时如果出现命中但模型、热度、英文不一致的行，这些行归为「待修复」，不导入。
- 涉及未成年的内容被剔除，审核未通过的不公开。
- 6 个视频模型写入目录种子（参数见 research），全部启用。Seedance 2.0 R2V 按 D8 映射。

验收：

- 体积估算报告先于 dry-run 的解析/分类步骤产出，且必须经过人工确认才能继续；未确认时脚本在估算步骤后停止，不解析、不生成 manifest。
- 5,097 条全部归入「已导入 / 已存在 / 待修复 / 已剔除」四类之一，四类总数等于 5,097；其中「已剔除」≥ 15。
- 待修复不包含“提示词过长”这一类（D14），提示词长度不参与分类判断。
- 每条导入作品都有非空 `prompt_zh`，来源标记为 `translation_pack`，且 `prompt`/`prompt_zh` 原样写入，不截断。
- 重跑不会产生重复数据。
- 导入不会产生扣费、返利或首次分享资格的变化。
- 外部热度单独存为 `source_heat`，不写入本地点赞。

### R4 原型边界（需求 4）

原型只提供信息结构。验收：UI 评审对照现有组件，没有新引入一套视觉体系。

### R5 计费（需求 5）

- 价格按媒体类型和模型分别计算。视频价格由目录中的价格矩阵决定（运营依据 `/video/quote` 的 USD 价换算），服务端报价是唯一权威。
- 提交时余额不足返回 402 并提示充值，不调用上游。

验收：

- 报价 → 提交 → 预扣 1 次；成功后不再扣费。
- 失败或拒审时退款 1 次。
- 同一幂等键重放不会重复扣费或重复退款。
- 并发提交不会透支。

### R6 审核拒绝（需求 6）

- queue 或 retrieve 返回 422（`provider_content_policy`）时：任务状态置为 `moderation_rejected`，自动退款，UI 提示“内容未通过审核，星尘已退回”，并提供“修改提示词”入口。

验收：

- 退款流水与 attempt 一一对应。
- 前端显示专用文案，不显示通用失败文案。
- Sentry 有对应计数。

### R7 复用与隔离（需求 7）

- 复用 image-plaza 的 DB 租约 worker 模式、`veniceFetch`、错误分类和 settlement 风格。
- 视频使用独立的 attempt/artifact 表和私有 bucket `media-plaza-video`，通过签名 URL 访问。

验收：图片表没有新增视频列（会话、消息、点赞、作品统一投影的除外，见 design）。

### R8 性能与监控（需求 8）

性能目标拆成两条用户路径，必须基于**当前图片广场**的列表与数据请求实现做增量优化，而不是另起一套。列表侧有三条**硬约束**（游标分页、列表无 MP4、资源走签名缓存），与 p95 预算同级，不可为降延迟而绕过。

#### R8.A 广场列表加载（发现 / 筛选 / 翻页）

现状（SRC，实施时不得回退）：

- 前端：`useImagePlazaFeedQuery`，`pageSize=20`，`staleTime=60s`，过期只保留第一页再刷新；无限滚动 `rootMargin:240px`；前 4 张 `eager`，其余 `lazy`；`prefetchImagePlazaFeed` **已导出但未接线**。
- 后端：鉴权 → runtime_config → `listSortedWorks`（1～2 次）→ `hydrateWorks`（artifacts+likes 并行 1 次 + 最多 20 路签名并发）；feed 缩略图 `width:720,quality:72`；签名 LRU≈2000、已发布作品 TTL 24h（`storage.ts`：稳定 URL → CDN/浏览器可命中）。
- 游标：`feed-cursor.ts` + filter 哈希；sort/filter 不一致直接 `INVALID_CURSOR`；推荐分区 liked→zero。
- 已知风险：冷缓存签名扇出、feed 仍带完整 `snapshot`（长 prompt）、ILIKE 搜索、tags 嵌在 feed 响应、视频混排后 hydrate/签名负载翻倍、误把 mp4 签进列表。

**硬约束 1 — 游标分页**

- 继续服务端游标，`pageSize=20`，`limit+1` 取下一页；禁止 offset、禁止客户端拼页冒充全局排序。
- filter 哈希必须纳入 `media` + 规范化后的 `tags[]`（以及既有 search/tag）；切换 media/tags/sort/search 后旧游标作废，从首页重拉。
- React Query：`queryKey` 含 media/tags/sort/search；过期刷新仍只保留第一页，丢弃后续页游标链（与现状一致）。
- 视频混排索引见 design §2.3；实施期用 EXPLAIN 确认游标谓词走索引。

**硬约束 2 — 列表无 MP4**

- 列表卡片只用封面图（`<img>`）；**不得**渲染 `<video>`，不得在 feed DTO 中返回 `video_url` / `download_url` / 可播放 mp4 签名。
- hydrate 对视频作品只签 **poster**（缩略图 ≤480）；图片保持 720/72 不恶化。
- 验收：广场列表页网络面板 **mp4 请求数 = 0**（含预加载、Range、HLS 变体皆为 0）。
- mp4 签名仅允许：作品详情、工作室消息卡、playback 重签接口、下载链路。

**硬约束 3 — 资源必须走签名缓存**

- 私有桶资源（图片、视频封面、详情 mp4）一律 `createSignedUrl`，禁止公开桶/永久明文 URL。
- **必须**复用并扩展现有 `storage.ts` 进程内 LRU（≈2000、提前 5min 失效、cacheKey=`path|ttl|transform`）：
  - 已发布广场资源（含视频 poster、详情 mp4）用**长 TTL（与图片共享作品一致，24h）**，保证同一 path+transform 在 TTL 内返回逐字节相同 URL，以便 CDN/浏览器命中。
  - 未分享的私有产物/参考图保持短 TTL（现状 15min），**不**写入与公开作品相同的长 TTL 策略。
- 视频 bucket `media-plaza-video` 的签名入口与图片共用同一套缓存原语（可按 bucket 扩展 path 前缀），禁止另起无缓存的签名路径。
- feed 冷签并发上限与签名超时保持现状量级；不得为冲 p95 去掉签名或改公开读。
- 详情/播放：签名过期可重签一次；重签结果写回同一 LRU。

其它必须落地：

- feed 列表 DTO **裁剪**：卡片只需封面/时长/描述摘要/点赞/模型名；完整 `snapshot` 只在详情或会话返回。
- `GET /feed/tag-counts` 与列表解耦，进程内缓存 ≥60s，失败不阻塞列表。
- 接线 `prefetchImagePlazaFeed`（及视频扩展后的默认 feed）到入口空闲预取；点「去创作」预取 config + studio 路由。

#### R8.B 创作页回复生成（报价 → 提交受理 → 状态可见 → 结果可见）

现状（SRC，图片链路）：

- 首屏并行拉 `config` + `conversation`；设置变更即 `quote`（无 debounce / 无客户端复用未过期 quote）。
- 提交：`quote` → `POST .../attempts` 返回 **202**；`startAction('image_generate')` 在**受理反馈**处结束（非出图完成），符合 10-21 规范。
- 轮询：会话全量 hydrate，有 `pending/generating` 时**固定 2s**，无退避、无 `document.hidden` 暂停。
- Worker：默认 3s tick、每 tick claim ≤2、Venice 超时 180s；耗时在 worker，**不得**计入 `http.server.duration kind:standard` 的 p95 预算。

必须落地（图片不回退；视频对齐并加强）：

- 进入工作室预取/复用 config（stale 60s）；用同款/新建会话继续 `setQueryData` 快显。
- 报价：设置变更 debounce；同参数在 quote TTL 内复用，提交前再强校验；失败不阻塞草稿。
- 提交路径保持「受理即反馈」；余额不足 402 不打上游。
- 视频：worker 异步 queue/retrieve/complete；前端 `useVideoAttemptQuery` 退避轮询（3s→×1.5→cap 15s），页面隐藏暂停，回前台立即刷新；终态停轮询并失效会话/钱包。
- 长会话优先轻量 attempt 状态接口，避免每次轮询全量 hydrate（图片侧可渐进，视频侧必须）。
- 下载转存成功后调用 `/video/complete`（失败只记日志）。

#### R8.C Sentry 指标与 p95 预算

沿用 `lib/sentry`、`lib/perf/*`、`10-21-sentry-ux-monitoring` 的指标命名与低基数约束。生成类长耗时与标准读接口**分看板**，禁止把 Venice/worker 耗时混进列表 API p95。

| 路径       | 指标                                                                     | 预算（test 冷热各 ≥20 样本；production canary 对照）                         |
| ---------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 列表       | 前端 `api.request.duration`，`route=/api/image-plaza/feed`，`outcome=ok` | **p95 ≤ 800ms**                                                              |
| 列表       | 后端 `http.server.duration`，同 route，`kind=standard`                   | **p95 ≤ 500ms**                                                              |
| 列表       | 前端 `page.ready.duration`，`route=/create`                              | 相对图片基线 **退化 ≤ 10%**（10-21 曾记 LCP≈4.2s，以实施前 20 次实测为基线） |
| 创作首屏   | `page.ready.duration`，`route=/create/studio/:id`                        | **主体可见 ≤ 1.5s**（有预取/缓存时）；冷启动退化 ≤ 10%                       |
| 创作受理   | `action.feedback.duration`，`action=image_generate` / `video_generate`   | **p95 ≤ 2.5s**（与 ACTION_STALL 一致；超时记 `action_stall`）                |
| 创作读接口 | `api.request.duration`：`/config`、`/quotes`、会话 GET、attempt GET      | **p95 ≤ 800ms**（`outcome=ok`）                                              |
| 图片回归   | 上表图片相关指标 + 点赞反馈路径                                          | **p95 退化 ≤ 10%**（对照归档 10-19）                                         |
| 视频完成   | `video.duration_to_ready`（distribution）                                | 只观测、按模型分位展示；**不纳入**标准 API p95 门禁                          |

埋点：

- 前端 `TrackedAction` 增加 `video_generate`；终态 `video.attempt.terminal`；播放失败 `video.playback_error`（无 URL）。
- 后端事件/指标：`video.queue.*`、`video.retrieve.status`、`video.ready`、`video.refund`、`video.moderation_rejected`、`video.failed_unknown`、`video.complete.failed`、`video.duration_to_ready`、`video.download_bytes`。
- feed / quote / attempt 轮询继续打 pino `durationMs`，便于与 Sentry p95 对照。

验收：

- R8.A：游标在 media/tags 变更后作废且无串链；列表页 mp4 请求数 = 0；封面/详情资源均经签名 LRU（同 path+transform 热路径不重复打 Storage）；feed 前端/后端 p95 达上表；tag-counts 失败不拖慢首屏。
- R8.B：工作室主体可见 ≤ 1.5s（有预取）；`image_generate`/`video_generate` 受理反馈 p95 ≤ 2.5s；视频轮询有退避且隐藏页暂停；图片生成受理与出图完成指标分离。
- R8.C：Sentry 看板可按 route/action 看到列表与创作两条路径的 p95；视频状态分布可见；图片相关 p95 退化 ≤ 10%。
- 任一门禁不达标不得扩大 production 模型灰度。

## 非目标

- 视频剪辑、视频或音频作为输入、多图输入、批量生成、自动播放、多码率、转码集群、HLS/MSE+fMP4、前端 `fetch`→ReadableStream→`blob:` 播放主路径、消息队列中间件、第二套钱包。

## 阻塞与待确认

已关闭（2026-10-24 用户确认）：

- ~~B-MODEL-1~~ → D8。
- ~~B-OPT-1~~ → D9。
- ~~B-FFMPEG-1~~ → D10。实施时记录镜像体积和构建耗时的变化，作为发布记录，不再是阻塞项。
- ~~B-ENV-1~~ → D12。test 执行前仍需在执行记录里核对连接目标并采集结构快照，这是执行步骤，不再阻塞。
- ~~B-SEED-2~~ → D14。视频提示词不设字数上限，原表 879 条英文超 2,000 字、翻译包 129 条中文超 2,000 字都原样导入，不隔离、不截断。

仍待确认（流程已由 D13 固定，但实际授权和配额数字仍需执行期拿到真实结果）：

- **B-SEED-1**：种子媒体的转存授权和 Storage 实际配额。流程是：先对全部 5,097 条视频 URL 发 HEAD 请求，汇总 `Content-Length` 得到总体积，产出报告；人工确认总体积在 bucket 配额内后，才能继续 dry-run 的解析和 manifest 生成（D13）。中文译文已由 D11 解决，提示词长度已由 D14 解决。
