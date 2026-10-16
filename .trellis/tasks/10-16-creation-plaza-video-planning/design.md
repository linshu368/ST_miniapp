# 技术设计草案：图片广场扩展视频

状态：技术方案待审核，2026-10-16。用户已确认分类 OR+计数、视频总共 0～1 张输入图并按模型能力映射用途、同会话交替生成、调用前余额检查且成功后扣费、跨媒体共用返利与首次分享资格；下文据此修订，不代表代码已实现或远端已部署。

## 1. 证据、现状与差异

工作区根目录：`D:/codeReposity/wq/ST_miniapp`。以下源码证据都以此绝对目录为基准；数据库结论仅是 MIGRATION，不是 TEST-DB/生产实况。

| 已检查入口（绝对路径）                                                                           | 已确认现状 / 设计影响                                                                                                   |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `D:/codeReposity/wq/ST_miniapp/packages/shared/src/api/image-plaza.ts`                           | image_url 必填，图片专用分辨率/模式、单参考图，不能直接给旧契约返回视频                                                 |
| `D:/codeReposity/wq/ST_miniapp/packages/backend/src/features/image-plaza/repository.ts`          | listWorks 按 like_count/published_at/id 降序；search 匹配 prompt 或 prompt_zh，标签只匹配 prompt_zh；详情/会话签名回填  |
| `D:/codeReposity/wq/ST_miniapp/packages/frontend/src/lib/api/image-plaza.ts`                     | React Query infinite feed、上一页占位、列表缓存辅助详情、创建后预填会话缓存；有未终态任务时轮询完整会话                 |
| `D:/codeReposity/wq/ST_miniapp/packages/backend/src/features/image-plaza/job.ts`                 | worker 租约模式；图片生成后转存结算，非长周期异步视频查询模型                                                           |
| `D:/codeReposity/wq/ST_miniapp/packages/backend/src/features/image-plaza/upstream.ts`            | Venice 图片调用有超时，写调用不自动重试，未知结果有独立错误                                                             |
| `D:/codeReposity/wq/ST_miniapp/packages/backend/src/features/image-plaza/storage.ts`             | 私有 image-plaza bucket、图片魔数与尺寸校验、短期签名；普通图片 20 MiB，审核 seed 50 MiB                                |
| `D:/codeReposity/wq/ST_miniapp/packages/admin/src/components/ImagePlazaConfigEditors.tsx`        | 已有模型目录/标签/分享配置编辑能力，可复用交互与字段模式                                                                |
| `D:/codeReposity/wq/ST_miniapp/packages/admin/src/lib/configSchemas.ts`                          | managed keys 和 shared schema 要同时扩展；数据库发布校验也须扩展                                                        |
| `D:/codeReposity/wq/ST_miniapp/packages/shared/migrations/20261012_image_plaza_v2.sql`           | 图片会话/消息、报价/任务/产物/作品，图片专用 FK，点赞和奖励跨域                                                         |
| `D:/codeReposity/wq/ST_miniapp/packages/shared/migrations/20261013_image_plaza_seed_catalog.sql` | seed 可无用户/任务，奖励拒绝 seed，奖励使用 grant_bonus_credits；不可误加非空约束                                       |
| `D:/codeReposity/wq/ST_miniapp/packages/shared/migrations/20260921_wallet_debit_refund.sql`      | apply_wallet_debit/refund_wallet_debit 已有，扣款 entry_type 白名单为 chat_debit/image_generation；不是现成视频计费 API |
| `D:/JobExe/ST/图片广场原型/index.html`                                                           | 示例仅三个视频模型；模型 ID、价格与能力不是供应商事实；大段内嵌媒体不作为生产实现参考                                   |

差异/缺口：根规则要求生成与计费进入 generation，而既有图片广场 worker 直接调用本域 upstream/repository；这是存量事实，不据此为视频增加同类旁路。新视频编排经 generation，图片不在本轮全面重构。`features/generation/image-plaza.ts` 不存在，不引用为可复用入口。README 已描述六个 workspace 包（含 reply-renderer），旧“五包”描述落后；验证以实际 workspace 为准。四张用户截图本轮不可见，未宣称已视觉验收。

## 2. 复用与最小架构

### 复用 / 扩展清单

