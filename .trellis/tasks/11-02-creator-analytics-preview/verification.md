# 本地验证 — 2026-11-02

## 已落地范围

- 本人真实只读GET接口、shared runtime契约、前端React Query与正式路由接线；非preview环境也有入口。
- 入口轻度提亮；首页作品/奖励/反馈各3条；全部服务端4条分页、选卡8条；保留作品来源页码/位置。期间没有评论用期间空态，长反馈首页最多3行。
- 生产组件无虚构统计源；固定示例移入UI fixture，通过同一HTTP契约展示。3180/3181只用于本地演示，页面明确示例数据。

## 结果

- 跨包 `pnpm -r typecheck` 通过（shared/backend/frontend/admin/reply-renderer/ui-tests）。
- Frontend生产build通过。选中root lint通过，frontend lint零错误，1条既有img优化建议。
- shared全部测试231通过，frontend全部测试720通过，creator analytics与原creator路由37通过，fixture server7通过。
- `ST_UI_TEST_APP_PORT=3190 pnpm test:ui --grep @creator-data`：390/320共4项通过，30.3秒；覆盖首页3条且无分页、三类全部列表翻页、首尾状态、关闭重开及单卡返回原页、多卡/周期/排序、空态及503重试。截图人工复核无横向溢出。
- 完整 `CREATOR_TEST_CONTAINER=st-creator-integration-test-20261030 bash scripts/test-creator-characters-local.sh` 通过：原creator迁移/权限/版本验收 + 新增真实Postgres统计5项场景。container=postgres17/network=none，无网络端口。实际Prisma.Sql经PREPARE/EXECUTE执行，不复制第二份查询。
- SQL验证包含自用排除、跨卡玩家去重、同卡深聊/回访、成功revision最早时间、分支引用及继承轮重生成排除、实际新分支轮计入、私密/停用/会话软删历史保留、真实到账/抵扣/退款当期净负数、删除评论、自身评论排除、外作者隔离和所有列表分页。
- `git diff --check`、Trellis模块声明/载荷校验通过。

## 范围与待发布验证

无新增DB对象/迁移，无账务写入，无生产业务查询；本地PG小样本证明逻辑与真实DDL兼容，不代表生产数据容量验证。真实发布前仍需确认目标环境权限/部署顺序并用作者身份检查数据。此轮未stage/commit/push/deploy。

3180手动预览已更新并在右侧打开；自动验收使用3190，未结束其他窗口3130/3170服务。此前未提交作者署名修改保留。

## 排序交互修正（同日用户反馈）

原生select在内嵌浏览器弹出样式不协调；sort切换触发overview缺数据分支，整页高度骤减。改为既有Sheet三项选择，当前项勾选，原位置轻量加载；仅同一用户/角色/周期/as_of内的排序请求沿用上一份overview，不跨范围保留数据。复用creator.spec补充排序面板、三种顺序、受控延迟期间总览不消失且scrollY偏移<4px。390/320共4项通过（31.0秒），Frontend与UI-tests类型检查、定向lint零错误；仅原img优化建议。右侧当前预览实点选择也已验证。未发布。

## 发布候选复验（2026-11-02）

最新origin/dev=d1789e3b隔离候选，保留其大厅推荐轮换；作者署名仍留原目录。Shared 233、Backend 1246、Frontend 732全部通过；全包typecheck、lint/import/legacy/migration guards及Frontend/Admin生产构建通过。真实本地PG17创作核心及analytics 5项通过。390/320创作数据4项和既有创作闭环2项通过。独立只读审查无阻塞。

已通过Supabase MCP只读结构核对生产wbtsfzozlmurljvglhpn的9张依赖表，所需字段无缺失；未读生产业务行、未迁移、未改资金。MCP连接权限不代替应用运行身份验收。Railway及Vercel生产基线均为05e1982a，部署仍跟main。

发布顺序：feature合dev；从届时最新main只携带本功能提交，主分支发布diff须无其他dev功能。核验Railway部署成功和新接口鉴权401，再确认Frontend生产ready及页面200。真实作者会话统计与双端P95需在线可用身份/足够样本，不虚称已测。

最初隔离合并fixture时脚本截断已在提交前修复，完整类型及移动用例随后通过。代码产品行为未增加额外功能。
