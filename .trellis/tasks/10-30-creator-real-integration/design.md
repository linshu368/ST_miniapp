# 设计与计划评审

## 最小充分实现与复用调查

已检索 Lab CharacterDraft/import/system-prompt/fullscreen/PolishDialog/local-draft；main CharacterCard/CharacterDetailSheet/favorites/roleplay navigation/image plaza studio、upload/storage、generation/quote/settle/sync、wallet debit/charge RPC、admin characters routes。
复用编辑器行为迁入Tailwind与主项目React Query，不iframe、不复制实验室fake作品；复用现有生成工作室产生封面，上传入口独立于图片广场enabled。封面保存资产ID/持久path，不能保存15分钟临时URL。真实生成统一放generation、凭据只经runtime-config，不复制lab密钥。新工具端点按用户限流且有180秒超时/取消，无隐式模型fallback。润色作为创作辅助由平台承担上游费用，不伪造用户扣费；先并发限流，不引入新付费商品。
角色公开字段与聊天runtime继续app_core.characters，编辑源JSON另存1:1创作实体，不在admin drafts建立第二业务真相。固定preset/background模板纯函数在shared，公开API DTO先定义。旧官方卡无creation行，原行为保持。

## 数据归属/不变量/生命周期

- app_core.character_creations：角色作者身份与编辑源，跨大厅/收藏/聊天/计费的根实体；后端owner CRUD与运营审核权威。owner不可客户端变更；revision CAS防覆盖；角色ID稳定。依赖app_core.users/characters。只本人完整读取，审核后台受现有授权。
- app_core.character_access_grants：历史使用资格，后端建聊/收藏成功写入；取消收藏/删会话不得删除。依赖users/characters，只判断有权使用，不表示大厅可发现。此资格被多域消费，不能随收藏功能删除。
- app_core.character_cover_assets：作者封面持久资产身份，后端上传/从本人生成产物复制；使用private storage，按授权签名返回；源生成记录删除不使角色封面消失。owner与角色引用验证；service-only写，无浏览器service key。
- app_core内角色创建/审核/访问RPC：维护上述根实体不变量，service role专用，固定search_path，显式grant/revoke/RLS。列表仅approved public，访问允许作者、approved public、历史授权；新creator卡enabled/archived仍为运营禁用最高限制；旧官方卡既有会话继续保留下架后可聊行为，不额外修改其历史访问规则。
- billing.character_creator_rewards及必要抵扣事实：按charge_key唯一保存实际扣款对应40%奖励/退款冲正；生命周期长于100条短期用量记录，不能FK到短期llm_usage_charges。钱包ledger与扣费事务权威，不在JS挂第二结算。跨域依赖作者快照、app_core.users/characters；仅后端RPC可写。
- admin.audit_logs复用审核审计，不新建平行审核平台。

## 故障模型与一致性

创建客户端UUID幂等；更新revision CAS；提交审核snapshot与revision CAS，不能审批旧稿放行新稿。私密ID知道也不可直建聊天；detail/favorites/socials/generation入口统一可用判定。审核旧版本保留已生效内容，私密修改不会自动重新公开。
扣费freeze creator user/规则与报价，pending重放不可覆盖；仅真实终态实扣发40%，零扣零奖，自用无奖，唯一charge_key防重，旧无快照用量不追溯。payer/creator钱包稳定顺序锁避免互相使用死锁。退款先保证付费用户退款，奖励已使用不足以收回记待抵扣以后奖励，不阻断退款；不另引入收益提现能力。
上传验证字节类型/大小/本人产物，不下载任意URL；明确超时且不隐式重试写入；失败清理已上传未入库文件。草稿持久化失败可见，退出/生成封面前flush；请求失败保留原稿，AI断流可采用部分。文本总请求与单文件设工程资源上限并明确错误，不悄悄截断；这与AI正文不设文案最大值不同。
公开API错误经现有envelope，鉴权/日志保留耗时和摘要，不能输出草稿正文/密钥。不引入队列/Redis/新的通用创作框架。

## 演进和恢复

唯一migration源packages/shared/migrations；先owner/access/cover，再billing。历史官方卡不创建假owner，不追溯奖励。隔离DB跑权限/并发/计费验证后再安排TEST，生产本轮不执行。应用先兼容schema再开放入口；关闭入口仍保留已创建卡与用户会话，不删除ledger/历史授权。必要时forward-fix，禁止回滚删除钱包事实。记录SQL依赖/权限/索引/锁及回滚说明。主项目真实preview仍可用fixture，不因此声称主库已接通。

## 计划审阅

