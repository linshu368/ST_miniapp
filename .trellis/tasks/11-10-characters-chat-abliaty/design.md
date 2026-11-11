# 技术设计（待审核）

> 2026-11-11按用户要求合并两方案：[history-combined-design.md](research/history-combined-design.md)为B3权威设计。一次纳入窄键分页、独立展示投影、真实原子writer复用、旧writer失效保护、有限回填及全链路验收；替代“先只读优化再决定补投影”和原“写时解析存量history的trigger”。AC14包括最早页无prompt读取，R10/AC17-20不变。当前仍仅规划。

## 1. 复用调研与当前实现

| 检索范围                                          | 现有能力与决定                                                                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGuide/chat-message-list                       | findLast在资格判断前运行；改为兼容反向查找。保留guide资格，沿用动态StoryGuideSheet，不引入polyfill依赖；引导加载放到已有enrich阶段。                                                |
| global-error.tsx/page-ready/page-tracker          | 当前全局按钮reset，存在Next恢复缓存二次异常；复用markPageFailed与归一化路由，使用用户主动硬重载，不改node_modules。根错误边界不能调用依赖Router Context的hook。                     |
| characters.ts/lobby-recommendations.ts            | 复用24h持久目录/public-head、推荐先完整head胜出、query key和一次访问冻结。最新不能降级成伪装的推荐，已确认下架不能被旧缓存重新恢复。                                                |
| timedFetch/request-concurrency/mobile-performance | 现Android1800ms在获槽后启动。改为该请求总预算覆盖队列、fetch和body；Android目标预算4000ms，iOS/other保留已有20000ms上限。本轮不新增目录自动重试放大流量；代理后端已有5000ms硬上限。 |
| use-chat-session/conversations/client             | ready依赖真实详情。沿用原query缓存和transport retry边界，不新增持久聊天缓存，不把401/403后的旧缓存当作已鉴权内容。POST创建/发送不自动重试。                                         |
| telegram/auth/init/launch-url                     | SDK读取+内存缓存与清理已有。补宿主和合法启动来源的安全回退，在清理前捕获；沿用SDK已有恢复能力，不创建initData localStorage/sessionStorage副本，不把凭据重新拼URL。                  |
| ConversationHistoryRepository.listMessages        | 已有history->0/1窄投影，不能再声称“首次改窄投影”。保留分页、继承、liked/edit/deleted字段、消息转换和owner先验；抽取专用读取/组装模块以缩小1006行文件。                              |
| conversations GET路由                             | 当前存在session/displayName、recover/opening、list三阶段日志；失败时缺细分。若触及878行route，先把GET详情编排抽到feature，保留附近@frontend-ready与现有响应。                       |
| preparation-diagnostics/Supabase client           | 已有observedSupabaseFetch，30秒兜底不是热路径预算。复用Pino/阶段诊断，不复用生成/计费的恢复器，也不另造全局retry层。                                                                |
| shared contracts/migrations                       | 现有GetConversationData及fail envelope够用，不新增公开API。B3增加专用展示投影/只读分页兼容迁移；已有索引复用，不直接改宽视图或为假设新建索引。                                      |
| UI/tests                                          | 扩展ui-tests的chat/roleplay/startup及fixture，复用client/request-timing/launch-url/仓库测试。复杂度基线只收紧本次触及条目。                                                         |

新增调研：app.ts当前用callback(new Error('Not allowed by CORS'), false)拒绝Origin；未指定statusCode。已核对安装的Fastify error-handler.js：普通错误默认500，4xx则使用info级处理。不存在必须把CORS拒绝作为5xx的框架限制。CORS注册与来源决策提取到专用小模块，app.ts保留注册；复用shared/api/envelope.ts失败包络，不建立第二份环境白名单或新依赖。详细证据见research/cors-preflight.md。

## 2. 数据与控制流

### 大厅

原排序/推荐query -> 现有并发帽与有界总预算 -> 原同源代理 -> 原数据消费 -> 原缓存/公共head降级 -> 真正内容ready。保留可信缓存的可用性，不把失败缓存清空；缺数据仍显示真实错误。把排队纳入总预算时必须保持timeout与外部abort分类，不能把超时当用户取消。

### 聊天与身份

捕获SDK/Telegram宿主可用initData -> 原清理URL -> 原受保护query/mutation。无身份不伪造本地账户或降低后端校验；只提供明确的重新进入提示。继续使用session URL定位已有会话，重载不自动触发写重试。轻量页面内容先可用，非关键引导再加载。

### 会话历史恢复

