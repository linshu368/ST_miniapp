# Task Breakdown

> 本任务交付 **backend + shared 契约**，以“用户第一次点击视频到首帧”为优先性能目标；不在本任务修改归档脚本或 frontend 实现，但要把相应交接项记录给依赖子任务。

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status | Task                                     | Files / Scope                                       | Depends On                          | Verification                                                                                                                                                                                       |
| --- | ------ | ---------------------------------------- | --------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Done   | 定义列表/详情/单视频播放契约             | `packages/shared/src/api/drama.ts`                  | `10-21-drama-archive-access` 已验收 | 四个类型含 `DramaPlayback`，`VideoItem` 无 `play_url`；shared typecheck                                                                                                                            |
| T2  | Done   | 最小查询层及 `upload succeeded` 证据确认 | `packages/backend/src/features/drama/repository.ts` | T1                                  | test 库真实关联与权限核实；三表必要列；按需最小读取 `pipeline_tasks` 关联键 + stage/status；不透传敏感字段                                                                                         |
| T3  | Done   | 逐字段回退和播放就绪判定                 | `packages/backend/src/features/drama/assemble.ts`   | T2                                  | 原始/AI 字段逐项回退；标签去空去重；签名失败不污染元数据 `playable`                                                                                                                                |
| T4  | Done   | 单视频签名 + 复用缓存                    | `packages/backend/src/features/drama/signed-url.ts` | T2                                  | 3600s URL、最多1800s 缓存、60s 安全余量；同权限原 Token 复用、single-flight、失效/签名失败降级                                                                                                     |
| T5  | Done   | 三个鉴权路由                             | `packages/backend/src/routes/drama.ts`              | T3, T4                              | `GET /api/dramas`、`GET /api/dramas/:id` 元数据不批量签名（实际零签名）；`GET /api/dramas/:id/play` 只签一个、可选 video_id、权限与归属校验、`@frontend-ready`、`Cache-Control: private, no-store` |
| T6  | Done   | test 真实调用 + 媒体条件验证             | curl/httpie、真实私有桶 MP4                         | T5                                  | 列表/详情/播放响应；Range 返回 206 / Content-Range；检查 faststart 并记录归档整改需求                                                                                                              |
| T7  | Done   | 失败、并发、缓存与泄露审查               | 接口、日志、签名缓存                                | T6                                  | 签名超时/失败降级；缓存范围隔离、Token 复用；无 `object_path`/Telegram 字段/完整签名 URL 泄露                                                                                                      |
| T8  | Done   | 首帧关键路径交接与数据采集               | `10-21-drama-frontend-ui` 联动说明、验收记录        | T5, T6                              | 点击后 `/play` 与详情并行；最多预取1–2个 URL；真实 Telegram WebView 首帧 P50/P95、签名耗时与 CDN HIT/MISS                                                                                          |
| T9  | Done   | 类型检查与现有测试                       | shared/backend                                      | T1–T8                               | `pnpm --filter @miniapp/shared typecheck`、`pnpm --filter @miniapp/backend typecheck` / `test`                                                                                                     |

## Execution Log

### 2026-10-22 实施完成（T1–T9 全部 Done）

**交付文件**

- `packages/shared/src/api/drama.ts`（新增）+ `index.ts` 导出
- `packages/backend/src/features/drama/{repository,assemble,signed-url}.ts`（新增）
- `packages/backend/src/features/drama/signed-url.test.ts`（新增，7 条用例）
- `packages/backend/src/routes/drama.ts`（新增）+ `app.ts` 注册

**契约相对 design.md 的调整**

1. `DramaSummary` 按交互原型补齐为 6 字段：新增 `tags`、`episode_count`、`duration_seconds`。
   - `episode_count` 取**可播视频数**而非 `videos.episode`（后者全库为空，且语义是单集编号不是总数）。
   - `duration_seconds` 恒为 `null`，待归档端从 `DocumentAttributeVideo.duration` 登记；先上字段使前端徽标互斥逻辑一次写完。
2. `DramaPlayback.video_id` 由 `string` 改为 `string | null`，零可播短剧时返回 `null`，不用空串充数。
3. `DramaDetail.videos` 只含 `playable=true` 条目，与 `episode_count` 口径一致，避免列表显示 N 集而详情列出 N+2 集。

**T2 阻塞项裁决**：实测 `videos` 表无任何等价的上传成功字段，确认**必须**读 `pipeline_tasks`。经用户批准读取 `video_id/stage/status` 三列最小投影，implement.md 原「只查三张表」表述已过时。任务行在 repository 内收敛成 `upload_succeeded` 布尔值，不出 repository。
实测补充：当前 10 条有 `object_path` 的恰好全部 `upload=succeeded`，两者完全吻合；仍按「两个条件都要满足」实现，依据是归档端 `SUPABASE_PIPELINE_DESIGN.md` §4 明示上传与落库非原子事务。