- 复用：现有页面外壳、双列卡片布局、Dialog/Sheet、骨架、按钮、点赞/分享交互模式；保留图片卡和图片设置分支。
- 复用：React Query、apiClient、详情缓存预填、会话创建缓存、query invalidation；不另引服务器状态库。
- 扩展：共用创作历史表/消息表，新增媒体类型；一套新广场聚合契约与路由，图片查询/写入仍委派已有仓库和 RPC。
- 复用：现有图片上传/校验/参考资产，视频最多引用一个资产 ID；前提是授权检查覆盖视频使用且不改变旧图片大小限制。
- 扩展：Admin 已有发布、草稿、回滚、校验链和 runtime-config 入口；独立视频目录，不向图片模型中塞视频枚举。
- 复用模式而非照搬：DB claim/lease、attempt 幂等、原子扣款/返利、pino 日志。视频有独立可恢复状态机，不能用图片同步 HTTP 请求撑完整生成。
- 不复用：图片二进制返回/Buffer 全量下载/图片签名 path 白名单处理视频；另做小型视频 storage/upstream 模块，不改变图片 bucket。
- 不复用：角色聊天 image attempts、chat_history、图片普通免费额度；创作历史统一不等于合并到角色聊天历史。

建议新增业务文件边界：shared 的 creation-plaza 与 video-plaza 契约；backend 一个 creation 聚合 route/repository、video-plaza 的 repository/job/upstream/storage，以及 generation 下视频编排；frontend 一个聚合 API hooks 文件、视频设置/产物呈现与分类弹窗；Admin 一个视频目录编辑器。只在真实重复时提取小函数，不建媒体插件框架、通用 adapter 注册中心或第二套设计系统。

### 数据流

UI → shared DTO → Telegram 鉴权 route → generation 视频编排 → 视频仓库 / 受限 RPC → 上游异步任务 → 私有存储 → 原子结算 → 统一历史与广场。

列表、详情、会话读与播放授权无需调用生成供应商。图片路径仍由原仓库承担；只在聚合层投影为统一 DTO。

## 3. 契约和旧客户端兼容

建议新前缀 `/api/creation-plaza` 承载统一 feed/config/works/conversations；`/api/video-plaza` 承载视频 quote/attempt/status/playback/share。不是复制整套图片 HTTP；旧 `/api/image-plaza` 路由继续只输出旧图片契约。

- FeedItem 使用 `media_type: image | video` 判别联合：公共身份、封面、尺寸、模型名、点赞、分享时间；视频仅增加时长等轻量字段，无播放 URL、参考图、完整 prompt 快照。
- Detail 使用完整判别联合：图片保持原图/快照；视频为封面、时长/分辨率、视频快照、可公开参考图摘要，不在首次请求签发视频正文 URL。
- 所有缓存、点赞、用同款、详情地址中的作品身份均使用 `(media_type, id)`，不可假设两张表 UUID 绝不碰撞。旧 `/create/work/[workId]` 无类型默认为图片；视频链接显式带类型，服务端严格校验。
- 会话不固定媒体类型；每次提交将对话框所选 `media_type` 与该次 quote/输入快照绑定，切换类型仍使用同一 conversation_id。历史列表按 updated_at/id 分页，摘要可用最近一轮媒体作为展示提示，不能据此限制下一轮。
- 新会话读取接口返回消息/生成轮次判别联合，逐轮按 `(media_type, attempt_id)` hydrate；消息时间线按 created_at/id 稳定排序，而非按任务完成顺序。两类任务共用消息表、各用本域 attempt，旧消息缺类型按 image 兼容，图片/视频轮次绝不互相覆盖。
- 旧图片接口仅投影图片消息/attempt/快照，不向旧 DTO 塞视频或按会话类型拒绝混合会话；旧列表只展示存在图片内容的会话（含旧空会话），纯视频会话不输出。新入口完整呈现混合历史。新接口下旧图片会话可直接追加视频；不改图片生成参数，只扩展共用历史适配。
- 视频 Submit 带 conversation_id、media_type=video、quote_id、idempotency_key、prompt、可选单个 input_asset_id 和能力参数；不提供多图数组、position 或用户自由选择 role。服务端按已验证的模型/模式解析单图用途并绑定报价和提交快照，拒绝伪造多图、用途及不支持的输入组合；图片分支仍保持图片输入契约。价格/供应商 ID 不能由客户端决定。同键跨类型或不同 payload 必须冲突，共用消息受理身份约束 `(user_id, idempotency_key)`，不能仅靠两张 attempt 表各自去重。
- 前端分别保留图片/视频参数草稿；切换类型使当前报价失效并重新获取对应报价，但不改已提交轮次。在途任务刷新按两类共同收敛。同次请求的类型不读取可能已改变的当前选择。每次生成仅用该次明确输入，不自动把历史视频/图片追加为供应商输入。
- 视频 snapshot 保存 model/capability/config version、时长/分辨率/画幅/音频选项及可选单图资产、实际用途和 adapter 映射版本；无图明确记录无输入，不把旧图片 resolution 扩为视频分辨率。
- Quote 绑定用户、模型版本、参数、价格和过期时间；参数变化重报价；下架或过期返回明确错误，不静默切贵模型。
- Playback 请求先校验本人产物或已发布可见作品，返回短期 URL 与 expires_at；URL 不进日志/遥测，不接受用户自传远端 URL。

