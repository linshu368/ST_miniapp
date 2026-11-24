# 短剧页面下线为开发中占位

## Goal

生产环境不再向用户呈现短剧：底栏「剧场」入口保留，页面只显示"开发中，敬请期待"；短剧后台服务不再运行；Stream 上的视频文件暂不删除。

## Requirements

- 前端：`/dramas` 渲染静态占位页（不请求接口、不预热 Stream）；`/dramas/[id]`、`/watch` 重定向到 `/dramas`；启动骨架与占位页一致；聊天页不再挂载短剧问卷。
- 后端：新增 `DRAMA_ENABLED`（默认关闭，仅 `'true'` 开启）。关闭时不注册短剧、短剧互动、短剧问卷、`/api/telemetry/drama-timing` 路由。
- 运维：本机入库 serve（launchd `com.qj.telegram-video-archive.serve`）停止并移出 LaunchAgents，不自启。
- 发布顺序：先发前端，观察旧页面请求消退后再发后端（后端默认关闭，部署即生效）。
- 不做：删除 Stream 视频、删除数据库 drama 表与短剧业务代码、清理 perf/埋点代码。

## Acceptance Criteria

- [ ] 点「剧场」只看到占位提示，无任何短剧内容与播放入口，不再请求 `/api/dramas*`。
- [ ] 旧链接 `/dramas/:id`、`/watch` 落到占位页。
- [ ] `DRAMA_ENABLED` 未设置时 `/api/dramas` 等返回 404；设为 `true` 时路由恢复。
- [ ] typecheck、lint:complexity、frontend/backend 单测、frontend build 通过。
- [ ] 本机无 serve 进程，LaunchAgents 里无对应 plist。

## Android/iOS 性能 P95 门禁

- 受影响页面：`/dramas`（变为静态占位页）、`/watch`、`/dramas/:id`（重定向）、`/chat/:id`（移除问卷组件挂载）
- 受影响接口：`/api/dramas*`、`/api/telemetry/drama-timing`、短剧问卷接口（下线，不再有请求）
- 本次只做删减，不新增请求或渲染负载，无需设置 P95 劣化目标。
- 发布后验证：观察 Sentry `page.ready.duration` 中 `/chat/:id` 无劣化；Railway 日志里 `/api/dramas*` 请求量归零（旧页面缓存残留除外）。

## Notes

- 恢复短剧：后端设 `DRAMA_ENABLED=true`；前端 revert 本次对 `dramas/*`、`watch`、`entry-shell`、聊天页的改动；ui-tests 删除 `drama.spec.ts` 顶部的 `test.skip`。
