# 执行计划（待用户审核）

## 阶段顺序

1. 审核prd/design/task与移动性能声明；收到针对最新规划的明确同意后运行task.py start。当前不写产品代码。
2. 保存受影响入口构建/测试基线；只操作本次源文件，审计目录不混进产品提交。
3. 修复ChatGuide兼容并按既有enrich调度按需加载；回归无findLast环境。
4. 改全局错误恢复为用户主动文档重载，复用安全启动身份捕获；明确401提示，验证清理URL/SDK恢复/存储禁用。不能调用脱离Router Context的导航hook。
5. 修复目录总截止与分类，复用缓存/公共head，覆盖排队超时、body挂起、外部取消和慢成功。保持排序与访问资格。
6. 先完成B3解压专项与长会话基准，再实施有证据的专用展示投影/单语句分页；抽取历史读取/GET编排，保留全部消息语义。B1只增加可识别传输瞬断的有界恢复及失败阶段诊断，不重试DB慢查询；客户端到数据库合并核对预算。若无法保持8秒总读取和取消不放大，停止该项并复核设计。
7. 只实施有生产构建证据且能保持原计时起点的首屏依赖拆分；禁止关闭监控/改ready语义。
8. 增加B2：优先保证用户确认的固定正式Vercel域名被精确允许。抽取CORS注册，在既有FRONTEND_URL/Admin外增加可选FRONTEND_ALLOWED_ORIGINS并规范化合法配置根URL；保留已有合法入口与支付回跳，不擅自改生产变量。真正未授权Origin返回403且提前终止业务，复用shared失败包络。保留合法预检204、credentials、headers、method、Vary和maxAge；Timing-Allow-Origin仅匹配允许来源。来源合法性先于UA类别，正式域名的自动访问不当作非法流量降噪。
9. 扩展现有固定UI场景及隔离Fastify.inject CORS矩阵；按改动范围运行检查并修复；同步README、架构与Backend环境/跨域模块spec。完成后仅交付本地diff、结果和剩余风险，不自动commit/push/deploy。

## B3实施顺序与门禁

**合并方案**：按[history-combined-design.md](research/history-combined-design.md)一并实施窄键分页、完整展示投影、真实原子writer复用、旧writer失效保护及回填。原只读阶段仅作基准对照，不作为可省略投影/最早页覆盖的最终版本；不采用解析存量history的同步trigger。身份字符串、有效输入分支、全链路读取及写恢复必须一起验证。

用户硬门槛为PRD R10/AC17-20：打开/交互性能不退化、完整历史零缺失、阅读体验不退化、正常回复及其他功能不回退。以下每步必须满足该约束，不以单独SQL达标替代。