## 4. 混合列表、分类和分页

建议通过受限 DB read RPC 对 image_plaza_works 与 video_plaza_works 先 UNION ALL 投影公共列，再统一过滤/排序/limit+1；同域内容合并，不建双写作品总表。点赞状态在受控 repository 批量读取，最多按媒体类型各一批，无逐卡 N+1。

排序：like_count DESC → published_at DESC → media_type DESC → id DESC。游标包含版本、排序元组、筛选摘要、目录版本和首次请求时间上界；任一筛选变化清空游标。非法游标返回 400，不退回第一页造成重复。点赞是可变排序键，因此时间上界只能排除新分享，不能冻结点赞；静态数据保证完整分页，动态数据前端按复合身份去重、刷新重新排行，允许动态排名造成暂时漏看，不宣称快照一致。若业务要求严格一致才另审排行榜快照。

已确认多选为所选分类 label 在 `prompt_zh` 中字面包含的 OR：取消一类不排除仍命中其他已选类的作品。边界建议为全选不限制、空选为空结果。多个分类重叠只返回一次。搜索条件与分类 AND，转义 `%`、`_`、反斜杠等 SQL LIKE 字面量，参数化 RPC，不拼不可信 SQL。

Admin 保留现有标签 key，兼容新增适用媒体范围（旧项默认两类）、稳定 ID/label/enabled/sort_order；首版仍按 label 匹配，不增加关键词词库和自动分类引擎。标签显示不受“分享自动打标”开关控制。无有效分类时视为不限制；删除/禁用后刷新目录并规范化选择，目录版本变化重置分页。弹窗展示每类作品数及“已选 N 项”。

计数口径建议：在当前 media_type + search + 发布可见范围内，以与 feed 相同的字面匹配计算每个启用分类的作品数，但不应用分类选择、游标、页大小；一个作品在一个分类内只计一次，可计入多个分类，分类相加不等于结果总数。返回 counts_by_category、未应用分类的 all_count、应用当前分类后的 selected_total、catalog_version、computed_at，均基于同一查询快照；全选总数包含未分类作品。该细则是实现建议，不冒称用户已逐项确认。

新增受限聚合 RPC 和 `/api/creation-plaza/facets` 契约，服务端同一公共过滤逻辑完成计数，禁止逐分类 HTTP/SQL 或客户端仅数已加载卡片。弹窗打开后独立请求并展示 loading/error，不能阻塞 feed 首屏；媒体/关键词/分类选择变更使用匹配的 query key，旧响应不能覆盖新条件。缓存建议短 TTL 15s（需容量验证），隔离可见范围及目录版本；分享/下架/分类发布使相应缓存失效，失败不展示虚假的 0 或拿另一条件的旧计数顶替。计数与另一次 feed 查询之间允许短暂实时差异，显示更新时间并可刷新，不承诺跨请求强快照一致。压测聚合 SQL 与列表并发，超时有界，不能为保留计数牺牲列表可用性；数据库规模增长后再基于 EXPLAIN 优化，不预建统计双写系统。

先按已发布行建立公共排序所需索引；包含搜索索引必须用目标环境 extension/EXPLAIN 证据决定，不能假定已有 pg_trgm。禁止为了混排先拉两张表所有数据到 Node 或客户端。

## 5. 模型、可选单图和 Admin

六个模型的准确名字见 PRD，供应商已由用户确认为 Venice。名称仅用于产品目录；实际视频 API base、provider model id、账户可用性、i2v/r2v/t2v、无图/单图支持、图片必填性与用途映射、时长/分辨率/画幅组合、音频、价格、任务查询/幂等/cancel、结果有效期仍待正式文档和 test canary 核验。不根据 R2V 名称或 Excel 标签推断行为；产品最多一图，供应商支持多图也不扩展上限，仅支持至少两图的模式保持禁用。

### Venice 默认值与参数证据边界

用户要求视频默认自动优化提示词开启、Venice 系统提示词关闭、safe_mode 关闭。默认值进入正式配置发布链与服务端运行时读取，并在每次提交快照记录实际采用值及配置版本，不在前端独立硬编码另一份真相；不更改既有图片目录/seed 参数。业务快照字段与 provider 请求字段分离，后者须按端点能力映射。

