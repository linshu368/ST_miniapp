# 证据、上游与重复修复核对

核查日期：2026-11-24，Asia/Shanghai。只保存脱敏事实，未保存用户ID、消息、原始breadcrumb、请求参数或错误局部变量。

## 代码基线与已有工作

- 工作区分支fix_request_speed，HEAD `448a092fb4adb69b58e51285c7aa2018ed0d2714`；开始时已有未跟踪错误报告。期间prompts.md出现其他修改，不纳入本任务。
- 只读fetch更新远端引用；未merge/rebase/cherry-pick。origin/main=`dd76026457db30f2fa207ede86d666b4136d0015`（#1114），origin/dev=`7de9de31fc646ca4e4806c27e0e01e8644784a5d`（#1113）。后续实施从origin/dev创建隔离分支，不能在旧feature上覆盖新上游。
- 已检查HEAD到origin/main/dev的相关文件diff：first-token-reports、Telegram init、Worker scheduler、cover viewer没有新的对应修复；上游GenerationObservationRepository增加钱包拒绝类型和prompt快照，必须保留，不能整文件覆盖。
- `58e622ee97337653e5e2582c3a975901e92fd15e`（生产#1109）已取得实际对象；`2c2c1b979666febed8c21971b7ec75eb20108490`为#1092分支状态继承，并非G5修复。
- `bd09632c`（#1045）/ `792ab4c5`只处理会话详情离页分类及旧WebView UUID；不能把这些已上线修复再做一遍或声称解决G3全局Fetch取消。
- 既有任务：11-19-cold-start-round2、11-19-creator-editor-performance、11-19-conversation-read-reliability均review；11-02-first-token-delivery-repair为in_progress；登记cline/claude是历史agent信息，不代表人类已接受分派。本协调任务不改写其原验收或擅自关闭。

## G1：确认SDK接收器生命周期，未确认线上触发时点

- Sentry ST-MINIAPP-2最新仍为2026-11-24 10:18:23 +08，global code app:///:1:25；无可定位业务调用、无身份和breadcrumb。初始化前/清理后/宿主版本原因尚未区分。
- 现行`lib/telegram/init.ts`在isTMA/init之前把inited置true，异常后后续调用无法重试，这是确定的代码缺陷，但不能直接说是33个线上事件的根因。
- `lib/perf/early-startup.ts`可在HTML阶段向原生发送ready，SDK在Providers effect初始化；存在待核时序窗口。不得因此先删early-ready、加入空receiveEvent或复制一套原生消息桥。
- 安装依赖@telegram-apps/bridge 2.11.0的dist/index.js:33–67为订阅计数和清理；:203–225安装/卸载TelegramGameProxy.receiveEvent。接收器由真实SDK维护，不能与已退役ST bridge混淆。
- 已核初始化相关commit `1e45cba153007c66a5cc5c9b71102ae935053c82`；它早显shell/延迟tracing，不能当G1已修复。
- 本轮最小补强：成功后才置初始化成功，有界允许下一次调用重试，失败仅记安全枚举。线上根因继续待真机/同次启动证据。

## G2：未定位，禁止猜改或全局过滤

- ST-MINIAPP-6D最新2026-11-24 10:42:56；栈仅characters:0:0。12事件/6个已识别用户来自原窗口快照，不是12次独立大厅失败。
- gallery.tsx:558–600已使用RAF调度滚动对齐；cover-viewer.tsx:113–120直接observer→move→setView，但固定stage并不证明它形成尺寸反馈。其他observer位于聊天/剧场/影像，不因路由名字盲目合并。
- 相关gallery历史commit `09258916eba651940fe8273cbda18839287cde31`、`a262a4fa0d9420b056f34a7f7acdd6b211dcd87f`未提供此Issue根因证明。
- 要求先用已有@roleplay场景及真实Android重现滚动返回/封面缩放/尺寸变化。找不到触发点时本组保持待核实，不扩大重构。

## G3：取消链有线索，不能等同业务安全

- ST-MINIAPP-7Z两条窗口事件均有removeObserver/cancel/onCancel/abort栈；最新10:18:59.932，导航到创建角色后约27ms。相关6个chunk源码映射未应用。
- 安装的@tanstack/query-core 5.99.2的query.ts/retryer.ts中，removeObserver取消已有retryer并abort当前signal；这能解释栈形状，不能证明哪个query、哪个业务结果。
- request-timing.ts已经用Promise.race包fetch与body并清理listener，主动取消也不报该层请求失败；API client仍对所有非ApiClientError记录api.request_failed(0)。后者是确定的分类缺陷，不是全局unhandledrejection根因已确认。
- `7f8df915d1ac409b814d3b4cba26307b80207d2d`的实际代码已在当前分支；对应总预算/取消保护不重复增加。
- 计划仅对“当前调用signal取消原因与抛出错误匹配”的路径复用现有取消观测，真实HTTP/独立SDK期限/非同因错误不降级。补充真实QueryObserver取消与body迟到拒绝测试；无法复现全局拒绝则保留Issue待核实。

## G4：资源当前可达，已有降级；局部idle错误状态缺陷

- ST-MINIAPP-34事件发生11月23日15:10:52，Worker importScripts依赖加载失败。压缩7478帧无debug ID，不能仅凭它证明为当前reply-renderer Worker。
- 2026-11-24 11:51左右只读HEAD检查4445.deea437c2a1dec2c.js：HTTP200、application/javascript、public,max-age=31536000,immutable。只证明检查时可达，不证明故障时响应或原操作已恢复；无依据要求清CDN/延长旧资源保留。
- worker-scheduler.ts:141–201已有构造失败原文fallback、5秒ready预算、执行超时与串行队列；:226–229 onerror在!active时直接return，保留可能失效的worker缓存。后一处是可由局部生命周期测试锁定的缺陷。
- 保留现有安全原文渲染；不加全局preventDefault或关闭Sentry上报，不自动刷新、不加无界重试。
- 既有恢复commit `5c7632267a0a55c9678974ca0ee751b254dd1dfe`已存在。此次只补空闲错误后的销毁/下个任务重建和失败路径验证，不再造fallback框架。

## G5：确定预算错位，底层数据库等待仍未知

- 原报告已用同request关联生产operation.terminal：Supabase约3001ms取消、HTTP约3014ms 500，release2c；不能按正常客户端离页过滤。
- 当前和origin/main均注册POST /api/v1/conversations/:id/first-token，Providers恢复及use-conversation-turn仍是consumer；report_chat_first_token仍被repository调用。此入口没有退役。
- registry标记chat_generation_requests为billing_input；最新6b收缩删除角色免费额度等旧逻辑，并未允许删除回执。不能重放旧迁移或把旧“释放免费额度”说明当现状。
- first-token-reports.ts:95–124客户端timer从请求前开始计3秒；Backend先身份读取（已有5秒上限/共享singleflight），RPC再3秒，因此排队/身份/RPC预算错位已确认。
- 最小应用补强复用apiClient总预算10秒，不加server RPC期限或数据库重试；HTTP失败保留原因和receipt，真实recorded=true才确认。最多4次/20条/24小时/owner隔离保持。
- 这解决客户端过早终止与后续可诊断性，不证明已解决数据库3秒等待。若仍失败，需后续经目标核验的结构/锁证据，另规划数据库或业务变更。本次不查业务行、不执行迁移。
