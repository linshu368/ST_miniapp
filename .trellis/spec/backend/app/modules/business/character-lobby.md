---
module_id: backend.business.character-lobby
title: 角色卡、大厅与收藏
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/11-02-lobby-quality-rotation/
last_verified_at: 2026-11-02
---

# 角色卡、大厅与收藏

## 职责与边界

提供角色列表/详情、最新红点、收藏、运营置顶和推荐排序，不负责聊天执行。

## 当前状态

公开角色发现、用户收藏、排序参数和每日排序分重算已落地。

## 入口与调用者

Frontend 大厅及 Admin 排序配置调用 characters/favorites/lobby API。

## 涉及文件

| 路径                                        | 职责     |
| ------------------------------------------- | -------- |
| `packages/backend/src/routes/characters.ts` | 角色 API |
| `packages/backend/src/routes/favorites.ts`  | 收藏 API |
| `packages/backend/src/features/lobby/`      | 大厅排序 |

## 关键实现链路

请求参数 → 公开/用户鉴权 → 排序与置顶配置 → repository → DTO。

## 数据、契约与外部依赖

依赖 app_core.characters、miniapp_features 收藏/排序表和 shared 角色契约。

## 关键节点与约束

测试卡与发布状态必须过滤；大厅定时重算不依赖 analytics 运行时视图。

## 验证方式

Backend lobby/route tests 与 Frontend 大厅人工回归。

## 已知缺口与待核验项

排序参数调整需观察推荐质量与任务容量。

## 关联模块

`frontend.business.character-lobby`、`shared.business.character-lobby-contracts`。

## 角色互动（2026-10-29，本地待发布）

`routes/character-social.ts` + `features/character-social/repository.ts` 提供 Telegram鉴权的 social批量/单项查询、PUT like、评论分页/发表/删除/举报。批量40项，评论每页20条。匿名公开DTO不返回用户ID；日志不记录评论正文。写入采用miniapp_features中的服务端函数、受限search_path与RLS，原character_favorites为收藏数量唯一来源。

迁移 `packages/shared/migrations/20261029_character_social.sql` 新建 character_likes、character_comments、character_comment_reports。UUID幂等、删除墓碑、作者权限、举报唯一性、并发限流已纳入 `scripts/test-character-social-migration.sh` 隔离Postgres验收。举报存储不等于自动审核，运营处理UI不在本轮范围。未执行线上迁移。

## 角色质量评分的平台资历（2026-11-02，本地候选）

`ranking-stats.ts` 在每日离线评分聚合中先筛选用户与角色配对资格：用户第一次向某卡发起聊天（包括失败尝试）时，首次有效聊天已满24小时且第10个有效逻辑轮次完成时间严格在先。资格只由全历史事前行为决定，不能用当前资历或本卡后续长聊追溯纳入新人首体验；注册时间不参与判断。

有效资历要求success且输入/回复非空白；同session+turn的重生成只算一次，缺session或turn的历史按id。时间取最早成功revision的不早于created_at的结算时刻，旧记录缺结算时间时近似使用created_at。分支继承引用不新增资历；消息显示编辑/删除不改变原生成事实。

一次参数化SQL复用窄字段全历史CTE，D30/R48仅聚合合格配对。既有窗口/权重/封顶/20人门槛和合格用户发起轮次（含失败占位）口径不变，R48有界回溯仅影响原新客观察，不裁剪平台资格历史。窗口有活动但无合格样本的卡输出n=0与null指标并覆盖旧分，按现有冷启动处理；不以缺样本判差卡。

复用专用连接、查询超时、advisory lock、原子落表及失败保留旧快照；job记录合格配对、零样本卡和回访观察数，无用户正文/身份日志。无schema迁移或公开API变更，未来发布后下一次成功刷新才生效。固定验收`pnpm test:lobby-ranking`执行现有单测和一次性本机PG17真实SQL；`ST_LOBBY_SCORE_BENCHMARK=1`增加40万虚构记录EXPLAIN。未运行生产重算，线上发布仍需授权与刷新结果核验。

## 前几屏优质轮换（2026-11-02，本地未发布）

鉴权recommendation批次与exposures独立于公开目录；发布后对全体用户生效，不读取旧enabled/rollout作为启用条件。24h open、显式resume、refresh CAS及30秒undo窗口。miniapp_features两表保存当前/上一批/最近3批头及曝光摘要。纯算法可靠40/头档70、实际曝光2–7天恢复/14天回流、90天可信证据；qualified-v1只由新资历job写，低样本保留旧可信，成熟新低分优先。可靠候选不足明确降级旧排序。固定命令pnpm test:lobby-ranking覆盖真实PG17权限、幂等、并发、时间与迁移重放。

## 本人创作统计（2026-11-02，本地待发布）

GET /api/creator/analytics 复用Telegram鉴权，owner只来自服务器，section选择总览/作品/奖励/反馈/选卡分页。features/creator/analytics-query.ts 参数化只读SQL，analytics-repository.ts负责只读事务、6s语句超时、签名封面与匿名评论映射。按本人拥有卡读取成功原history，排除自用/继承轮并合并revision，先取首次成功再筛日期；跨卡玩家去重，同卡深聊/回访。奖励按真实到账和实际追回各自事件时间统计，不重算40%、不改账本。私密/下架不擦掉历史统计，单卡越权404，故障503。无migration。真实SQL回归纳入原creator PG17脚本，接口权限/参数另有route回归。

### 心愿回应（本地候选）

character-wishes routes 使用服务端认证身份，repository 调 miniapp_features 的限定RPC。所有心愿只允许public，契约和DB同时拒绝private；公开结果不含作者身份。关联资格为本人公开且有有效审核版本，展示app_core.characters已发布快照。回应与notifications事务提交并business_key去重。creator publish仅在成功后附加可选关联；关联失败不改写发布成功事实，不重做审核或计费。
