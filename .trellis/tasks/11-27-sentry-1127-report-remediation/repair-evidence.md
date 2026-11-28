# 11-27错误报告修复证据（本地候选）

记录日期：2026-11-27，Asia/Shanghai。任务仍为in_progress；本文件不是全范围完成声明。

2026-11-28最新交付指令：停止继续修复、不访问Vercel、不做本地UI；仅复核现有改动、生成[修复说明](../../../docs/observability/sentry/错误治理报告/2026-11/修复说明_2026-11-28_production_v1.md)，检查通过后按用户明确授权commit，不push/部署。旧段落中“未授权commit”和请求Vercel连接均为历史边界，由本条替代；未完成Issue不作恢复声明。本轮重新通过全仓typecheck、Frontend81/Backend86项相关回归、Shared422项及适用静态检查，构建/规则复验和最终提交证据见新说明。当前本机依赖缺失已按frozen lockfile离线恢复，未改产品代码或依赖版本。

最新补证：2026-11-28用户授权Supabase限定只读查询，并收敛到frontend/backend相关错误。G08已取得25006只读事务错误，G10取得3条observed候选但原HTTP→业务ID仍未精确对应；外部CS访问不再作为本轮代码交付前置条件。详细查询、原子只读边界与完整性见[investigation-2026-11-28.md](investigation-2026-11-28.md)。以下11-27段落保留当时已知事实，最新G08/G10事实以上述补证为准。

## 授权、基线和交付边界

- 用户“批准并修复”后完成task.py start；后续“后续不进行UI本地测试”覆盖规划中的UI命令。此后没有执行Playwright、preview或浏览器验收。此前4项UI仅为历史基线；Vitest单元测试不代替真机。
- 基线分支fix_request_speed，HEAD `fae9e1d066bd578c995b4b2c2f83a74a1de0bbc1`。本次没有git add/commit/push、PR、合并、部署、运营配置/数据库写入或Sentry Issue状态修改。下述代码均未提交、未上线。
- 原错误报告保留：`docs/observability/sentry/错误治理报告/2026-11/错误报告_2026-11-27_production_v1.md`。SHA256 `ffcf0a827dbf4d7fe1ad8347ee3add8951fd664894db623584dc16d7d4e0816e`。本轮不重新计算窗口数据或覆盖原版。
- 冻结统计窗：[2026-11-25 15:00:00, 2026-11-27 15:00:00) +08:00。46 Errors、13 Issue、16名已识别用户；不是46次去重业务失败。缺业务分母，不报比例。后续事件只用于持续性判断，不追加到46。
- 生产Supabase仅在确认ref后读catalog结构/函数定义，无业务行读取、函数执行或DDL/DML；详细来源与工具缺口见[investigation](investigation-2026-11-27.md)。没有用TEST结构替代生产。

## 逐组代码、复现和剩余证据

### G01 / ST-MINIAPP-6D：未修复，待核实

13条Android发现页ResizeObserver错误，7名已识别用户。全部cover_open=false、observer_source=unattributed，缺同交互的真正observer和业务结果。未按异常名称全局过滤。需要发现页负责人取得同visit布局、阻塞与observer来源；2026-11-28 12:00 +08:00前复查，若出现不可操作或循环持续立即升级P1。

### G02 / ST-MINIAPP-2：未修复，启动专项

10条iOS，全部SDK not_started/真实receiver absent，7条HTML ready、3条未ready。源码providers effect才init，真实bridge2.11.0建立receiver；此前初始化失败可能已有订阅，现有once状态避免盲重入。不能由后到的React代码证明HTML执行前宿主回调可被接收，也不能装空receiver、假ready或按异常名忽略。

本次没有改启动代码。缺真实宿主早到回调与实际监听器创建/释放时序，现有单测不能证明原问题恢复。启动负责人原最晚动作11-27 23:59；未获得闭环，需项目负责人落实宿主样本，11-28 12:00前提供可核验时序。阶段验收：真实receiver建立且重复挂载不重复订阅→部分失败不假成功→双端实际入口/失败率与采集健康观察48–72小时；不能仅移动一行init后宣称完成。

#### 23:53追加：早期初始化候选的因果与性能审查

