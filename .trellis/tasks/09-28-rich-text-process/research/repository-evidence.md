# 仓库复用研究与证据边界

采集日期 2026-09-28；分支 dev_rich_text_process，当前基线 632f966b。所有结论为静态 CODE/SPEC/MIGRATION，不是 TEST-DB/Production 实况。

## 已检索范围

组件：ChatMarkdown、ChatMessageBubble/List/Composer、SystemInstructionsEditor、ConfigValueEditor、VipStrategyView、CharacterCardsView。
hooks/helpers：use-chat-session、use-conversation-turn、conversation-stream、mergeStreamingMessages、adminApi、adminNavigation、configSchemas、environment、confirmAction、replaceUserPlaceholder。
契约：shared/api/conversations、settings、envelope、shared 根出口与 package。
Backend：features/conversations/generate/history/user-placeholder/sse、features/generation/execute/settle、platform/runtime-config、ConversationHistoryRepository、ChatSessionRepository、routes/admin-supabase-proxy。
DB：035/037/042/077/095/099 及 date-named 后续迁移；检索 start_chat_history_turn/regeneration、current_chat_history、config_drafts/releases、publish/rollback、runtime_config。
规范：根 README/ARCHITECTURE、Trellis workflow、模块 index、frontend/backend/admin/shared/database 相关专题与模块现状。

## 关键证据及复用判断

- chat-markdown.tsx:12 的 Showdown 已覆盖换行/删除线/代码等；:20 只允许少量 tag，:38 全部 attr 禁止；:47 内含 store 用户名依赖。可复用底层处理与视觉，需以显式 props 解耦，不能让 Admin import frontend 或复制渲染器。
- generate.ts:106 读取依赖后 :125 原子开轮；:143 上游打开后输出 start；:169 统一 execute；:179 写模型原文。只扩展请求时版本绑定与传递，结算不变。
- ConversationHistoryRepository 有开轮 RPC/终态/元数据三个写集合，版本属于开轮，不写 billing snapshot。listMessages 把首轮开场白作为虚拟消息；toChatMessages 是 DTO 映射。开场白第一版保留旧展示。
- user-placeholder.ts 已对 GET message.content 替换，而 live SSE 是原始文本；引入按原文匹配后需兼容带版本 assistant 的 raw GET，不能假设现有两端内容完全相同。
- frontend mergeStreamingMessages 当前 StreamingTurn 不含规则版本；必须从 SSE start 接入，不能依靠当前配置 query 猜测。
- Admin adminApi.ts:135 读取 managed configs；:168 保存草稿；:187/:205 通用 publish/rollback。getReleases :164 只返回最近 100 条，不能作为运行历史快照来源。
- 035 的 base_version / publish 条件是运行版本 CAS，037 的 upsert draft 没有客户端 expected_updated_at；需为新 key 增加保存并发约束，不能声称已有完整多人编辑保护。
- 035/077 等早期 SQL 含 miniapp schema；099 提供八域搬迁。只追加新 migration，以目标结构确认真实签名/权限/视图，不按旧文本直接改写或推断远端已执行。
- shared 规范禁止应用 UI/store，工具必须确定且无隐藏 IO；当前仅 Zod 依赖。新增 renderer workspace 是两个真实 UI 消费者共享实际 React 展示的边界，shared 纯编译可使用经验证的 browser-safe AST 工具。
- frontend/admin 目前 DOM/端到端基础不完整；worker、DOM 净化和真实点击不能仅用纯函数测试声称已完成设备验收。
- root package 没有 backend dist build；存在 lint:imports、lint:legacy、lint:migrations 和 migration-ledger test。新 renderer 应提供自己的 test/typecheck 脚本。

## 原型核对

源码提供三栏、规则搜索/状态过滤、新建/复制/删除/排序、正则 flags/捕获组、模板/CSS 编辑、即时 Worker 预览、宽窄屏、独立指令 dialog、localStorage 保存和模拟选项。processText 按 text/html segments 防重复命中，单规则 catch 不丢前序结果；总 Worker 超时 1s 时全原文回退。50,000 字符、1,500 matches 是原型阈值，不是生产性能实测。

差异必须补齐：没有服务器发布/回滚、没有真实 APP renderer、没有真实流式模拟；原型 iframe/CSP 不能直接迁入 APP（spec 禁止 iframe）。原型 CSS 直接聚合与 class 保留不能单独证明隔离。原型 prompt 示例缺少现有必需 INTERACTION_MODE，占位指令不能当生产模板；原型规则默认 highlight 停用、dialogue 非 global、状态卡 open，不能不经运营发布当线上初值。

## 技术待证及处理

AST 工具具体版本、体积/锁文件、可信 Markdown 合成、Next/Vite Worker 与 Node 编译运行、预算和设备表现在 T0 验证；不能把未验证库/API写成已采用事实。运行/运营对象、history view、RLS/grant、锁容量在授权的 TEST 结构检查后确认，Production 独立核验。用户配置自由度已决定，技术验证不得未经复审缩成仅四类固定组件。
