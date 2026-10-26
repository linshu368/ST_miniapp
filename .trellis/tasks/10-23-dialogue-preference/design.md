# Design

## Reuse / smallest solution

基于现有ChatReplyPreferences、generation-config ReactQuery逐字段optimistic helpers、MiniappUserSettingsRepository、runtime-config唯一入口、Admin managed-config草稿/发布/历史/回滚及认可的ReplyStyleOptionsEditor原型。

用一个JSON配置 reply_style_options（options数组）取代本分支尚未发布的静态more_dialogue_rules与pref_more_dialogue。内部字段id/name/description/marker/rules/enabled；数组顺序是显示顺序，不增加sort_order。新增项id由UI生成style-UUID，英文marker由运营自己填写，不用作数据库身份。最多24项，name40/description200/marker120/rules12000，内容允许空，保存时名称必填，id唯一。公开目录严格投影id/name/description，只含enabled项。

Shared先定义配置、公用metadata和偏好map schema及optional DTO字段；不新建endpoint。GET/PATCHgeneration-config增加公开目录，UserSettings与UserGenerationConfig增加optional pref_reply_styles map。数据库默认{}；每次PATCH是部分map更新，RPC以一条SQL执行existing||patch。前端optimistic/response/rollback仅处理请求id，避免并发覆盖。未知合法id即使目录下架仍可保存布尔状态，不产生生成行为；实际UI仅显示当前目录。

Backend新增一个小展示feature，读取runtime-config正式值并校验，无效为空，日志不含配置文本。它不进入EnginePlatformInstructions/GenerationRequest/buildPrompt；本次不实现动态prompt注入。原有用户自定义要求/三个模块/thinking与计费不变。

Admin新增view reply_style_options，用平台规则submenu组织原规则页与新独立页面。受控Editor保留临时选中、焦点和手机预览开关；不用strict保存schema过滤输入中的空行。复用configEditorCard的保存发布历史controls，无新API/状态库。保存或环境加载期间禁用，离开脏状态确认。

## Data ownership / migration

app_core拥有长期用户偏好JSONB和正式runtime_config；admin拥有草稿/发布/校验链。无新表/FK；新增app_core.update_reply_style_preferences(UUID,JSONB)为service_role-only原子写入RPC，与现有用户设置鉴权repopath一致，禁止anon/authenticated直接写别人的偏好。公开API认证userId为唯一写入主体。

单份新手工migration注册配置key，保留全部现有白名单/validator/两表CHECK表达式、验证状态与ACL；seed空目录，选项及其marker/rules均由运营自行新增填写，ONCONFLICT不覆盖运营值。pref_reply_styles JSONB NOTNULL DEFAULT{}，检查object/boolean/id形状和合理上限。常量default无业务行回填，无新索引。事务lock5s/statement60s，失败整笔回滚。测试环境验证再独立生产执行，顺序migration→Backend/Admin→Frontend。当前unshipped单一对白迁移删除，不改历史迁移。

## Reliability / recovery

写map是幂等的单键赋值并原子合并，不重试写请求；同键最后写入有效，不同键不丢。JSON选择数上限64，catalog上限24，保留近期下架id，避免一删一加使其他状态丢失。无新外部provider调用、队列、计费事务或补偿。现有请求超时/鉴权/失败信息复用。缺失/非法目录不影响聊天主体；运营草稿隔离，规则不出公开API或日志。

恢复先停用配置或回滚已发布目录，应用可回退，保留扩展列/历史审计，DB缺陷forwardfix。不删除配置发布历史或覆盖其它dev。敏感需求数据继续Git外。

## Authorized thinking repair

用户授权恢复main ac60b1af丢失的已上线5b958012 thinking接缝。恢复generate/execute/first-token-fallback/frontend3files，保留main contextWindowStartTurn/dispatch/writequeue/metrics。已通过852backend+366frontend回归和所有消费者types；最终集成再次适用验证。