1. 读取research/history-read-performance.md、数据库/跨层规范，核对真实TEST身份及与production的view/index/ACL差异。生产已读catalog不等于已验证数据量/计划。先保存既有读取行为与生成写耗时基线。
2. 在具备Docker的隔离PG17执行解压A/B：普通列、history->0、history->0/1、完整history、标量投影；固定ID/过滤/排序/页大小、强制消费表达式、控制快照大小与压缩率。先测原表再测原视图，分别归因detoast、选键/排序/overlay、序列化和网络。当前机器无Docker/psql，本轮没有该实测，不允许跳过后冒称目标通过。
3. 复用scripts/test-conversation-branches-migration.sh验证实际迁移链；仅在packages/shared/migrations/新增日期expand文件。声明experience归属、前置shape、owner/ACL/RLS。新增小表、仅失效trigger及分页RPC；修改真实begin_chat_generation_observation，在原guard接受history的分支由有效输入同事务更新投影。不重新读取存量prompt，不把uuid规范化代替旧request文本，不新增网络双写。禁止改历史文件或MCP写库。
4. 建立真实/旧版/维护writer矩阵。验证placeholder→full→初始重放、旧writer更改已有有效投影、NULL/Unicode/UUID、失败回滚及history→投影锁顺序。旧writer仅失效，新writer同事务恢复有效。回填只读锁定原行，不UPDATE history；跳过锁保留重访清单。先定真实容量与有限事务范围，再按迁移账本安排有限文件逐个执行，不把100行预算当100行一个永久文件，不用长事务循环或force_rerun绕过。
5. 新只读RPC按逻辑turn选键+最大revision→继承遮蔽→最终K+1→展示/overlay/likes；单语句快照，最早页opening也走有效投影。缺失/失效仅最终页有界fallback，已知NULL不fallback，缺migration/权限/shape错误明确失败。全历史覆盖属于本次交付，兼容态不能标完成。保持公开DTO并用shared消费者校验。
6. 10/100/1000/10000轮、多revision、prompt大小、继承/覆盖/编辑/删除矩阵验证旧新结果等价；每组>=100次记录P95、EXPLAIN ANALYZE BUFFERS、扫描/TOAST/sort及冷暖条件。SQL<=200ms、10000对100轮<=2倍、本地GET<=500ms为工程目标；不达标先调整查询形状，新增索引另附计划证据。
7. 切换展示读法；列出recover/require/finalize/context/cancel每个consumer字段，仅对无需完整快照的分支收窄列或复用同一投影。保留真实模型上下文、恢复/结算语义及原session归属、active-delivery/placeholder顺序。独立测terminal/session-stats与连接/网络，尚阻断硬指标的慢路径不能以list优化关闭。B1可重试边界不包写入或整个handler；fallback消耗同一deadline，禁止重试层叠乘。
8. 复用@chat/@roleplay的fixture与真实页面，纳入长历史连续翻页、最早页开场白、失败恢复、切会话、重生成/取消/点赞/编辑/删除后刷新场景；不新造mock后端。DB性能与Telegram真机单列，不能由UI fixture替代。
   将全部分页拼成完整有序序列，与基于事实、最大revision、继承/覆盖和权限建立的预期逐项比较，缺失/重复/截断/错归属为0。失败重试不清空内容或误报无更多；位置/草稿/键盘/流式滚动保持既有行为。追加媒体入口、后处理、会话管理、免费额度及结算的适用既有回归，不自动发起真实付费供应商调用。
   新旧版本匹配基线对照page ready/首次真实历史可见/API P50与P95，并在普通聊天、并发翻页、回填运行时对照生成准备/首个可见回复/history写P95；均不得高于旧版同口径。既有混合release指标不能作严格不退化证明。缺样本或噪声未排除标未验证，基准与适用功能未通过前不切换新读法。
9. 确认TEST再通过仓库workflow逐文件验证shape/权限/关键读写/锁/WAL/coverage及读、写两种恢复；生产另行安排。原子写兼容验证→回填核验→硬门槛通过→灰度读切换。按平台/cohort观察至少24h且>=100成功样本；确认内容、功能或性能退化即停，覆盖回退同样阻断。读故障可退Backend；新增DB维护导致写故障需执行已演练的数据库恢复并停用新读取/维护，不能只回退应用。

## 回归测试必要性

这是已有生产故障修复，兼容、取消、身份、只读重试和CORS权限边界需要回归锁定。B3涉及新DB对象、派生写一致性及分页契约，风险评估确认需要SQL权限/并发/结果等价回归和性能矩阵。优先增加既有用例/harness；无法覆盖时才新增最小专项测试/SQL fixture，不镜像实现、不引入新依赖。CORS用隔离Fastify实例+真实cors插件验证，不能靠buildApp启动后台job或访问数据库。

## 必须验证的失败路径

