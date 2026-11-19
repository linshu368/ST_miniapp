# 当前验证证据（2026-11-17，本地候选）

## 生产种子已导入（2026-11-18 20:39，Asia/Shanghai）

- 用户明确授权导入，且通知视频版本已上线。Supabase目标wbtsfzozlmurljvglhpn确认ACTIVE_HEALTHY；cae4b356实际包含视频/混合行读取器，Railway生产部署成功，Stream变量齐全且无暂存修改；GitHub生产部署记录证明Frontend/Admin为相同SHA。Vercel连接账户不覆盖生产团队，因此使用仓库部署记录核对，未修改任何部署。
- 只读workflow 44303150060：10份种子均not_applied，零checksum漂移。用户期间合并main/dev到分支，重新确认10份SQL及workflow/apply/inspect脚本字节不变后，使用feat_video_park的d0dc98c3执行。未提交/推送，未force_rerun。第二批首次调用在GitHub GET阶段EOF，核对没有新run后才重新发起；无重复SQL执行。
- 按01→10串行执行，前九批各500，末批487。每批matched_works/published_works与预期一致，工作流success且记录对应checksum；10个run链接及校验和保存在production-seed-import-execution.json。
- 最终生产API仅HEAD聚合验证：4987视频产物、4987视频作品且全部可发布，缺失Stream UID/链接0；原8047条可见图片作品数量不变。未通过MCP读取业务行；MCP仅复核目录/约束/权限，钱包creator/survey/video类型、NOT VALID、bonus-first和无废弃分享列写入均保留。
- 导入前重新读取Cloudflare库存，4987存在/ready/private、主机/尺寸匹配；六模型签名HLS 200、3–5档；生产私有桶JPEG允许，六封面样本200/长度/JPEG匹配。所有4987封面的对象/MIME/长度由批次SQL逐项核对，不冒充本轮重新读取全部封面字节。签名使用本地授权材料，不输出token，也不宣称实际用户页面UI验收。
- 最终Railway最新为4a2f1d06 / bce3779c-d268-4370-bdf6-73d922c43916，SUCCESS，实际仍包含视频读取器，health200。未发起付费生成、发布模型价格、切worker、清理资产或执行storage_path contract；用户免本地UI，未测UI/真机/P95。汇总见production-seed-import-verification.json。

## 生产兼容SQL生成（2026-11-18）

后续导入授权复核：生产已存在视频/Stream基础对象，不能重跑早期引导。Railway最新9f21f4a3（78159c80-afa0-466b-89dc-3b8c50c809ea）仍无video-stream/混合读取器；真实hydrateWorks对视频NULL artifact触发image_plaza_work_shape_invalid。用户选择自己先上线，再继续导入。本轮10份原始SQL已逐字节/哈希校验并纳入唯一迁移源，合计4987条，迁移命名通过；无生产DDL/DML或部署，未提交推送。下一步门禁与manifest见implement.md，不把生产结构已就绪写成应用已上线。

- 交付`20261118_media_plaza_video_production_base.sql`与`20261118_media_plaza_video_production_config.sql`，各有同名只读postflight；未修改历史迁移、未执行远端DDL/DML、未改Railway变量/部署、未发布价格或发起付费生成。任务仍有远端验证/发布门禁，未标记整体完成。
- 新隔离PG17/WASM回归复用真实钱包、图片表、视频RPC与脱敏catalog定义：原creator/survey保留且可发奖；bonus-first/main_only、扣退一次、零/正返利分享重放；原图片来源非空规则、桶设置、service-only/RLS；配置原lookup/标签/outer属性及FK保留，旧key/drive分支仍校验；未知钱包守卫/outer、部分结构、validated类型CHECK/缺FK/公开桶拒绝并全事务回滚，重复执行安全拒绝。旧配置委托使用合成拒绝器，仅证明委托保留；不代表全部生产key已实测。
- 同一升级夹具接续标签/参考图/Stream迁移及外部10批素材SQL，逐文件哈希匹配，得到4987 seed产物/作品；重放不增行，缺封面/资产冲突拒绝回滚。原图片及生成/分享事实保留。单连接WASM不覆盖多连接并发或生产所有历史行；没有远端TEST执行或生产容量实测。
- 命令：`node scripts/test-video-production-migrations.mjs <已安装PGlite入口> <外部素材目录>`；既有`test-video-wallet-reservation.mjs`与`test-video-stream-delivery.mjs`均通过。shared 25文件256项、Backend广场/播放12文件102项通过。8包`pnpm -r typecheck`通过；第一次因合入上游后本地Prisma Client过期缺listing失败，按当前schema重新generate后通过，未改源码或数据库。
- 迁移命名、日志AST/规划、模块payload、复杂度及格式/diff检查通过。db-contract通过但6条提示已逐项解释：旧M/J落位债务复用（需PR注明理由）、两处媒体时长非测速。复杂度仅既有基线警告。本轮只改SQL/回归脚本/文档，shared无build脚本，运行时TS/依赖未改，不重复有Sentry上传副作用的Frontend构建；用户免本地UI，未做UI/真机/P95。
- 两份一次性SQL不可盲目force_rerun；提交成功而记账未知时先核对catalog/claim/checksum，另审恢复。先结构后兼容应用再种子，异常停worker并保留资产/账务forward-fix；视频行导入后不能回退image-only Backend。执行顺序/PR落位例外说明见`docs/video-plaza-production-release.md`。

