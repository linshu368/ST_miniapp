# 实施与验收记录

## 当前结论

2026-10-26 已按用户授权完成本地实现、文档与适用检查。远端 TEST migration、真实 API／Telegram 播放验收尚未执行，任务保持 `in_progress`。未提交、未推送、未部署；Production 未操作。

## 环境与结构证据

- Supabase 分支元数据：`ST_telegrambot` 的 `testdb` 为 `zoqelpfhurwehlvypryl`，与仓库 TEST ref 一致。
- MCP 只读 catalog：`dramas.tags/description` 存在，`ai_results.drama_id` 为 PK，FK `ai_results_drama_fkey` 指向 `dramas.id`；`source_video_id` 只是来源 FK。`videos.created_at` 缺失；`source_id/message_id` 非空且组合唯一。五表均 RLS 开启，无 policies；视频表无用户触发器。已有 table grants／schema 访问边界不修改。
- 只读服务端 HTTP HEAD／关系 count：69 部剧、577 条视频、5 条剧级 AI，单剧最多 156 条视频；只输出聚合计数，不导出定位明细或内容。目录规模目前低于默认 PostgREST 1000 行上限。
- 使用列表／详情新关联投影（排除尚未迁移的 created_at）执行 TEST HEAD，两者均成功、count=69；新时间列真实读取须在迁移后复核。
- 本地 TEST 直连认证失败；未重置凭据或绕过工作流。GitHub CLI 在允许网络后认证正常；沙箱内最初的“凭据失效”提示不是最终结论。

## 实现摘要

- shared 兼容扩展 `first_published_at?: string | null`，新 Backend 返回 ISO 时间／NULL。
- repository 从剧级关系获取 AI；assemble 统一逐字段回退，标签整组归一／回退，列表详情一致。视频 DTO 只保留自身原始信息。
- 只在可播视频中聚合最早 created_at；未就绪视频不影响排序。封面、可播判定、播放顺序、鉴权、签名和查询超时沿用现有实现。
- 前端完整标题／标签／简介子串匹配，trim／忽略大小写，搜索与分类取交集；推荐保留 API 顺序，最新倒序／缺时间置后／同时间按 ID；新增无匹配反馈和清除筛选。点击时冻结当前所见浏览队列。
- 迁移只扩展既有列，不建持久表／RPC／索引；锁住 videos 后要求整批仍为 577，以 `source_id,message_id` 升序固定序号，只补 NULL。起点 UTC `2026-10-20T03:00:00Z`，末条 `2026-10-24T03:00:00Z`，间隔 600 秒。已有非空时间不匹配即拒绝。

## 已执行验证

- `pnpm -r typecheck`：所有五个包通过。
- `pnpm --filter @miniapp/shared test`：17 文件／177 项通过。
- `pnpm --filter @miniapp/frontend test`：55 文件／395 项通过。
- `pnpm --filter @miniapp/backend test`：最终 100 文件／868 项通过。首次与构建并行运行时一项 generation 首 token 实时计时测试失败并出现 stream closed 异常；单独复跑该文件 40 项通过，再完整复跑 868 项通过；未修改该测试或生成代码。
- `pnpm --filter @miniapp/frontend lint`：通过；五条既有图片优化 warning，均在本任务未修改文件。
- `pnpm -r --if-present build`：Frontend 与 Admin 构建通过。根目录不存在 `pnpm build`，因此采用实际可执行的 workspace 命令。
- 改动代码的根 ESLint／跨包导入边界检查通过；`pnpm lint:migrations`、`git diff --check`、模块影响声明校验通过。
- 临时合成 fixture 使用真实 Supabase client 与 repository，验证查询投影、剧级 AI 映射、播放顺序、单集隔离、精简播放投影和读取失败；未请求真实内容。
- 临时纯函数 fixture 验证原始齐全／部分缺失／AI 回退／AI 缺失／全空、标签去空去重整组回退、列表详情一致、可播最早时间／全部缺时间、三字段独立匹配、长简介尾部与未展示标签、条件交集、空结果、稳定时间排序、推荐原序和不修改输入。
- 隔离 PostgreSQL 17 临时库：577 行补录、时区／间隔、部分非空保留、同批 SQL 再执行不覆盖；时间冲突／规模变化／错误类型／缺 AI 主键／now 默认值均拒绝；人为触发 postflight 失败后新增列和更新一起回滚；并发 writer 持锁时 5 秒锁超时拒绝；ACL／RLS／原始元数据不变。临时 cluster 已清理，未远端写入。
- 浏览器使用本地合成 API：验证推荐／最新次序、缺时间置后、未展示标签搜索、仅简介命中的分类、搜索分类交集、无结果与清除；检查 390×844 和 320×740 布局。截图 `/private/tmp/drama-mvp-mobile.png` 使用合成内容，非 TEST 业务数据。

临时复验入口（本机临时目录可能被系统清理，不作为永久测试设施）：

```bash
bash /private/tmp/drama-mvp-migration-check.sh
pnpm --filter @miniapp/backend exec node --import tsx /private/tmp/drama-mvp-fixtures.ts
pnpm --filter @miniapp/backend exec node --import tsx /private/tmp/drama-mvp-repository-fixtures.ts
```

## 待执行的远端验收与停止条件

1. 人工审阅本次最终路径／摘要／校验值和验证结果，明确批准提交；推送需独立明确授权。SQL 在远端分支可见之后才运行 workflow，不以 MCP 写入代替。
2. `db-migrate.yml`：`mode=apply`、`environment=test`、`migration_file=packages/shared/migrations/20261026_drama_video_created_at.sql`、`force_rerun=false`，Production 确认项留空；核对分支 SHA 和文件 checksum，确认 ref 为 `zoqelpfhurwehlvypryl`。
3. 规模变化／锁超时／shape／非空值冲突即停止；不修改批次数量或重试 force_rerun。成功后核对 workflow 结果、repo_migrations filename/checksum、created_at shape、ACL／RLS，以及迁移内覆盖／时间断言；结果未知先互证账本和 shape。
4. 发布兼容 Backend 后验证实际列表／详情元数据及 first_published_at，数量与可播集一致；再发布 Frontend。按标题、第四标签、完整简介尾部各搜一次，组合分类／排序，核验无匹配／清除／加载失败重试。
5. 在 Telegram 真机验证卡片进入、首集、手动选集、自动续播、上下滑换剧；后端不返回来源定位／object_path／列表签名 URL。真实 TEST／Telegram 未完成前不宣称上线闭环通过。

## 取舍与暂缓

按已批准轻量范围保留全目录前端筛选，不新增服务端搜索、公开分页、缓存／重试框架、依赖或永久测试文件。现有数量没有截断证据；容量增长后须重新核验。新增视频上传时间接入、连载最近更新排序、Production、旧参考库文档重采集仍暂缓，不另建 backlog。
