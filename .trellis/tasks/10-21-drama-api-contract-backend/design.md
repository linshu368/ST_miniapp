# 技术设计：短剧契约层与 backend API

> **目标**：优先降低**首次点击视频 → 首帧**的延迟。约束：不改私有桶、不转发视频字节、不在详情接口为全量视频签名；此文档仅定义 backend/shared 与 frontend/归档端的接口协作。

## 1. 契约层：`packages/shared/src/api/drama.ts`（新建）

参照 `shared/src/api/characters.ts` 的列表/详情分层写法，以及 `envelope.ts` 的 `ApiResponse<T>` 包装：

```ts
export interface DramaSummary {
  id: string;
  title: string;
  cover_url: string | null; // 暂无封面图来源，前端兜底占位
}

export interface VideoItem {
  id: string;
  title: string; // 原始标题非空用原始，否则 AI 标题，都空则 ''
  tags: string[]; // 原始标签非空用原始，否则 AI 标签，都空则 []
  description: string; // 原始简介非空用原始，否则 AI 简介，都空则 ''
  episode: string | null;
  playable: boolean; // 已验证 upload succeeded 且 object_path 非空；不代表签名永远成功
  // 不提供 play_url；读取详情不得触发批量签名
}

export interface DramaDetail extends DramaSummary {
  videos: VideoItem[];
}

export interface DramaPlayback {
  video_id: string;
  playable: boolean; // 此次是否获得可用播放地址，临时签名失败可为 false
  play_url: string | null; // 唯一包含临时签名地址的对外契约字段
  expires_at: string | null; // 签名有效期终点的 ISO 8601 时间，失败时 null
}
```

- `ApiResponse<DramaSummary[]>` / `ApiResponse<DramaDetail>` / `ApiResponse<DramaPlayback>` 与其他路由一致。
- **不出现** `source_id/message_id/media_id/object_path`，不把数据库行或 `pipeline_tasks` 原始记录透传到 frontend。
- 原始数据逐字段回退规则写在类型注释和 `assemble.ts`，保证 AI 结果生成后无需改前端。

## 2. 后端：`packages/backend/src/features/drama/`

### 2.1 `repository.ts`

- 用 `getDomainDb('drama_archive')` 只读查询 `dramas`、`videos`、`ai_results`，显式选必要列，不能 `SELECT *` 后在响应端过滤；先实测 PostgREST embed 能否工作，否则采用分次查询 + `id` 关联。
- **阻塞核对项**：既有设计把 `playable` 定义为 `pipeline_tasks.stage='upload' AND status='succeeded'` 与 `videos.object_path` 非空，却同时要求“只查三张表/绝不读 pipeline_tasks”，两者不能同时成立。先核对 test 库真实表关系、状态字段及前置任务已授予的权限：
  1. 如果 `videos` 存在已验证等价且可靠的上传成功字段，可使用它，无需读取 `pipeline_tasks`；**不得仅凭路径存在就视为上传成功**。
  2. 否则通过**最小投影**查询 `pipeline_tasks` 的视频关联键、`stage` 和 `status`，需要时先完成 `10-21-drama-archive-access` 的最小只读权限调整；不读取任务原始 payload/Telegram 字段、不向前端透传。
  3. 若无法证明上传完成，返回不可播并在任务记录中标为未解决依赖，不猜测。
- `GET /api/dramas/:id/play` 查询**仅对应视频**的内部 `object_path` 和就绪状态；未指定 `video_id` 时按确定性排序选择**第一条**可播视频（例如已有业务排序规则，若无则按 `episode`/稳定 ID 排序，具体在仓库联调中固定，不能依赖无序 SQL 行）。显式校验视频属于该短剧。
- repository 只返回最小数据库投影，`assemble.ts` 才组装 shared 的对外类型。

### 2.2 `assemble.ts`

逐字段回退，规则来自 `telegram-video-archive/SUPABASE_PIPELINE_DESIGN.md` §5：

```
trim(original_title) 非空 → 用它；否则 trim(ai_results.title) 非空 → 用它；否则 ''。
trim(original_description) 同理回退到 ai_results.description。
original_tags 去空项+去重后非空 → 用它；否则 ai_results.tags 去空项+去重后非空 → 用它；否则 []。
episode 直接取 videos.episode（无回退）。
```

- 不整行替换、不混合标签、不编造信息。
- `VideoItem.playable` 只表示**可靠的上传成功状态**且 `object_path` 非空。签名失败仅改变**本次** `DramaPlayback.playable`，不污染列表/详情的就绪元数据。
- `ai_results` 目前可能为空，标签和简介大量为空值是预期行为。

### 2.3 `signed-url.ts`

- 仅对本次选中的、已验证允许播放的视频调用 `supabase.storage.from('drama-videos').createSignedUrl(object_path, 3600)`；未通过校验不签名。
- 采用**进程内 TTL 缓存 + 同 key single-flight**：缓存同一个 URL 及到期时间，TTL 上限 1800 秒，且不得超过真实签名到期前 60 秒；缓存键包含 `object_path` 与**授权范围**。每次从缓存取 URL 前仍先完成请求者权限校验。用户权限不同/撤销后不得跨域复用（必要时按用户或权限组隔离）。
- 多实例只保证各实例内命中，无 Redis/数据库持久化；缓存应有容量上限和过期清理，不允许无限增长。
- 对网络、权限、签名异常及超时进行捕获并返回本次 `DramaPlayback { playable: false, play_url: null, expires_at: null }`，不让列表/详情出错；内部错误日志做脱敏，**不记录完整签名 URL/Token、内部对象路径或 Telegram 定位信息**。
- 不能把“`createSignedUrl` 成功”当作“文件一定存在”；人工验收必须对真实签名 URL 发起 Range GET 验证可读取。

