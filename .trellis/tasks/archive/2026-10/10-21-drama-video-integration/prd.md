# 短剧视频接入 miniapp（MVP 最小闭环）

> 方案来源：`docs/短剧视频接入方案.md`（方案草案，用户已确认思路）。本任务是父任务，拆成三个独立可验收的子任务，父任务本身不直接写代码，只负责需求归口、跨子任务验收标准和最终整合review。

## Background

`telegram-video-archive`（独立 Python 项目）已经从 Telegram 下载了一批短剧视频，归档进 Supabase **test 库**的 `drama_archive` schema（`dramas`/`videos`/`ai_results`/`pipeline_tasks` 四张表 + 私有桶 `drama-videos`）。现在需要把这些已归档的视频接入 ST_miniAPP，让用户能在小程序里刷到并观看。

`drama_archive` 的建表迁移由 `telegram-video-archive` 直接对 Supabase 执行，**不经过** ST_miniAPP 的迁移通道，且迁移脚本把 `anon/authenticated/service_role` 三个角色对该 schema 的权限全部 `REVOKE`，只留 `drama_worker`（下载/AI pipeline 专用角色）可读写。这意味着 ST_miniAPP backend 现在的 `service_role` 读不了 `drama_archive` 任何一行——这是本次需要解决的前置阻塞，不是 bug，是原设计刻意把下载链路和 miniapp 隔离开。

## Goal（本轮范围：最小闭环）

在**测试 miniapp** 上跑通一条完整链路：用户在短剧 tab 看到列表 → 点进去 → 视频能播放。标签、简介允许缺失但 UI 占位要到位，等二环节 AI 产出后自动补上，不需要再改前端代码。

## Non-Goals（本轮不做）

- AI 标签/简介的真实内容生成（`ai_results` 当前大概率为空表，这是预期现状）。
- 搜索、筛选、分页优化、多集/剧集导航。
- 生产环境发布、埋点、大厅推荐排序接入。
- `drama_archive` 正式登记进 `.trellis/spec/database/supabase/schema-and-object-conventions.md` 的八域地图（见 Open Issue，放到二期）。
- 原型视觉（`https://shunying-ai-drama.bagproectvwjo.chatgpt.site/`）细节精修（抓取失败，细节待用户后续补充）。

## 子任务拆分与依赖顺序

一个请求里包含三个可以独立验收的交付物，按严格的前置依赖顺序执行（后一个子任务在前一个验收通过前不得开始实现）：

1. **`10-21-drama-archive-access`**（前置阻塞项）：`drama_archive` 域授权、PostgREST 暴露、`DOMAIN_SCHEMAS` 接入、私有桶签名权限验证。不做这个，backend 一行数据都读不到。
2. **`10-21-drama-api-contract-backend`**（依赖 1）：`shared/api/drama.ts` 契约 + backend `features/drama/` + `routes/drama.ts`，提供只读列表/详情接口和现签播放地址。
3. **`10-21-drama-frontend-ui`**（依赖 2，页面结构可先用 mock 数据并行推进）：前端短剧 tab、列表页、播放页、占位态 UI，接入真实 API。

依赖顺序写在各子任务的 `prd.md`/`implement.md` 里，父子任务树本身不是依赖系统，只是交付物归口；真正的先后顺序以子任务文档为准。

## 核心设计约束（跨子任务，任何一个子任务都不得违反）

1. `drama_archive` 是短剧模块专属的域；DB 层面 `service_role` 现在对 `dramas`/`videos`/`ai_results`/`pipeline_tasks` 四张表都有读写权限（`GRANT USAGE ON SCHEMA` 开门后，这四张表早已存在的表级授权一并生效，见 `10-21-drama-archive-access` 的「范围变更记录」），不复用、不触碰 `drama_worker` 现有权限边界。但 **API 契约层**（`shared/api/drama.ts`）仍然只读、只暴露 `dramas`/`videos`/`ai_results` 三张表的字段——`pipeline_tasks` 和任何写操作都是 backend 内部实现细节，边界从"数据库强制"改为"API 设计 + code review 强制"，子任务 2 不得违反。
2. **Telegram 定位字段严禁出 backend**：`videos.source_id/message_id/media_id`、`pipeline_tasks` 整表只能在 backend 内部用于定位/回退判断，绝不能出现在 `shared/api/drama.ts` 的响应结构里，也不能被日志打印到前端可见的地方。
3. 字段回退规则照抄 `telegram-video-archive/SUPABASE_PIPELINE_DESIGN.md` §5：标题/标签/简介逐字段回退（原始非空用原始，否则用 AI，都空则空/`[]`），不整行替换、不混合、不编造。
4. 播放地址现签、不落库：backend 每次请求时用 `storage.createSignedUrl` 对私有桶签一个短期链接返回，不保存永久/长期签名地址。只有 `upload` 成功且 `object_path` 非空的视频才下发播放地址。
5. 前端新增第 5 个 tab，UI 参照原型风格适配；原型抓取失败这一限制不阻塞框架先定下来。

## 验收标准（MVP，父任务整合验收，逐条对应到具体子任务）

- [ ] 底部导航出现第 5 个"短剧" tab，点击可进入列表页。（`10-21-drama-frontend-ui`）
- [ ] 列表页展示至少几条真实（test 库里已归档、`upload` 成功的）短剧标题，无崩溃。（`10-21-drama-api-contract-backend` + `10-21-drama-frontend-ui`）
- [ ] 标签/简介为空时，UI 是占位态而不是空白或报错。（`10-21-drama-frontend-ui`）
- [ ] 点击进入播放页，视频能正常加载播放（签名链接有效期内）。（三个子任务共同保证）
- [ ] 某条视频不可播（`object_path` 为空或上传未完成）时，列表/详情有明确提示，不是静默失败。（`10-21-drama-api-contract-backend` + `10-21-drama-frontend-ui`）
- [ ] 全程不出现 `source_id/message_id/media_id` 等 Telegram 定位字段流到前端/响应体。（`10-21-drama-api-contract-backend`）

父任务在三个子任务都验收通过后做一次端到端整合review：实际在测试 miniapp 里走一遍"打开短剧 tab → 看列表 → 点进详情 → 播放视频"的完整用户路径，而不是只看各子任务分别的局部验证。

## Open Issue（跨子任务记录）

1. `drama_archive` 目前不在 `.trellis/spec/database/supabase/schema-and-object-conventions.md` 的八域地图里。该规范要求"扩展八域需要单独的架构决策"，本轮不满足这个完整要求——这是已知缺口，用户已确认延后到二期处理（正式登记为第九个域，或并入 `miniapp_features`），不在本次父任务或任一子任务的验收范围内裁决。
2. 原型 `https://shunying-ai-drama.bagproectvwjo.chatgpt.site/` 的视觉细节抓取失败，细节待用户后续补充截图/描述或重新抓取；本轮先交付功能框架，视觉精修不阻塞 MVP 验收。