- 缺findLast、非新人/跳过引导仍不崩溃；首次聊天/流式/编辑资格不变。
- JS/chunk根错误后一次手动重载有效，无reset二次异常/自动重载环；正常reload保留session/source、身份、邀请/支付上下文。
- 原始initData来自SDK/宿主/合法启动来源，缺失、空值、存储禁用、清理后重试分别验证；凭据不入URL/日志/新持久化。
- Android2.2秒目录成功；critical槽全部占用、response.json挂起、手动取消、缓存可用/无缓存、推荐恢复与最新目录、下架校准。
- 历史首次成功只1次分页RPC/SELECT；可识别传输瞬断首败后成功；两次失败；外部取消；DB statement_timeout/权限/SQL错误不重试；分页has_more、开场白、继承、点赞、删除/编辑、streaming陈旧恢复不变。投影完整时无history读取，缺失仅最终页同语句fallback，version已知NULL不读旧JSON。
- B3：10至10000轮初页/深页/多revision/继承遮蔽/全页删除等价；metadata与新旧writer、placeholder、并发backfill及原写回滚；anon/authenticated/非本人/软删除失败；missing migration明确失败；回填锁超时可停止续跑，不触发原统计/奖励。发送、重生成、取消、免费额度与结算既有回归必须通过。
- 401/403不以缓存成功、不自动重放创建；聊天失败后手动重试可恢复同session。
- 若拆短剧观测静态依赖，验证watch/dramas document与click原起点及离页，不能把模块加载后的时间当起点。
- CORS：合法Frontend/Admin OPTIONS成功且响应头精确、无initData预检允许但后续无身份GET为401；非法Vercel、其他Origin、Origin:null的OPTIONS及实际POST均403且不进入handler；无Origin服务端请求、配置Admin Vercel、TEST/PR及开发不回退。缺少/非法预检头走明确4xx，不误报500。
- CORS日志与监控：预期拒绝可查且不产生500/Sentry服务器异常；真正handler异常仍500且保留{err}。日志中不含完整Origin、凭据、请求/响应正文；不把任意UA或请求header当可信流量来源或放行条件。
- 自动化目标：现有ui-tests继续隔离外网；PR预检继续对PR后端；可定位生产检查使用正式Origin。仓外Headless访问的调用方未知时明确记录限制，不声称已修复其脚本。
- 正式域名回归：精确允许的固定Vercel域名、现有Frontend别名及Admin均204，随机哈希部署域名拒绝；配置根URL含尾斜杠/空白正确规范化，凭据/path/query/hash/通配配置失败且不扩大权限。相同正式Origin下Headless和普通浏览器策略一致。现有支付回跳URL构建不回退。

## 执行命令

- pnpm --filter @miniapp/frontend test
- pnpm --filter @miniapp/backend test
- pnpm --filter @miniapp/backend test src/lib/cors.test.ts（若新增专用注册器，路径随实际实现；先跑允许/拒绝/业务不执行及日志断言）
- pnpm --filter @miniapp/shared test（若触及shared或契约消费者边界）
- bash scripts/test-conversation-branches-migration.sh（B3必须，在有Docker的隔离PG17环境；扩展真实migration和SQL/性能矩阵，不连接远端）
- pnpm lint:migrations（B3新增日期SQL后）
- pnpm -r typecheck
- pnpm --filter @miniapp/frontend lint
- pnpm --filter @miniapp/frontend build
- pnpm --filter @miniapp/admin build（跨包验证）
- pnpm lint:imports
- pnpm lint:complexity
- node scripts/complexity-budget.mjs update（仅拆分后，检查diff只收紧受影响条目）
- pnpm test:ui --grep '@chat|@roleplay|@startup'（复用3130/3131）
- pnpm test:ui --grep @drama（仅改变短剧观测依赖时）
- git diff --check；受影响文件prettier检查；不使用生产用户/供应商进行本地测试。

## 发布后真实验证

同release，Android/iOS分别观察至少24小时及>=100成功样本，不足明确低样本。区分大厅document与SPA，聊天SPA；同步看N、error/stall、目录timeout、历史恢复attempt与失败率、401和chunk错误。CORS单列合法来源204、未授权来源403、真正OPTIONS 5xx及自动化/其他类别；正确拒绝的403不计作服务端5xx，但拒绝总量不隐藏。无可见分平台预检P95基线，保持null；发布后采样实际P95，不以0代替。不能以本地fixture或请求延长后成功数量代替P95达标。真实Telegram旧Android/iOS、存储禁用、刷新/重开、系统键盘由工程师验证。发布并不在当前授权操作内；无远端写入。

B3补充：初页/深页/最早页、普通/长会话cohort分别观察page ready、客户端成功API、Backend GET及DB P95和N；缺失基线保持null。同步看缺失/失效fallback、覆盖、timeout/5xx、原子写及失效机制P95、锁/WAL和相关统计/恢复耗时。混合release服务端438.66ms与客户端成功1841ms口径不得互换。未覆盖旧数据仍处兼容态，不得声称已消除快照解压。

R10收紧停止条件：确认内容不一致、功能回退或同口径性能退化即停止切换/回填并保留或恢复旧读法；原“恶化>20%”只可作辅助告警，不能当允许20%退化。真实供应商首字性能需同provider/model分组的自然流量或另行授权验收，UI stub/本地耗时不能替代；没有证据时明确该项尚未验收。
