> **已暂停（2026-11-11，范围已澄清）**：后续开发不强制执行本地性能测试；此前已有规划与质量门禁不变。仅暂停本任务新增采样/结果门禁，下文为待重新研究的历史方案。

# 本地 TEST 性能机制设计

已按用户批准的口径实施本地 runner、采集、报告与门禁；真实 TEST 采样验收尚未完成。用户已确认20样本/2秒/人工豁免及Chromium/WebKit模拟。

## 1. 复用调研

| 入口                                                                                              | 决定与理由                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| ui-tests/playwright.config.ts、tests/fixtures.ts、preview.mjs                                     | 复用Playwright、定位断言、宿主初始化、进程管理；独立perf config/fixture，不把重置mock和全外网拦截fixture接真实TEST，保留3120/3121及3130/3131。 |
| frontend/lib/perf/page-ready.ts、page-tracker.ts、api-timing.ts、request-timing.ts、api/client.ts | 复用业务ready、首内容与logical请求计时；仅增加最小只读本地采集出口，不提前ready、不建立第二计时状态机。                                        |
| backend/platform/config.ts、runtime-config.ts、shared数据库配置                                   | 复用环境/项目身份校验，真实repository/RPC/REST；应用之间不相互导入。                                                                           |
| conversation-detail.ts、conversation-history-reads.ts                                             | 复用phase/attempt/fallback诊断；公开DTO不变，不为测试增加业务API。                                                                             |
| test-conversation-branches-migration.sh、chat_history_display_performance.sql                     | 保留隔离PG17功能及SQL诊断；大事务rollback不代替真实提交/HTTP验收。独立旧/新写对照留在隔离库。                                                  |
| test-openrouter-retirement-local.sh                                                               | 复用独立进程环境和目标预检；性能主链路使用托管TEST而非本地REST。                                                                               |
| mobile_performance_gate.py、task.py、common/task_store.py、archive_stale.py及既有Python测试       | 扩展现有声明/lifecycle；archive在所有写回前校验，审计stale绕过通道。                                                                           |
| ci.yml、db-migrate.yml                                                                            | 增加无远端凭证的证据校验；迁移仍用原workflow，采样器不执行DDL。                                                                                |
| ios-drama-sampler                                                                                 | 不复用真机/macOS驱动；本次明确浏览器模拟。                                                                                                     |
| k6/pgbench/数据库函数                                                                             | 首期不增加k6或新DB函数，浏览器原链路可同时采页面/API；容量压测后续按需扩展，不替代平台样本。                                                   |

## 2. 架构与最小范围

`本地CLI → Playwright Chromium/WebKit → 本地Next生产构建 → 本地Backend → Supabase TEST REST → PostgreSQL`。

代码归 `packages/ui-tests/performance/`，以 Playwright library 驱动固定次数采样（不使用测试框架重试），场景归 scenarios.json；使用3140/3141，端口冲突失败，不关闭未知进程。独立 `.next-perf` 构建缓存和 tsconfig.performance.json；本地性能构建不生成 standalone，规避 Windows junction 清理导致依赖文件被移除的问题。普通生产构建保持 standalone，不覆盖普通/UI缓存。首期不增加workspace、数据库表、微服务或测试DSL。

固定浏览器描述符、Playwright与二进制版本；报告维度 `platform=android|ios, engine=chromium|webkit, device_mode=emulated, host_os`。两端均在真实browser context调用原client，不复制Node HTTP结果后改平台标签。Windows WebKit不等于真机iOS Safari。

凭证只在Backend进程，浏览器访问本地Backend与明确TEST资源。使用既有TEST开发身份及独立用户，不伪造生产签名、不修改保护的DEV_SEED。若既有身份无法隔离用户，须先解决，不拿真实用户跑。

复用既有计时出口；优先本地collector，无法安全接收时才增加显式开启、仅本地TEST有效的只读observer。禁止采headers/body、改变业务状态或计时起点；生产默认关闭。内部结果schema留ui-tests，公开HTTP/SSE契约不变。

首批实现场景为大厅、聊天读取与深页；不会发起模型生成或计费。生成首字及 provider 对照仍属于原聊天任务专项验收，未纳入本轮结果，也不以读取性能代替回复性能。

## 3. 分组、采样与计时

组键：`platform + method/route + scenario + metric + cache_profile + dataset_version + provider_mode`。每组预定N≥20，默认20，任何维度不合并。

