# 技术设计：广场视频统一使用Cloudflare Stream

## 1. 范围与证据

只改变未来生成和TEST现存13个产物。用户明确无需旧视频播放兼容，广场功能尚未生产发布；此为用户范围确认，不冒充生产数据库查询结论。TEST已确认project_ref、13行最小资产元数据、13/13对象HEAD及长度，未执行远程写入。复用研究和官方资料见research.md。

## 2. 复用与最小充分方案

- 复用现有Venice queue/retrieve与报价、预扣、退款、并发上限，不重新生成这13个视频。
- 后端抽出短剧的Stream本地签名原语，短剧旧调用保持行为；广场采用独立有界清单缓存，避免挤出短剧工作集，冷请求不等待清单管理请求。
- 前端提取现有原生HLS/hls.js装载原语，保留低档起播、动态加载、清理/取消、迟到结果防护。短剧手势/续看/实验/seek业务不进入广场。
- 不新增R2、转码队列服务或统一供应商框架；Stream完成多码率处理和分发。管理API只参与上传/后台处理，不进入播放首帧关键路径。
- 原Supabase视频上传和取址消费者改为Cloudflare；不保留运行时MP4回退或旧字段别名。封面仍使用Supabase。

## 3. 数据落位卡

### 已有对象

补齐registry中历史video_quotes（当前位于media_plaza的M，费用归属债务只登记、此次不重组）、video_attempts（E，已有J/M字段标记moving、不给它加交付租约或价格列）、video_artifacts（E，active）、相关RPC的现状。证据来自历史migration和本次最小TEST元数据，结构仍须用指定TEST的只读结构采集/inspect互证。

### media_plaza.video_artifacts：产物实体E

权威writer仍为影像发布/导入RPC，消费者为工作室、作品详情、分享与取址。新增stream_uid及稳定playback_url；封面路径、尺寸、时长、原视频字节数和origin保留。长期存稳定链接，不存JWT或到期观看地址。新增字段与产物在发布时一次写入，同生命周期，符合CONTRACT §2.1。经过13条切换后要求stream_uid和playback_url非空，移除旧storage_path读写及列；不为未来供应商增加storage_provider分支。mime_type继续描述源视频MP4，HTTP播放format明确为hls，不能拿源MIME判断播放器。
生命周期与现有产物一致：被会话/作品引用时保留，不设新增自动删产物策略；Cloudflare对应资产随受控产物删除/补偿流程处理，不碰短剧资产。

### media_plaza.video_delivery_jobs：后台交付任务J

权威writer为影像delivery worker/RPC，读者仅worker及受权限约束的任务摘要读取。通过attempt_id关联已有生成尝试；artifact_id仅在发布完成后填入。唯一attempt_id防止重复交付。记录stage/status、stream_uid或TUS上传会话、重试计数、next_run_at、deadline、租约owner/expiry、终态安全码，禁止费用/观测耗时混入。lease使用SKIP LOCKED和fencing；不得向moving的video_attempts增加J字段。
成功/已补偿的终态任务保留7天后通过既有worker有限批次清理；未解决未知结果保留至对账完成，不按TTL丢弃。TUS临时能力在完成/终止时清除，不出日志/Markdown/公开API。与产物/attempt同域引用；不新增跨域FK，账务只调billing既有RPC。

### 函数与配置

新增enqueue/claim交付任务RPC；publish*video_artifact改为校验交付任务租约、写Stream实体并结束原attempt和job的短事务，保持按attempt的幂等。不新增\_before*包装链或保留旧函数重载。失败/补偿按既有billing退款RPC及数据库行锁/CAS收敛，不复制价格和流水。
用户实施中明确要求直接复用短剧配置：runtime-config.ts继续读取DRAMA_STREAM_HOST/KEY_ID/PRIVATE_KEY，上传复用通用CLOUDFLARE_ACCOUNT_ID/API_TOKEN；不新增VIDEO_STREAM三变量或前端secret。播放签名不依赖管理Token，不受短剧A/B开关/片单影响。短剧源码仅有签名配置，账户/管理Token在受控部署环境仍须核验；缺失不伪造或提取Codex OAuth。新生成受理前校验完整配置，缺失时先拒绝，不预扣后才发现不可交付。

