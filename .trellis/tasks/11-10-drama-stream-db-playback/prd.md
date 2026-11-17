# 存量短剧迁移到 Cloudflare Stream 的 App 播放对接

## Goal

归档端（telegram-video-archive）会把存量 supabase 视频重新下载并上传到 Cloudflare Stream，
就绪后**整剧一起**把 `videos` 行切成 `storage_provider='cloudflare_stream'`（写入 `stream_uid`、
`stream_ready_at`，`object_path` 置空）。App 必须能按数据库里的 `stream_uid` 播放，且切换瞬间不影响线上播放。

## 现状

- `repository.ts` 只读 `object_path`；`assemble.ts#isPlayable` 要求 `object_path` 非空。
- Stream 播放只存在于 A/B 实验：UID 来自环境变量清单 `DRAMA_STREAM_MANIFEST`，不读数据库。
- 一旦行被切换，`object_path` 为空，App 会把它判为不可播，整部剧从列表消失。

## Requirements

两阶段，由环境变量 `DRAMA_LEGACY_SUPABASE_ENABLED` 控制（默认开启 = 阶段一，上线即安全）。

1. 阶段一（默认）：读取 `storage_provider`、`stream_uid`、`stream_ready_at`。
   - `cloudflare_stream` 行：`upload` 成功且 `stream_uid`、`stream_ready_at` 同时存在才可播，用数据库里的 `stream_uid` 本地签名，返回 HLS。
   - `supabase` 行：保持原样（`object_path` + 原签名链路），线上存量照常播放。
   - Stream 行不依赖客户端是否带 `format=hls`，也不依赖 A/B 清单；没有 mp4 回退（`object_path` 为空）。
   - 未配置签名参数时 Stream 行判为不可播，不影响 supabase 行。
2. 阶段二（`DRAMA_LEGACY_SUPABASE_ENABLED=false`，存量迁移完成后手动切换）：
   - supabase 行不可播、不进入播放列表；
   - 一部剧只有在它**所有**视频都是 Stream 且就绪时才出现在列表、详情、播放里。
3. 现有 A/B 实验（`DRAMA_STREAM_*` 清单）行为不变。
4. 不改前端，不改 shared 契约（`format: 'hls'` 已在契约内）。

## Acceptance Criteria

- [ ] Stream 行（有 `stream_uid`）在默认配置下可播，`/play` 返回 `format: 'hls'` 的签名地址。
- [ ] supabase 行在默认配置下与改动前行为一致。
- [ ] 阶段二：supabase 行不可播；含任一非 Stream 视频的剧不出现在列表和播放里。
- [ ] 缺 `DRAMA_STREAM_HOST/KEY_ID/PRIVATE_KEY` 时 Stream 行不可播，不抛错。
- [ ] backend typecheck、非 integration 测试通过，新增用例覆盖以上场景。

## 发布顺序

1. 归档端 009 已应用到 App 连接的每一个库：生产已应用（2026-11-10）；**TEST 库（zoqelpfhurwehlvypryl）截至 2026-11-10 还没有**，发布到 TEST 之前必须先应用，否则列表查询会因缺列失败。
2. 发布本任务（阶段一）：对线上无可见变化。
3. 配置 `DRAMA_STREAM_HOST`、`DRAMA_STREAM_KEY_ID`、`DRAMA_STREAM_PRIVATE_KEY`（与 A/B 实验共用，不依赖实验开关）；归档端应用 010，开始重传。
4. 存量迁移完成并验收后，设置 `DRAMA_LEGACY_SUPABASE_ENABLED=false`（阶段二）。
5. 回滚：阶段二把变量改回 true；单行回滚见归档端 `migrations/010_restream_legacy.sql` 头部。

## Android/iOS 性能 P95 门禁

- 受影响页面：`/dramas`、`/dramas/:id`、`/watch` 的起播（仅 Stream 行的签名来源改变）
- 受影响接口：`GET /api/dramas`、`GET /api/dramas/:id/play`
- Android / iOS 页面 P95：本任务不改前端与起播链路，无新基线；目标为不退化。已有 Stream 组基线见 `11-06-ios-stream-720p-cap`
- 接口 P95：无新增可见样本，不推测；目标为不退化。列表接口多读 3 个列，`/play` 本地签名无外部请求
- 数据来源与观测窗口：Grafana st-engineering-drama（Loki）`st_drama_stage`，按 `cdn_group`/`provider` 分组，发布后取等长窗口
- 发布后验证：阶段一发布后确认 supabase 行 P95 无变化；Stream 行迁移后对比起播与 seek P95，低样本只作方向参考
