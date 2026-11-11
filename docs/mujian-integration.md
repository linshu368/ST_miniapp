# 幕间短剧与两段归因（本地实现，未发布）

幕间复用 `/api/dramas`、`/api/dramas/:id`、`POST /api/dramas/play`，本期直接免费观看。
短剧路由只验 Telegram 签名，不调用会写 `miniapp_entered_at` 的通用用户读取，因而不会把观看幕间算作进入秘境。
播放器及弹窗在独立静态仓库；本仓库负责身份、进入事实、CORS 和本地验收。

## 数据所有权与口径

`miniapp_traffic.app_entry_facts` 保存渠道进入过程，属于归因域；不是用户根身份或统计报表。
Backend 的 `record_app_entry` 事务是唯一业务写入方，接口返回确认会读取它。
生命周期随漏斗存在，默认不清理、不设置归因过期窗口；账号删除按现有用户删除策略级联。
唯一键 `(user_id, surface, source_key)` 去重，空 source_key 表示自然来源。启动时间来自已验签的 Telegram `auth_date`，接收时间由数据库记录。重试只补更早的启动时间，不覆盖已固定资格。

同一 Telegram ID 使用 `app_core.users.tg_id` 唯一约束关联；事务内创建时明确 `miniapp_entered_at=NULL`，仅秘境进入写标记。
使用事务内同等 get-or-create 语义是为了将新建账号证据、资格快照和首次来源计数原子提交，避免分两次请求丢失“本次新建”依据。
`source_id` 仅在为空且渠道已登记时写入，原首次来源不覆盖；原渠道 `increment_click` 保持一次并与来源写入同事务。

首次幕间进入固定资格：

- `existing`：真实秘境首次进入或历史 chat_history 的时间早于幕间启动。
- `new`：本事务创建且无此前使用；或已有 Bot 账号无秘境进入/使用；或可证明首次秘境标记晚于签名启动。
- `unknown`：历史无法证明、累计轮次与时间无法确定、或同秒边界无法确定。不计新增。

依据快照仅存上述标记、累计轮次、首条历史时间和规则版本，不存正文、Telegram 资料、initData 或媒体地址。
首次资格跨后续请求复用，随后进入秘境不改判为老用户。若迟到的验签事实证明秘境进入实际发生在首次幕间之前，则保留初次判定快照并补记历史证据、排除该历史老用户；这不把后续使用误判为历史使用。
两个接口均使用真实签名校验，忽略 body 用户 ID / source_id；新漏斗即使在本地 bypass 环境也不会跳过验签。
普通浏览器无合法身份时幕间只提供 Telegram 打开入口。

转化必须有同账号、同来源的幕间资格与首次秘境事实，且秘境启动晚于幕间；直接进秘境、仅点击链接、跳转失败或自然来源不计此渠道转化。
乱序到达按签名启动时间重建；秘境先到会保存进入前的资格快照，后到的幕间可以复用它。
若迟到的更早秘境事实证明首次渠道不同，重新计算转化，不改变幕间资格。
Telegram 时间精度为秒：同秒只在幕间先成功落库时确认顺序；同秒逆序缺乏可靠顺序证据，保守不计转化。
不采用前端任意时间戳补证，也不设归因窗口。

查询定义（只作为后续经授权统计使用，本次未查线上用户）：

```sql
SELECT source_key,
 count(DISTINCT user_id) FILTER (WHERE eligibility='new') AS mujian_new,
 count(DISTINCT user_id) FILTER (WHERE eligibility='new' AND converted_at IS NOT NULL) AS mijing_converted
FROM miniapp_traffic.app_entry_facts
WHERE surface='mujian' AND source_key='mujian_dzmm'
GROUP BY source_key;
```

转化率是第二项除第一项，分母为零时不计算。事实表不是统计后台。

## 迁移、边界与恢复

唯一迁移：`packages/shared/migrations/20261111_mujian_entry_funnel.sql`，新增表/函数并登记 `mujian_dzmm`。
跨 schema 依赖：users 外键/身份/首次来源和进入标记，chat_history 只读历史证据，botlinks 与 increment_click 渠道资产/兼容计数。
无业务回填；用户级 advisory lock + 行锁 + 唯一约束处理重复并发。请求事务有 2 秒锁等待、5 秒 SQL、8 秒事务上限。
新表启用 RLS，anon/authenticated/PUBLIC 无表权限或函数执行权；service_role 有必要读写，函数使用 SECURITY INVOKER。
DDL 锁超时 5 秒、语句上限 30 秒；执行前核验目标结构和角色权限。迁移仅由既有单文件工作流发布，不随应用自动执行。

