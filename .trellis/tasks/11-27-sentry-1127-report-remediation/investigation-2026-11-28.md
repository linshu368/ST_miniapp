# 11-28只读取证：G08/G10与前端G05

取证日期：2026-11-28，Asia/Shanghai；本轮时钟范围约00:00–00:15 +08:00。原Errors统计窗仍为[2026-11-25 15:00, 2026-11-27 15:00) +08:00，没有增加/重算Errors。

## 授权与执行范围

用户回答补证请求：“帮我连接supabase进行查询”，随后明确“只修复frontend和backend相关的错误”。本轮据此对G08/G10做限定生产只读取证，包括与原请求关联的状态投影；这项具体授权覆盖此前任务仅采集catalog的边界，不扩展为读取任意业务内容或生产写入。

产品修复继续仅针对本仓库frontend/backend相关错误；独立客服平台、Admin及数据库配置/迁移/账务补偿不执行。G05仍保留为前端渲染错误，未扩展为Renderer独立功能开发。G09不再以取得外部客服项目访问作为本仓代码交付的前置条件，外部根因只记录依赖。

先经现有Supabase连接get_project确认production ref `wbtsfzozlmurljvglhpn`、ST_telegrambot、ap-southeast-1、ACTIVE_HEALTHY、PG17.6.1.063，与仓库生产环境说明一致；未使用TEST替代。SQL全部使用BEGIN READ ONLY、SET LOCAL statement_timeout='5000ms'、COMMIT；已返回`transaction_read_only=on`。没有DDL/DML、RPC执行、EXPLAIN ANALYZE、补偿、真实生成或收费。

只输出SQLSTATE、固定SQL形状布尔、状态/时间和聚合计数；原SQL、参数、JWT/凭据、用户身份、消息正文及原始业务行均不落盘。匹配用的session/user/http request ID仅在工具内存；文档仅保留事件ID与候选编号，SQL证据使用绑定占位说明。

## G08 / ST-MINIAPP-HQ：取得25006

原本只有Prisma P2010；本次postgres_logs的parsed.sql_state_code提供数据库错误码：

