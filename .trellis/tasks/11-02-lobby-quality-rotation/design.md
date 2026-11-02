# 技术设计

## 复用调查

公共GET /api/characters已取全量可发现目录、排序快照、运营主推；继续复用discoverableCharacterWhere，公共目录/搜索/最新兼容。featured.ts是列表/详情/收藏统一资格出口，保留与个性化位置分离。
ranking-stats每日job已经只取合格用户，本任务扩展可信历史证据，绝不在请求读聊天历史。runtime-config唯一读口和现有lobby_ranking_params/lobby_pinned_characters草稿发布复用，不加managed key。
CharacterGallery/useCharactersQuery及lobby-return复用；当前公共query和localStorage只按sort、不能放私有顺序。loadedCharacterIds当前未用于保序，需要修正。
现有ui-tests虚构数据、fixture server、roleplay.spec扩展；现有PG17评分集成测试扩展，无新增依赖/平行环境。

## 公共契约（shared先行）

POST /api/characters/recommendation：{action:open|resume|refresh|undo,request_id:uuid,expected_batch_id?:uuid|null,restore_batch_id?:uuid|null}。
返回{enabled,degraded,batch_id,generated_at,expires_at,character_ids,head_ids,previous_batch_id}，nullable元数据；character_ids为全顺序，前端投影公共目录。open到期才轮换；resume优先恢复当前/上一批，不变更current；refresh以expected做CAS；undo要求expected=current且restore=previous，原子恢复。重试复用request_id。
POST /api/characters/recommendation/exposures：{batch_id,character_ids:uuid[<=40]}；只接受用户拥有当前/上批中存在的卡，服务端时间、同批幂等。
所有私有响应no-store，requireTelegramAuth及当前DB用户判定，禁止客户端传user_id。服务异常503由前端保旧；无旧批才退公共排序。上线后对所有鉴权用户返回个人推荐；响应enabled仍为协议兼容字段，不作为运营开关。

## 数据归属和生命周期

miniapp_features.user_lobby_recommendations：单用户当前/上一批全顺序与最多3批头部摘要、操作幂等状态；推荐状态投影，功能移除可删除，唯一写入方后端推荐service。user_id指向app_core.users，删除级联；IDs保存在JSON不产生每卡FK，读取与曝光时重新校验可发现权限。
miniapp_features.user_character_exposures：user+character主键、最近实际曝光、批次去重信息；读写只属于推荐，功能移除可删。FK用户/角色app_core级联；以用户前缀主键服务批量读取/写入，无事件大表。
miniapp_features.character_ranking_scores增可信分/样本/时间/quality_version。只由每日评分job写，quality_version=qualified-v1；迁移不得回填旧不合格分数，低样本保留最近可信证据。证据有效参考窗90天，过旧只探索；当前已达样本但变差不能拿旧高分覆盖。无近期活动不删除可信历史。
以上为运行时产品投影，归miniapp_features，不属于仅分析schema或用户根身份。RLS启用、anon/authenticated无直接读写、service_role/受控后端最小授权；无浏览器直连。原runtime_config仍归app_core。

## 算法与配置

rotation可选嵌在lobby_ranking_params：interval_hours=24、max_repeat=2、exploration_count=2。未配置rotation同样全量生效；历史enabled/rollout字段仅保留配置兼容，不再决定用户是否参与，不更改已执行SQL。运营端只编辑三项参数。pinned增加fixed_character_id可空，老character_ids<=8为加权候选，不再固定旧八张。
纯函数输入可见候选、当期/可信质量、曝光、最近3批、配置、seed、now。先按质量确定可靠范围和头档，再在同档加权无放回；强推最多1（可见且质量底线）、上一批硬避让至重复预算，若质量/分档不足有界放宽重复；早两批降权，标签同类堆叠软惩罚。当期可靠分优先，过去可信仅用于当期缺样本；新评分尚未就绪或可靠候选不足时明确降级，不以任意差卡兑现去重。
曝光权重连续恢复，<=2天0.15，至7天线性恢复至1，8天完全正常；>=14天且可信质量最高1.2倍。主推、回流、题材权重均有限，不能绕过质量分档。
尾部生成时快照固定，不受job/公共目录刷新影响；下架只剔除并从既有尾部补位，新卡可在下次批次加入。

## 可靠性与恢复

