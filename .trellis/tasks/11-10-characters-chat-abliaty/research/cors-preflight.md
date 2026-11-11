# OPTIONS 500：来源拒绝被分类为服务器故障

## 用户澄清后的修正（2026-11-10）

用户明确https://st-miniapp-frontend.vercel.app/为正式入口。17:31前后生产预检实测：该Origin为500且无Allow-Origin，app.themijing.com为204并允许，随机未配置Vercel测试来源为500。固定正式域名在原七天窗口有62条独立CORS拒绝WARN（11月4日13:58至11月10日05:59北京时间）。完整记录见formal-origin-probe.json。

因此“Vercel来源=Preview/噪声”的整体归类不成立。Headless只说明客户端类型，不说明Origin不合法。正式入口当前被拒是必须优先修复的可用性缺陷；修403只适用于真正未授权来源，不能把正式域名的500简单换成403。

当前Railway OAuth仅能读变量名，无法确定FRONTEND_URL实际值，也无法确认是漏配、旧值还是尾斜杠等精确比较问题。代码原样比较配置字符串；实施须规范化配置Origin并验证。config.frontendUrl还用于支付回跳，故不盲改其含义：在中央配置增加可选FRONTEND_ALLOWED_ORIGINS并与现有Frontend/Admin精确来源取并集，保留现有合法入口，只加入用户确认域名；生产变量变更不在本次只读检查中执行。

## 已确认事实与来源

1. packages/backend/src/app.ts:75起注册@fastify/cors，生产只接受配置Frontend/Admin Origin；开发另允许Vercel与localhost。第105-106行对其他Origin写WARN并callback(new Error('Not allowed by CORS'), false)。
2. 已检查本地安装Fastify 5.8.5 lib/error-handler.js:154-167：无4xx/5xx状态的普通Error默认500；4xx由defaultErrorHandler使用info级日志，>=500使用error。当前没有把CORS拒绝映射到403的处理。
3. 审计固定窗口：2026-11-03T08:20:05Z—2026-11-10T08:20:05Z。../11-10-characters-chat-root-cause/evidence.json记录525条5xx，其中490条OPTIONS 500；442条为HeadlessChrome、48条Mobile/Telegram。504条独立CORS拒绝WARN均来自Vercel域名。不能将504条WARN和490条OPTIONS强行一一对应或直接当同一分母。
4. 47个真实服务启动前后5分钟有437条5xx，其中436条OPTIONS。自动化访问与发布时间高度相关，但不能仅凭UA就认定具体CI或排除全部真实访问。
5. packages/ui-tests/tests/fixtures.ts与playwright.config.ts已将浏览器请求限制在本地隔离端口，不允许生产外网。没有证据将442条HeadlessChrome归咎于该本地系统。
6. .github/workflows/railway-pr-env.yml:145起以不含用户凭据的OPTIONS验证PR后端Admin代理，明确禁止生产wildcard；应保留这种环境隔离。
7. shared/src/api/envelope.ts定义已有ApiResponse/错误包络，复用现有fail能力；不要引入专有CORS JSON协议。

## 为什么有OPTIONS

浏览器页面跨域访问Railway，实际请求含X-Init-Data、Content-Type或其他非简单header时，通常先发送OPTIONS及Origin、Access-Control-Request-Method/Headers。预检不携带实际initData，只有预检允许后才发送实际请求；它不同于实际业务GET/POST的身份校验。CORS不替代认证和资源归属校验。

合法来源应拿到精确Allow-Origin等响应；未授权来源本来就应拒绝。错误在于普通Error导致500，放大服务故障指标；不能通过允许所有Vercel域名或仅忽略日志来处理。

## 规划决定

- 同一受控来源决策覆盖预检和实际方法。允许的Frontend/Admin正常204；非法Origin和Origin:null返回403且不进入业务，复用shared失败包络，无授权头。
- 不使用仅callback(null,false)就继续路由的方案，以免非法Origin实际POST仍执行；不要求OPTIONS带用户身份；不让自动化标记成为放行条件。
- 保留无Origin服务端调用、有效开发/TEST/PR行为、精确Frontend/Admin白名单、credentials、method/header允许项、Vary与预检缓存；本次新增可选精确前端Origin列表以兼容用户确认正式入口，不新增secret或production bypass，不改支付回跳目标。
- 受控结构化拒绝事件保留request链路、归一化route、method和来源/UA类别。缺少合法性判断时归为unknown；不用完整Origin/UA/部署hash做Prometheus标签，不记录header/secret/堆栈。预期403仍可统计，真实500不能被过滤。
- 可定位自动化脚本核对正式域名或正确TEST目标；已有本地隔离不重写。仓外未知Headless调用方记录为边界，不伪称已修复。
- 该状态纠正不会解决全部大厅/聊天加载问题；保留原R1-R7，CORS新增为R8/B2。

## 验证与发布

隔离Fastify实例+真实CORS插件，验证Frontend/Admin 204、非法/空值Origin403、无Origin、不带initData的OPTIONS与实际401、非法POST无写入、真实handler异常仍500、环境矩阵及日志安全。无数据库业务访问。修改HTTP状态/环境行为时同步README/ARCHITECTURE及Backend spec，跨包typecheck/build。

现有资料没有Android/iOS分别统计的预检P95，基线用null；发布后按同release、Origin类别与自动化类别观察204/403/5xx及耗时。当前仅补规划，未改产品代码、配置或部署。