先验证session归属，保留原陈旧streaming恢复顺序 -> B3专用只读分页函数 -> 首次读取最多5秒；仅可识别的传输瞬时超时/网络瞬断可以一次短退避后再读，全部读取最多8秒；外层取消优先。DB statement_timeout、已知慢查询、权限/SQLSTATE/结构错误不重试，不能用重试代替优化。两次失败沿用原错误响应和重试UI，不用空消息掩盖错误。只对listMessages读取重试，recover/create/写事务不进入重试闭包。首次成功无额外重试等待；核对客户端和query重试，防止预算乘法放大。

### B3：长会话读取及prompt解压专项

合并后的对象归属、写入/失效、SQL边界、兼容与验证矩阵见[合并设计](research/history-combined-design.md)，为本节技术细节的权威来源。原[调研](research/history-read-performance.md)及[复核](research/history-design-review.md)保留证据，不再作为互相竞争的实施方案。本轮只更新规划。

**用户确认的硬门槛（R10/AC17-20）**：打开速度和阅读/操作体验不退化；原业务语义下完整记录零缺失；正常回复和其他既有功能兼容。SQL目标通过不能覆盖这些门槛。完整历史继续沿现有分页访问，不限制总量、不截断正文，也不一次渲染全历史。新元数据缺失不得丢消息，has_more必须来自逻辑轮次候选，不受投影覆盖或单页可见消息数量误导；加载失败不得设置has_more=false。

新旧版本按相同平台/设备/网络/冷暖缓存/数据和指标起点对照，page ready/首次真实历史可见/API的P50/P95及生成准备/首个可见回复/history写P95均不高于匹配基线；同时满足原工程目标。回填不进入首屏依赖，普通聊天、并发翻页、回填运行分别验证。按既有计时定义测量，不允许改ready、扩大deadline或牺牲内容量换取达标；缺样本只标未验证。

上线切换前先完成全部分页与权威预期序列的等价校验，再验证阅读位置/草稿/失败恢复及发送、取消、重生成、分支、编辑/删除/点赞、媒体、后处理和账务。单条新回复或业务写入因新增trigger而失败也不能以“派生数据可重建”接受。确认性能/功能退化或记录不一致即停止切换并保留/恢复旧读法，不等待恶化20%。本轮是明确验收约束，尚未证明达标。

- **事实**：现有游标默认25轮+1，production已有session/turn/revision组合索引。11月10日21:30:35会话GET 500/6104ms与Sentry 5秒listMessages AbortError匹配；总体服务端GET P95=438.66ms不能代表长会话。没有业务执行计划，不能把故障直接归因于SQL。
- **解压专项**：production history是支持TOAST的EXTENDED jsonb；PG17源码确认数组取元素先走PG_DETOAST_DATUM。对同组虚构数据分别测普通展示列、单元素、两个元素、完整快照、新标量投影，隔离JSON成本和视图/排序成本；强制使用结果、覆盖不同压缩率。当前无Docker/psql，未实测，结果不得补零或编造。
- **数据流**：owner/recover → 单语句从索引键选择该页逻辑turn及最大revision、合并冻结继承 → 仅该页读取展示正文、overlay/likes及小元数据 → 原DTO/active-delivery/placeholder。最早页开场白也由投影取得，不保留“最后一页再解压一份”的最终设计。
- **对象与写者**：新增experience.chat_history_display_metadata（history_id PK/FK、精确request_id text、完整opening_message、projection_version）、仅标记失效的小trigger/function、内部只读list_chat_message_page RPC。现有begin_chat_generation_observation在真正接受history的分支，用已有有效输入同事务写投影；不新增网络双写、不重新SELECT存量prompt。复用chat_generation_requests权威身份校验，不把uuid::text擅自替换旧展示字符串，不伪造历史observation。
- **一致性/安全**：version=1含已知NULL表示有效，version=0表示失效。旧writer UPDATE OF history只触发失效标记，不解析/比较JSON；新原子writer在更新history后同事务重建。单语句读快照；新表RLS和最小权限、分页invoker及owner校验。回填与writer统一先history后metadata锁顺序，起始最多100行/3秒语句/500ms锁；跳过锁需重访，不更新history。失效标记及upsert仍有写成本，必须测首字和WAL。
- **兼容与完成**：expand→写者验证→有限回填及覆盖核验→硬门槛验证→Backend灰度。缺失/失效仅同语句最终页有界fallback，已知NULL不fallback。缺migration/权限/结构错误直接失败。新旧可见历史与最早页均纳入本次，未覆盖范围标未完成，不留作后续整改。保留原history/旧视图；读故障可退Backend，新增DB维护导致写故障还必须执行已演练的数据库恢复，不能只退应用。
- **相关路径**：逐项审计recover/require/finalize/context/cancel实际字段消费者，只移除不需要的完整快照读取，复用同一有效投影。真正模型上下文不裁剪。独立测量整会话stats及连接/网络；若仍阻断硬指标，本次不能以list更快结项，不预先重写计费或统计状态机。
- **最小性**：复用existing索引/分页契约/PG17 harness/@chat/@roleplay；不新增缓存服务、当前版本指针、常驻job、分区/归档或大JSON覆盖索引。若计划仍扫描过多行，先调整专用键选择；新增方向索引必须有基准证明。
- **目标**：固定页/正文的10000轮SQL P95<=200ms且相对100轮<=2倍，本地GET<=500ms；移动页面与客户端API沿用<=2000ms。长会话/分平台DB与API基线未知保持NULL，分层指标不互相替代。

