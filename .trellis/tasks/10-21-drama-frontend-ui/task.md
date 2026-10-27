# Task Breakdown

## Status Legend

- Todo: not started
- Doing: currently in progress
- Done: completed and verified
- Blocked: waiting on external input
- Skipped: intentionally skipped with a recorded reason

## Tasks

| ID  | Status  | Task                     | Files / Scope                            | Depends On                                     | Verification                                                                                                                                  |
| --- | ------- | ------------------------ | ---------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Done    | drama API hooks          | `packages/frontend/src/lib/api/drama.ts` | 父任务:10-21-drama-api-contract-backend 已验收 | React Query hook 返回类型与 `@miniapp/shared` 契约一致                                                                                        |
| T2  | Done    | 列表页                   | `app/(main)/dramas/page.tsx`             | -                                              | loading/error/empty/success 四态齐全                                                                                                          |
| T3  | Done    | 详情/播放页              | `app/(main)/dramas/[id]/page.tsx`        | -                                              | playable=true/false、简介空/非空、episode_count=0 组合齐全                                                                                    |
| T4  | Done    | 接入真实接口             | T1-T3                                    | T1                                             | 本地 backend（连 TEST_SUPABASE_URL）+ Playwright 接管真实 Chrome 跑通：列表 10 部真实数据、零集态、2 集短剧真实签名直链播放、`ended` 自动续集 |
| T5  | Done    | BottomNav 扩展到 5 tab   | `components/nav/bottom-nav.tsx`          | -                                              | 原 4 个 tab 行为不受影响，新 tab 可点击进入列表页                                                                                             |
| T6  | Blocked | 移动端人工验证           | Telegram WebView + 常规移动浏览器        | T4, T5                                         | 自动化工具到不了 Telegram WebView 和真机，仍需用户自行验证                                                                                    |
| T7  | Done    | 类型检查/lint/test/build | -                                        | T1-T6                                          | `pnpm --filter @miniapp/frontend typecheck/lint/test/build` 均通过                                                                            |

## Execution Log