| 指标                  | 起点                            | 终点                                                             |
| --------------------- | ------------------------------- | ---------------------------------------------------------------- |
| 冷文档页面可用        | document navigation time origin | 既有业务ready且目标内容可见、主要操作可用                        |
| SPA页面可用           | 同浏览器时钟下真实导航动作开始  | 同上；不能从route effect后计时                                   |
| 首次聊天内容可见      | 对应进页起点                    | 正确会话首批消息可见；合法空状态须加载完成，骨架不算             |
| 历史翻页              | 触发更早记录                    | 正确消息插入且阅读锚点保持                                       |
| 普通API logical total | client入队/逻辑调用开始         | 内部重试、body读取、JSON/envelope校验完成                        |
| SSE/长任务            | 用户动作/逻辑调用开始           | 明确的首个可用业务结果/可见token或受理确认；另记录完整结束与终态 |

长任务必须在规划明确2秒阶段和最终正确性/耗时，不能静默只测headers；无法合理拆分则完整响应仍适用2秒或明确豁免。真实provider与stub不混合。

- nearest-rank：排序后第ceil(0.95\*N)项，原值毫秒比较<=2000，N=20取第19项。P50/P99/max为诊断。
- 每引擎/场景固定10次预热且标warmup；冷文档每次新context，SPA固定前置。服务器预热不等于冷数据库，缓存命中与真实网络读取独立场景。
- workers=1，框架retries=0，两平台交替固定小批，分别汇总。测量期间不build或另跑压测；共享TEST背景负载记录，不扣RTT“校正达标”。
- 固定N次尝试。任一非预期4xx/5xx/网络/超时/业务错误使组failed；缺终态/采集器崩溃为incomplete。缓存无请求不产生0ms接口样本；不足20须运行已登记API场景，不能轮询同一访问冒充20次操作。
- 内部安全重试属于同一逻辑样本，总耗时不重置；控制器不自动重发POST。失败时长保留但不伪造成成功P95；重新测量是完整新run，关联旧失败run，不能挑最快批次。
- 2秒是判定预算，不是请求timeout。默认采集单操作30秒、单组60分钟、整次6小时，执行前按场景登记；超预算结束为未通过，不自动扩大。

## 4. 场景登记与TEST隔离

单一小型注册表声明场景id、影响路径、页面、接口method/template、指标、操作、数据/缓存版本及预算，动作是普通TS函数，不建DSL。任务引用场景ID。公共helper反向展开消费者，未映射路径必须人工确认覆盖或具体not_applicable。

首批：大厅冷进入/SPA、聊天普通/长历史冷进入/SPA、最新/深页；含 `/characters`、`/chat/:id`、`GET /api/lobby-characters`、`GET /api/v1/conversations/:id`。聊天源任务10/100/1000/10000矩阵另按其要求扩展。完整翻页零缺失是正确性断言，不要求每个计时样本全量扫历史。

2页面×2进入方式×2平台可形成1600页面样本；API可从同一访问独立采集，但页面样本不能代替缺失API。既有功能回归继续复用ui-tests。

- 每次预检DATABASE_ENV=test、ref与解析host严格匹配，拒绝production/TLS关闭/mock/dev/缺迁移或权限。迁移走workflow，runner无DDL/truncate/全库恢复能力。
- 仅合成用户/角色/会话，run ID与显式创建清单。清理同时核对run归属和ID，不按模糊前缀/时间批删。不得读共享真实业务行，MCP仍只做获准结构采集。
- 默认runner1、动作间隔至少1秒、只读并发≤2、写并发1；新历史≤50,000行且未压缩合成payload≤256MiB，先到上限即停。大矩阵分批建数/清理，不一次灌10000×1MiB。扩大预算需先登记审核。
- 本机run锁＋共享TEST预约＋可信CI同项目concurrency=1；预约不是真正跨机分布式锁，发现其他负载/身份不确定则incomplete。首期不建锁表。
- 遥测本地受控接收或关闭外传，不能污染生产指标；浏览器/Backend外部出口显式限定。清理失败保留清单，只可精确重试自身记录。

## 5. 三阶段门禁与证据

扩展既有 `meta.mobile_performance`，历史schema_version=1保留，新增 `local_gate` 子合同含policy/场景/双平台/N/2000ms/计时版本/TEST/数据缓存/资源上限/更严约束。未测基线仍null。

**开工**：task.py start在状态及指针变更前检查计划完整性、注册表覆盖。新任务默认local_gate pending；所有继续实施的旧任务补声明，不能删除字段或利用旧任务兼容绕过。纯文档/工具可具体not_applicable，CI与实际路径交叉核对。无需先有新功能的20样本才能开工。

