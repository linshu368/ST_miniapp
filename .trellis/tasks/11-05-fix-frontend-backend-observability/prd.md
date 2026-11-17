# 修复 Frontend / Backend 可观测性覆盖与耗时口径

## Goal

仅针对 `packages/frontend` 与 `packages/backend`，补齐已确认的 Sentry/Grafana 运行时覆盖缺口，修正页面、普通 HTTP 与流式请求的错误耗时终点，并交付修改后的覆盖清单 Markdown。

## Requirements

- 不处理 Admin、shared/database 独立运行面的可观测性；shared 只作为既有契约依赖，不修改外部 DTO。
- Frontend 新增页面必须进入低基数 page route registry，并在主要内容成功或失败的真实边界结束 page ready，不能等待次要图片、分页或后台刷新。
- 普通 HTTP 的 Sentry `api.request.duration` 必须覆盖响应体读取、JSON 解析和业务 envelope 校验；响应头时长保留为独立 `api.headers.duration`，timeout/inflight 不能在 headers 到达时提前结束。
- Grafana 的 `api.queue`、`api.headers`、`api.body`、`api.total` 保持兼容；修正角色静态接口和 creator/wishes 接口的错误路由分组。
- 聊天完整回复的用户体验指标必须在匹配回复终态 React commit 时结束，不得继续等待 detail refetch、余额/额度刷新或连接 EOF；持久态恢复仍保留独立 recovery 口径。
- Creator polish 流必须区分 headers、首段可见文本、业务 done 与 terminal total；主动取消、后台、错误与超时必须有互斥终态，观测失败不能改变编辑器结果。
- Next `/api/lobby-characters` 中转必须记录安全的 Sentry 异常/总耗时，并向浏览器暴露低基数 upstream server timing，供现有 Grafana API 链路记录中转阶段。
- Backend 主 Fastify route 的通用覆盖保持不变；为生产后台 job 与独立生产脚本补充统一、低基数的 Sentry error/duration 和 Grafana job outcome/duration。
- 独立脚本退出前必须有界 flush Sentry/OTLP，不得因遥测失败改变业务退出码；不能记录 secret、订单内容、initData、prompt、消息正文、URL 或动态 ID 标签。
- 本地离线分析器（如 drama export compare/parser）不作为生产运行链路接入 exporter，清单中必须明确排除理由。
- 输出 `docs/grafana/frontend-backend-observability-coverage.md`，列出修改后的覆盖、指标口径、仍需生产核对项、验证结果和回滚入口。

## Acceptance Criteria

- [ ] Frontend 当前 27 个 page 文件均有明确 page-ready 覆盖或合理排除；新增 6 个页面不再落入 `other`。
- [ ] Sentry HTTP headers 与 total 分开，body 卡住仍受 timeout 保护并保留 inflight；调用方 abort 不被误报为失败。
- [ ] `chat.full_reply.duration` 与 Grafana `roleplay.full_reply` 在同一匹配终态 commit 结束，旧的 invalidate 后上报被移除。
- [ ] Creator polish 和 lobby proxy 具备可定位的 Sentry/Grafana 阶段信号。
- [ ] Backend in-process jobs 和生产 standalone scripts 具备 job outcome/duration，捕获异常进入 Sentry；Exporter/Sentry flush 有界。
- [ ] 现有相关测试扩展覆盖 headers/body timeout、路由分组、页面 registry、聊天 commit、流式终态和后台 job 指标。
- [ ] Frontend/Backend typecheck、相关测试、lint、build 与 complexity 检查按影响范围通过；无法执行项记录风险。
- [ ] 最终 Markdown 清单与代码事实一致，不把源码配置存在写成生产已启用。

## Android/iOS 性能 P95 门禁

- 受影响页面：`/creation/characters/new`、`/creation/characters/:id/edit`、`/creation/data`、`/creators/:id`、`/wishes`、`/wishes/:id`。
- 受影响接口：所有经 `apiClient` 的 JSON 请求计时；`POST /api/v1/conversations/:id/messages|regenerate`；`POST /api/creator/polish`；`GET /api/lobby-characters`。
- Android 页面 P95：当前新增页面未登记，基线无可见样本，不补零；发布目标沿用工程 page-ready 2 秒预算。
- iOS 页面 P95：当前新增页面未登记，基线无可见样本，不补零；发布目标沿用工程 page-ready 2 秒预算。
- 普通 API P95：历史聚合基线最高约 3858ms，但本任务修正分组后旧聚合不可直接对比；发布目标沿用普通 API 2 秒预算。聊天/润色流按 first-token/full-reply 独立口径，不并入普通 API 2 秒目标。
- 数据来源与观测窗口：历史 Grafana `engineering_v1` 2026-10-27 至 2026-11-03；当前 Sentry token 403，新增页面与新分组无可靠当前样本。发布后按 release、platform、route/api_route 连续观察两个完整 24h 窗口，每组 N<100 标记低样本并延长窗口。
- 发布后验证：比较 Android/iOS `page.ready`、普通 API `api.total`、聊天 commit full reply、creator polish first text/full；观测代码不得使业务 P95 相比同 release 前一稳定窗口回退超过 5%。

## Notes

- 用户已明确要求创建并处理，无需再次请求任务创建或实施授权。
- 本任务会修改既有测试文件锁定高风险 timeout/SSE 计时回归，不新建独立测试框架。
