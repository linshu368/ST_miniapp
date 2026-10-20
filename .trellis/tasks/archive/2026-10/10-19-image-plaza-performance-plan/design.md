# 技术设计（用户已授权实施，按阶段记录验证）

## 1. 证据与复用调研

工作区根目录：`G:/JobLib/ST_miniapp`。以下证据为源码或 MIGRATION，不是生产实况。

| 已检索位置 | 当前事实 / 复用决策 |
| --- | --- |
| `G:/JobLib/ST_miniapp/packages/backend/src/features/image-plaza/repository.ts` | `listWorks` 按 like_count、published_at、id 降序，先筛选再分页；扩展现有 repository，不新建 feed 服务。保留 prompt/prompt_zh 搜索和 prompt_zh 标签匹配及字面转义。 |
| `G:/JobLib/ST_miniapp/packages/shared/migrations/20261014_image_plaza_feed_like_order.sql` | 当前点赞排序 migration 来源；不改写历史。 |
| `G:/JobLib/ST_miniapp/packages/shared/migrations/20261013_image_plaza_seed_catalog.sql` | seed 有 source_heat，generated 的 source_heat 为空；保留数据语义，不回填虚构热度。 |
| `G:/JobLib/ST_miniapp/packages/frontend/src/lib/api/image-plaza.ts` | feed key 当前只有 search/tag；详情已有 feed placeholder；创建会话已有 cache 写入；点赞成功仅 invalidate。扩展这些 hooks，不重复造缓存。 |
| `G:/JobLib/ST_miniapp/packages/frontend/src/app/(main)/create/page.tsx` | 复用现有标签、搜索、瀑布流及无限查询，在标签下增加排序控件。 |
| `G:/JobLib/ST_miniapp/packages/frontend/src/components/chat/chat-message-list.tsx` | 有 120px 底部阈值、用户滚动检测、直接 scrollTop 和 ResizeObserver；复用策略而非整组件，避免耦合聊天 DTO。 |
| `G:/JobLib/ST_miniapp/packages/frontend/src/components/chat/message-list.tsx` | 已纳入聊天组件检索；不引入第二套聊天渲染。`chats/page.tsx` 是会话列表，不是滚动算法来源。 |
| `G:/JobLib/ST_miniapp/packages/frontend/src/app/(main)/create/studio/[conversationId]/page.tsx` | messages 更新时反复 smooth scroll；上传完成才设置 reference；只修改此处交互，不改轮询传输。 |
| `G:/JobLib/ST_miniapp/packages/frontend/src/components/image-plaza/studio-artifact-card.tsx` | 复用产物展示，必要时补图片尺寸占位；不重做卡片。 |
| `G:/JobLib/ST_miniapp/packages/frontend/src/lib/use-visual-viewport-height.ts` | 复用视口适配，不另建 Telegram 键盘高度来源。 |
| `G:/JobLib/ST_miniapp/packages/frontend/src/app/(main)/create/work/[workId]/page.tsx` | 心形 aria-label 是点赞；“用同款”已有 pending，需补失败反馈；详情当前直接切换 img src。 |
| `G:/JobLib/ST_miniapp/packages/frontend/src/lib/api/favorites.ts` | 独立角色收藏路径，不与作品点赞合并。 |
| `G:/JobLib/ST_miniapp/packages/frontend/src/lib/api/client.ts`、`G:/JobLib/ST_miniapp/packages/frontend/src/lib/api/query-client.ts`、`G:/JobLib/ST_miniapp/packages/frontend/src/lib/api/media-cache.ts` | 沿用统一 client、Query 生命周期及媒体缓存约束；不把签名 URL 持久化成永久地址，不盲目扩大缓存。 |
| `G:/JobLib/ST_miniapp/packages/backend/src/features/image-plaza/storage.ts`、`G:/JobLib/ST_miniapp/packages/backend/src/routes/image-plaza.ts` | feed 签名缩略图、详情签名原图；复用签名与鉴权，先拆分 API/签名/传输/解码耗时。 |
| `G:/JobLib/ST_miniapp/packages/shared/src/api/image-plaza.ts` | 扩展现有 Zod 契约，保持已有响应结构；不将 DB 行类型传给浏览器。 |

