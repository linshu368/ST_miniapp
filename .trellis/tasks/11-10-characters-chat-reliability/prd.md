# 大厅与聊天入场可靠性修复

## 目标与价值

根据11-10-characters-chat-root-cause审计，修复/characters和/chat/:id已确认的渲染崩溃、错误恢复失效、目录过早超时、身份读取缺口及会话历史瞬时读取失败，减少无法打开、重复等待和白屏。用户请求本地修复；生产发布和线上效果仍需后续独立验证。

## 背景证据

来源为../11-10-characters-chat-root-cause/report.md及其evidence.json，窗口2026-11-03 16:20:05至11-10 16:20:05 Asia/Shanghai。大厅8次error/196次stall，其中183次为document；聊天22次error/84次stall，其中77次为SPA。30次error均远离Railway启动±5分钟，不能以改部署或CORS替代全部修复。用户随后确认st-miniapp-frontend.vercel.app为正式入口；11月10日17:31生产实测该Origin预检500、app.themijing.com为204，历史62条拒绝来自固定正式域名。正式入口被拒是独立真实故障，不能归作Preview噪声。

## 范围与需求

- R1 旧Android WebView不支持findLast时，聊天消息和引导仍正常渲染。
- R2 全局渲染/chunk失败提供有效的用户主动重载路径，避免反复reset进入同一个损坏路由状态；失败如实记录，重载不自动重复创建或发送消息。
- R3 大厅排队、网络、响应读取有明确的总预算。Android超过1.8秒但在合理预算内的正常响应不再提前失败；沿用已有排序/推荐/公开head/缓存语义，有数据时不中断展示，无数据时给出可恢复失败。
- R4 会话历史瞬时读取中断可在有界预算内安全恢复；最终失败保留错误UI和人工重试，不返回伪造空历史；退出不重试、不改写其他会话。
- R5 从已有Telegram SDK/宿主上下文捕获身份后再清理敏感URL；缺身份仍严格拒绝受保护操作，并给出重新从Telegram进入的提示。
- R6 减少大厅/聊天首屏无关模块静态依赖，复用已有入场阶段与预取；不改变页面可用判定、4秒阈值或把失败算成功。
- R7 使用已有Vitest与移动验收系统，覆盖正常、超时、取消、身份缺失、渲染/资源失败及重试恢复。
- R8 优先修复正式入口st-miniapp-frontend.vercel.app被CORS拒绝，再修复真正未授权Origin被误报为OPTIONS 500。已确认正式Frontend/Admin来源必须正常预检，保留现有合法别名；未授权来源明确拒绝且不执行业务。不能仅凭vercel.app后缀或Headless UA把访问归作无效噪声。

## 非目标

不新增数据库对象、索引、迁移、业务缓存服务、后台job、依赖或通用重试框架。CORS仅补充用户确认的正式域名，不开放通配或任意来源，不削弱鉴权；不更改计费、生成或用户消息语义。不升级Next主版本或修改供应商代码。不承诺未经发布复测的生产P95达标；未归因的10次聊天失败只做恢复与诊断支持，不编造统一根因。

## 验收标准

- AC1（R1）禁用Array.prototype.findLast的固定场景下，能打开聊天、看到历史并发送；不出现引导渲染异常。
- AC2（R2/R5）全局错误后点击重新加载能真正发起文档重载；保留可分享路由/会话参数；URL、日志和持久化中不新增initData；正常Telegram恢复上下文，无法恢复时明确提示重开。
- AC3（R3）Android目录延迟2.2秒但预算内成功；队列拥塞、响应体卡住和取消均有界；缓存命中不因校准失败退回白屏；推荐/最新不串顺序，不恢复已确认失效角色。
- AC4（R4）仅只读历史请求瞬时超时/网络失败最多重试一次；总读取<=8秒，首次尝试仍<=5秒；退出立即取消；权限、SQL契约、无效session等不自动重试。双失败不返回空历史、不重复建会话，不改变陈旧streaming恢复及计费。
- AC5（R5）SDK暂时不可读而宿主有合法原始字符串时可以正确带header；无身份/无效身份不旁路，401有可操作提示，不自动重试POST。
- AC6（R6）通过生产构建对比受影响入口依赖/体积，次要引导和非页面关键观测不阻塞首屏；短剧计时、路由与资源失败监控不丢起点，未证实安全的拆分不落地。
- AC7（R7）受影响既有测试、frontend/backend typecheck、lint/complexity、相关UI失败恢复场景通过；跨包执行build与pnpm -r typecheck；检查不足如实列出。
- AC8 两端发布后按同release/路由/冷启动或SPA分组核对P95、成功N、stall/error、目录timeout、历史读取重试及身份缺失；N<100不判稳态。
- AC9（R8）配置的固定正式Vercel域名、既有合法Frontend别名和Admin Origin均返回204及精确Allow-Origin、Allow-Credentials、所需Allow-Methods/Headers和Vary: Origin；配置根URL的尾斜杠/首尾空白按合法Origin规范化；维持现有预检缓存上限。OPTIONS不要求实际initData，后续受保护请求仍须鉴权。
- AC10（R8）未列入精确允许列表的Vercel部署域名、其他Origin及Origin:null返回403，采用已有shared失败包络；无Allow-Origin/Allow-Credentials授权，无业务handler/DB调用，不产生普通预期拒绝的500或Sentry服务器异常。不能按\*.vercel.app整体放行或整体拒绝。
- AC11（R8）拒绝日志为结构化事件，保留链路、method、归一化route、受控来源/UA类别；不输出完整Origin、URL查询、initData、凭据或大堆栈；真实服务5xx继续记录并告警，403/拒绝数量仍可查。
- AC12（R8）无Origin的服务端/health调用及开发、TEST/PR、Admin跨域行为不回退；测试覆盖非法来源实际POST也不执行。仓内本地验收继续隔离外网；可定位的部署验证使用正式域名或正确TEST后端，不靠放宽生产CORS让Preview通过。

## 约束

规划审核后才能start和写产品代码。本轮已确认需要回归锁定真实bug：优先扩展既有测试，现有设施无法覆盖兼容/恢复、只读重试或CORS权限边界时才新增小型测试文件。业务API外部契约默认不变；本次明确包含非法Origin由500纠正为403并复用shared失败包络，不新增业务错误协议；如需新增外部错误码或其他契约变化，先更新shared设计再重新审核范围。