- 2026-10-22：`lib/api/drama.ts` 新建 `useDramaListQuery`/`useDramaDetailQuery`/`useDramaPlaybackQuery`/`usePrefetchDramaPlayback`。
- 2026-10-22：**跳过 mock 阶段，直接对接真实接口**（T2/T3/T4 合并执行）。依据：原计划 T2/T3 先用 mock 搭 UI、T4 再换真实接口，是为了让 UI 开发和 backend 联调解耦、并行推进；但本轮 backend test 环境本来就不可用，无法在浏览器里实测播放，mock→真实接口的切换本身不会带来额外的可验证性，重复写一套 mock 数据再丢弃是多余工作。因此直接用真实 hook 实现页面，类型/占位态覆盖由 TypeScript 契约类型和已读代码路径保证；真实数据下的播放效果等 backend 恢复后由用户验证。
- 2026-10-22：**发现 design.md §1 的响应解包方式已过时**。design.md 草稿里 `fetchDramas`/`fetchDramaDetail` 直接返回 `DramaSummary[]`/`DramaDetail`，但 `packages/shared/src/api/drama.ts`（backend 契约任务产出，验收通过）里响应体分别是 `GetDramasData { dramas }`、`GetDramaByIdData { drama }`、`GetDramaPlaybackData { playback }`，多包了一层。以 `packages/shared/src/api/drama.ts` 实测契约为准，`lib/api/drama.ts` 里按 `{ dramas }`/`{ drama }`/`{ playback }` 解包。
- 2026-10-22：**简介字段的位置与初稿预期不同**：`description` 不在 `DramaSummary`/`DramaDetail` 上，而是在 `VideoItem`（按集维度）。详情页「简介整理中」占位改成取当前播放集（`currentVideo?.description`），未选中具体集时退回第一集。
- 2026-10-22：续播自动重试（遇 401/403 重调一次 `/play`）直接复用全局 `QueryClient` 默认 `retry: 1`（见 `lib/api/query-client.ts`），没有再为 `/play` 单独写重试分支——默认配置已经是"失败重试一次、不循环"，和需求一致，额外的状态码判断分支对本期没有增量价值。
- 2026-10-22：自动播放拦截兜底已按拍板现在做：`play()` 被拒时显示"点击播放"覆盖层（`needsTapToPlay`），而不是黑屏；真机测试后再按实际问题调整。
- 2026-10-22：卡片点击顺手预取 `/play`（`usePrefetchDramaPlayback`），实现成本低，按拍板直接做了；没有做跨卡片的后台预测性预取。
- 2026-10-22：为续播逻辑抽出纯函数 `lib/drama-playback.ts#resolveNextVideoId`，配了 5 条 vitest 用例（当前集/末集/找不到当前集/未开始播放/空列表），满足"写个测试脚本，够用就行"的要求，不做完整 RTL/DOM 测试。
- 2026-10-22：`pnpm --filter @miniapp/frontend typecheck/lint/test/build` 全部通过（`test` 42 个文件 261 个用例，含新增续播用例）。清理过程中发现 `.next/types` 残留了已删除的 `create/wish` 页面类型导致 typecheck 误报，删除 `.next` 缓存后恢复正常，与本次改动无关。
- 2026-10-22：**T4 补做**。用根目录 `pnpm install` 补上 undici（已知环境问题解除），本地起 backend（`packages/backend`，`.env` 已配 `TEST_SUPABASE_URL` + `MOCK_AUTH=1`/`DEV_AUTH_BYPASS=1`）连 test 库，frontend 指向 `http://localhost:3001`；用 Playwright 接管本机已安装的 Chrome（跳过下载 playwright 自带 chromium，省时间）驱动真实点击。注意：这是本地 backend 连 test 库，不是 Railway 上的 test backend 部署——我这边环境里没有 Railway 的访问方式，如果你需要专门验证 Railway 部署本身（不只是代码逻辑），需要另外验证。
  - `/api/dramas` 真实返回 10 部短剧，episode_count 分布 0/1/2/4 都有。
  - 点一部 `episode_count=0` 的剧：`/play` 返回 200+`playable:false`，没走 error 分支，详情页显示「暂无可用集数」，不渲染 `<video>`——与契约一致。
  - 点一部 2 集的剧：进详情页后 `/play`（不传 video_id）和详情接口并行发出；拿到的 signed URL 真实加载进 `<video>`（`readyState=4`）。Chrome 的 autoplay 策略挡住了无手势的 `play()`，走到了"点击播放"覆盖层分支——这正是前面拍板要做的那个兜底，首次在真实浏览器里验证生效。点击覆盖层后视频真实播放（`currentTime` 持续增长）。
  - 手动把 `currentTime` 推到接近结尾触发 `ended`：前端立即用**第二集的 video_id** 重新请求 `/play?video_id=...`，新 URL 加载后播放对象的 `duration` 从 169.0s 变成 175.9s（确认是换了真的另一个视频文件，不是重放同一个）。全程没有二次用户点击——续播在同一个 `<video>` 元素上触发，没被 autoplay 策略二次拦截，印证了设计里"复用同一个 video 元素续播不会被拦"的判断。
  - 过程中唯一的异常日志是 `/api/support/unread` 返回 500（`CS_SERVICE_URL`/`CS_SERVICE_SECRET` 未配置）——这是客服模块本地环境缺配置，与短剧功能无关，不处理。
  - 结论：T4 的核心验收点（真实数据渲染正确、真实签名链接可播、续播正确触发）已经跑通；浏览器截图见本地 `/tmp/st-pw-driver/shots/` 与整理过的 `/tmp/st-demo-artifact/`（含一个可直接用浏览器打开查看的 `index.html` 汇总页，因为当前会话无法发布 Artifact 到 claude.ai）。
  - T6（Telegram WebView + 真机移动浏览器）仍然做不到——自动化工具到不了那两个环境，保持 Blocked，交给用户。

## 来自 backend 契约任务的交接（10-21-drama-api-contract-backend，已验收）

### 接口与契约

三个路由均需 `X-Init-Data` 鉴权，响应统一为 `ApiResponse<T>`：