### 首屏依赖

先对比production构建入口依赖；优先把ChatGuide从聊天关键静态依赖移到既有enrich。PagePerfTracker当前静态引入drama-observer与大量诊断依赖，只有确认能保留短剧document/click原起点时才拆成轻量入口捕获+按需实现；不延迟页面自身计时，也不改4秒阈值。若单项无法保持原行为，保留它并记录为后续，而不是牺牲监控或短剧体验。

### CORS预检、拒绝及访问来源

用户明确的正式入口是https://st-miniapp-frontend.vercel.app/。2026-11-10 17:31实测：该Origin返回500且无Allow-Origin，app.themijing.com返回204且带精确Allow-Origin；历史固定正式域名有62条拒绝。当前连接无法读取配置值，不能断言FRONTEND_URL具体值或单独指认尾斜杠。先保证已确认的正式入口获准，之后才讨论真正未授权来源的403与日志分类。

在受保护业务handler之前使用同一来源决策处理OPTIONS和实际方法：合法Frontend/Admin精确Origin正常交给现有@fastify/cors返回204；不允许Origin返回403+既有shared失败包络，且不设置授权响应头。不能仅callback(null,false)而让带非法Origin的实际POST继续到业务代码；也不能单为OPTIONS放行所有Origin。预检本来没有实际X-Init-Data，不能把它按用户鉴权请求拒绝；实际API仍走原鉴权。

沿用现有配置读取入口和有效环境语义。现有FRONTEND_URL也用于支付回跳和Timing-Allow-Origin，不能为修CORS就盲目改写它。最小方案是在platform/config.ts增加可选FRONTEND_ALLOWED_ORIGINS（逗号分隔精确Origin，默认空），与已有FRONTEND_URL、ADMIN_PLATFORM_URL取并集；只添加用户确认的正式入口，保留现有合法来源。读取配置后用URL.origin规范化协议/主机/端口及根URL尾斜杠，拒绝通配符、凭据、非根路径、query/hash和非法URL；不对入站非法Origin做宽松修补。需要部署的公开配置差异单列，不自动修改生产变量或部署。该增量是两个已存在入口兼容所需，不是未来通用来源管理平台。

生产不启用\*.vercel.app通配；已明确配置的固定Vercel前端及Admin必须允许，其余部署域名才按未授权判断。保留无Origin服务器调用、TEST/PR与开发的必要行为，并用环境矩阵检查，不能用未批准生产bypass兜底。Timing-Allow-Origin仅对已允许且与请求匹配的Origin返回，以便两入口均能安全获得客户端网络诊断；无Origin/拒绝请求不反射任意来源。保持credentials、允许的method/header、maxAge和Vary行为，拒绝响应不得缓存成其他Origin的成功结果。

先按显式允许列表决定来源合法性，再记录受控结构化事件：request链路、method、路由模板、origin_kind（approved_frontend/approved_admin/unlisted_vercel/localhost/other/invalid等有限类别）、UA类别（automation/mobile/browser/unknown）。UA不影响允许决策，正式域名的Headless请求不能按“来源不合法”降噪。不把完整Origin或每次变化的部署域名做指标标签，不记录完整UA、URL、敏感header或错误堆栈；403计数与排查线索保留。真实未处理错误与5xx不静默过滤。若添加Sentry筛选，只能精确匹配本次预期CORS拒绝，不能全局忽略403/网络失败。

历史490条OPTIONS 500中442条为HeadlessChrome，504条CORS拒绝WARN均为Vercel域名，其中62条来自已确认正式入口。WARN与HTTP记录口径不同，不能直接相减得出其他状态数。后缀和UA只证明分布，不能证明正式流量不受影响，也不证明自动请求由仓内CI产生。现有ui-tests仅允许本地3130/3131（或手动3120/3121），Railway PR workflow预检指向PR后端，均应保持。先核对可定位脚本目标；仓外调用方无源码时记录边界。用已确认正式域名验证正式环境，用TEST/PR后端验证Preview；不把正常的正式Vercel域名改成其他未确认主入口。