本地证据：`D:/codeReposity/wq/ST_miniapp/packages/backend/src/features/image-plaza/upstream.ts` 对图片发送 `safe_mode=false`，仅 generate 分支设置 `enhance_prompt`（缺省 true），edit 不发送；`D:/codeReposity/wq/ST_miniapp/packages/backend/src/features/generation/image-plaza-prompt-translate.ts` 使用聊天参数 `venice_parameters.include_venice_system_prompt=false`。它们不是视频端点支持同名字段的证据，不能直接复制整个图片/聊天 payload。

2026-10-16 读取官方入口 https://docs.venice.ai/api-reference/endpoint/video/queue.md ，可见视频为 quote → queue → retrieve 异步流程；本轮长文输出截断，进一步脚本提取返回 HTTP 403，因此尚未完整核验三个开关的请求 schema。G2 必须逐端点/模型验证默认值、参数支持及实际生效；未支持不能发送猜测字段、静默忽略或宣称成功关闭。若需独立提示词优化步骤，须另审 generation 内复用、超时、费用与失败行为，不擅自新增付费 LLM 请求；系统提示词关闭指 Venice 默认系统提示词，不等于删掉应用鉴权、输入校验或内容审核。

目录包含：稳定业务 ID、名称、说明、排序、启停、默认项、服务端 provider 映射、有效参数组合及对应售价、无图支持/单图必填性与用途映射。使用有效组合列表避免独立数组产生不存在的参数笛卡尔积。未验证模型只能保存为禁用草稿；全部禁用是视频关闭的合法状态，不沿用图片“必有启用默认模型”的约束。后台不能突破 adapter 已验证能力或产品总共一图上限。

输入规则以用户最新确认为准：每次总共 0～1 张，不是每种用途各一张。UI 只有一个可选图片入口，按所选模型/模式显示首帧图、参考图或垫图的实际用途，不让用户自由选角色。业务用途标签不等于供应商字段名，“垫图”不能据名称虚构独立 API 参数；adapter 必须有明确且唯一的已验证映射，含糊或不支持的模式不开放。无图仅允许支持 t2v 的模式提交；要求图片时提示补图或切换模型。不得把一张图片复制到多个角色来绕过模型最低图数，也不扩大到尾帧或多任务批处理。

上传复用图片入口，只允许一个图片槽位，单张沿用 20 MiB 且不得超过 provider 限制；不再设计多图并发上传或 40 MiB 总预算。客户端、Shared 和服务端均限制最多一图；批量选择/拖入多图明确拒绝，不取第一张后静默丢弃其余图片。支持显式替换、移除与失败重试；替换/移除后的旧上传响应不得覆盖新草稿，上传未完成不提交。生成请求只传资产 ID。切模型后重新显示用途并使旧报价失效；不兼容时保留草稿且阻止提交，不静默丢图或复用旧角色。视频“用同款”最多带入一张授权且角色兼容的图片；无授权时提示自行补图，不复用输出视频当作首帧。

配置发布同时覆盖 shared/Admin schema、managed keys、数据库发布校验器、runtime-config 读取和版本缓存；密钥只在服务端启动配置，前端公开目录不含 provider ID/内部标签或 secrets。

## 6. 持久化归属（拟议对象，不创建迁移）