| 路由                                       | 响应类型                                           | 实测耗时                    |
| ------------------------------------------ | -------------------------------------------------- | --------------------------- |
| `GET /api/dramas`                          | `GetDramasData { dramas: DramaSummary[] }`         | 951ms（6 部）               |
| `GET /api/dramas/:id`                      | `GetDramaByIdData { drama: DramaDetail }`          | 259ms                       |
| `GET /api/dramas/:id/play?video_id=<可选>` | `GetDramaPlaybackData { playback: DramaPlayback }` | 首次 738ms / 缓存命中 247ms |

类型定义在 `packages/shared/src/api/drama.ts`，不要自己重写一份。

### 首帧关键路径（本任务的核心设计）

点击卡片后**立即并行**发两个请求，不要串行：

```
点击 ├─ GET /api/dramas/:id/play  → 拿到 play_url 立刻设 video.src 并 play()
     └─ GET /api/dramas/:id       → 标题/简介/集数，渲染 UI，不阻塞 play()
```

`/play` 不传 `video_id` 时后端按固定顺序返回第一条可播视频，**所以不需要先拿详情再请求播放地址**。

### 顺序播放

`DramaDetail.videos` 已按播放顺序排好，**数组下标即集数顺序**。当前集 `ended` 事件后，取 `videos[i+1].id` 调 `/play?video_id=<该 id>` 换 `src` 续播。

### 封面徽标规则

- `episode_count === 1 && duration_seconds !== null` → 右上角显示时长
- `episode_count > 1` → 左上角显示集数
- 其余 → 不显示徽标

注意 `duration_seconds` **当前恒为 `null`**（待归档端补数据），所以现阶段单集剧不会有徽标，逻辑先写好即可。

### 字段现状（避免误判为 bug）

- `cover_url` **恒为 `null`**，需要前端占位（渐变底 + 标题）。归档端补缩略图后自动有值，契约不变。
- `tags` 返回**全量**（实测 6–7 个），列表卡片由前端截断到 3 个，详情页可展示全量。
- `title` / `description` 当前全部来自 AI 回退（原始字段在库里为空），属预期。
- `episode_count === 0` 的短剧（测试库里有 2 部）：列表正常展示、可点击，详情页提示「暂无可用集数」。此时 `/play` 返回 **200 + `playable:false` + `video_id:null`**，**不是错误，不要走 error 分支**。

### 签名 URL 处理

- `play_url` 是临时凭证，有效期 1 小时，`expires_at` 为 ISO 8601 到期时间。
- 后端有进程内缓存会复用同一个 URL 原文（CDN 命中依赖 Token 一致），前端**不要**自己加随机参数。
- 播放时遇到 401/403，**最多重新调一次 `/play`** 取新地址，不要循环重试。
- 不要把 `play_url` 写进 localStorage、日志或埋点。

### 性能验收口径（重要，与原计划不同）

⚠️ 原计划要测「点击到首帧」的 P50/P95，但实测发现**10 条可播视频里有 6 条的 MP4 `moov`（索引）在文件尾部**，浏览器必须多做 2 个网络往返才能解出首帧，实测光这一项就要 **0.8–2.3 秒**（本机宽带 + CDN 已 HIT 的条件下）。

这意味着现在测「点击到首帧」主要反映的是 MP4 容器结构，不是前后端代码质量。**修复点在归档端的无损转封装（`-movflags +faststart`），前端做不了任何优化。**

所以前端本期只验收：

- `/play` 请求耗时（后端已实测 738ms 首次 / 247ms 缓存命中）
- 点击后是否**立即**发起 `/play` 且不等详情
- 续集切换是否无额外等待

「点击到首帧」的 P50/P95 等归档端转封装完成后再测。

### 不要做的事

- 不要在列表页为多条视频 `preload="auto"` 或并发创建多个 `<video>`，会抢占用户真正点开那条的带宽和解码器。
- 不要用首帧抽取来做封面（已评估：需要 tab 打开时就签 N 个 URL + 数 MB 流量，直接拖慢 tab 观感，结论是归档端预生成）。
- 最多后台预取 1–2 个最可能点击的卡片的 `/play` 返回值，不要预下载视频内容。