## 4. 新生成数据流与恢复

Venice完成 -> 原attempt进入storing并幂等建立delivery job -> 持久化上传会话/UID -> 上传现有视频 -> 后台查询编码/清单 -> 取得封面并写Supabase -> 发布产物短事务 -> 原attempt ready -> 清理上游。
仍使用现有generation worker负责模型任务，delivery轮次在同一进程调度机制中有独立有界并发；不让一个长编码占用模型poll轮次。Cloudflare处理中及时展示封面/阶段，未可播不得展示成功。
默认最多2路上传、4路状态读取；管理查询/封面/清单读取均有覆盖响应体的10-15秒上限，上传按文件体积和总deadline限制，编码总预算先设20分钟并允许配置；不与播放P95混合。状态轮询5-10秒、有界退避并尊重429/Retry-After。
按TUS协议用现有observed fetch执行有界单块上传（避免SDK一次长任务跨租约），不把视频暂存进Supabase，不在进程内额外复制整段媒体。临时文件可在本机/worker暂存，源视频直到Cloudflare和DB发布确认前保留；无需再对原片做整段FFmpeg转码，多码率由Stream处理。
TUS创建结果未知时先对账/恢复已有会话，禁止盲目创建重复资产。重启根据job继续同一UID，不再次调用Venice queue。Stream未就绪状态不能当失败瞬间退款，也不能无界等待。
已知转码/交付失败且确定未发布时退费一次；DB发布结果未知先回读产物/attempt，不删可能已发布的视频、不立即退款。失败、退款与迟到publish竞争以数据库CAS/事务防止“已退款又发布”。补偿失败留待有限重试/明确对账，不能把resolved Promise当业务成功。

## 5. 接口与播放器

新DTO将播放与下载分开：artifact/work具有artifact_id及playback对象（format=hls、play_url、expires_at、可选inline_manifest），保留poster/尺寸/时长。公开种子没有attempt，不能继续用attempt_id作为详情刷新主键。
统一取址采用GET /api/image-plaza/video-artifacts/:artifactId/playback，鉴权后允许本人生成产物或已发布作品关联产物；刷新位置与暂停状态保留。旧attempt状态读取仍服务生成进度，旧按attempt取址及video_url MP4别名不保留。
下载采用按artifact读取的独立接口，返回processing/ready/failed及短期MP4下载地址，启用Stream下载副本。私有观看/下载都签名，下载JWT使用供应商要求的downloadable声明；不把HLS清单当MP4下载。下载准备不阻塞已就绪HLS播放，UI给出处理中状态、有限重试与错误提示。
结果卡与详情共用HLS装载；低档起播再由ABR升降档。列表只预取地址/封面，不批量预载片段。进入可视区域/点击时装载，卸载、切源、后台和迟到请求不恢复旧媒体。保留移动端用户手势内的播放启动，不用attach完成冒充真实首帧。

## 6. 多码率就绪

核对Stream处理状态和实际主清单；readyToStream不等于全部档位完成。对足够分辨率源验证至少两个不同BANDWIDTH的有效variant，并验证子清单/分片可访问。不能自行猜测固定档位一定存在，不通过上采样制造虚假清晰度。
HLS进入可播成功须满足完整处理和清单准入；编码期间的“正在处理”即时反馈与最终播放首帧分别计时。主清单缓存预热不阻塞首次播放，不缓存包含身份差异的观看token。

## 7. TEST全部13条迁移

准确目标zoqelpfhurwehlvypryl；13条=10个civitai_seed+3个generated，74,247,409字节，13/13源可读。9份已校验本地副本可复用，缺少的1个种子和3个生成源从TEST恢复并校验。仅此13个视频，封面和全部业务主键不变。