| 对象                                                     | 不变量与权威写入方                                                                                         | 生命周期 / 消费者 / 跨域                                                                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| experience.image_plaza_conversations/messages 扩展       | 会话不锁定类型；轮次消息持久 media_type，旧消息默认 image；共用受理幂等身份                                | 保留旧会话/消息 ID；按轮次绑定图片或视频 attempt；旧 image snapshot/source 保留兼容，不作为全会话当前类型真相               |
| experience.video_plaza_attempts                          | 一个用户幂等键一个任务；用户/助手消息、输入快照、provider job、lease/version、next_poll_at、deadline、终态 | job/历史读写；按保留政策留审计，不随开关删除；与 billing 通过受限 RPC 结算                                                  |
| experience.video_plaza_artifacts                         | generated 按 attempt/position 唯一；seed 按来源身份幂等，允许无 attempt；仅媒体校验通过才就绪              | 私有视频/封面、字节、尺寸、时长、摘要；job 或受控 seed importer 按来源写入，不伪造生成任务                                  |
| experience.video_plaza_works                             | generated 必须成功结算；seed 必须导入审核与媒体就绪，无用户/扣款也合法；每产物至多一作品，软下架           | feed/detail/share；种子来源元数据与批次归 experience（内容真相），受控 importer 权威写；无 billing 写依赖，长期保留来源审计 |
| experience.image_plaza_reference_assets 复用             | 输入必须本人或显式获准公开复用；有序 ID 在不可变 snapshot 中，服务端验证                                   | 不建立第二份图片资产；被任务引用时不清理；未来回收要同时检查图片/视频引用                                                   |
| billing.video_plaza_quotes                               | 价格与钱包策略快照由服务端签发，过期/用户绑定                                                              | 短期报价，任务保存不可变快照；财务真相依八域第一条归 billing，不复制图片报价的 experience 归属                              |
| billing.video_plaza_charges                              | attempt 软引用唯一，debit/refund 对账状态权威记录                                                          | generation 调用受限 RPC；账务长期留存；钱包/ledger 不复制到视频域成为第二余额源                                             |
| billing.video_plaza_share_rewards                        | 每 work/扣款最多一次奖励，与图片共用返利规则和 grant_bonus_credits                                         | 财务审计长期保留；视频作品引用独立，账户首次事实与配置共用                                                                  |
| miniapp_features.video_plaza_likes                       | 用户/作品唯一，幂等设置最终 liked，不做 toggle                                                             | 功能互动状态；RPC 同事务更新体验域计数，删除/下架规则明确                                                                   |
| experience.list_creation_plaza_works 受限读 RPC          | 同域 UNION，稳定有界筛选，只读发布可见内容                                                                 | 后端调用，禁止 anon 直接执行；不读跨域私人点赞表，由 repository 批量补齐                                                    |
| experience.count_creation_plaza_categories 受限读 RPC    | 复用 feed 可见性/搜索/分类谓词，分类内按复合作品身份去重                                                   | 后端 facets 调用，语句超时和短 TTL；无逐类 N+1，不持久双写统计表                                                            |
| app_core.miniapp_user_settings 既有首次分享字段          | 图片和视频共用 image_plaza_first_share_completed_at，只能 NULL→时间                                        | 两种 billing 分享 RPC 按同一账户原子协议写；存量值原样保留；前向迁移说明跨媒体语义                                          |
| billing 视频结算/分享 RPC；miniapp_features 视频点赞 RPC | 跨表一致性、最少权限、受理/结算幂等                                                                        | 显式限定依赖 experience/app_core/billing，事务中不做外部 HTTP                                                               |
| app_core.runtime_config 新 key；admin 发布校验函数       | 正式视频目录/开关只一份，Admin 保持草稿和审计                                                              | runtime-config 统一读取；随正式发布切版本，不另建配置表                                                                     |

所有新表 RLS 启用；anon/authenticated 不直读写，必要服务端角色最小 grants；SECURITY DEFINER 固定 search_path、全限定对象、校验调用身份/owner、REVOKE 默认 PUBLIC EXECUTE。私有 video bucket 和图片 bucket 分离，避免放宽图片 MIME 与容量。新函数与索引按域写文件头。

上游结果 URL 也属于不可信输入：仅 HTTPS、明确供应商/CDN allowlist，拒绝私网/回环/link-local 和非标准端口；跳转禁用或每跳重新验证，防 DNS 重绑定，不能把 API Authorization 转发给下载域。下载需同时校验声明与实际字节数、容器/编码/时长/尺寸；扩展名与 Content-Type 不能替代真实媒体校验。具体媒体探测手段需在供应商研究阶段验证，当前未确认可复用解析器，不能只靠文件头宣称安全。若未来采用 webhook，必须验签、时间窗、防重放和 provider job 归属匹配；首版采用服务端查询，不暴露未认证回调。发布内容需沿用既有审核约束并补充视频内容政策，输入图片授权与输出公开分享授权分别确认。

引用生命周期：工作室草稿未绑定资产可按审核 TTL 回收；被任务/公开作品引用的输入与产物不得随意删。共享参考图默认不公开，分享时明确授权才允许别人用同款获取输入；撤回后的新访问拒绝，已签 URL 在短 TTL 内仍可能可用，此边界需要产品接受。

## 7. 异步生命周期、计费与恢复

建议持久状态：queued → submitting → provider_pending → storing → settling → ready；明确失败进入 failed；不确定进入 outcome_unknown（可读查询对账，禁止重发生成）。已确认成功后扣费，不引入预扣、冻结或由此产生的失败自动退款流程；已有财务纠错/退款事实仍需在分享资格校验中考虑。