现有数据库点赞、分享、创建会话与 seed import 的 RPC/repository 链路不替换；推荐查询为新增只读能力，不能复用计费/发奖 RPC 来排序。当前任务不修改全局 Supabase client；其初始化未显式配置全局 fetch deadline，不能据此断言所有调用都无超时，实施时逐路径核对。

已读规范入口：`G:/JobLib/ST_miniapp/README.md`、`G:/JobLib/ST_miniapp/docs/ARCHITECTURE.md`、`G:/JobLib/ST_miniapp/.trellis/workflow.md`、frontend/backend app、shared/contracts、database/supabase 的 index，以及跨层指南和 schema 对象约定。实现前按入口补读相应专题与源文档。

## 2. 推荐排序：固定初始序位 + 实时点赞优先

用户最新确认：先用 TEST 现有作品计算交错顺序，固定结果供初始数据分页，后续以点赞数为主。本节替代每页重算排名的旧方案；本次不读取业务行、不执行初始化。

1. 一次性初始化覆盖目标环境中当时未下架的现有作品，包括有赞作品，以便取消点赞后仍有固定基准；不按 search/tag 分别计算。
2. 按存储 model_name 分组，组内 `source_heat DESC NULLS LAST, published_at DESC, id DESC` 得到 r；跨模型按 `r ASC, model_name COLLATE "C" ASC, id DESC` 交错。
3. 对最终序列赋唯一正整数 `initial_feed_order` 并持久保存，越小越靠前。点赞、热度变化、下架和筛选都不重新编号；删除留下空位正常。
4. 用户明确固定序位仅用于零赞作品。运行时分两段：有赞区 `like_count > 0` 按 `like_count DESC, published_at DESC, id DESC`，同赞沿用现有时间/id 规则，完全不参与 initial_feed_order；零赞区 `like_count = 0` 按 `initial_feed_order ASC NULLS LAST, published_at DESC, id DESC`。所有有赞作品先于零赞作品。
5. generated 空热度在组内非空热度之后，组内全为空则按时间/id；模型耗尽自然跳过。
6. 后续新增作品建议序位为空，仅在零赞区排在已编号作品之后，再按时间/id；在“最新”正常曝光。一旦获赞进入有赞区，与其他作品同样按点赞/时间/id 排序，不因没有固定序位受罚。不改原分享/导入写链路，不采用 MAX+1 分配；若要求持续交错新增作品需单独评审。

示例：A 模型热度 10000/8000/5000，B 模型 20/10，零赞顺序为 A1、B1、A2、B2、A3；任意站内 1 赞作品仍先于它们。

取舍：模型均衡仅针对初始化序列；筛选取其子集而不重新交错，点赞优先也会打破均衡。取消点赞至零赞后恢复自身固定位置，不改变其他作品编号。不新增 Redis、物化视图、定时重算或会话快照系统。

最新独立使用 `published_at DESC, id DESC`，不读取热度和点赞作为排名条件。

## 3. API、游标与分页