1. 将生成受理/worker置于本次TEST切换维护状态，保留读取检查；确认Cloudflare目标账户与TEST资源命名空间、可用额度及管理权限，不碰现有短剧资产/账户webhook/签名密钥。
2. schema扩展迁移：artifact先允许新增字段为空，建delivery jobs及新RPC；逐文件执行/记账。
3. TEST专用离线工具preflight锁定13个artifact、原路径/大小及manifest摘要；逐个上传、checkpoint同一UID，核验私有访问、多档、时长/方向、封面及实际片段。日志只输出安全ID/计数/阶段，不写签名URL。
4. 全部13个就绪后，由映射生成仅TEST可执行的数据migration：13行CAS核对原路径与ID，一次事务写UID/稳定链接，不改会话、作品、点赞、价格、流水或奖励。失败整笔回滚，不能只切部分。
5. 发布新Backend/Frontend并验证13/13列表、详情、生成历史和操作；执行contract迁移收紧非空并移除旧storage_path/旧签名读取、退役Supabase视频写入命令。生产不执行。
6. 13/13验证后，按已核对清单只清理这13个Supabase MP4对象，封面不删；保留独立本地恢复副本及对象hash。清理前可恢复DB映射，清理后如需恢复先从本地还原源，不能声称删除可无条件撤销。
   数据库结构和数据切换都以packages/shared/migrations为唯一源，通过Database Migration workflow(environment=test)逐文件运行。工具只产生审查后的SQL/映射，不绕过workflow直接改表；需要提交/推送workflow所需文件时遵守最终文件审查，不自动推送。该发布依赖在最后交付中明确，不把“本地生成SQL”冒充已执行。

## 8. 日志与观测

统一business_module=image，修正当前video值被过滤的问题。新轮次用runObservedJob，逐任务withBusinessContext绑定可信user/image_conversation/attempt/artifact/work；HTTP与后台都有独立根和可关联request/trace/span。Cloudflare UID不冒充UUID video_id。
新增upload、encode、publish、playback、download、cleanup阶段operation/event及中文展示。使用允许的固定provider、stage、状态/结果、数量、耗时、错误码；补字段必须同时过EventFields/安全投影/Pino JSON/告警链，不能只在调用点多传对象。
info为受理/实际就绪/成功摘要，warn为可恢复超时、429、刷新、拒绝，error为确定失败和补偿失败；保留一次终态、并发隔离、{ err }安全cause。沿用默认关闭告警与投递失败隔离，不自动向外发送消息。
新增严格、有界、限流的影像播放观测接收：首帧、seek恢复、stall聚合、错误/中断，可关联artifact及取址请求；接收端重新鉴权并验证访问权，绝不信任客户端user_id。只记Pino/既有观测出口，不建分析表、不混入drama统计。ID不进指标/Sentry标签；禁止URL/token/私钥/prompt/完整响应。

## 9. 性能、发布与停止条件

Android/iOS无本次线上样本，基线null；既有目标页面1500ms、取址800ms、参考网络首帧/未缓冲seek2000ms，均为待实测目标，不保证任意网络下上限。发布后24小时、低样本7天复查，并与短剧原数据按同版本/网络条件比较。
出现未知账户/环境、13条集合变化、源hash或大小变化、私有访问失效、清单非多档、重复UID/发布/退款异常即停止迁移，不扩大范围或自动放开权限。回退停止新受理和worker、保留云端与数据库事实，优先forward-fix或恢复到本次Stream版本；不新建旧MP4运行时兼容分支。

## 10. 风险评估与待部署事项

尚未核验Cloudflare账户/额度/长期管理secret，本会话也尚未加载已授权的Cloudflare MCP工具；这些是受控TEST联调前置，不能用Codex OAuth代替服务端凭证。实现可先做本地边界验证，真实迁移必须在连接就绪后进行。
新J表、租约、幂等、退款竞争、鉴权和协议切换属于高风险，需回归锁定：优先扩展已有测试；允许为全新delivery协议及SQL状态机新增最小专项测试，避免只测试实现镜像。

2026-11-17实施修订：用户明确“直接复用短剧中得配置”，替代原独立VIDEO_STREAM配置设计。OAuth重新登录成功，但本会话仍无Cloudflare工具，不等于Stream写权限已验证。