先查询同一幂等键的既有结果，合法重放不因当前余额变化被当成新提交拒绝。新受理事务校验 owner/quote/媒体类型/输入角色/幂等，并按所选模型参数的报价和钱包策略预检真实可用余额；不足返回 402/明确余额不足错误与充值提示，不写可调度任务、不调用供应商。通过后在同一会话写带媒体类型的 user+assistant messages 与 attempt，更新会话时间。受理建议 202 返回任务身份，轮询轻量 attempt，不反复传整个历史。

worker 在首次供应商提交前再次校验可用余额，覆盖排队期间余额变动；不足则将未派发任务收口为明确余额不足，前端提示充值，供应商调用次数为零。余额查询失败/超时按失败关闭处理，不能用客户端缓存或默认通过；预检不扣款。充值后由用户确认重新提交并获取有效报价，不自动恢复一个已失败任务重复调用。已提交的 provider job 继续查询/恢复，不因余额降低停止对账或重新提交。

- DB 短租约领取有限批次；每次只推进一个可恢复步骤，持久 next_poll_at；用 lease token/version fencing 防过期 worker 提交。
- provider 写调用前持久 dispatch 标记与稳定请求身份；成功立刻保存 job ID。崩溃在“供应商接收但 job ID 未存”窗口，只有供应商支持按幂等键查询才可自动恢复，否则 outcome_unknown，人工处理，不能重新 POST。
- 已有 job ID 的查询是幂等读，可有限退避、抖动并遵守 Retry-After。建议单次 API 15s、提交 30s、单次下载总限 120s、provider task 总 deadline 20min（均为待供应商核验的初始预算）；轮询 2s 递增至 15s，总次数和总 deadline 同时封顶。未知超时不得直接当作可重试失败。
- 多副本共享 DB 并发配额，不把进程 running 当全局锁。建议初始每用户 1 个活动视频任务、全局 2 个转存任务，供应商并发按实际配额；容量不够明确排队/429，不能无限排队。
- 转存先检查来源、边读边限制字节与总时限，建议输出初始上限 100 MiB/任务；需要以实际 provider 样本核验，不假定 Storage 项目上限支持。对象使用不可变确定路径与校验摘要，重复恢复验证已存在对象，不覆盖已发布内容。
- ready 只在视频/封面可用、原子扣款成功后设置；终态与扣款在一个受限 RPC 中完成，幂等键为 attempt。结算请求超时保留对象、状态 settling，按同一键回查；不得因为结果未知就删对象或再次扣费。
- 最终明确余额不足：不置 ready、不分享，标记明确错误；已存对象进入有界清理，不影响图片数据。上游成本由平台承担，这是成功后扣费的已知风险，不伪装成冻结额度。
- 视频扣费经 generation 编排调用 billing RPC，复用 apply_wallet_debit；正式实施要扩充 entry_type 白名单及钱包历史 consumer 的视频展示，不能冒充 image_generation。
- 两次余额预检都不预留资金，预检之后的并发消费仍可能导致最终结算不足；不得跨外部调用持有钱包事务锁或声称完全无竞争。保留最终结算的原子余额校验、不透支与失败补偿，并把剩余供应商成本风险列为上线风险，而不是擅自改收费模式。
- 分享事务创建 work 并按与图片相同的正式返利配置唯一奖励，复用 grant_bonus_credits；需真实成功扣款和未退款证明。首次分享使用既有账户字段 image_plaza_first_share_completed_at 作为跨媒体唯一事实，保留历史值、名称暂不重命名，通过前向迁移更新注释；不建 video_first_share 字段。两条分享 RPC 共用同一账户级首次事实判定/原子更新协议，统一锁顺序，跨媒体同时分享也只能从 NULL 转换一次。
- 共用首次资格不意味着将现有逐作品返利改成“只有首次才返利”；保留图片既有奖励条件、比例和舍入口径，视频采用同样规则。视频奖励可独立保存其作品引用，但规则、首次事实和幂等保障不另起一套。两端配置响应/缓存消费同一个 has_completed_first_share，任一媒体分享成功刷新共同配置与钱包。

可观测性使用 pino：request/attempt/阶段、类型、模型业务 ID、耗时、重试计数、租约争抢、provider 错误码、队列年龄/数量、结算待恢复数量；原始错误 `{ err }` 在进入日志前保证不含上游 body/签名 URL。不得记录 prompt、图片、完整 URL、密钥、initData 或私人输入。高频 poll 成功只聚合统计。

降级：视频不可用不阻断图片；翻译失败可保存未译文并在全选可见，后台有限重试，不能让翻译阻塞播放；封面缺失不得在列表临时下载视频抽帧；独立展示占位/重试并保留状态。无供应商取消能力不提供伪取消；离页只是停止前端轮询，后端任务继续。