- 在 `G:/JobLib/ST_miniapp/packages/shared/src/api/image-plaza.ts` 增加 feed query schema 与 sort 枚举 `recommended | latest`，route 校验 search/tag/cursor/limit/sort，保持响应 items/next_cursor。
- 新 UI 必须显式发送 sort，默认 recommended。为滚动发布兼容，建议未传 sort 的旧客户端继续旧排序/旧游标；该兼容分支不作为新 UI 的第三种排序。下线旧分支必须有消费者证据。
- 新游标含版本、sort、标准化筛选指纹、分区与最后排序 tuple。latest 为时间/id；recommended 有赞区为点赞数/时间/id（不含固定序位），零赞区为可空 initial_feed_order/时间/id。零赞游标继续零赞区，不重新从有赞区开始；有赞页不足时才衔接零赞区。续页正确处理混合升降序及 NULLS LAST；序位不得丢失整数精度，不作为公共作品 DTO 字段。
- 推荐使用持久字段排序、游标过滤和 limit+1，不在线计算 row_number，不取全表到 Node 排序。序位空洞不影响续页。
- 分页沿全局交错序列继续，不要求每页从一轮开头开始。例如 A1、B1、C1、A2、B2、C2 在 limit=4 时，第一页 A1/B1/C1/A2，第二页 B2/C2；有赞区结束在页中时，用零赞区继续填满本页。验证跨区、跨轮、模型耗尽和末页，不能为均衡而重复、丢弃或提前截断作品。
- 游标做长度、类型、范围、版本与筛选匹配校验；编码不是权限凭据；不能把游标字符串直接拼接 SQL。新协议非法游标返回 shared 定义的校验错误，不静默重复第一页。旧游标仅在旧兼容路径消费。
- 保留分页上限，不增加 total count；只有本页作品参与签名与个性化 liked hydration，避免 N+1 或给全部候选签名。
- key 包含规范化 search/tag/sort/协议版本；切排序重置页链与滚动。过渡显示明确加载状态，禁止 keepPreviousData 无提示地把旧排序当新结果；旧请求取消或由独立 key 隔离。

### 一致性边界（必须审核）

首版仍为实时 keyset：固定序位消除了删除/热度变化造成的其他作品名次漂移，但点赞变化仍会让作品移到游标前后，新作品也可能进入已翻过的位置，跨请求仍可能重漏。去重不能恢复遗漏。刷新重建第一页，mutation 后不得混接新排序第一页与旧游标。固定初始顺序不是冻结实时点赞的快照。

不使用仅带时间戳却未冻结点赞/排名的“伪快照”。如果验收要求浏览期间完全不重不漏，应暂停推荐实现，重新评审带过期时间的冻结 ID/排名快照及容量，而不是承诺实时游标能做到。

## 4. 数据库范围与对象归属

### 实施决策（2026-10-19，MIGRATION/源码，非远端事实）

- 沿用列方案：`experience.image_plaza_works.initial_feed_order` 是作品初始目录排列属性，生命周期随作品；权威 writer 仅本次手工 migration，既有分享/导入默认 NULL。无新表/函数/跨域依赖；无需平行排行事实源。新增零赞作品保持 NULL，有赞完全忽略序位。
- 单事务加列、正数/唯一约束、全体未删除作品初始化和候选零赞/最新索引。先锁表固定集合；5 秒锁超时、60 秒语句超时、最多 100000 未删除作品，超预算拒绝另审。重复执行因列已存在而明确失败（包括空目录），不得对新 NULL 再编号。workflow 账本不代替原子提交检查。生产容量另审，不能沿用此上限推断可执行。
- 复用 PostgREST 两分区读，不新增 RPC。同页最多两次有界查询，第二段排除第一段已返回 ID，防止取消点赞造成页内重复并用 limit+1 补足；不提供请求内 MVCC 快照，跨段/跨页点赞仍可移动或遗漏。查询返回的 likes 与后续个性化 hydration 也可能暂时不同；刷新重建页链。无严格快照需求则不引入新表/RPC/服务。
- bigint 在 PostgREST 投影中 cast 为 text，游标按十进制字符串验证到 signed bigint 上限，不经 Number。新协议筛选指纹 SHA-256，拒绝错版/跨筛选/跨排序游标。未传 sort 保留旧分支。
- 本机未找到 PostgreSQL/Docker，不能执行 SQL 或 EXPLAIN；索引收益/写成本与真实 TEST 初始化必须在发布前补证，当前不执行远端 SQL。

