# 技术设计

## 证据与复用

最新 origin/dev 46159929。只读生产结构 wbtsfzozlmurljvglhpn 于2026-10-29核验：chat_history 保留各轮/revision；chat_sessions.context_window_start_turn 仅供入模过滤；历史列表不裁窗口；没有独立记忆表参与生成。
复用 ChatSessionRepository、ConversationHistoryRepository、conversations.ts、useChatSession.selectSession、现有 footer、useMemoryDraft、React Query、ui-tests 的 @chat。复用 A/B runtime config 与原开轮/重生成 wrappers，保持收费及后处理快照。

## 数据归属与最小方案

所有新增对象在 experience，因维护用户×角色会话执行状态。Backend service role + restricted RPC 是唯一权威写入。用户身份/角色 FK 继续引用 app_core，继承记录依赖同域 chat_history。数据随分支会话生命周期，原会话软删不删除历史。
新增 chat_branch_turns(session_id, turn_index, source_history_id)：固定 inherited turn → 已完成真实生成行的引用，局部轮次重排1..N；不拷贝生成/账务行，也不存重复prompt/记忆。分支再分支展开成直接 history id，不递归父树。
chat_sessions 增加 branch_source_session_id、branch_source_turn_index、branch_source_message_id、branch_inherited_turns、branch_request_id。原会话默认0/NULL。新会话标题含“分支”，origin 信息仅保留来源语义；不增加专门返回入口。
新增 session_chat_history 只读视图，显式业务列，合并当前本会话生成与固定继承引用。自己的当前 revision 覆盖同轮继承；暴露 is_inherited。原 current_chat_history 及所有分析/计费入口不变。仅对话展示/上下文读新视图，findCurrentTurnById 仍用于真实本会话媒体写入。
新增 fork_chat_session(p_user_id,p_source_session_id,p_message_id,p_request_id,p_retain_turns) 原子创建，返回 chat_sessions JSON。以 source latest visible message id + terminal nonempty 验证；截至 anchor 取最后 A 个逻辑轮，映射1..N，保存origin metadata与初始stats。请求id按user唯一，用同key重试恢复结果。使用conversation-branch命名空间的用户级事务advisory lock串行化幂等与限速；不跨域查询或锁定app_core.users，用户存在性由来源会话ownership和既有FK保证。
开轮基础RPC取 max(local turn, inherited_count)+1；原水位从1起算，后续沿已有A/B。重生成基础RPC允许继承的最后轮，以冻结user_input建真实新revision；stats trigger 计会话展示轮次（不算全局真实生成）。隔离PG17复核发现原slot wrapper在SELECT无行时将诊断变量置NULL，旧CASE会错误落到concise；本迁移仅把两个current-postprocess wrapper的NOT v_previous_exact改为NOT COALESCE(v_previous_exact,false)，使继承边界无诊断时回full。动态替换验证唯一锚点/原签名，保留OID、owner、ACL、search_path和其他逻辑，不增另一组状态。

## API

POST /api/v1/conversations/:id/branch, body {message_id,request_id}（UUID），响应 GetConversationData 形状，初始返回最多最近25轮并has_more，由原分页读取更多。
ChatSession.branch?: {source_session_id:string|null,source_turn_index:number,inherited_turns:number}; ChatMessage.inherited?:boolean。frontend只使用shared DTO。
错误：branch_not_allowed(409，目标不是当前终态正文)、branch_request_conflict(409，requestId不同参数)、branch_rate_limited(429)，源不存在/非本人统一404。API不接受用户传A/B，后端读现有配置传受限RPC。

## 交互

回复footer采用低对比小图标与44px触区。语音、换回复和出图常用操作只显示图标；分支图标后显示“分支到新聊天”，aria-label同名，title说明第N轮。单击后原位loading并同步锁，pending禁重复；不添加确认弹窗。失败toast保留当前会话/草稿和同requestId供手动重试。成功缓存详情、失效列表、selectSession；仅给创建成功反馈，不加分支来源横条或返回入口；原会话与分支均在现有对话列表独立呈现。原会话查询/流式状态身份检查防迟到切会话。生成中暂禁分支，避免主动切走未完成请求。
继承消息footer只保留分支与最后轮重生成，不出现会失败的语音/生图生成入口；新轮行为不变。

## 可靠性与验证

事务+源会话行锁防并发重生成，按用户ID取conversation-branch命名空间的事务advisory lock用于限流/幂等；不跨域读取用户表。唯一user/requestId保证丢响应重试。数据库声明5秒statement timeout、有限行数(受运营A约束且硬保护1000)、每用户合理创建频率，无自动循环重试。API显式5秒RPC预算；安全日志仅ID/数量/耗时。
不新增队列/缓存/模型提取/通用分支树。数据库和consumer均需回归：ownership/幂等/原记录不增长/窗口/分支嵌套/分页/权限。高风险跨层迁移确认需要专门SQL回归；UI扩展既有chat.spec.ts，禁止临时mock。
RLS + revoke PUBLIC/anon/authenticated；service_role只读继承表/视图，写入仅RPC。SECURITY DEFINER固定pg_catalog且schema-qualified，postgres所有者。上线需迁移先于Backend/Frontend，本轮仅本地，旧普通会话兼容。已有分支后可隐藏UI入口，但须保留可读继承视图的Backend/RPC；完全旧Backend无法显示继承前缀，需前向修复，禁止直接删含用户分支的对象。

## 授权与规划评审

产品规则已由用户“好，就这样”确认；本地实现被明确授权。实施前进行独立技术规划复核，非上线授权。