## 8. 加载与播放性能

- 列表只传卡片摘要，懒加载封面、有宽高/aspect-ratio、可见首屏优先；保留当前骨架与缓存，切筛选显示刷新状态而非把旧内容当新结果。
- video DOM 在用户点击后才挂载/设置 src，`preload=none`、`playsInline`、controls；列表与历史使用 poster 图片，不建几十个播放器。页面离开/隐藏暂停；同页最多一个视频播放。
- 播放签名点击时请求，返回后尝试 play，浏览器拒绝自动续接则显示原生播放按钮；失效仅重新签名有限一次，不无限重播或刷新整个页面。
- 文件优先使用已验证的 MP4 H.264（有音频则 AAC）、fast-start 和 HTTP Range/206；真实签名 URL 必测 Range、CORS、seek。不将整个视频代理进 Node 内存，不以 HEAD 成功替代播放验收。
- 封面优先使用供应商明确返回且获准转存的 poster；首帧输入只能作为说明清楚的备用预览，不能谎称输出截图。无可靠封面/编码保证时属于供应商上线阻塞；当前未证明有 ffmpeg 等转码依赖，不在此规划自动引入。
- 工作室并行加载 config + 最新一页 messages；历史抽屉打开才加载列表；旧消息向前分页，建议首批 20 条，活动状态单独短轮询，后台页面暂停、聚焦立即回查。
- 封面签名复用到期前缓存或批量签名（SDK/图片变换能力需核验），不要在每次 poll 重新签所有历史。列表缓存的摘要不能冒充详情完成态，需要明确占位类型。

建议性能门禁（目标而非测量结果）：同一 Telegram 设备、同等网络、冷/热缓存各至少 20 次；列表 API p95 ≤800ms，首屏可交互 ≤2s，工作室/详情主体 ≤1.5s，点击播放首帧 ≤2s；图片指标相对实施前 p95 退化 ≤10%。播放首帧排除生成等待，但包括签名与取媒体。测量失败须记录设备/网络/样本和分段耗时，未达标不得宣称“秒开”。列表打开视频正文请求数必须为零，比纯耗时指标更硬。

## 9. 演进、停止和恢复

1. 按已确认五项产品决策审核计数细则、混合会话兼容和并发成本风险，核验供应商；确认 test 环境，采集前置 shape/权限/存储配额，不读业务行。
2. 新增兼容 migration：共用会话扩展、视频内容对象与索引；账务/RPC；Admin 配置校验与默认关闭开关。逐文件先 test 后另行批准 production。
3. Backend 先支持双版本，视频关闭；Admin 支持草稿验证；Frontend 使用新聚合接口并保留旧图片路径。
4. test canary 验证无图/单图、用途映射、拒绝多图、恢复、扣费、播放与性能；仅已核验模型可开放，六模型完整交付需要六份证据。
5. 受控用户灰度 → 容量放量；任一重复扣费、越权签名、不可恢复未知任务、图片回归或容量超限立即停止接收新视频。

回滚顺序：关闭视频新受理/可选隐藏广场视频；保留能够读取视频历史和推进已接收任务的兼容 Backend/worker，不能一键停 worker 留付费任务悬挂；必要时保留专用恢复实例，最终对账后再停。退回图片 UI 不删除视频任务/账本/对象。旧 schema 不收缩、无破坏性 drop；缺陷采用 reviewed forward-fix。锁等待超预算、权限不符、前置 shape 不符时停止 migration，不自动继续下一文件。

本轮没有数据库连接或媒体测试，所有实际环境能力、性能数值、模型能力与生产状态均未验证。实施验证矩阵见 implement.md。

## 10. 视频初始作品全量导入（后续实施）

### 本地数据证据

来源：`D:/JobExe/ST/翻译包/civitai_venice_nsfw_videos.xlsx`；2026-10-16 只读解析 ZIP/XML，未执行公式、访问单元格 URL 或下载媒体。文件 5,208,439 字节，SHA-256 为 `cbbd1dff5f007f62007896e45cf3907473dbc75a4605b0f1fdd3def1b6559642`。Data 工作表含表头和 5,097 条记录；来源 ID 与视频 URL 各 5,097 个唯一值，不能据此证明链接有效或授权完整。

| 模型标签                  | 记录数 |
| ------------------------- | ------ |
| MiniMax H3 Max            | 716    |
| MiniMax H3 Max R2V        | 1,112  |
| Seedance 1.5 Pro          | 583    |
| Seedance 2.0 R2V Enhanced | 686    |
| Wan 3.0 Pro               | 1,880  |
| Wan 3.0 Reference         | 120    |

