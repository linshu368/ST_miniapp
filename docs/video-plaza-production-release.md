# 广场视频 Cloudflare 生产上线清单

2026-11-18导入授权后的最新复核：生产视频基础三表、Stream交付表/UID/链接及视频RPC已经存在，不得再重跑base/Stream扩展。Railway当前`9f21f4a3`（部署`78159c80-afa0-466b-89dc-3b8c50c809ea`）仍是image-only读取代码，直接导入会触发作品hydrate失败；用户明确选择自己先上线，之后由助手继续导入。10份原样种子SQL已复制到`packages/shared/migrations/`，哈希/批次见任务`production-seed-import-manifest.json`；必须随选定GitHub ref提交后才能workflow读取，当前未自动commit/push、未执行生产数据写入。`CLOUDFLARE_ACCOUNT_ID`目前是外部暂存、尚未部署的变更。下方“已核验生产实况”为前次审计记录，执行前以后续实时核验为准。

核验日期：2026-11-18（Asia/Shanghai）。范围仅广场视频与指定目录的初始素材。本轮只读访问生产部署、目录/迁移元数据、Cloudflare库存和封面，没有执行生产DDL/DML、改变量、部署或生成任务。

## 结论

**素材和两份生产兼容迁移已生成并通过隔离验证，尚未在远端执行。** 生产没有视频基础结构，早期基础/配置SQL与后来上线的钱包类型及运营配置登记机制冲突。须按下列新迁移顺序逐文件验证，再发布兼容应用，最后导入10批初始数据。隔离演练不替代独立测试环境和生产执行前复核。

## 已核验生产实况

- Railway：`gallant-insight / production / stminiapp`，`stminiapp-production.up.railway.app`；main提交`25a6f1ce23170a7db411b7e03eb72a5681e26f9b`，部署`256448f5-1167-40d3-a2a9-1697b9ad4f93`成功，1/1副本在线，无待提交变更，health实际200。审计时素材候选为`859bc0d0`；本轮生成SQL的工作区HEAD为`ea9de18c`，均不能等同线上版本；线上main尚无广场视频/Stream实现。
- Supabase：确认生产项目`wbtsfzozlmurljvglhpn`，ACTIVE_HEALTHY，健康建议为空。media_plaza已有8张图片表，RLS开启，anon/authenticated不能直接SELECT，service_role可读。不能重跑图片建表/搬域SQL。
- video_quotes、video_attempts、video_artifacts、video_delivery_jobs及视频reserve/refund/交付RPC均不存在，作品/消息表也无视频列。因此本次无生产旧广场MP4回填或清理。
- 当前钱包helper是bonus-first，entry_type只允许chat/image；ledger CHECK另外支持creator_reward、creator_reward_reversal、survey_reward，且为NOT VALID。
- 运营配置已采用managed_config_keys登记表/FK；旧config_drafts_config_key_check、config_releases_config_key_check不存在。视频模型validator不存在，标签validator仍为旧形状，首发分享旧settings列已删除。
- 相关图片/视频文件多数未登记仓库账本，但图片结构已存在；不得按“未记账”批量重跑。相关账本查到11-11专项优先钱包和11-17配置登记迁移，视频迁移未登记，视频结构亦未存在。

## Railway与运营配置

- 已有DRAMA_STREAM_HOST、DRAMA_STREAM_KEY_ID、DRAMA_STREAM_PRIVATE_KEY、VENICE_API_KEY变量名。OAuth隐藏值，本轮未证明生产签名材料有效或Venice余额充足。
- 最终复核仍缺CLOUDFLARE_ACCOUNT_ID。核验期间生产同SHA重新部署，现已出现VIDEO_STREAM_API_TOKEN变量名，可作为管理Token别名；其权限/值未验证，不能用Codex OAuth替代。
- 最终复核已出现VIDEO_PLAZA_WORKER_ENABLED变量名，但值被隐藏，不能确认开关状态。迁移/导入期间须明确保持false，受控验收后再启用；当前main尚无视频worker实现。
- 模型provider映射、规格和价格走运营CLI的whoami、config describe/get、draft set、diff、publish、get审核流程，不能直接复制TEST价格。本机CLI返回setup_required，生产目录/价格现值未核验，本轮没有设置CLI或登录。
- 生产Venice余额/Key支出额度需独立核对，不能用TEST此前402代替生产实况。素材可播放与付费生成成功分别验收。

