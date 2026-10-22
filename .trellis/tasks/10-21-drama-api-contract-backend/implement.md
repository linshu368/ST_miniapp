# 执行计划：短剧契约层与 backend API（首次点击首帧优先）

前置条件：确认 `10-21-drama-archive-access` 已验收（`DOMAIN_SCHEMAS` 已含 `'drama_archive'`，test 库所需表的 service_role 权限/PostgREST 暴露已生效）；若上传成功状态的数据来源需额外最小权限，先处理该依赖，不能跳过验证。

## 步骤

1. **契约先行**：在 `packages/shared/src/api/drama.ts` 定义 `DramaSummary`、不含 `play_url` 的 `VideoItem`、`DramaDetail` 与只包含当前播放地址的 `DramaPlayback`，封装在 `ApiResponse<T>` 中。执行 shared 类型检查。
2. **repository.ts：优先验证真实数据和上传状态来源**：对 `dramas` / `videos` / `ai_results` 显式选列；先尝试必要的 PostgREST embed，不支持则分次查询。核实 `pipeline_tasks` 对 `upload succeeded` 的关联方式；若没有等价可靠的 `videos` 状态字段，按已确认权限读取 `pipeline_tasks` 的关联键和 `stage/status` **最小字段投影**，不可把原始表行/Telegram 字段传给 frontend；权限未具备则标记为前置阻塞。
3. **assemble.ts**：逐字段回退、标签去空去重、`VideoItem.playable`（已上传成功且有 `object_path`）判定；临时签名失败只影响本次 `DramaPlayback`，不改视频持久就绪状态。
4. **signed-url.ts**：单条视频签名，3600 秒有效期、backend 内存最多缓存 1800 秒且预留至少 60 秒安全余量；缓存键包含对象及授权范围，取缓存前重查权限；同 key 并发 single-flight，有限容量清理、超时及脱敏失败降级。不得保存签名 URL 到数据库或日志。
5. **routes/drama.ts**：注册并鉴权 `GET /api/dramas`、`GET /api/dramas/:id`（二者仅返回元数据、不批量签名且实际零签名）及 `GET /api/dramas/:id/play`（可选 `video_id`，每次只签当前一条，未传时按已确认的固定排序选第一条可播视频）。校验视频归属与观看权限、使用 `ApiResponse`、`@frontend-ready` 注释；`/play` 返回 `Cache-Control: private, no-store`。
6. **test 环境联调**：用 curl/httpie 对三个真实接口验证：
   - 列表/详情有真实标题，AI 空数据时 `tags: []`、`description: ''`，并确认两者未发生 Storage 签名调用。
   - `/play` 返回 `video_id/playable/play_url/expires_at`；首个可播视频可直接由戏剧 `:id` 得到，不依赖前端先拉取详情；指定 `video_id` 必须属于该剧。
   - 使用短期凭证对真实 MP4 请求 `Range: bytes=0-1023`，验证 `206`、`Content-Range` 与实际可播放；不要将凭证写入 task.md 或日志。
   - 对一个不可播样本验证 `play_url=null`；若测试库没有现成样本，优先用可控 mock 进行失败路径验证，不在共享数据库随意制造残留数据。
7. **缓存与安全路径**：验证缓存 TTL 内同权限对象返回原 Token、并发只签一次、即将到期重新签、不同授权范围不共享；签名超时/权限错误/路径异常返回降级，不把元数据端点拖成 500；前端最多 1 次刷新 URL 重试。确认响应及服务端日志无 Telegram 定位字段、`object_path`、原始任务行或 Token。
8. **与 frontend/归档端联动（写入前端任务，不在本 backend 子任务改前端代码）**：
   - `10-21-drama-frontend-ui`：用户点击卡片后**直接**调 `/api/dramas/:id/play`，详情可并行请求；获 URL 即设置当前 video 的 `src` 并 `play()`；最多后台预取 1–2 个候选的 URL，不预下载整条视频。真实 Telegram WebView 测试点击至首帧及 `/play` 延迟，分离记录 P50/P95 和 CDN HIT/MISS（不记录 Token）。
   - 归档端：检查 MP4 `moov` 在 `mdat` 前（faststart）；缺失则交给 `telegram-video-archive` 单独做无损转封装。`cacheControl: '3600'` 可作为重复播放缓存优化的**独立**归档脚本变更，不作为首次首帧的阻塞项。
9. **类型检查与测试**：运行 shared/backend typecheck 和 backend 现有测试；如回归风险需要，再最小化增加缓存/权限/签名失败测试。将 curl 关键字段和性能数值记录到 `task.md`，不记录 URL Token。

## 验证命令

```bash
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
```

性能验收可用真实 Telegram WebView + 浏览器网络工具记录 `click -> first frame`（优先 `requestVideoFrameCallback`，回退 `loadeddata`）；在目标亚洲网络中至少比较**冷启动/缓存 MISS**与**有效签名复用/CDN HIT**两类情况，标记视频大小、测试终端、网络条件。不要把 `preload="metadata"` 当作首帧优化必然成功的证据。

## 风险控制

- `ai_results` 可能为空。如果完全没有数据，记录“原始字段路径已验证，AI 回退路径因数据缺失暂未实测”；不谎称完成 AI 回退实测。
- “只查三表”和 `pipeline_tasks` 判定状态存在冲突，必须先验证并在执行日志写明实际采用的数据来源、查询列与权限依据，未解决不得将 `object_path` 存在等同于上传成功。
- 真实签名链接属于临时凭证：不写进 Git、日志、错误堆栈或演示截图。遇到 400/403/206 非预期时保留脱敏状态码及响应头用于排查。
- 后端内存缓存不保证多实例一致性。MVP 先避免引入 Redis；如果首帧数据证明主要瓶颈是签名与缓存命中，再考虑集中缓存。

## 回滚

- shared 类型、backend feature/route 都是新增能力，无历史路由需迁移；按正常 Git revert 回滚新增接口及签名缓存逻辑即可，不改变现有归档对象和 Storage 配置。