**查询方式**：实测 PostgREST 深层嵌套 + 嵌套过滤可用（`dramas→videos→{ai_results, pipeline_tasks}`，`videos.pipeline_tasks.stage=eq.upload`），一次查询取全，无需分次查询。三套列投影：`LIST`（无简介）/ `DETAIL`（全）/ `PLAY`（仅定位与就绪）。外部查询超时 5000ms。

**播放排序**：`episode` 数字升序（空值靠后）→ `message_id` 升序。`episode` 全库为空，实际生效的是 `message_id`。

**接口实测（test 库真实数据，6 部剧 / 16 条视频 / 10 条可播）**

| 路由                       | 状态码 | 耗时  | 关键字段                                                               |
| -------------------------- | ------ | ----- | ---------------------------------------------------------------------- |
| `GET /api/dramas`          | 200    | 951ms | 集数 2/0/4/3/1/0；两次请求顺序不同（随机排序生效）                     |
| `GET /api/dramas/:id`      | 200    | 259ms | `episode_count === videos.length`；响应无 token/object_path/message_id |
| `GET /api/dramas/:id/play` | 200    | 738ms | `Cache-Control: private, no-store`；选中详情第一集                     |
| 同上第二次                 | 200    | 247ms | 同一 URL 原文，签名缓存命中（省 491ms）                                |

边界：跨剧 `video_id` → 404；零可播剧 → 200 + `playable:false` + `video_id:null`；不存在的剧 → 404；非法 ID → 400。

**签名与缓存**：真实签名 339ms，缓存命中 0ms。Range GET 实测 `HTTP 206` / `Content-Range: bytes 0-1023/54712104` / `Content-Type: video/mp4`，真实 MP4 可读。参数：签名 3600s、缓存复用窗口 `min(签发+1800s, 到期-60s)`、容量 500 条、超时 5000ms、缓存键 `authenticated:<object_path>`（单一授权范围）。单测 7/7 覆盖 Token 复用、超窗重签、single-flight、对象隔离、失败/超时降级、失败不入缓存、日志不含路径与 Token。

**回退规则**：真实数据原始字段全空（AI 回退路径已实测），另用构造数据补测 9/9：原始优先不被 AI 覆盖、空白串视为缺失、两边空→`''`、标签整组回退不混搭、trim+去空+去重、两边空→`[]`、`upload` 成功但路径空→不可播、路径有但 `upload` 未成功→不可播。

**质量门禁**：shared + backend typecheck 通过；`vitest run` 672 个测试全过；`pnpm lint`、`pnpm lint:legacy` 通过。
既存环境缺陷：`undici@7.16.0` 在 `packages/backend/package.json` 已声明但本地未安装，导致 7 个测试文件加载失败 + 2 个 typecheck 报错。已用 `git stash` 验证改动前即存在，与本任务无关；跑一次 `pnpm install` 即可消除。因此 T5 的端到端验证用最小 Fastify 实例只挂 drama 路由完成（完整 `app.ts` 会传递性引入 `undici` 而起不来），`app.ts` 注册由 typecheck 与 register 行确认。

### 首帧瓶颈的实测结论（影响验收口径）

对 10 条可播视频逐条探测 MP4 atom 顺序：**faststart 仅 4 条，`moov` 在文件尾部 6 条**。后者浏览器需额外 2 个网络往返才能解出首帧，实测「头部 + 尾部索引」合计 **805ms–2297ms**（本机宽带 + CDN 已 HIT）：

```
a80210f3 52MB  798+938 =1736ms    d9d54f14 54MB  926+1371=2297ms
656127a0 39MB  931+1005=1936ms    91dc2ef2 46MB 1003+1149=2152ms
cebbc318 34MB  961+1252=2213ms    180e1ad1 19MB  570+235 = 805ms
```

对比本任务已优化的签名环节（339ms，缓存命中 0ms），**容器结构才是首帧延迟的主要来源，签名不是瓶颈**。修复手段为归档端无损转封装 `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`（不重编码、画质无损、体积几乎不变），客户端与 backend 均无法规避。

因此 T8 的性能验收口径调整为：本任务只验收 `/play` 自身耗时（已完成），「点击到首帧」P50/P95 推迟到归档端转封装之后再测。该调整已写入前端任务交接。

### T8 交接完成

前端交接已写入 `10-21-drama-frontend-ui/task.md`，含：三路由契约与实测耗时、点击后 `/play` 与详情并行的关键路径、`videos` 数组即集数顺序的续播方式、封面徽标互斥规则、`cover_url`/`duration_seconds` 恒为 null 的预期行为、`episode_count===0` 返回 200 不走 error 分支、签名 URL 的 401/403 最多重试一次、性能验收口径调整、以及禁止多 `<video>` 预加载与客户端抽帧做封面的原因。

归档端待办（faststart 转封装、Telegram 自带缩略图、`duration` 登记）属 `telegram-video-archive` 项目范围，已实测确认三项可在同一批脚本内完成且不需要 ffmpeg 抽帧（缩略图取 `doc.thumbs`，时长取 `DocumentAttributeVideo.duration`），未在本仓库建档，交由负责人安排。