2026-11-18追加：生产只读核验及4987条初始化素材已整理，见docs/video-plaza-production-release.md。生产无视频基础表、旧M2钱包约束及M3配置迁移不兼容现状，尚不能直接上线；本轮未执行生产写操作。10批哈希/契约/隔离SQL验证通过，4987个Cloudflare库存重新核验ready/private，六模型签名HLS及生产封面样本通过。完整封面字节复核为11-17交接证据，生产长期密钥/余额、模型价格和兼容升级另验。

## 真实TEST资产和Cloudflare

目标zoqelpfhurwehlvypryl，13条=10种子+3生成，74,247,409字节。13/13源文件已独立备份并回读SHA-256，恢复目录位于Git之外。13/13已上传Stream并验证签名清单、多档子清单与实际分片；实际每条3～5档，匿名访问拒绝。单条MP4下载副本ready，签名下载经Cloudflare重定向后Range可读。首次未开始上传的创建回执已按精确test资产标记对账补偿，无盲重投；正式13条各有独立UID。

直接使用用户指定backend/.env；复用短剧签名，现有VIDEO_STREAM_API_TOKEN具实际Stream读写能力。原私钥多行未引用导致只读首行，已转换为等价Base64 PEM，并用既有短剧UID真实签名校验。通过同一短剧customer host匹配账户后仅补本地账户ID。未生成替换密钥、未改账户webhook或短剧资产，所有网络校验启用TLS。

TEST-API结构采集（不是MCP/生产结论）：现有video_quotes 13列、video_attempts 34列、video_artifacts 15列；video_delivery_jobs尚不存在。源自确认目标的PostgREST只读OpenAPI，与原20261027迁移相关形状相符。

数据库迁移、应用部署、原Supabase MP4清理均未执行。扩展/切换/收缩SQL已准备；只有本地生成文件不等于远端生效。

## 已运行检查

- shared：24文件253测试通过。
- Frontend：75文件843测试通过；lint通过，存在既有img/短剧Hook警告。
- Backend原全量178文件1910测试在测试专用代理隔离配置下通过；之后新增的取址/权限/种子/观测4条和TUS协议6条另行通过。后续变更继续按最终检查记录更新。
- 本地.env的HTTPS代理会把generation/upstream的localhost真实网络用例错误送往代理，默认命令该1条失败；Windows首次动态导入还会触发默认5秒超时及迟到mock。测试专用临时配置只让loopback绕开代理并将测试上限设20秒，未改产品代理行为或跳过断言；同一全量1910通过。
- pnpm -r typecheck全部8个消费者通过；后续新增测试再补Backend typecheck。
- Frontend和Admin生产构建通过；Admin有既有大chunk提示。Frontend现有构建配置自动上传Sentry source maps，无应用部署。
- 隔离PostgreSQL/WASM执行真实expand/contract SQL，验证旧/过期租约拒绝、更新token、发布重放、退款一次、迟到发布拒绝、未知隔离、浏览器ACL；真实13行数据SQL的环境守卫、CAS全事务回滚和重放通过。单连接不代替多连接锁竞争。
- fixtures协议12项通过；用户随后明确“不需要本地UI验证测试”，已停止相关进程，UI验收未完成。保留HLS fixture契约适配供后续复用。