## SQL顺序与处理

1. `20261118_media_plaza_video_production_base.sql`：补当前视频契约的业务对象、混合作品/消息列和钱包/分享RPC。扩展现有ledger类型集合，保留NOT VALID、creator/survey等已有类型、bonus-first、helper OID/owner/ACL及幂等；不改历史流水。分享不写已删除settings列，保留现有私有封面桶和原图片来源校验。
2. `20261118_media_plaza_video_production_config.sql`：注册视频目录key/validator，保留登记表/FK、已有key、NULL行为和最外层校验主体/属性；不新增before包装、不查找已移除CHECK，不直接写价格或发布配置。
3. `20261028_image_plaza_tag_groups.sql`：供当前分支分组标签消费；适配配置后复核validator前置，再执行。只扩展校验，不重写标签数据。
4. `20261029_media_plaza_image_artifact_video_reference.sql`：生产缺source_image_artifact_id，完整“图片产物做视频参考图”流程需要这一步；保留归属和RESTRICT生命周期。
5. `20261117_media_plaza_stream_delivery.sql`：基础对象存在后扩展UID/链接、交付队列和fenced RPC；先互证结构/账本，不能重复添加已有对象。原注释是TEST实施说明，生产复用须重新验证。
6. 新base已包含钱包守卫和分享修正，**本路径无需再执行**`20261117_media_plaza_video_wallet_entry_guard.sql`与`20261117_db_reorg_p3b1_video_share_first_share.sql`。不重跑完整旧钱包或旧视频迁移。
7. **先发布兼容混合视频行的Backend、Frontend和Admin/CLI消费者，再导入作品**。基于最新main保留上游行为，worker仍关闭。当前image-only后端可能无法hydrate artifact_id为空的视频行；先导入会影响现有图片广场。
8. 审核10批素材SQL，纳入唯一迁移源`packages/shared/migrations/`并提交到workflow指定ref后，按01→10逐文件执行。现在这些文件仍在仓库外，workflow无法读取本机绝对路径。每批matched_works/published_works应与预期一致，再进入下一批；不并行导入。
9. 读链路和一次受控生成验收后，再评估`20261117_media_plaza_stream_contract.sql`：所有产物UID/链接非空，无在途视频任务、旧writer退出、旧列无引用，才删除storage_path/旧seed RPC。另取生产依赖/锁/容量证据，不沿用TEST结论。

正式执行均通过Database Migration选择production，按仓库要求填写生产确认，一次一份、检查账本和checksum；本轮未触发生产workflow。

### 两份旧文件禁止原样作为上线步骤

- `20261027_media_plaza_video.sql`的静态wallet_ledger CHECK会遗漏生产已有creator/survey类型，并带来整表验证/锁风险；原分享函数还写废弃settings列。需要新的兼容基础迁移，不能直接照抄执行，也不改历史文件。
- `20261027_media_plaza_video_config.sql`会新增before包装链，并查找两条生产已删除的config_key CHECK，当前生产会失败。需要登记表/FK方式的适配迁移。
- 不在生产运行`20261117_media_plaza_stream_test_assets.sql`、`20261028_media_plaza_video_seed_test_10.sql`或TEST的13个MP4 cleanup；不重跑已有图片schema_move/initial_feed_order迁移。

## 初始数据

来源：`G:/JobWork/ST/video-plaza-production-sql-20261117`。