基于main_creator_contract_review、creator_editor_research、creator_billing_research三项只读证据形成。执行前由子代理审阅本文件，记录阻塞问题或通过，然后start。

## 实施前细化与审阅结论

- creator_billing_research已审阅通过资金方案；必要抵扣投影明确命名 billing.character_creator_reward_balances（每作者一行），仅奖账本内部事实，权威同奖励事务，service-only，用户维度锁和主键，回滚不得丢弃欠额。
- Frontend spec提到RHF，但当前frontend没有对应依赖，Lab与既有studio都使用受控状态。本次保留受控编辑，提交用shared Zod验证，避免新增表单依赖和状态源；这属于最低复杂度实施选择。
- 草稿服务器create/save与publish分离，发布失败保留server ID/revision，retry不重新建角色。GET本人列表返回owner_user_id使无作品新用户也能隔离本地草稿。
- cover迁移单独文件、最先执行；create数据迁移引用cover；billing最后。公开初次publish可立即本人试聊，只有审批通过后被大厅发现。
- main_creator_contract_review整体审阅通过：作者试聊在已校验owner的repository中投影本人draft，不覆盖正在大厅分发的已批准runtime；其他用户读已批准runtime，不建第二套聊天/计费链路。

## 卡级版本与会话固定（新确认需求）

复用当前角色ID、revision及现有开轮事务。新增app_core的不可变角色版本记录，属于跨大厅/编辑/聊天使用的角色内容真相，权威写入由作者发布/试聊版本生成的后端RPC；已被会话引用不能删除或覆写。experience聊天会话只引用固定版本，不复制平行可编辑上下文。固定时点是第一次真实接受用户消息，不是仅收藏或建立带开场白的空会话。后续上下文与重生成沿固定版本；分支继承来源版本。新卡版本不触碰旧会话，官方历史卡行为保持。详情显示字段在可行范围与使用版本一致，不能把草稿系统prompt公开到未授权API。新增对象需要明确service-only权限、主外键与on-delete restrict，不允许客户端传版本号绕过角色权限。验证首次发言并发、作者更新与开聊竞争、空聊更新、已聊不变、分支继承。core agent负责最小实现并补充其实际方法到本文。


## 已开聊角色版本固定（2026-10-30 用户补充，已本地实现）

- 用户要求：更新是卡级操作；已经真实开聊的上下文不变，未发言的空会话可继续接收最新卡。作者试聊相同，分支必须继承原卡版本；不增加对话级更新开关。
- `app_core.character_versions` 是不可变卡级内容快照，按 `(character_id, audience, source_revision)` 复用。`owner` 快照来自当时作者草稿，`published` 快照来自已生效运行内容；保存运行字段以及名称、描述、封面资产引用、标签和开场白。只有真实使用时惰性建立需要的版本，不复制出另一张角色卡。
- `experience.chat_sessions.character_version_id` 只是外键引用。`chat_history BEFORE INSERT` 在原有开轮事务/会话锁内绑定；角色与创作行共享锁保证快照不会混入并发更新的两版字段。开轮事务失败时，history 与绑定、版本插入一并回滚。打开/新建空会话本身不绑定。
- `generate.ts` 在 `startTurn` 成功之后读取会话绑定版本，和上下文/请求登记并行；失败仍进入原有终态清理，不调用模型。首轮上下文查询只读 `turn_index < 1`，不存在旧虚拟开场白，使用新绑定卡开场；后续轮次沿用历史保存的开场白。重生成和角色相关生图读取同一引用。
- 分支创建触发器从经过原有 owner 校验的源会话继承引用，后续不能回捞最新卡。`GET /api/characters/:id?session_id=` 验证当前用户拥有同一角色的会话，再返回绑定版本的展示字段；无绑定的空会话显示最新内容。普通大厅详情不传 session，继续显示当前可发现版本。
- 官方卡没有 creation 行，不绑定版本，仍保留既有下架后旧会话继续聊天行为。本次不追溯修改官方历史。creator 平台禁用与私密撤大厅仍是不同动作；私密撤大厅保留曾用/曾收藏资格。
- 迁移顺序：`20261030_creator_cover_assets.sql` → `20261030_creator_characters.sql` → `20261030_creator_character_versions.sql`，计费迁移另按其依赖接续。应用关闭入口时保留版本与会话外键；不能删除版本回滚。


## 预设选择增量：静态接入（取代运营配置计划）

用户随后明确本轮不做运营平台，提供四套已定稿原文，重点预览用户端选项。沿用现有编辑器/草稿/固定Markdown组合，拒绝新配置平台、新表或新支付行为。

