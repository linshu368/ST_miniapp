# 角色互动固定验收

## 范围

仅扩展既有 `packages/ui-tests/fixtures/data.ts`、`fixtures/server.ts`、`tests/roleplay.spec.ts` 与 `README.md`，保留原充值/短剧/滚动验收。

## 已纳入

- `character-social`：首卡已有收藏，点赞独立，23条评论可分页，末卡空评论。
- `character-interaction-error`：第一次点赞、收藏失败；第一次评论已成功写入但响应503，同UUID重试返回原记录。
- `/api/characters/social`批量计数和单角色social/like/comments/delete/report显式fixture，公开DTO校验，无生产兜底。
- 4条 `@roleplay @character-social @layout` 流程及1条生成期间打开评论流程，390/320两种尺寸：触区/独立计数/三处同步、评论直达分页发删举报、失败草稿重试、跨角色和私人聊天草稿隔离。

## 验证记录

- ui-tests typecheck：通过。
- `pnpm test:ui:fixtures`：4项通过；原受限环境阻止tsx本机socket，批准本地端口执行后通过。
- `pnpm test:ui --grep '@roleplay|@chat'`：18项通过，含390/320布局、360px短视口发送按钮、生成期间打开评论不打断回复。
- 全工作区 `pnpm -r typecheck`：通过（shared/backend/frontend/admin/reply-renderer/ui-tests）。
- 前端单元测试：58文件、456项通过；lint通过（保留已有img提示）；生产构建通过。
- 后端角色互动路由：11项通过；shared：17文件、180项通过。
- `scripts/test-character-social-migration.sh`：隔离Postgres通过，覆盖已有收藏、active过滤、RLS权限、独立点赞、幂等、自删、举报去重、并发限流与回滚。
- 实际检查手机截图：320px卡片三触区与390px评论面板，未横溢。
- `git diff --check`：通过。

## 边界

虚构数据只验证前端接口/状态和交互；数据库权限、并发、真实后端身份、Telegram键盘不由此证明。无提交/推送/线上写入。

## 2026-10-29 卡片减重复验

- 复用既有“点赞收藏独立，列表详情和聊天同步”流程：390px/320px两项通过，44px触区保留。
- 前端typecheck、lint、Prettier检查通过；未新增测试文件。
- 人工检查新手机截图：标签单行、数字降低对比，封面维持3:4。
- 本轮仅本地样式和零计数展示调整，未发布。
