# Design

## 范围与复用
沿用唯一的 shared conversations 契约、generation 上游出口/SSE tap、useConversationTurn、ChatReplyPreferences 和 ChatMessageBubble；不新增 provider SDK、数据库列、通用网络客户端或独立计费路径。

## 接口与数据流
- SendMessageRequest / RegenerateRequest 新增可选 thinking_enabled:boolean；新UI默认显式true；HTTP请求缺失时兼容旧客户端按false。非布尔值在开轮前400。
- ConversationStreamEvent 兼容追加 {type:'reasoning',text:string} 增量；旧客户端忽略未知事件。start 可选携带 thinking_enabled，描述本轮请求设置，不宣称模型保证执行。
- GenerationRequest 新增可选 thinkingEnabled；generation hooks/tap追加 onReasoningDelta。OpenRouter reasoning.enabled/exclude 与 Venice reasoning.enabled/venice_parameters 分开映射。最终参数以官方研究记录为准。
- 思考只流经临时回调，不进入 SseTapResult.content、DB正文/metadata、后续prompt或计费条件。限制每轮可转发思考64Ki字符，继续drain上游与收口正文，不重试生成。
- 前端唯一SSE parser分流正文/思考；思考批次必须在首正文之前flush，done/error/finally均收尾；两种真实进度重置idle，但不延长绝对deadline。

## UI与状态归属
- 思考控制与“回复偏好”置于同一操作行，以Atom原子轨道图标+“深度思考”圆角胶囊/aria-pressed表达，生成中禁用并标示本轮已锁定。偏好展开区保持原布局与高度预算。
- 开关属于当前设备用户偏好，localStorage仅保存bool并按Telegram用户ID隔离；SSR默认on；存储失败仅降级本页。切换用户重新默认/读取，不写服务器用户设置。
- 思考内容属于页面临时内存，按会话/assistant ID/revision归属，最多保留最近12条、每条64Ki字符；刷新/离开页面不持久化。不修改历史消息DTO，不将思考伪装成服务器历史。
- 思考区域单独组件：默认在真实思考到达后展开；思考进行中有低干扰状态；正文开始或终态自动折叠，用户可再展开，后续正文增量不再反复收起。区域内长文滚动，纯文本转义，无链接/富文本/工具动作。关闭/无公开思考时沿用准备回复状态。
- 父层当前请求身份保护onReasoning；会话切换清理临时思考。取消只在服务端确认后撤本地占位，未确认保持生成态。思考长度加入停滞判断和底部跟随依赖，手动翻历史不被拽回。
- 思考区域加PostHog遮罩/不采集和Sentry mask；不新增文本日志/telemetry。

## 兼容性、失败与恢复
生产先backend后frontend；旧客户端未携带thinking_enabled时保留旧的正文首字流程。新前端配旧后端可正常正文且无思考。未知/非法reasoning帧跳过不记录payload。关闭时不向浏览器传思考，不仅隐藏UI。按用户补充要求，不增加强制思考型号识别、能力目录扩展或特殊重试；只发送两平台通用开关，强制思考计算由供应商决定。只收到思考、上游中断/取消无正文保留既有失败/免费释放/不扣费条件；不另调生成，不重发造成双成本。
无数据库迁移/env新增。回滚撤掉本功能提交，现有正文/历史无需修复。必须保持调用ID持久化先于向浏览器转发、绝对超时和终态CAS等原边界。

## 测试必要性
这是跨平台参数/SSE时序/计费边界变更，现有测试扩展不足时允许新增临时状态纯规则测试文件；不引入RTL/E2E基础设施。覆盖开关缺省/非法/发送/重生成，provider参数，拆包/多字节/结构化reasoning/上限，reasoning-only不计费，SSE首正文排序/EOF/错误/取消/旧client，以及前端偏好与隔离/折叠状态。

## 未覆盖边界
本地fixture为虚拟验证，不能冒称真实供应商生成、真实扣费或手机键盘实测。强制思考或不公开思考模型遵循供应商能力，UI不承诺关闭成本。官方来源见research/provider-reasoning.md。

视觉：使用用户参考图的原子轨道标记，复用Atom图标配“深度思考”圆角胶囊；无问号、无说明弹窗。消息标题保留thinking并统一Atom图标。

## 最新线上首字兜底衔接（用户确认）
发布基线更新为main 971af209。开启深度思考时，首个真实非空思考字符与正文首字具有同等效力：都满足首字选择、解除首字截止并计入原有首字指标；关闭仅正文有效。先确定delivery attempt再转发思考，避免首发思考混入兜底正文。前端仅观察真实思考文本节点，thinking标题/spinner/准备标签不计首字，仍经原DOM可见+两帧绘制方法确认。计费、完成必须有有效正文，二者口径独立。
HTTP开关缺失采用false保持旧常驻页面的正文首字兼容；新UI始终显式发送设备偏好（首次默认true）。无新能力字段/数据库迁移或强制模型特判。