- 直接读当前bridge2.11.0和sdk3.11.8：真实事件订阅建立receiveEvent；默认isTMA()仅解析启动参数，不发request_theme，只有显式完整探测分支才发请求。因此现有isTMA()先于init并不是已证明的主动触发竞态。
- `html_ready`字段的真实定义是`window.__miniappStartup?.status === 'sent'`，表示HTML早期路径已发送native ready；false不等于HTML未收到或JS未运行。7/3计数不变，不能据此断言3条发生在所有页面JS之前。
- 官方Telegram iOS中，WebAppWebView.sendEvent先检查接收器对象/方法再调用。已固定到2026-10-28提交[f640ef328f9b9b1be49813594ddd2b4821db6807的源码](https://github.com/TelegramMessenger/Telegram-iOS/blob/f640ef328f9b9b1be49813594ddd2b4821db6807/submodules/WebUI/Sources/WebAppWebView.swift#L275)，不是用故障后最新实现反推当时。该提交并不证明故障设备运行此版本；当前事件缺精确Telegram客户端构建及原始回调来源，故也不能认定应用的HTML ready主动触发了未保护调用。
- Providers模块初始化候选只能缩短模块加载到React effect之间的窗口；instrumentation提前引入SDK还会改变启动关键依赖和现有分阶段计时含义。没有实际回调时序/P95证据时，不用位置移动、空receiver、额外订阅或改计时定义冒充根因修复。HTML early-ready本身是已验证的既有冷启动路径，本轮不撤销或延迟它。
- 本轮没有产品代码改动、无UI或新的测试/构建进程；上一轮2162项后端测试和既有前端检查不被扩张为G02验收。下一步需要真实宿主构建/回调时序（去身份/启动payload），以及同次初始化与实际启动结果，才可通过design的修改证据门槛。

### G03 / ST-MINIAPP-F4 与 G13 / ST-MINIAPP-1R：原问题未修复，局部防护待上线

两Issue仍分组保留。F4完整栈为input onChange→useMemoryDraft→store.write→Zustand通知→React；1R压缩store尚不完整，不能确认同根因。共用代码路径不是同因证明。

改动：`packages/frontend/src/stores/memory-draft-store.ts`在有效entry同文本时返回原state。复现的确定缺陷是同步订阅者把同文本写回会再次通知：旧代码的有界回归在第4次通知失败；新代码只通知1次、revision保持1。另验证过期同文本仍刷新；既有A→B→A、空覆盖、TTL、容量和跨用户/会话/模块用例保留。6项store测试通过。

这是局部反馈防护，不是已复现原React组件递归。没有本次UI/系统键盘结果。风险：同值通知不再刷新TTL，符合“无编辑不续期”；真实编辑仍提升revision。回滚只恢复该store改动，不清草稿。前端聊天负责人11-28 12:00前补真实反馈组件/完整符号栈，之后才能决定两个Issue是否合并；出现不可发送立即P1止损。

### G04 / ST-MINIAPP-EY：原Issue待补因果，取消竞态修复待上线

`packages/frontend/src/lib/api/conversation-stream.ts`修复三个局部边界：调用前已取消不发送POST；fetch在取消后迟到则消费其body清理；helper响应与reader监听挂接之间再次检查aborted。原网络/idle/deadline错误、Promise.race和生成幂等语义不变，不新增重发。

扩既有测试，逐一先红后绿：预取消旧代码fetch一次；迟到body旧代码cancel零次；第一版仅检查fetch后仍漏掉微任务间隙，补listener挂接后的检查。最终stream36项通过。提取同文件fetchConversationResponse使read函数回到120行以内；无新公开API。

不能断言EY所有样本由这些竞态造成；线上abort所有者/未处理Promise仍缺完整关联。回滚限此stream单元，不改服务端生成/收费。前端流负责人11-28 12:00前补同request取消来源；生产验收还须旧流终止后新流正常、无额外POST、无晚到回调/未处理拒绝、业务终态不被本地abort改写。

### G05 / ST-MINIAPP-34：未修复，已有保护待原故障验收

3条Android importScripts失败；原任务的Worker启动/执行预算、idle/error/messageerror释放、代际守卫和完整原文fallback已经存在，故障release也含相关补丁，不能重复加同样保护。当前renderer既有35项单测通过；批准前4项UI仅为旧基线。

本次无renderer产品改动。仍缺故障静态资源的原HTTP状态/部署保留/缓存事实，不能拿当前其他资源200证明恢复。前端构建/交付负责人11-28 12:00前补原chunk和部署映射；确认资源失效时先使用既有完整原文降级并保留输入，禁止盲刷新丢草稿。需真实故障资源下consumer原文完整、下一轮仍可操作的发布验收。

11-28 00:21补证：原异常精确入口及依赖当前均200；隔离Node加载同一旧bundle可发ready，未复现装配缺陷，未拿不同hash的当前build替代。历史HTTP/CDN仍缺；当前Vercel按两部署ID/域名均404，本机无CLI身份，已请求前端项目连接。详见[investigation-2026-11-28.md](investigation-2026-11-28.md)。没有新产品改动或UI测试，G05状态不改为已恢复。

### G06 / ST-MINIAPP-1H：未修复，待核实

iOS发现页2事件/1名已识别用户，原报告窗后仍有同类；仅Fetch取消栈，不足以确认用户主动离页或内部deadline。已查原signal/API取消传播，没有原请求owner和同visit业务结果，不与EY合并、不降级过滤。前端API/发现页负责人11-28 12:00 +08:00前补取消发起者和关键读取结果；关键读持续失败升级P1。未修改产品代码。

### G07 / ST-MINIAPP-7Z：未修复，待核实

iOS QueryObserver取消2事件/2名已识别用户，c046f213/7b628e4d；缺query key、owner与实际流程结果，不能认定正常取消。沿用React Query signal和last-good边界，没有以缓存成功掩盖取消，没有与1H/EY强行合并。查询层负责人11-28 12:00 +08:00前补同次请求链；历史/配置等关键读取阻塞即P1。未修改产品代码。

### G08 / ST-MINIAPP-HQ：未修复，SQL诊断增强待上线

成本job两条P2010，窗后仍有同类事件。生产catalog所需列、call_id主键、kind/attempts/status约束均存在，无自定义触发器；postgres/service_role相关授权存在，但不等于已取得应用连接角色。未证明缺列、冲突键或权限就是根因。

`platform/observability/events.ts`安全提取Prisma P2010.meta.code为可选err.database_code；保留库code=P2010及二次投影，拒绝非SQLSTATE形状，不恢复SQL/message/query/参数。既有真实Pino测试新增有效码、已投影错误、非法码和敏感字段断言，先红后绿；相关logger/core/check共42项通过。README/spec同步。

没有修改cost SQL、job重试或成本事实；这是补证，不是故障修复。缺安全SQLSTATE/失败阶段及隔离PG17执行；本机docker/psql/bash不可用，不改用生产SQL执行。成本/数据负责人11-28 12:00前提供脱敏SQLSTATE与实际连接角色/阶段，在隔离PG17运行两条真实SQL、部分成功重跑与并发用例后决定修复。若证实账务不一致立即P0升级，当前仅潜在风险，不声称已发生资金损失。

### G09 / ST-MINIAPP-D5：未修复，上游跟进；本仓局部处理待上线

已确认只读unread上游约4秒期限，不代表客服写消息失败。`routes/support.ts`仅在身份阶段已完成且unread上游TimeoutError时返回503失败信封、SERVICE_UNAVAILABLE，无data；保留原始err和support.proxy.failed日志。没有新重试、没有unread:false或清徽标。身份失败、其他操作与写消息原路径保留。

既有support-cs-proxy测试新增unread503与POST timeout仍500/一次调用，旧代码unread断言先失败，最终6项通过。此改动只改失败语义，不能宣称减轻原上游等待或服务恢复。回滚为support局部改动，不动客服数据。独立客服平台负责人和代理负责人11-28 12:00前核对同请求时段上游；消息/主入口也持续失败立即升级P1、启用已存在人工客服入口，不能只等待供应方。

### G10 / ST-MINIAPP-H6：未修复，交付/计费专项

同request的RPC约3006ms，HTTP500约3022ms，outcome_known=false。只读取得当前report_chat_first_token函数：md5 `350609cb9e92730473ca84ec4ad5bc3b`，有user/session/revision/client_request匹配、请求行锁与幂等判定；没有同receipt最终业务行/锁等待证据，不能由fetch.abort推断回滚。未修改函数或计费逻辑。

现有客户端是24小时TTL、最多20条、3次即时+最多1次恢复、owner隔离，不再叠重试。生成/交付和计费负责人原最晚11-27 23:59；11-28 12:00前取得获授权的脱敏同receipt最终态与锁/等待证据。阶段验收：unknown保留→隔离验证重复/并发/迟到提交→恢复后recorded与账务读取一致→生产同链观察48–72小时。仅延长超时或消除500不足，资金/重复交付差异立即P0止损。

### G11 / ST-MINIAPP-HC：配置依赖放大局部修复待上线，DB等待根因未确认

GET generation-config约5142ms返回500，偏好/资料名字响应头等待取消；实际DB排队/网络/连接原因未知。2026-11-27 23:46 +08:00重新读取Sentry事件41cab2b6fed04214a1adf82eb2ab56dd，栈确认getGenerationConfig→getGenerationContext→UserProfileRepository.readNames:64。当前源码config-only只消费config却额外读names，确认此处存在可避免的依赖放大。

修改MiniappUserSettingsRepository：将既有偏好读取/档位归一化提取同类私有readGenerationConfig；config-only不读names，完整生成context仍并行读config+names、任一失败即失败。5秒期限、字段/档位回退、错误cause及传入instructionPromise复用保持，无写入、新DTO、重试或默认配置伪成功。

现有repository测试增加4项：profile挂起不应启动且config返回；偏好失败保留cause且不返回默认；规则拒绝保留原错误；完整context使用传入规则快照且names仍读一次。前两项旧代码先红（挂起超时、额外读users），局部修复后相关4文件71项通过；补齐规则与快照用例后全量194文件2162项通过，backend typecheck及日志/复杂度/导入静态检查通过。真实生成profile失败的旧回归仍通过。没有新增测试文件或UI测试。

边界属于小修：仅移除配置响应不使用的读取，保持完整生成所需persona；回滚限此repository改动、不清配置。不证明共享DB慢等待已经消失；HTTP仍可能因身份、偏好或规则依赖失败，不能宣称HC全因恢复。

后端账号配置/前端聊天负责人原最晚11-27 23:59；11-28 12:00前补同request子阶段与前端是否阻塞发送。若持续阻塞核心聊天，先停止扩发、回滚完整配置读取变更，不改用户数据。需资料/偏好任一失败均不覆盖现有配置，恢复后读取一致；其他请求成功不能作为本Issue恢复。

### 23:46续查：剩余边界与外部访问

- G03重取原窗F4事件，确认输入onChange→store.write→React订阅，react版本18.3.0-canary；breadcrumbs有100条上限，最后行为与栈仍不足以识别真正反馈组件。没有把同值防护当完整根因。
- G04重取EY事件49add64129ce47119d955aeaa1d3bb49，确认onunhandledrejection及卸载abort栈。当前SDK10.69源码会clone并旁路消费fetch body；这只形成需要验证的监控交互假设，未证明它导致原Safari拒绝，未改SDK私有实现、未禁用采集、未全局过滤。官方旧[DOMException讨论](https://github.com/getsentry/sentry-javascript/issues/1866)也不能证明本版本根因。
- G09只读检查独立CS仓库：hasAppUnread为cs.messages/conversations的EXISTS查询；Vercel池max2、connect_timeout10秒，代理原有限期限5秒。没有数据证明当前超时来自冷启动、池排队或查询，未改该仓库或生产数据。依该仓AGENTS先读AGENT_BRIEF，但没有调用发消息/改状态命令。
- 当前Vercel连接list_teams只返回一个可见团队；该团队全量项目仅infra-docs。带st-cs-inbox搜索与个人可见项目均空，无分页下一页；本机两仓无.vercel/project.json。未取得客服项目运行日志。已向用户异步请求客服项目team/project信息或切换可见连接；这属于实际权限/目标缺口，不能用主项目日志代替上游根因。没有新建连接、部署或修改项目配置。
- G08 fresh HQ最新仍为2026-11-27 15:01:33 +08:00，现有事件无可见SQLSTATE；没有通过生命周期次数更新原窗总数，SQL专项仍未完成。

### G12 / ST-MINIAPP-DR：局部依赖放大修复待上线，原取消源未确认

确定源码问题：公开目录Promise.all逐卡调用私有creator-cover解析，一张可选封面失败导致整份目录失败；原事件同request有close→DB取消，不能直接说HTTP500。`routes/characters.ts`复用已有resolvePublicCharacterAvatarUrls/resolvePublicCreatorCoverUrls批量签名、缓存/有限期限/缺图策略。可见性筛选仍在前，顺序不变，私有详情owner校验不变；没有吞掉列表主体失败。

扩既有characters测试：单私有封面错误旧代码500而新代码200/空图；批量签名、普通头像和顺序断言旧代码失败、新代码通过；characters27+cover4共31项通过。拆分list/latest/detail注册，保持所有@frontend-ready注释；文件不超500行，函数不超120行。原characterRoutes和readConversationStream复杂度基线两项删除，不放宽其他项。

此处可作为小修：只隔离已授权公开目录的可选展示依赖，无新DTO/DB/并发池。风险是临时显示空图，不能把私有授权错误放行；整体回滚characters路由单元，不动资产。后端角色列表负责人11-28 12:00前仍需补原cancel来源及受限真实发布观察；没有证据声称原4975ms完全消失。

## 验证记录

依赖恢复：pnpm install --force --frozen-lockfile --ignore-scripts，lock未变、不执行安装脚本。未创建新测试文件，均扩已有用例。

- `pnpm -r typecheck`：8个子项目全部通过。
- `pnpm --filter @miniapp/frontend exec vitest run --maxWorkers=2`：84文件1007项通过。首次默认并发有grafana超时及artifact beforeAll超时；降低并发后全部通过，未改产品逻辑或断言。
- `pnpm --filter @miniapp/backend exec vitest run --exclude '**/*.integration.test.ts' --maxWorkers=2 --testTimeout=20000`：194文件2158项通过。首次默认并发9项失败，后续2worker仍有首次动态import期限和创作状态栏读本机供应商配置干扰；3文件64项隔离复跑通过后，全量通过。
- `creator-status-bar.test.ts`补测试隔离：每例把config.voice.draft.apiKey置空并还原，只使用原mock OpenRouter transport，避免本机.env选择未mock的真实DeepSeek；不修改产品模型路由。首次运行可能发起真实供应商请求，未核实上游是否接受/计费，不称为生产验收，不保存凭据或响应。
- Shared：29文件422项通过；ReplyRenderer：1文件35项通过。总数不与业务事件/用户合计。
- Frontend lint通过，存在原有img/hook警告；Frontend build在显式禁用Sentry上传后通过（20静态页面），Admin build通过，存在原有chunk大小警告。
- `pnpm lint:backend-logging`通过，422 runtime files；`pnpm --filter @miniapp/backend logging:validate`通过，5规则/1启用。
- `pnpm lint:imports`因Windows的空--rule参数解析失败；等效`pnpm exec eslint --no-eslintrc -c .eslintrc.json "packages/*/src/**/*.{ts,tsx}" --no-inline-config`通过，不关闭实际限制。
- complexity update已运行，仅保留本次两个函数收紧；lint:complexity通过（17存量文件、76函数，其他存量警告未修改）；git diff --check通过。
- task.py validate通过（implement/check各13项；长文注入截断警告保留，相关源文已直接阅读），logging_planning_gate.py --task通过。新增测试隔离后的backend typecheck/日志静态检查再次通过。
- 本次UI/Playwright/preview/浏览器测试：按用户要求未运行。真实Android/iOS键盘、Telegram、供应商交付、计费、SQL隔离集成和发布P95均未完成，不以unit/build代替。

### 构建的意外外部写入

首次普通Frontend build读取.env.local，触发Sentry Node/Edge sourcemap artifact上传，release为当前HEAD fae9e1d066bd578c995b4b2c2f83a74a1de0bbc1；可见bundle ID `8c12cc72-fb5d-57a6-96ad-f811312ed505`。发现后停止构建并向用户说明；未部署产品、未改Issue状态，未自行删除远端制品。不能宣称本轮Sentry完全只读。

后续构建使用Node子进程env将SENTRY_AUTH_TOKEN、SENTRY_ORG、SENTRY_PROJECT显式设空，阻止Next从.env.local补入，不打印凭据；NODE_OPTIONS仅该子进程8GB。构建成功且无上传日志。未来验证先读构建配置再运行，避免把源码构建视为必然无外部副作用。

## Bug Analysis：局部依赖与异步边界

1. **Root Cause Category**：已复现的局部缺陷属于E（隐含假设：可选封面永远成功、abort监听注册前不会取消、同值write仍是编辑）和D（测试缺少失败路径）。原Sentry全部根因仍未确认，不能把这些类别反向覆盖13组。
2. **Why Fixes Failed**：仅fetch后检查仍漏微任务挂接间隙；新增该精确回归后补监听后检查。原Worker/receipt已有保护，不重复新增；已有成功请求、错误消失和旧任务完成均不能证明目标恢复。
3. **Prevention**：P0保持未知交付/账务事实与授权边界；P1扩现有失败路径测试并完成真实Pino脱敏验证；P2将这些可执行契约写入frontend/backend规格与日志README。
4. **Systematic Expansion**：检查了草稿恢复、query缓存、Worker scheduler、私有详情和其他客服写操作；没有证据不扩大为通用框架、全局异常过滤或无限重试。测试必须隔离本机可选供应商配置，构建必须显式隔离上传配置。
5. **Knowledge Capture**：更新`.trellis/spec/frontend/app/api-dataflow-and-state.md`、backend对应data-reliability-and-security.md及observability README；相关代码/测试签名和错误矩阵可直接复验。

## 发布验收、回滚和下一周期

最新状态（2026-11-28 00:25 +08:00）：恢复取证后已获得G08 SQLSTATE=25006和G10候选状态，另对G05原资源做了无UI装配诊断。详情及最新阻塞复核见[investigation-2026-11-28.md](./investigation-2026-11-28.md)。尚缺前端项目访问及剩余问题的原请求因果事实，目标为blocked，未宣称全部修复；下文11-27旧缺口以最新调查为准，G08不再缺SQLSTATE、外部客服访问不再是本轮前后端范围的阻塞条件。

### 当前继续工作的证据边界（2026-11-27 23:53 +08:00）

上一目标轮次完成G11代码/回归，属于实际进展；本轮取得G02官方宿主与已安装SDK源码证据，排除了“默认isTMA主动请求theme”假设，并澄清html_ready字段含义。不能用启动位置调整替代尚未成立的因果。当前没有活跃测试/构建进程，不属于等待运行作业。

当前缺口仍为：G02精确宿主构建/回调及初始化时序；G03/G13实际反馈组件（故障release acf345d1与HEAD的history/entry/draft/merge相关源码一致，不能声称已有其他提交修复）；G04原未处理Promise所有者；G05故障时静态资源/部署状态；G08安全SQLSTATE和实际失败阶段；G09客服Vercel项目日志访问；G10同receipt持久最终态/等待事实。G01/G06/G07继续缺同次业务结果。现有局部修复及所有检查不覆盖这些根因，整个10组修复目标未完成。

已异步请求用户补G09项目连接信息；本轮再请求G08脱敏SQLSTATE/阶段与G10同receipt最终结果/锁等待。按根AGENTS数据库边界，不能自行读取生产业务行；本机无可用隔离PG17工具，不能以生产执行代替隔离复现。无需传身份、SQL参数或凭据。补证后先对应design证据门槛，再修改/验收；未获证据期间不扩代码、不重跑已通过检查、不发布或假设恢复。

### 发布与验收安排

2026-11-27 23:55 +08:00再次复核外部状态：Vercel可见团队全量项目仍仅infra-docs；HQ最新事件仍9ff9e8e045a94a2e933ec5b5091ccaec（15:01:33 +08:00），无SQLSTATE/extra；H6最新仍d9fc274341fb4185a32979cc3aec55fe（11-26 15:23:41 +08:00），无同receipt最终态。当前无活跃验证进程，工作树保留已检查的局部改动。相同运行证据/项目访问缺口已连续多轮存在，现有静态来源不足以支持剩余根因修改，目标按blocked保留，不标完成、不缩小范围。补证请求仍有效；本轮没有重复跑检查或新增产品改动。

以上局部单元是可审阅diff，不能把整个10组宣称完成。技术未知仍需补真实因果，任务保留in_progress。建议责任角色尚未在外部系统派发，项目负责人需落实人员。

下一顺序：G10交付/计费未知和G02冷启动→G03/G13输入→G05静态交付→G11配置→G12局部修复发布验收→G08 SQL专项→G09外部跟进；G01/G06/G07并行补证。P1原期限11-27 23:59保持追踪，未闭环升级项目负责人，补证复查11-28 12:00 +08:00。没有可接受影响证据，不设可暂缓项。

发布前需对本次diff单元审阅并确认全部适用Quality Gate，作者按流程提交/发布；本任务不自动执行。每个局部单元可独立回滚，无migration/新依赖/数据清理。止损条件为核心失败扩大、P95同时恶化>10%且>200ms时停止扩发；身份/隐私/资金/一致性异常立即升级。真实P95基线无样本为null，不能判断已达标。

上线后以实际release/平台/流程同曝光，采集健康且有效N至少100观察48–72小时；不足继续“待验证”。每组按上文失败路径验收，不以其他请求200替代；没有业务分母不算故障率，不把Logs/HTTP/性能加进Errors。真实键盘和宿主由工程师在授权环境验证；本地UI按用户要求不执行。