- 复用调研：ReplyStyleOptionsEditor与managed-config可用于未来运营治理，但本轮不接；CharacterDraft、creatorRuntime、既有draft_runtime/submitted_runtime与character_versions已经能承载固定内容。现有预设输入/文档导入与localdraft继续复用。
- 展示：shared只含四套稳定ID、用户给的名称/适用/效果。用户端默认只展示名称，可多选，单独展开适用和效果；保留自定义/文件导入。不会返回、下载或显示几千字规则原文。
- 内容：附件按四套边界机械拆分为Backend私有静态文本文件，正文保持原样，不改写、不扩写、不生成示例。服务器仅允许从固定ID读取这些文件，禁止用户传文件路径。组合顺序固定为目录顺序：选定预设 → 自定义预设和附件 → 背景和附件。
- 契约：CharacterDraft.selectedPresetIds默认[]，允许多选去重，未知ID拒绝；旧草稿无需回填。shared compose函数接受可选的已解析内容，用户端无法传入可信规则。Backend creatorRuntime服务端解析后保存runtime；仅运营/编辑者通道可以看到自定义稿，公开DTO不含静态原文。
- 一致性：静态文件更新不会自动改写已有卡/会话；用户主动保存角色时按当前静态内容更新卡，审核和已开聊沿用原有机制。save幂等比较限定客户端意图，同revision相同稿/封面重试必须返回首次结果，即使服务端文本有更新也不能改变首次写入。
- 可靠性：本地静态内容无网络重试；未知/缺失文件返回可恢复错误并保留草稿，不默默跳过已选项。并发与发布沿现有CAS；文件不放public/shared前端bundle，不添加数据库对象。
- 验收：原文拆分一致性（hash/字符数）、四选项多选与自写并存、隐藏全文边界、刷新恢复、展开/选择互不干扰、320/390宽、组合顺序与旧稿兼容、相同保存意图重试；只扩展既有测试/fixture。独立审查通过后实施。


### 预设详情的最新授权
用户随后明确允许主动查看完整实际prompt：默认目录仍只有短文案，展开说明后新增“查看详情”，点击后才经鉴权GET /api/creator/presets/:id获取该套原文，用现有全屏弹层纯文本展示。此授权取代“任何用户端都不可查看原文”的旧约束；表单和静态bundle仍不携带全文。白名单ID只读静态文件，不接受路径，不变更选择，不改写文本；固定预览读相同静态素材，不连线上资料。无需运营配置页或新表。

### 创作区域亮度微调
按用户本轮要求，创作路由使用独立暖灰紫底色，输入框、封面空态、预设列表及全屏弹层同步提亮；辅助文字提高对比度，仍保留夜间风格。仅改变颜色和局部视觉层次，不更改字段、流程、其他主页面或全局主题。复用既有移动端390/320验收。

## 创作连续性增量设计
- 复用：现有IndexedDB草稿及owner隔离、CharacterEditorModal、工作室会话/creator_return、owner DTO已有审核字段、现有creator.spec.ts。无新存储服务/数据表/步骤向导。
- 润色：每字段最多一份候选写入本地稿，关闭只隐藏；明确暂不采用才清理；采用后清候选并保留已有一次撤回。中断恢复保留已收到文本，旧稿默认空候选。
- 恢复：载入最新角色前先以独立本地草稿保留完整当前内容，标明恢复副本并给查看入口；备份失败不能覆盖/离开；本地保存失败时返回停留并提示重试。单设备即可，不构造通用版本管理。
- 封面：草稿记住上次工作室ID，重复生成默认进入同一会话；沿用现有新建按钮与权限检查，继续flush草稿后跳转，失败保留文本。
- 空间：本地稿记录初始创作意图指纹，比较draft/cover/visibility识别真实未提交修改，忽略候选、签名URL和临时状态；旧稿不丢失。已有卡只显示一张，草稿筛选可找到修改，首次待审/新版待审依据实际approved_revision，补owner DTO不改数据库。
- 发布：先判断有无实际变化；未改动已有ready卡不写服务器；私密保存、首次公开审核、公开更新审核使用明确动作与结果文案。
- 缺项：首次点提交就定位首个缺项并聚焦可输入项；可点缺项清单继续补齐，尊重reduced-motion。
- 可靠性/演进：无新外部调用、计费/权限不变；已有CAS继续阻止覆盖其他更新，候选/工作室为向后兼容可选字段；本地写失败显式提示，不静默清稿。
- 验证：扩展既有creator用例覆盖候选收起/刷新/采用/放弃、备份后载入/恢复、工作室往返复用、缺项定位、已有卡草稿找回、未改无请求、首次与更新审核文案；390/320，既有单元测试+消费者typecheck+构建按变更范围执行。