单用户短事务+事务advisory lock序列化批次变更；CAS与request_id抵御连点/响应丢失/迟到请求。操作存储有界，避免无限幂等表。外部API超时，最多有限重试且同ID；DBstatement/lock/transaction timeout有界，无外部调用夹在锁内。
曝光合并上报，批次归属+去重；无有效曝光则不写；失败不挡浏览。换批期间保旧卡直到成功，撤回短窗口但服务器校验；客户端query、本地缓存与返回snapshot按user隔离，账号切换清理pending observer及旧异步结果。
新浏览：新文档或离开大厅30分钟后新入口；明确聊天/详情返回优先resume。跨24h不加定时器重排。当前文档顺序冻结，重新获取资料只更新字段。
容量O(用户\*可见卡数)仅当前和上一批全序；最近三批仅12ID。曝光每用户每卡一行。公开目录继续复用缓存，不增加聊天历史读或LLM；pino记录耗时、批次原因、head重复数、degraded摘要，无正文/身份明文。
迁移先本地PG17单文件重放/ACL/并发验证；已执行迁移保持不变，远端执行状态见发布记录。发布顺序迁移→后端job产生qualified-v1→前端/admin，应用上线直接全量生效，不需运营激活。运行时异常仍保留旧批次/公共目录，可靠候选不足按现有降级规则处理；必要时应用回退或forward-fix，不DROP新增数据，不添加隐藏运营开关。复用现有遥测评估，不新建分析平台。

## 拒绝的扩展

不新推荐服务/队列/缓存框架，不兴趣画像，不实时跨端同步，不重算历史对话，不额外读用户正文。新测试仅锁住本次并发、契约、迁移、时间和返回体验，沿用已有固定入口。

## 独立审核补充（通过）

- 可靠成熟score>=40、优先头档>=70是第一版起步值，不是经验最优值。qualified-v1前的旧分不能当可信分冲前排，>90d证据仅探索。
- 已有current时refresh/undo必须带expected_batch_id；缺失/过期不得生成，幂等记录淘汰后CAS仍挡旧重试。
- 曝光至少保留current/previous批次seen，undo再曝光不延长last_seen；尾部补位仍属于原batch。
- resume目标不在current/previous时只返回当前权威批，客户端不得提供任意顺序；旧snapshot只本地临时恢复且必须剔除不可见卡。
- rotation_admin_review已独立审核，可开工。

## 合入最新 main 后的移动端性能约束

- 2026-11-02 对齐 main `7a9ddf27`。保留同事的 `useMobilePerformancePolicy`、Android/iOS 列表首批/增量挂载预算、图片 eager/highPriority 分配及滚动哨兵；不恢复旧的统一固定数量。admin 的 `fallback_provider_routes` 字段/测试及原 roleplay 冷编译、增量尾项验收也保留。
- 本次影响 `/characters` 的推荐入口、换批与返回，以及推荐、曝光和缺资料时的公共目录补取。已在 `task.json.meta.mobile_performance` 登记 required；Android/iOS 页面 P95 目标分别为 3000ms，接口逐路由 P95 起步目标为 1500ms。它们是目标，不是已验证的生产结果。当前没有本次发布前的实时分组样本，新接口未上线，因此基线均为 null；旧周报早于上游性能改动，不冒充当前基线。
- 复用 Sentry 页面就绪/关键视觉及请求追踪，按 release、route、tg_platform 分组；发布前后各两个完整 24 小时窗、每组至少 100 个有效样本后评估。分组不足明确记低样本并延长观察，不补零，不平均不同平台的 P95。接口以现有请求追踪为准，结构化日志交叉核对；缺少新路由观测时先明确缺口。
- 公共目录与个人批次并行获取；仅新头部摘要缺失时补取资料并延后提交批次。通常换批不重取目录；失败保留原卡片及同一请求 ID。曝光批量异步发送，列表继续使用平台增量挂载。真机/WebView、CDN 和真实数据 P95 留待发布后观测，本地验收不代替此结论。

## 最新生产主分支接缝

本轮同步 `85780e91` 的启动拆分、角色创作统计和心愿墙；仅适配推荐相关接缝，保留它们的入口、分页与服务端归属规则。角色候选继续复用 `discoverableCharacterWhere` 和已发布角色快照，不读取创作草稿作为推荐卡；公开已审核用户创作卡与官方卡遵守同一规则。上游模块文档段落完整保留。