## 待完成门禁

最终受影响文件校验、人工最终内容审查后才可暂存/提交；未经明确授权不推送。需要受审阅SQL进入远端分支才能走Database Migration TEST workflow。之后执行受理/worker维护、逐文件迁移、Stream应用发布、13/13 API/权限核验和一次受控新生成，最后清理原13个MP4。真实iOS/Android和发布后P95仍无本次样本，不填0，不用Cloudflare探针替代。

## 最终收尾补充

- 最近相关Backend复跑25文件209测试通过，包含取址/越权/attempt-less种子/观测4项、TUS6项、配置复用/坏密钥预拒绝与真实Pino JSON；全量1910及其测试环境修正见上文。
- 全8包typecheck再次通过；日志、复杂度、legacy、迁移命名、DB契约门禁通过。DB-contract只报既有drive_mode修改moving表的无关警告。
- 原lint:imports在Windows将空JSON参数错误解析；等价ESLint Node API按同一.eslintrc、禁inline配置检查1170源文件，0错误0警告。
- 13条数据SQL已在独立PG引擎测试身份拒绝、末行CAS失败导致前12行整笔回滚、13行成功与重复执行稳定。
- 新封面路径实测：Cloudflare JPEG获取、Supabase私有上传、同名upsert、签名回读SHA-256一致；随机临时TEST封面已清理，原13个封面未改动。
- 只读OpenAPI与样本下载的最终报告确认下载ready且Range可读。真实13条云端映射在Git外checkpoint保全；切库和源MP4清理尚未执行。

## TEST 预览恢复与生成故障（2026-11-17）

- 修复前：health 200，用户指定视频详情 503 / IMAGE_PLAZA_UNAVAILABLE。pr-566 已部署73056646，但缺全部DRAMA_STREAM签名/管理变量；本地.env不进入镜像。
- 修复：仅向pr-566 Backend安全复制用户授权.env的五项Stream配置；未输出或提交值。Railway新部署1c35abe9-4257-4ace-860e-9767c2a494c1为SUCCESS，同一源码SHA。
- HTTPS验收：原失败详情200；12个已发布视频的详情、artifact刷新、封面、HLS主/子清单和真实分片全部通过，3–5档。未进行本地UI或真机/P95测试。最初诊断客户端一次403，后续签名公钥验证、UID与host/密钥ID比对通过，正常浏览器User-Agent链路全量200；不把单个客户端失败泛化为播放不可用。
- 生成第一故障：14:47Z提交在reserve边界P0001。只读TEST目录证实11-11重建的helper只允许chat/image，原10-27视频类型丢失；ledger CHECK仍允许视频。新forward-fix只补唯一已知守卫，不覆盖现行钱包主体。
- 用户报告执行后于14:56Z复核：视频类型允许、bonus-first、service-only权限及security/search_path均true；仓库repo_migrations未登记此文件。不使用force_rerun、不重复改库，账本来源需另对账。
- 当前生成故障：14:53:47、14:53:58、14:54:12Z的三个任务均已进入Venice queue并收到HTTP402；三个任务API回读均为failed / video_provider_http_402且无产物。官方Venice视频文档定义queue402为余额不足。需要运营者核对该环境VENICE_API_KEY对应余额/支出额度；本轮未发起额外付费生成、未换模型密钥，不能宣称新生成成功。
- 回归：Backend五文件36项；shared24文件253项；8个workspace消费者typecheck通过。新增隔离PG/WASM加载真实钱包/视频reserve/refund函数，覆盖故障复现、一次扣退、余额不足、bonus-first/main_only、幂等与ACL、未知形状原子拒绝及matching只读postflight；既有Stream SQL交付回归仍通过。单连接不代替并发实况。
- 静态：迁移命名、db-contract、日志规划/AST、模块payload、复杂度及脚本Prettier通过；db-contract有不相关drive_mode moving表警告，复杂度为原有基线提示。无运行时TS/TSX改动，本次保留同SHA原已通过的Frontend/Admin构建证据，不重复构建或上传source maps。
- 根因复盘：部署配置传播遗漏与全局钱包函数重定义丢失后续调用方类型；此前交付测试替代了钱包函数，缺少真实reserve链路。防复发以真实函数联测、预览配置核对、保留helper调用方白名单和逐阶段验收为准。相关规则已补spec，工作区不自动提交/推送。