最小方案建议在既有 `experience.image_plaza_works` 增加可空 bigint `initial_feed_order`，正数约束及非空值唯一约束，不新增排名 RPC/表。理由是既有作品目录的一次性排列属性，生命周期随作品，不是独立维护的动态分数投影；列归属须数据库评审。若独立建排行对象，应按八域规则归 miniapp_features，不能因性能方便复制点赞真相。

- 不变量：已初始化序位唯一且不随点赞/编辑改写；点赞、所有权、未下架过滤及鉴权仍走既有链路。
- 权威写入方为获批的手工初始化 migration；新作品默认 NULL，不修改已有插入显式列列表语义。运行时消费者为既有 backend repository。无新增跨 schema FK、RPC 或触发器。
- 在目标数据库内部一次计算并写入，不经 MCP 读取/导出业务行，不提交 ID/热度清单到 Git。MCP 仍仅允许确认目标后的只读结构采集，写入走手工 migration 流程。
- 初始化事务检查未初始化状态并记账本；失败整体回滚，成功后重跑须跳过或明确拒绝，不能再次编号。暂停分享/导入或采用经评审短锁来固定集合，记录锁/WAL/容量与窗口；不覆盖并发点赞计数。
- 有赞区优先复用现有 `(like_count DESC, published_at DESC, id DESC) WHERE deleted_at IS NULL` 索引；零赞区候选索引为 `(initial_feed_order ASC NULLS LAST, published_at DESC, id DESC) WHERE deleted_at IS NULL AND like_count = 0`。不用固定序位参与有赞同分排序。查询分区和衔接方案须用 EXPLAIN 验证；若实现为两个数据库请求，必须评估中间点赞变化造成的页内重复/缺额，不能宣称同一 SQL 快照。最新索引按证据决定；搜索和混合游标仍可能额外扫描，不承诺固定 O(page_size) 耗时。
- 分阶段加列/约束→一次初始化→索引验证→兼容 backend→frontend；TEST 基线与 10 倍合成规模覆盖首页/深页/搜索/并发及点赞索引写成本。线上查询不得含窗口排名。
- TEST 数据只用于 TEST 初始化与验证，不按 TEST UUID 把排名直接复制 production。生产需另行确认目录映射；默认在生产自身现有数据上独立执行同一算法，不把 TEST 结果当作生产实况。
- migration 仅放 `G:/JobLib/ST_miniapp/packages/shared/migrations/`，手工逐文件执行，记录 shape/RLS/grants、回填数量汇总、锁/容量和回滚。本次不创建 SQL。回退先恢复旧读协议，保留序位列和数据；确认无消费者后才审批删列/索引。纠正初始化需独立 forward-fix 并使旧游标失效。

## 5. 工作室底部跟随

在原页面维护局部 ref，不先抽通用 hook、不改聊天组件行为。确认实际 overflow 容器，避免 scrollIntoView 同时滚动外层页面。

- 初次进入、用户显式发送成功、主动回到底部时进入跟随；用户上滑超过 120px 退出。发送成功是一次显式恢复跟随，不要求用户一直停在底部。
- 依赖最后消息 id/状态、产物数量及真实布局变化，不依赖整份 messages 对象引用。无变化的轮询不滚动。
- 自动补位用直接 scrollTop/auto；smooth 仅用于用户明确动作且非 reduced motion，不能每两秒重新启动动画。
- 同时观察内容 wrapper 与容器尺寸，rAF 合并到每帧最多一次，涵盖图片加载、输入区增高与 visual viewport；只在原先跟随状态补位。
- 图片用已有 width/height 预留空间，避免终态图片到达挤压；不因 attempt 结束就丢弃底部意图，仍可处理晚到图片尺寸。
- 用户阅读历史时，图片/键盘变化优先保留可视消息锚点；不要仅因 resize 后离底部变远就误判成用户主动上滑。监听器、observer、rAF 在切会话/卸载清理。

反复 smooth 是源码支持的疑点，不是已经量测确认的根因；性能 trace 同时排查图片解码、布局和状态重渲染。

