# 短剧目录与首次上架时间

## 1. 范围与来源

本任务为 `.trellis/tasks/10-26-drama-mvp-search-latest/`。既有 `drama_archive` 是外部归档域，继续使用当前访问边界，不另建 schema、表或 RPC。基础对象由归档仓库维护；本次仅在 shared migration 添加展示时间列。

`TEST-DB`：2026-10-26，`ST_telegrambot/testdb`，ref `zoqelpfhurwehlvypryl`。MCP catalog 证明剧级 AI 结构已落库、当时 `videos.created_at` 缺失；服务端只读 HTTP 计数为 69 部剧、577 条视频、5 条剧级 AI，单剧最多 156 条视频。与旧 `test-database-reference.md` 的其他参考项目不同，不替换该历史证据，也不代表生产。

## 2. 接口与数据库签名

- 继续使用 `GET /api/dramas`、`GET /api/dramas/:id`、`GET /api/dramas/:id/play` 和既有鉴权／包络；不添加公开查询参数或分页接口。
- `DramaSummary.first_published_at?: string | null`：新 Backend 必返回 ISO 8601 或 NULL，可选性用于旧 Backend 的部署兼容；`DramaDetail` 继承同一摘要。
- `drama_archive.videos.created_at timestamptz NULL`：无默认值。由独立上传脚本在首次上传成功后写一次，重试／转封装不覆盖。上传端接入前保持 NULL；本仓库不修改上传脚本。
- 迁移：`packages/shared/migrations/20261026_drama_video_created_at.sql`，仅 TEST，经 `db-migrate.yml` 单文件执行、按 filename/checksum 记账。

## 3. 契约与数据流

`DramaRepository → assemble → shared DTO → React Query → selectDramas → 页面／浏览队列`。

标题、标签、简介各自采用 `dramas` 原始字段 → 按 `drama_id` 关联的 `ai_results` → 空值。空白字符串缺失；标签去空、trim、去重后整组回退，不混合原始和 AI。列表与详情采用同一组装函数。AI 的 `source_video_id` 仅代表生成来源，不是视频级归属；`VideoItem` 只保留该集原始字段。

可播仍为 upload/succeeded 且 object_path 非空；封面仍取播放顺序中的首条可播且封面就绪的视频。剧级时间取全部可播视频非空有效时间的最早值，不按首集／最大时间取值；全缺失为 NULL。

前端搜索词和分类关键词分别 trim、忽略大小写；任一完整标题／标签／简介子串命中即可满足该条件，两条件取交集。“全部”无分类条件。推荐保留 API 顺序；最新时间倒序、NULL／旧字段缺失排最后、同时间按 ID 升序。不得修改 React Query 原始数组；点击卡片时将当前所见列表保存为既有浏览队列快照。

## 4. 校验、失败与恢复

迁移先核对字段和唯一键，锁住 videos 后要求总量仍为 577，在事务临时快照中对整批按 `source_id, message_id` 升序编号，起点 `2026-10-20T03:00:00Z`，每条加 600 秒。只补 NULL；已有非空值若不等于该条整批预期则整笔拒绝。不按剩余 NULL 重新编号。

字段类型／nullable／default 不符、规模变化、既有时间冲突、锁等待超过 5 秒、语句超过 60 秒、覆盖／间隔／ACL／RLS／原始元数据断言失败均停止并回滚。不得 force_rerun 或直接改常量扩大范围。结果未知时先核对 workflow、账本和实库 shape。

权限、RLS、播放任务和其他元数据不变。先 TEST migration 验收，再 Backend，再 Frontend。应用问题回退至兼容剧级 AI 的版本并保留时间；已提交误填使用受审核的定向 forward-fix，不 DROP 列或清空时间。Production 另行审批。

## 5. 正常、缺省与反例

- 正常：原始标签存在、原始简介空白，仅简介回退 AI；列表／详情剧级文字一致，换集不变。
- 缺省：AI 行缺失且原始也为空，返回空字符串／空标签；无有效可播时间的剧在最新末尾，推荐顺序不变。
- 反例：使用首集简介搜索、把第四个标签因卡片不展示而排除、用 source_video_id 的 AI 当单集 AI、取最近一集时间作为本版“最新”、用 now() 补造上传成功时间。

## 6. 验证要求

执行 shared／backend／frontend 既有测试、所有消费者 typecheck、frontend lint、各可构建包 build、迁移静态检查。根目录没有 `build` script，使用 `pnpm -r --if-present build`。

本任务不新增永久测试文件。临时合成 fixture 验证五种回退、剧／集隔离、可播最早时间、三字段独立匹配、长简介／未展示标签、组合筛选、同时间／缺时间稳定排序；隔离 PG17 验证 577 行回填、部分非空保持、冲突／shape／规模拒绝、锁超时和事务回滚。浏览器验证交互和布局；真实 Telegram 选集／播放、远端迁移／账本必须另外记录，不以本地合成结果替代。

目录全量读取依赖顶层和单剧嵌套结果不截断；当前 TEST 已核验数量低于默认 1000 上限。容量增长后若发现截断，先在 repository 补全内部读取，不让前端搜索静默只覆盖部分目录。

## 7. 错误与正确做法

错误：对 NULL 子集重新编号或在冲突时覆盖已有时间；向前端透传来源定位／对象路径来实现排序。

正确：锁内固定整批序号、仅填 NULL，冲突整笔停止；DTO 仅公开聚合后的 ISO 时间，签名播放链路继续独立。