### 2.4 `routes/drama.ts`

```
GET /api/dramas                         -> DramaSummary[]，仅元数据，无签名
GET /api/dramas/:id                     -> DramaDetail，视频元数据，无签名
GET /api/dramas/:id/play?video_id=<id>  -> DramaPlayback，仅当前一条视频；video_id 可省略
```

- `play` 路由是为了**列表点击时只发起一次直接播放地址请求**：未传 `video_id` 时，backend 根据已确认的固定顺序选择本短剧第一条可播视频；前端可同时、独立拉详情元数据，不应先等详情返回再请求签名。
- 三个路由一律使用现有 `X-Init-Data` / `requireTelegramAuth`，校验 `:id` / `video_id` 的合法性、短剧及视频归属、观看权限；不存在的短剧返回 404，非授权按现有错误 envelope 返回 403（或仓库既有错误惯例），不暴露对象是否存在的信息。
- 播放签名 URL 的响应 `Cache-Control: private, no-store`，阻止中间代理存储凭证；这不禁止 backend **内部内存缓存**同一已授权范围的签名。
- 外部查询及签名均有明确超时；对临时签名失败回 `ApiResponse<DramaPlayback>` 降级数据而非未捕获 500；未就绪返回 `playable=false`/null。
- 按仓库规则在**每个路由注册**上方写 `@frontend-ready: true — MVP：标签/简介为占位，标题/播放已可用`；日志只记请求数量、耗时、状态码及脱敏的性能分段，不记标题全文或 URL Token。

## 3. 数据流与首帧关键路径

```text
点击短剧卡片 ──────────────────────────┐
  ├─ [关键路径] GET /api/dramas/:id/play -> 鉴权/查选中视频 -> 命中缓存 URL 或 createSignedUrl -> 返回单个 play_url
  │                                       └-> frontend 立即设置当前 video.src/play -> Supabase CDN -> 首帧
  └─ [非关键路径] GET /api/dramas/:id -> 标题/简介/剧集元数据 -> UI 渲染，不阻塞 video.play()

进入列表后可选：后台仅预取 1–2 个最可能点击的卡片的 /play 返回值（签名 URL），不下载完整 MP4。
```

- 前端子任务 `10-21-drama-frontend-ui`：选中卡片立即播放；如果预取 URL 尚有效，直接复用；否则发起 `/play`。播放器使用浏览器原生 `<video>`；当前选中的视频拿到 URL 后立即设置 `src` 并调用 `play()`，不要等标签、详情、其他 URL 加载。可以对当前视频尝试 `preload="metadata"`，但不能假设它能预取第一帧；以真实首帧事件验收。未经许可或用户操作不做多条视频的 `preload="auto"`。
- MP4 条件：真实视频须验证 `Range: bytes=0-1023` 返回 206 / `Content-Range`，并检查容器 `moov` 位于 `mdat` 之前（faststart）。如不满足，记录为 `telegram-video-archive` 的后续归档/无损转封装任务；**不是本次 backend 变更范围**。
- `cacheControl: '3600'` 属于归档上传时的**浏览器重复观看缓存**优化，和初次点击首帧不是同一个机制；可开独立任务，不设为本次 backend 完成的阻塞条件。Supabase Smart CDN 对私有桶签名 URL 的缓存命中需**原 Token 复用**。

## 4. 风险与边界处理

- **敏感字段泄露**：只选最小列；分别使用内部投影类型与对外 `shared` 类型；不得泄漏 `object_path`/Telegram 定位字段/签名 Token。
- **授权与缓存**：检查实际用户观看权限后才能共享缓存签名；按对象和权限范围隔离，禁用跨范围复用。
- **空数据**：`ai_results` 为空时返回 `tags: []`、`description: ''`；未就绪时 `playable=false`，不虚构视频 URL。
- **失效与错误**：签名接口失败不影响元数据；前端收到 401/403 最多刷新一次签名后重试；不要循环重试。签名 URL 缓存有效期不等于严格的即时撤销机制。
- **性能验证**：分别记录列表点击到首帧耗时（优先 `requestVideoFrameCallback`，不支持则使用可比较的 `loadeddata` 指标）、`/play` 耗时、Storage Range/206、`cf-cache-status` HIT/MISS；在真实 Telegram WebView、目标亚洲网络下记录 P50/P95，避免用单次测试断言容量瓶颈。

## 5. 复用评估

- 类型分层复用 `characters.ts` Summary/Detail 模式，响应复用 `envelope.ts` 的 `ok/fail`，鉴权沿用 `requireTelegramAuth`，不新增登录流程。
- `drama_archive` 作为新域不复用其他 feature 的 repository；目录结构延续 `features/<domain>/{repository,...}.ts` 与 `routes/<domain>.ts`，不引入 Redis、流媒体转发层或 HLS。