七列为 Venice 模型、正向提示词、Video URL、Civitai Video ID（内部续爬去重）、热度（Like + Heart）、可能的垫图列表、prompt_zh。前五列均非空；中文提示词 5,082 条非空、缺失 15 条；候选垫图 901 条非空。候选字段并非以 `[` 开头的 JSON 数组，本轮未确认其具体分隔格式，不直接用 JSON.parse 或猜测图片角色。工作簿没有可靠的时长、分辨率、封面、生成参数与发布时间列，必须探测/核验或保留未知，禁止编造输出参数与历史生成事实。

### 复用、映射与不变量

- 已检查 `D:/codeReposity/wq/ST_miniapp/packages/backend/src/features/image-plaza/seed-import.ts` 和 `D:/codeReposity/wq/ST_miniapp/packages/backend/src/scripts/import-image-plaza-seed.ts`：已有 xlsx 依赖、默认 dry-run、审批 manifest、目标确认、分批/并发、去重与资源清理模式。图片 parser 严格要求五列表头及图片模型映射，不能直接导入本七列视频表；复用小型 helper/模式而非把视频伪装成图片，不建通用 ETL 框架。
- 元数据保存在拟议 experience 视频作品/产物对象，媒体转存 Supabase 私有 Storage；使用 `origin=seed|generated` 判别并约束各自必填字段。seed 保存 source=civitai、source_video_id、来源模型标签、原始 prompt、prompt_zh、source_heat、候选输入元数据、批次/文件摘要及审核依据；来源 URL 仅限受控导入/审计，不暴露到 feed 或日志。以 `(source, source_video_id)` 唯一去重，视频 URL/摘要辅助发现冲突；源变更需显式审核，不覆盖已发布内容。
- source_heat 是外部历史热度，不制造本地用户点赞行。是否沿用图片 seed 的热度初始化排序规则须在实施前核验；保留源值、分离本地互动，重跑不能重置点赞或热度。导入发布时间表示实际入库/发布，不冒称来源发布时间。
- 候选垫图列表作为来源元数据完整保留，不受用户上传最多一张的限制；它不是生成输入列表，不自动成为首帧图/参考图/垫图或公开可复用资产。确认授权、媒体有效性和用途后，“用同款”最多映射一张；多候选不得静默取首项，须明确选择一张，未确认时要求用户自行补图，无图提交仍按模型能力校验。保留现有中文译文，15 条缺失走明确补齐流程；不在导入中隐式调用付费翻译/生成。
- seed 不创建虚假 user/attempt/quote/charge，不触发分享奖励、不改变首次分享资格；用户用同款产生的新任务仍执行正常余额、计费和分享规则。生成任务的 ready 结算约束保持不变，种子媒体就绪是独立来源分支而非绕过生成结算。

### 导入门禁、恢复与全量验收

1. 功能、schema、播放与权限验证后，先本地 dry-run：检查文件摘要、七列、类型/长度、模型映射、候选字段格式、重复、缺译文和授权 manifest；只输出计数/安全错误码，不提交原始表格、提示词、媒体 URL 或敏感审核材料到 Git。
2. 明确 test/production 目标、转存和公开使用授权、内容审核、Storage 容量/流量预算与媒体探测手段。文件大小不代表视频总大小，不能承诺 5,097 条能在既定配额内完成；小批 test 成功不等于 production 授权。默认开关值也不绕过供应商限制或素材审核。
3. 有界分批、并发、下载超时/字节限制与安全 URL 校验；幂等下载/存储才有限退避重试，拒绝跳转到私网。视频及封面校验完成后再原子发布元数据；网络调用不占 DB 事务。确定对象路径与摘要用于恢复，存储成功但 DB 响应未知先回查，禁止盲删可能已引用的对象。
4. 按来源身份记录进度/失败原因，断点重跑不重复作品或覆盖互动；不为导入调用 Venice 重新生成。异常记录留在受控对账清单，修复后补入；下架/回滚按导入批次操作，只清理确认无引用的本批对象，不删除用户生成或财务记录。
5. 全量目标是 5,097 条，不抽样代替交付；逐条归入已导入/已存在/待修复并使总数相等，待修复未清零不能标记全量成功。缺授权/失效媒体需修复或另行确认范围调整，不能为凑数发布无效或未审核作品。最终验证六模型数量、中文字段、混排/分类计数、点击播放、重复执行、零扣费/零返利与图片回归。
