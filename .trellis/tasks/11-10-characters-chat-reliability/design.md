# 技术设计（待审核）

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
| shared contracts/migrations                       | 现有GetConversationData及fail envelope够用，不新增API/DB函数。未获运行证据，不新建索引或改session_chat_history视图。                                                                |
| UI/tests                                          | 扩展ui-tests的chat/roleplay/startup及fixture，复用client/request-timing/launch-url/仓库测试。复杂度基线只收紧本次触及条目。                                                         |

## 2. 数据与控制流

### 大厅

原排序/推荐query -> 现有并发帽与有界总预算 -> 原同源代理 -> 原数据消费 -> 原缓存/公共head降级 -> 真正内容ready。保留可信缓存的可用性，不把失败缓存清空；缺数据仍显示真实错误。把排队纳入总预算时必须保持timeout与外部abort分类，不能把超时当用户取消。

### 聊天与身份

捕获SDK/Telegram宿主可用initData -> 原清理URL -> 原受保护query/mutation。无身份不伪造本地账户或降低后端校验；只提供明确的重新进入提示。继续使用session URL定位已有会话，重载不自动触发写重试。轻量页面内容先可用，非关键引导再加载。

### 会话历史恢复

先验证session归属，保留原陈旧streaming恢复顺序 -> 专用只读分页函数 -> 首次读取最多5秒；仅传输超时/网络瞬断可以一次短退避后再读，全部读取最多8秒；外层取消优先。权限/SQLSTATE/结构错误不重试。两次失败沿用原错误响应和重试UI，不用空消息掩盖错误。只对listMessages读取重试，recover/create/写事务不进入重试闭包。首次就成功的请求无额外等待和数据库调用。

### 首屏依赖

先对比production构建入口依赖；优先把ChatGuide从聊天关键静态依赖移到既有enrich。PagePerfTracker当前静态引入drama-observer与大量诊断依赖，只有确认能保留短剧document/click原起点时才拆成轻量入口捕获+按需实现；不延迟页面自身计时，也不改4秒阈值。若单项无法保持原行为，保留它并记录为后续，而不是牺牲监控或短剧体验。

## 3. 可靠性评估

- 超时：目录总预算覆盖排队/网络/body；只读历史总<=8秒，首次<=5秒，非重试错误立即失败。不得累加成两次完整5秒。
- 有限重试：只读历史最多2次，退避100–250ms；只有可识别瞬断/超时可重试，无全局HTTP500重试，无POST自动重试。
- 幂等/事务：只重试SELECT，不重放创建、陈旧状态回收、扣费、生成；现有事务和CAS不变，不新增事务。
- 并发/容量：不并发竞争两次数据库读取，取消上一尝试后再读；每个请求最多增加一次SELECT；保留前端3槽帽和critical优先，无新队列/轮询。中止HTTP不保证数据库已经停止，发布看重试率/容量并设置停止条件。
- 降级：大厅复用已有合法缓存；聊天无成功数据不伪造ready，权限错误绝不展示其他用户缓存。
- 补偿：无新增写流程无需补偿。重载前未确认的POST不能自动重放；原会话URL与已有mutation恢复语义保留。
- 限流：无新endpoint或后台预取风暴；只复用已确认用户intent/现有阶段，不为所有角色预读或预建会话。
- 可观测性：Pino {err} + request上下文/phase/attempt/elapsed/outcome/数量；不打印initData、正文、SQL业务行。Sentry/Faro失败或出口关闭不阻塞业务。
- 恢复边界：硬重载由用户点击触发，不自动循环reload；SDK原上下文恢复不可用时提示从Telegram重开，不能用URL携带secret兜底。
- 新依赖、公开API、数据库函数：无；严格未知项不先泛化。

## 4. 最小充分方案与拆分

新增运行时文件限于被验证需要的专用抽取：历史分页读取/组装、GET详情编排、轻量恢复/入口观测（仅必要时）。不为测试创造通用框架。每个新增文件<=500行、函数<=120行；触及原超长文件先抽取并在检查后收紧baseline。不改图库的大量视觉布局，不拆整套聊天页或升级框架。

## 5. 演进、兼容与恢复

无数据库迁移和新增环境变量。兼容旧前后端：不改变GET/POST DTO及错误包络；前端先后部署均能工作。推荐顺序、角色访问权限、点赞/编辑/继承和streaming恢复须保留。发布建议先backend只读恢复，再frontend兼容/目录/重载；由PR作者在另行发布后观察。若重试率持续>5%、请求量或P95显著恶化、出现身份混淆/重复会话/短剧计时丢失，停止发布并回退本次应用代码。无DB回滚，不回滚业务事实。灰度以现有Preview/TEST验证，不新增feature flag框架。

## 6. 验证与遗留

失败路径、消费者命令、真机场景与发布后观测见implement.md。未归因10次error和Vercel chunk保留状态不冒充已根治。历史5秒链路故障的具体SQL/网络根因仍需发布诊断；本次不读远程业务行。规划状态保持planning，待用户对最终摘要明确同意。
