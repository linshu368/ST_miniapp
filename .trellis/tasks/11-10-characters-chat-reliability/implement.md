# 执行计划（待用户审核）

## 阶段顺序

1. 审核prd/design/task与移动性能声明；收到针对最新规划的明确同意后运行task.py start。当前不写产品代码。
2. 保存受影响入口构建/测试基线；只操作本次源文件，审计目录不混进产品提交。
3. 修复ChatGuide兼容并按既有enrich调度按需加载；回归无findLast环境。
4. 改全局错误恢复为用户主动文档重载，复用安全启动身份捕获；明确401提示，验证清理URL/SDK恢复/存储禁用。不能调用脱离Router Context的导航hook。
5. 修复目录总截止与分类，复用缓存/公共head，覆盖排队超时、body挂起、外部取消和慢成功。保持排序与访问资格。
6. 先抽取历史分页读取/GET编排，保留窄投影和所有消息语义；增加单次有界只读恢复与失败阶段诊断。若无法保持8秒总读取和取消不放大，停止该项并复核设计。
7. 只实施有生产构建证据且能保持原计时起点的首屏依赖拆分；禁止关闭监控/改ready语义。
8. 增加B2：优先保证用户确认的固定正式Vercel域名被精确允许。抽取CORS注册，在既有FRONTEND_URL/Admin外增加可选FRONTEND_ALLOWED_ORIGINS并规范化合法配置根URL；保留已有合法入口与支付回跳，不擅自改生产变量。真正未授权Origin返回403且提前终止业务，复用shared失败包络。保留合法预检204、credentials、headers、method、Vary和maxAge；Timing-Allow-Origin仅匹配允许来源。来源合法性先于UA类别，正式域名的自动访问不当作非法流量降噪。
9. 扩展现有固定UI场景及隔离Fastify.inject CORS矩阵；按改动范围运行检查并修复；同步README、架构与Backend环境/跨域模块spec。完成后仅交付本地diff、结果和剩余风险，不自动commit/push/deploy。

## 回归测试必要性

这是已有生产故障修复，兼容、取消、身份、只读重试和CORS权限边界需要回归锁定。优先增加既有测试用例。若当前没有可覆盖ChatGuide兼容、错误重载、专用历史读取器或CORS注册的测试文件，允许新增最小、行为导向测试文件；不镜像实现、不引入新测试依赖。CORS用隔离Fastify实例+真实cors插件验证，不能靠buildApp启动后台job或访问数据库。

## 必须验证的失败路径

- 缺findLast、非新人/跳过引导仍不崩溃；首次聊天/流式/编辑资格不变。
- JS/chunk根错误后一次手动重载有效，无reset二次异常/自动重载环；正常reload保留session/source、身份、邀请/支付上下文。
- 原始initData来自SDK/宿主/合法启动来源，缺失、空值、存储禁用、清理后重试分别验证；凭据不入URL/日志/新持久化。
- Android2.2秒目录成功；critical槽全部占用、response.json挂起、手动取消、缓存可用/无缓存、推荐恢复与最新目录、下架校准。
- 历史首次成功只1次SELECT；超时/网络首败后成功；两次失败；外部取消；权限/SQL错误不重试；分页has_more、开场白、继承、点赞、删除/编辑、streaming陈旧恢复不变。
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