发布顺序：先 TEST 结构核验和迁移验收，再经授权生产迁移 → Backend → 秘境 Frontend 与幕间。
`Database Migration` 工作流仅在 TEST apply 后运行与迁移同名的 `migrations/tests/*.sql`。
幕间断言在事务内创建保留编号的虚构账号，检查新/老/未知资格、来源、乱序、去重及转化后全部回滚，并确认没有残留；生产不会运行这些断言。
回退应用时保留事实表与渠道，不删除已收集数据；归因偏差做可审计 forward-fix。
跨域仅增准确幕间域名 `https://short-drama-demo-sigma.vercel.app`，生产不允许其他 Vercel 来源；原秘境/Admin 来源保留。
发布前同步现有 dev/main 后，复用已有 lib/cors.ts，仅追加精确幕间来源；不保留平行 CORS 实现。

## 本地验证与体验

```sh
pnpm -r typecheck
pnpm --filter @miniapp/shared test
# 不可连接的本机占位地址用于现有单元测试初始化；不加载线上配置。
DATABASE_URL=postgresql://127.0.0.1:1/mujian_unit NODE_ENV=test pnpm --filter @miniapp/backend test
bash scripts/test-mujian-entry-local.sh
pnpm --filter @miniapp/ui-tests exec playwright test -c playwright.mujian.config.ts
pnpm --filter @miniapp/frontend build
```

本地 PostgreSQL 脚本仅启动临时目录/Unix socket，结束后清除自己的临时实例；不读取环境凭据、不开公网端口。
UI 验收复用 `packages/ui-tests/fixtures/data.ts` 和 `drama-preview.mp4`；`mujian-hls` 是该虚构素材的 HLS 转封装。
`playwright.mujian.config.ts` 默认从同级 `mujian-drama-site` 提供静态页面，可用 `MUJIAN_SITE_DIR` 指向其他本地位置。
加 `--ui` 可逐项体验回归；测试身份、视频和 API 均为本地模拟，不连接生产。
直接运行幕间 README 的 HTTP 服务可查看正常无身份状态；真实目录/播放需要合法 Telegram 环境。
正式计时始终 120 秒与 30–90 / 180–270 秒，测试只加速浏览器时钟。

## 本次结果（2026-11-11，仅本地）

- 全部包 typecheck、shared 233 项、backend 全量 1560 项、frontend 758 项通过；后续 CORS 提取的相关 28 项通过。
- 浏览器 8 项通过：目录/选集/真实 ID 片单、暂停续播、两种随机区间、刷新/翻页去重、自然来源、无身份入口、三次失败收口、HLS.js 与过期取址恢复。使用虚构素材。
- 隔离 PostgreSQL 的新/老/未知资格、资格固定、同账号去重、反序上报（含普通秘境接口抢先创建账号）、迟到的其他首次渠道、原来源保留、自然入口、权限/RLS和并发重复进入均通过。
- Frontend/Admin 构建、imports lint、complexity 与迁移命名检查通过。构建保留原有依赖版本/打包体积提示，本期不处理性能优化。
- 原 ST_miniAPP 工作区的未提交状态与开工时一致；所有秘境侧改动仅在独立工作区。未创建 Trellis 任务、未提交或推送。

## 尚未验证

本次无部署、线上迁移、账号/归因生产写入、BotFather 操作或提交推送。
Supabase 连接工具请求失败，当前线上结构、155 个视频的现状及渠道登记状态未重新核验；仓库已支持数据库 Cloudflare Stream 视频，不等于实时线上已验证。
真实链路仍需隔离 TEST 后端/内容、当前结构核验、合法 Telegram 启动上下文、可达 HTTPS 联调入口及 Cloudflare 有效签发配置。
尚缺 Telegram iOS/Android 真机播放、原生 HLS、有效签名的实际跨域预检/媒体分片及真实两端落库闭环证据。
本地样本通过不能替代这些验收。

## 发布前复核

2026-11-11：已只读确认 TEST 与生产 users/botlinks/chat_history 结构。生产仍保留可空历史初始化标记，TEST 已删除；通过 `to_jsonb` 可选读取，只作为历史使用证据，不恢复旧身份映射。对应迁移与本地断言加入精确 legacy guard 例外。上游已拆分的 conversation-history-billing.ts 同时登记为原 Repository 的委托文件，修复继承的门禁遗漏，无业务逻辑修改。