## 6. 详情图片、“用同款”与点赞

### 先测量

在现有日志/浏览器 Performance 工具中拆分：点击→详情 placeholder、API TTFB/总耗时、repository/签名耗时、图片下载/onload/decode、创建会话响应→导航可见、点赞反馈→服务端确认。冷缓存、热缓存、深链分别测；不同源 Timing 信息不可用时标记缺失，不编造精度。

route 沿用 pino，记录 request id、sort、数量、阶段耗时和安全错误摘要；原始错误 `{ err }` 经现有脱敏，不记录图片 URL/签名、正文、search 文本或上传 base64。不得把支付专用 telemetry 扩成另一套采集系统。

### 最小改动

用户已确认“收藏”指本节的现有作品点赞，目标是提高实际处理速度和交互反馈速度，不新增收藏系统。

- 保留 feed placeholder，在原图下载/解码完成前显示已有缩略图，不先白屏；预留宽高比，加载失败有提示和显式重试。深链无缓存正常 skeleton。
- 不预加载整页原图；仅详情目标或明确意图触发可选预取，先证明节省超过带宽成本。签名失效只进行一次受控刷新，防无限 onError 循环。
- 不因性能猜测改公开桶或延长永久缓存。若考虑缩放图/签名复用，先核验套餐、费用、授权、URL 有效期和对象不可变性；复用期必须短于 token 剩余寿命，个人状态不能跨用户缓存。
- “用同款”保留已有创建成功写缓存和导航，增加可靠失败提示/重试入口；pending 防连点，不提前造会话 ID。未知结果的创建请求不自动重试，后续若要消除重复创建须独立增加幂等契约。
- 点赞在现有 mutation 中 cancel 相关查询、记录该 work 的旧字段，对详情和所有 feed 中该 id 做乐观 liked/count patch。成功用响应 liked/like_count 校准；失败只回滚该 work，不覆盖整份 feed 的其他并发修改。
- 点赞反馈不等待详情/feed 重取：乐观更新目标 p95 ≤ 100ms，成功响应直接校准缓存；相关排序只标记失效并按下条规则刷新，不立即重拉所有已加载页。服务端单独量测鉴权、点赞 RPC/锁等待、响应构造，确认是否存在冗余串行读/写；仅依据 trace 精简，不绕过权限/事务，不把未提交写入作为成功返回。成功链路应无用于确认本次 liked/count 的额外 GET；异常/超时保留受控校准。记录修改前后写请求 p50/p95、每次点击请求数和确认到 UI 稳定耗时，基线后确定服务端改善幅度；仅乐观反馈变快不能代替服务端提速结论。
- 同一作品 mutation 串行/禁用，避免回滚覆盖后一次操作；超时表示结果未知，提示后受控 refetch 确认。写操作默认不自动重试。
- 点赞不让正在浏览的卡片立即跳位；标记排序已失效，在列表重新进入/显式刷新时重建第一页，或当前列表显式重置页链。不得用旧游标续接更新后的排序。该 UX 取舍一并审核。
- 401/403/404 与网络失败分开处理；作品下架/权限失效应清理相关可操作缓存，不能以 placeholder 掩盖真实错误。

Supabase 官方资料（2026-10-19 查阅）说明 signed token 影响 CDN 缓存键，Smart CDN/图像转换存在套餐与费用条件；这不是本项目已开通的证据：<https://supabase.com/docs/guides/storage/cdn/smart-cdn>。

## 7. 参考图即时本地预览