**验收**：拟 `pnpm perf:mobile:verify --task <task>` 从样本重算分位数与失败/覆盖/指纹，不信任passed布尔值。measured_status为passed/failed/incomplete；decision为passed/developer_waived/blocked/not_applicable。所有组达标才passed；未通过组均有有效精确豁免才developer_waived；其余blocked。错项目/敏感泄露/正确性/计费安全失败不能借性能豁免跳过其独立门禁。

**完成/归档/CI**：Phase2 check、Phase3交付、cmd_archive最前及CI均校验结果。task.py finish继续只清指针，不能代表通过。archive失败不写module知识/status/completedAt/目录。archive_stale对受政策约束任务先校验性能，模块门禁fallback也不能绕过，过期不自动等于完成。已归档历史不重写。

本地原始日志/HTML进入忽略目录 `output/performance/<run-id>/`。可提交或保存私有CI artifact的 `performance-evidence.json` 仅含脱敏样本id/组别/时间/结果/duration/attempts及机器/浏览器/数据/结构摘要，不含真实身份、正文、headers或连接串；CI没有可重算样本则incomplete。默认关闭可能含凭证的trace/HAR，诊断捕获须脱敏。

指纹包括HEAD、受测产品/测试/锁文件的排序路径及SHA256（dirty/untracked也计算）、policy/manifest/计时/fixture哈希、浏览器版本、TEST结构/迁移/关键配置摘要。报告本身、生成物及纯归档记账不进入产品摘要，避免自引用；性能预算/场景定义必须入摘要。默认有效7日且执行前后TEST摘要一致；任何相关变化失效。CI验证候选/合并结果的实际内容指纹，不仅看commit字符串。仅commit元信息变化而内容一致可重新关联。

## 6. 开发者豁免

独立 `performance-waiver.json`：task、source_fingerprint、report_sha256、groups、approved_by、approved_at、expires_at（默认≤7日）、reason、risk、follow_up、confirmation_source。确认必须发生在报告形成后，开发者明确看到结果和范围；每次代码/报告/计划变化失效，禁止全局无限期例外。缺样本豁免必须明确接受“未完成采样”，不能伪装成P95达标。

本地校验只能验证结构/指纹，写一个人名不能证明人类批准。执行者核对真实对话来源；CI的例外须绑定受信任开发者的PR review/comment或受保护workflow确认，核验权限和当前内容。机器人或AI自批无效。未配置可信入口时，只允许实测passed自动过CI，豁免待人工核验。性能豁免不放宽安全/正确性门槛。

## 7. CI、演进和恢复

独立Performance Gate job默认无远端凭证，核验范围、方案、证据；所有PR均执行并明确not_applicable，避免paths过滤让required check悬空。真实采样为本地显式运行或可信手动workflow；fork PR不获TEST密钥。证据真实性依赖获授权工程师/受保护执行器，哈希不是身份认证。

启用顺序：规范/模板→采集/报告→正反测试→试点每组双平台20→完成/归档门禁→CI及分支保护实际核验。工具未落地期间按规范人工阻断，不能声称自动门禁已生效。恢复只回退工具并保留人工验收及证据，不回退业务迁移，不清TEST，不用关gate代替优化。

## 8. 可靠性与可验证性

超时有界、原重试计总时长、POST不重发；run/sample/业务request ID去重；串行默认，混合负载另声明；各RPC真实提交，不包大事务rollback；清理按清单补偿；失败只incomplete/failed，无mock降级；容量/速率/时长预算明确；只收允许的指标摘要。无需新数据库对象，因此八域归属/迁移新增不适用，已有对象按workflow核验。

必须覆盖19/20、2000/2000.001、跨平台合并、NaN/负数/重复ID、超时/缺终态、缓存零请求、重试计时、篡改/过期证据、伪造豁免、archive无副作用、stale/删字段绕过、错TEST目标和精确清理。更严聊天不退化门槛单独保留。

机器算力、实际网络、TEST资源影响绝对时延；报告保留，未达标就调整/复测或明确例外，不扣RTT。模拟不证明真机/生产容量/模型质量；本地验收不取消生产发布后的实况核对。

## 实施校准：TEST 数据隔离

TEST 实际约束 `characters_test_cards_disabled` 禁止启用 is_test 卡；为让真实页面详情与权限读取成立，dataset v2 使用本轮合成用户的私有角色草稿、enabled=true/is_test=false 和精确 run marker。同一事务先写入无版本历史再附加私有归属，提交前核验 owner 可用且公共不可发现。这样避免生成受 immutable trigger 保护、无法用普通清理删除的 creator version；不修改数据库约束或触发器。此数据集明确覆盖旧会话读取，不验证 creator 版本绑定或生成写入。清理先按角色/run/owner 精确删除归属，再删除合成用户及角色，核验无残留。