## 3. 可靠性评估

- 超时：目录总预算覆盖排队/网络/body；只读历史总<=8秒，首次<=5秒，非重试错误立即失败。不得累加成两次完整5秒。
- 有限重试：只读历史最多2次，退避100–250ms；只有可识别瞬断/超时可重试，无全局HTTP500重试，无POST自动重试。
- 幂等/事务：只重试SELECT，不重放创建、陈旧状态回收、扣费、生成；B3投影加入已有原子writer事务，保留CAS/重放guard，不增加独立双写事务。
- 并发/容量：不并发竞争两次数据库读取，取消上一尝试后再读；每个请求最多增加一次SELECT；保留前端3槽帽和critical优先，无新队列/轮询。中止HTTP不保证数据库已经停止，发布看重试率/容量并设置停止条件。
- 降级：大厅复用已有合法缓存；聊天无成功数据不伪造ready，权限错误绝不展示其他用户缓存。
- 补偿：B3派生写失败随原事务回滚，沿用generation既有恢复；不补造账务或请求事实。重载前未确认的POST不能自动重放；原会话URL与已有mutation恢复语义保留。
- 限流：无新endpoint或后台预取风暴；只复用已确认用户intent/现有阶段，不为所有角色预读或预建会话。
- 可观测性：Pino {err} + request上下文/phase/attempt/elapsed/outcome/数量；不打印initData、正文、SQL业务行。Sentry/Faro失败或出口关闭不阻塞业务。
- 恢复边界：硬重载由用户点击触发，不自动循环reload；SDK原上下文恢复不可用时提示从Telegram重开，不能用URL携带secret兜底。
- 新依赖、公开API：无；数据库增量仅限B3专用投影/失效/分页、原RPC兼容修改与受控回填。失效标记及原子投影写增加成本，纳入并发、错误回滚、写P95与容量检查；不以读优化牺牲生成事实落库。
- CORS拒绝：在onRequest阶段快速失败，无外部调用/重试/业务写入，不需要事务补偿；403不能被客户端作为瞬时5xx重试。复用现有日志/HTTP指标，不增加定时任务、UA存储或高基数指标。来源允许与用户鉴权分离，均不能被自动化标记旁路。

## 4. 最小充分方案与拆分

新增运行时文件限于被验证需要的专用抽取：历史分页读取/组装、GET详情编排、轻量恢复/入口观测（仅必要时）。不为测试创造通用框架。每个新增文件<=500行、函数<=120行；触及原超长文件先抽取并在检查后收紧baseline。不改图库的大量视觉布局，不拆整套聊天页或升级框架。

## 5. 演进、兼容与恢复

B3数据库发布独立于应用，先在确认身份的TEST按仓库workflow逐文件验证expand、限额backfill、权限、新旧writer及读法，再另行安排生产；本轮没有迁移/部署授权。生产切换前必须有覆盖、锁/容量与恢复证据。读异常回退Backend并停回填；新增原子写或失效机制导致失败/变慢时，还需已演练的数据库恢复文件撤回新增维护并禁用新读取，不能只退Backend。保留原history/账务，失效投影重建验证后才能复用，详见合并设计。

新增可选的公开配置FRONTEND_ALLOWED_ORIGINS，缺省时兼容原有合法来源。业务GET/POST DTO不变；真正非法Origin的错误状态由500纠正为403，并复用既有shared失败包络。生产变更清单必须列出正式域名精确放行差异，先检查当前允许来源与支付回跳用途；不能擅自把app.themijing.com下线。先TEST/PR完成CORS矩阵，再部署兼容后端并按授权应用精确来源配置，随后前端兼容/目录/重载；由PR作者另行发布后复核正式Vercel入口、已有合法别名和Admin。若合法入口被拒、拒绝来源获得授权头/执行业务、重试率持续>5%、请求量或P95显著恶化、出现身份混淆/重复会话/短剧计时丢失，停止发布。只回退代码会恢复原先正式入口被拒的缺陷，必须优先保留正式域名放行并forward-fix；配置回退仅撤回错误增量，不撤掉已确认正式入口。

## 6. 验证与遗留

失败路径、消费者命令、真机场景与发布后观测见implement.md；B3增加PG17解压对照/执行计划及长历史UI验收。未归因10次error和Vercel chunk保留状态不冒充已根治。历史5秒链路故障的SQL/网络耗时占比仍需实测；本次不读远程业务行。规划状态保持planning，待用户对最终实施摘要明确同意。