- 复用 PNG/JPEG/WebP、20MB 校验，先校验再 `URL.createObjectURL(file)`；局部状态区分 localPreview、uploading/error/ready、已确认 artifact，blob URL 不进入 shared DTO/持久缓存。
- 沿用现有 JSON/base64 上传与 api hook，不为真实百分比改 XHR/分片协议。首版显示“读取中/上传中”不定进度，不能伪造上传百分比。
- 选择新图时分配递增 request token；删除、切模型、不支持 i2i、切会话或卸载均使旧 token 失效。晚到响应不能覆盖当前选择。
- 上传/读取期间禁用依赖新参考图的生成；失败保留本地预览与重试/移除，不静默使用旧 referenceArtifactId。重试由用户触发，上传非自动无限重试。
- 成功先保存服务端 artifact id；本地预览可保留到远端图片 onload 后再替换，远端图失败不丢失已成功上传的引用。发送只用服务端 id。
- 替换/移除/卸载 revokeObjectURL，避免过早 revoke 正在显示的资源；File/base64 不在多个长期状态里复制。取消请求不代表服务端未落库，沿用现有未引用产物生命周期，实施前核对清理策略，禁止猜测删除已共享对象。

## 8. 可靠性、最小方案与发布恢复

| 风险 | 约束 |
| --- | --- |
| 超时/重试 | 新排名读建议客户端总预算 10s、DB statement 3s（待基线确认）；图片保持可取消/失败 UI。读最多一次退避重试且不叠加 Query/client 多层重试；写默认零自动重试。确认 SDK 请求可真正中止，不用 Promise.race 冒充取消。 |
| 幂等/并发/事务 | 排名一次只读语句获得请求内一致性；点赞复用既有写事务，不改账务；创建/上传结果未知不得盲重试；客户端 request token 防晚到覆盖。 |
| 降级 | 读失败显示可重试错误，保留已展示图像；不能无提示把推荐改成最新。不得让遥测失败影响业务。 |
| 补偿 | 乐观点赞字段级回滚；预览清理本地资源；无新增账务写入，因此无账务补偿。 |
| 限流/容量 | 复用鉴权与既有限流、分页上限、上传大小限制；控制并发签名、避免全量原图预取与多层自动重试。无新队列/后台任务。 |
| 安全 | RPC grants、未下架过滤、个性化 liked 隔离、上传所有权检查不变；无敏感日志/导出。 |
| 可观测性 | 分段耗时、错误率、DB 排序成本、重复请求数、主线程长任务；基线和回归使用同条件，不把感受替代数据。 |

发布顺序：纯前端预览/滚动可独立验收；排序为 TEST 加列/一次初始化/索引→兼容 backend→frontend→真机→production 独立批准。先内部 Preview 小范围验证，不引入新的灰度平台；若需开关只能走既有 runtime-config 入口并另审契约。

停止条件：错误率上升、查询预算超标、权限泄露、点赞错误/分页混乱、滚动强拉用户、预览引用错配，任一出现即停止扩大范围。回退 frontend/backend 到兼容版本；新增 DB 对象先保留不删，确认无消费者后再独立回滚 migration。不得删除作品/点赞数据以恢复排序。旧历史 migration 不改写；权限或 SQL 修正使用 forward-fix。

## 9. 已确认事项与实现前审核项

1. 已确认：先用 TEST 现有作品计算并固定模型内热度排名、跨模型交错的初始序位，仅用于零赞作品；有赞作品按点赞数优先，同赞保留现有时间/id 规则，支持分页。新增零赞作品空序位策略及列归属按本设计评审。
2. 待审核：实时分页与刷新恢复的边界。用户确认支持分页不等于已确认接受动态重漏，也不等于要求严格快照。
3. 已确认：“收藏”就是现有作品点赞，要求提速；反馈与服务端处理分别量测，不新建收藏功能。
4. 确认 TEST 目标、模型数据规模、性能设备/网络基线、DB 预算和索引证据；production 单独确认。
5. 审核必要回归：优先扩展现有测试文件；游标/乐观并发/上传竞态属于需锁定风险，若现有文件无法覆盖，先批准新增测试文件再创建。

用户随后授权“开始按规划执行”。前端阶段按本文实施；排序阶段实施前落实查询一致性与归属决策，真实 TEST 与 production 门禁不因代码授权而跳过。性能目标并非已测成绩。