- 2026-11-27 14:31:35.171 +08:00：UPDATE，query包含llm_calls、openrouter_usage、unnest的固定形状；SQLSTATE=25006，与原已知成本写入故障同秒/同SQL路径。
- 2026-11-27 14:51:33.310 +08:00：INSERT，query包含llm_cost_jobs、unnest；SQLSTATE=25006，与原补查job写入故障同秒/同SQL路径。
- 该错误码是[PostgreSQL17定义](https://www.postgresql.org/docs/17/errcodes-appendix.html)的read_only_sql_transaction。确认直接失败原因是事务处于只读状态，不能继续归因于尚未证实的缺列、缺主键、类型转换或SQL语法。

关联是生产项目+精确时间+受控SQL形状，并非取得数据库日志与Sentry事件的相同trace ID。两条路径均指向只读事务故障类，但触发只读的运维/连接/会话原因仍未查明。没有修改SQL、强制READ WRITE、自动重试写入或数据库设置。

### 故障时段与当前状态分开

扩展日志诊断窗[2026-11-27 14:00,16:00) +08:00，按sqlstate聚合返回5组（上限50）：25006共577条Postgres ERROR/FATAL/PANIC日志行，首14:27:24.817、末15:02:02.816。均含只读错误文本，disk字样匹配0；这不能证明无磁盘/平台问题，也不能确定故障恰在该首末时刻开始/结束。

另有53300日志15条（15:25:25.194–15:45:24.240），表示too_many_connections；它发生在较后时段，未与G08或G10强行合并为同根因。其余P0404/42P01/42703不是本次两条HQ的已证根因，未扩大取业务内容。

当前只读诊断连接：pg_is_in_recovery=false、default_transaction_read_only=off，设置来源configuration file；本诊断事务自身read_only=on。pg_db_role_setting中只读覆盖仅见专门reader角色，未见postgres覆盖。不能用当前可写默认值证明历史恢复时刻、某个生产应用连接可写或原批次补齐。

检索backend/shared运行时代码未见SET SESSION/default_transaction_read_only设置。creator analytics和status-bar只读查询使用现有局部transaction READ ONLY，不足以认定它们泄漏了会话状态；没有证据就不改这些路径。

### 成本任务状态投影

额外只读聚合既有call_cost/OpenRouter job（调用dispatch范围[2026-11-20 14:00,2026-11-27 15:02:03) +08:00）：返回2组，共378 job行，当前均status=unavailable；120行cost_source非空但cost_usd为空，258行二者非空。没有pending组返回。

这只是限定历史cohort的当前状态分布，不是原两个故障batch的精确成员，不是378个本窗失败，也不能断言全部成本真实补齐或资金损失；没有将NULL成本补0，也未读取/更改钱包或ledger。现有loadPending按source空、最多2000行、有界年龄和8次策略运行；本轮没有调用该任务。

backend已完成的安全SQLSTATE序列化增强仍待上线，可保留以后同类25006。原job异常仍按失败记录并释放running，未伪造成功；本次不重写有效SQL来掩盖数据库只读状态。外部状态原因需平台负责人处理，非本轮代码执行范围。

## G10 / ST-MINIAPP-H6：候选现为observed，精确关联仍不足

重读Sentry事件`d9fc274341fb4185a32979cc3aec55fe`，用其http request_id查询原生产Railway部署日志，返回8行（上限100），取得一致session和user关联。确认identity后RPC在3006ms被取消、receipt=unconfirmed/unknown、HTTP500；这些是原请求事实。

apiClient为回执HTTP尝试另生成X-Request-Id；它与原生成请求的client_request_id不同。原安全日志未记录后者，因此不能把HTTP ID直接查询成业务回执ID。

在READ ONLY事务中，按该session/user及原失败前24小时TTL范围联查experience.chat_generation_requests与chat_history；只选时间、轮次/revision、status、client_outcome/measurement、首字耗时及交付/超时布尔，不选正文/preview/身份/金额。LIMIT21返回3，范围内未触上限：

- 候选A：请求15:23:34.903 +08:00，第3轮/revision0；当前message_status=success、client_outcome=observed、client_committed_v4，首字4597.5ms。
- 候选B：请求15:21:20.353，第2轮/revision0；当前success/observed/client_committed_v4，首字4861.2ms。
- 候选C：请求15:19:47.769，第1轮/revision0；当前success/observed/client_committed_v4，首字8963.4ms。

三者均first_token_timeout=false、billing_rejected=false、requires_visible_token=true、recoverable_delivery=true、client_delivery_failed=false、有delivery_attempt。布尔billing_rejected=false不证明已收费/无重复收费；本轮未查询金额/钱包。最近候选A时序最接近，但没有故障POST中的业务request_id，不能认定原H6一定是A或已恢复，更不能把此状态当原调用当时已成功。

Supabase edge_logs在[15:23:35,15:23:48) +08:00的同RPC路径返回2行（上限100），均200，分别15:23:42.181/42.269，x_envoy_upstream_service_time为6/3ms。二者trace_id均不匹配H6 backend trace。它们可能是迟到提交、重试或其他请求，仅属时段证据，不能替代原回执的因果关联，也不能证明原3秒等待是数据库执行/锁等待。

同13秒窗Postgres错误日志未返回，PostgREST有2条含timeout/read字样的日志，缺请求关联，未取得历史锁/最终提交时间。当前状态无法还原当时锁等待；未用当前pg_stat活动代替历史。

仍保留unknown、原幂等/owner/有限恢复及计费边界；不延长期限、不假recorded、不重复发起生成。原首字专项尚未验收。

## 查询证据与完整性

统一Supabase日志工具显式传入UTC ISO start/end；query_logs仅执行SELECT。各查询分别命名：

- DB01：G08日志源枚举，[06:31:20,06:52:00)Z；6个source，postgres368行。它们不是Errors。
- DB02：同窗PG ERROR投影初查LIMIT100返100，标部分；不拿初查样本作总数。后续按sqlstate/command/target聚合LIMIT100返7组，合计356 ERROR行，范围内完整；UPDATE/INSERT精确小窗各返2/3行。
- DB03：PG异常扩展窗[06:00,08:00)Z，sqlstate聚合LIMIT50返5组；25006的577日志行只用于故障形态/时段说明，不加进46 Errors/13 Issues/16用户。参数变更文本查询返空，不作为未发生设置变化的证明。
- DB04：H6 Railway，[07:23:30,07:23:50)Z，字段request_id过滤，8/100行；生产部署和release与原报告相同。
- DB05：同session/user回执投影，request_received_at范围[11-25 07:23:38,11-26 07:23:43)Z，3/21行；只说明过滤范围内完整，原HTTP与业务ID映射缺失。
- DB06：H6 edge路径精确过滤，[07:23:35,07:23:48)Z，2/100行；trace比较失败，未建立原请求对应。PostgREST两条timeout不直接归因。
- DB07：当前catalog/read-only设置及受限成本job聚合，所有业务SQL在只读事务、5秒statement_timeout下执行。health advisors返回空列表，只代表当前工具结果，不反推历史健康。

工具失败：日志DESCRIBE被服务端拒绝；message列不存在，改用已验证的event_message做布尔投影；含多项pg_stat诊断/部分edge投影曾返回工具internal error，不能当空结果或缺陷证据。已改为最小字段查询并取得上文成功结果。未对失败工具结果补0。

全部查询结果仅作诊断，不替代故障原始业务分母/去重失败数。原始日志、SQL参数、业务ID和完整行未提交；报告只保存上述脱敏事实。

## 00:21追加：G05实际Worker资源与编译入口

原窗事件e2c426960e214e9b8932ae5da51c6a4b（11-25 20:31:50.398 +08:00，c046f213）和窗后事件e549b9ad87614becb1620cba22ff2074（11-27 23:06:48.662，47896386）均指向入口7478.63191147eb2e0d33.js及其importScripts依赖4445.deea437c2a1dec2c.js。分别记录Telegram13.3.0/13.3.1、Android16/17；未取得实际WebView引擎版本。窗后样本不加进原3条Errors。

2026-11-28约00:20 +08:00，只读GET原异常精确公开资源：

- [原Worker入口](https://app.themijing.com/_next/static/chunks/7478.63191147eb2e0d33.js)：HTTP200，40048字节，SHA256 b8a17207c43c26996b01c451a809c793792975df25af40fbcadd43ab1d171421。
- [原依赖块](https://app.themijing.com/_next/static/chunks/4445.deea437c2a1dec2c.js)：HTTP200，58171字节，SHA256 4974fde7266c57ea6750d36e3194797c6bb798a1481433411a61507a835ddb81；application/javascript，public/max-age31536000/immutable，Vercel HIT，Age8949秒。

本地既有build是不同hash的4445.888271eb431ad05d.js，不能拿它证明旧资源正常。按原入口/依赖字节做隔离Node24 vm加载诊断：仅提供Worker所需全局、postMessage捕获和预取依赖的importScripts；不启动浏览器、不渲染UI、不执行用户artifact/生成。实际只导入上述4445块，发出一次ready，建立onmessage处理器。脚本上下文无Node I/O/网络能力，单段限制2秒；源资源经PythonHTTPS默认验证读取，Node仅消费内存内容。

结论仅为当前旧资源可获取、Node环境能完成装配；不证明故障当时HTTP/MIME/CDN/网络正常，也不替代Android/WebView或同次原文fallback结果。未复现可直接修改的错误URL/缺失模块，不重做已有启动预算、代际释放和完整原文保护；没有新增产品代码或测试文件。

第一次Node直接fetch因本机ECONNRESET失败，未取得资源，未拿作生产故障证据；随后PythonHTTPS和无网络Node装配成功。该模块加载诊断没有preview/Playwright或UI验收。

两条Sentry帧中的部署ID及正式域名向当前Vercel连接get_deployment均返回404；可见团队此前仅infra-docs，无法区分无访问与目标记录不可用。本机没有Vercel CLI、VERCEL_TOKEN/项目环境标识或所查标准auth文件，不能借用不存在的本地身份；未安装CLI、登录、改连接或部署。

已请求用户提供/切换能访问st-miniapp-frontend的连接或team/project信息，仅用于前端日志，不恢复外部客服平台的访问前置条件。缺历史资源请求事实前，G05仍未修复，原文绕行和业务阻塞未验证，不能因现在200或Node ready判低影响/可暂缓。

## 后续代码与报告

### 01:50追加：用户停止继续修复，转为核查、说明与提交

用户明确不访问Vercel，因此撤回原连接请求，不再将前端项目访问列为本次交付前置条件；随后要求先不修复、按现有内容生成说明，并在确认现有改动后commit。本轮没有Vercel调用或新增产品修改，保留完整未完成映射。审查G03/G13时未发现可证明原React递归反馈的新边；现有history/streaming裁剪及偏好ref检查不支持追加推测性修复。

重读G05原事件e2c426960e214e9b8932ae5da51c6a4b及其breadcrumbs：异常明确为原4445依赖importScripts加载失败；breadcrumbs工具返回100条，达到上限，标部分。唯一后处理相关HTTP为版本接口200，没有故障chunk请求状态或错误之后的fallback结果，不能据此宣称原故障恢复。无新统计、无身份或正文保存；只作旧事件诊断，不扩大46条Errors窗口。

现有改动的说明、适用非UI检查及提交边界见新生成的修复说明；完整修复工作按用户要求停止，历史blocked记录保留时间顺序，不再追索Vercel访问。

### 00:25补充：剩余证据缺口复核

2026-11-28 00:25 +08:00，现有Vercel连接仍只返回wanghangchengs-projects团队；没有取得前端项目的新访问。重新读取F4当前详情，最新事件仍为36e8b7c551794dd7b4f6f844b163c8c8（11-27 01:08:06.595 +08:00），没有新增因果定位；工具中的生命周期7次/6用户仅供当前详情核对，未用于改写原窗统计。没有活跃的vitest、Next build或Playwright作业需要等待。

恢复后的连续取证轮次已分别完成Supabase事实补充、G05原资源装配诊断和本次访问/事件复核，剩余同一类运行事实与前端项目访问缺口仍在。当前可用静态来源和只读结果不足以支持剩余根因修改，目标记录为blocked，任务目录仍保持in_progress，全部未完成映射保留。解除条件为取得可访问app.themijing.com对应项目的连接及相关历史请求证据，或补齐能直接支持对应修改的宿主/反馈组件/Promise所有者/精确回执事实。G08的25006已取得，不再请求SQLSTATE；外部客服平台访问不属于本轮阻塞条件。

本次没有新增产品补丁或重复运行已通过检查。补证复查仍为11-28 12:00 +08:00；不将等待补证解释为可暂缓、已恢复或已验收。

本轮仅取证和文档，未新增产品代码、未再跑UI/测试/build、未提交/发布、未改Issue状态。此前frontend1007/backend2162/shared422/renderer35单测及相关typecheck/lint/build证据仍只覆盖此前局部改动。

更新错误报告为同窗v2，按当前实际汇报日保存修复报告\_2026-11-28_production_v1.md；均保留旧版。G08从“SQLSTATE未知”更正为“25006只读写失败；触发只读原因未知”，G10保留精确回执未闭环。G09外部访问不再阻塞本轮frontend/backend范围，外部只记录影响；其他未确认根因仍不得宣称已修复。