- 原表5082条，4987对视频/封面可初始化，95条源站404保留在unpaired清单，不补空记录。
- 10份SQL的SHA256全部匹配原manifest；4987个source_video_id、Stream UID、封面路径和source_row均不重复。所有输入小于200MiB，尺寸符合目标约束，英文prompt和中文译文非空，4987条作品数据均通过shared契约。
- 模型分布：wan-3-0-pro 1836；wan-3-0-reference 119；seedance-2-0-r2v 682；seedance-1-5-pro 576；minimax-h3-max-r2v 1084；minimax-h3-max 690。素材不包含模型价格初始化。
- 本轮重新读取Cloudflare库存：4987存在/ready/private，主机和尺寸全匹配，无allowedOrigins限制。六模型各一条签名HLS返回200，清单3–5档；使用本地授权材料签名，不代表已核验Railway隐藏的生产密钥值。
- 生产media-plaza-video桶存在、私有、允许JPEG；六个模型的封面样本读取200、JPEG头和长度匹配。11-17交接曾全量回读4987张，本轮没有重读全部封面字节；执行时每批SQL会逐对象核对存在/MIME/长度。
- 每条插入一个产物和一个作品，共9974条业务记录；不建用户/生成任务，不扣费、不发分享返利，不重生成或重上传视频。
- title取prompt前80字符，description前500字符，完整中英文prompt保存在snapshot；tags为空，published_at为2026-01-01加source_row秒的固定排序时间，不当作真实生成时间。initial_feed_order不重排，不改变现有图片目录顺序。

10批同一文件前缀为`20261117_media_plaza_video_stream_seed_production_`：01.sql至09.sql各500条，10.sql为487条。原10份SQL、manifest.json、unpaired.json保持原样。

新交付文件：initial-data-index.csv（4987条逐资产索引，不复制prompt）；initial-data-audit.json（计数/哈希/实时核验）；production-environment-audit.json（脱敏生产实况）；专项验证JSON；INITIAL_DATA.md（目录内说明）。

## 验证、停止和恢复

- 隔离PG/WASM的Stream目标结构夹具执行10批得到4987产物+4987作品；首批重放不增行，缺封面或资产冲突均拒绝并回滚。它不等于当前生产所有历史结构/业务行的完整升级演练。
- 新兼容迁移已在PG17/WASM隔离夹具验证：真实钱包/视频RPC、bonus-first/main-only、预扣/退款/分享重放、零/正返利、原图片来源规则、生产类型/配置函数及FK形状、ACL/RLS、部分结构/未知形状拒绝与事务回滚；接续标签、参考图、Stream与10批4987条初始数据成功。夹具复用采集的生产目录定义和真实仓库SQL；旧配置委托以合成拒绝器验证原委托路径保留，不冒充所有生产配置的完整回归。单连接WASM不覆盖多连接并发、托管Storage或生产全量行，仍需独立验证环境及执行前catalog/容量复核。
- 两份新SQL均一次性，重复执行明确拒绝；若SQL提交而迁移记账失败，先互证catalog、claim和checksum，另审恢复，不盲目force_rerun。配套`migrations/tests/`同名文件只读验收，不创建用户或真实扣费。
- 落位例外：为部署当前TEST/应用已有契约，base复用video_quotes的M和video_attempts的历史混合J/M字段，registry继续moving；没有在旧逻辑对象加新字段。拆往billing/jobs需同步改消费者，另立任务；PR必须注明这一现存债务。db-contract的6条提示含上述债务，以及两处媒体时长duration_ms被误判为测速字段；它们表示内容时长，不是性能观测。
- 哈希/资产/封面不匹配、未知函数形状、权限改变、锁超时、checksum漂移或批次数量不符立即停止；结果未知先查提交及ledger/claim，不盲用force_rerun。已软删作品不由重跑自动恢复。
- 验收覆盖列表/详情、分片和签名刷新、图片参考、一次受控新生成、失败退款与日志关联。工程师可复用@image/@drama补后续重复验收；用户免本地UI，本轮不做UI/真机/P95、不填造样本。
- 异常先停视频受理/worker，保留云端资产、作品、任务及账务，采用forward-fix。视频行已导入后不能回退到旧image-only后端；只回到已验证可读取视频行的版本。contract后更不能恢复旧MP4 writer，不用删数据/重生成代替恢复。
