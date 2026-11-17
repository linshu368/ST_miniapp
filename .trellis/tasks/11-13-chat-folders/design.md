# 设计

## 1. 复用调研

| 检索对象                                                                                   | 结论                                                                                                 |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `experience.chat_sessions` + `ChatSessionRepository.listSessions/updateSession/softDelete` | 复用。列表加 folder/搜索/快捷筛选条件；PATCH 增加 `folder_id`；批量写沿用同一 owner 过滤与软删口径。 |
| `idx_chat_sessions_user_pinned_recent`（078）                                              | 全部/未分组/搜索沿用；分组内筛选另建部分索引。                                                       |
| `GET /api/v1/conversations?character_id=`                                                  | 复用为「按角色」展开时取该角色全部段落，增加 folder 条件。                                           |
| `components/chat/session-row-actions.tsx`（重命名/删除确认/置顶）                          | 复用，行组件只加「移到分组」入口与多选态。                                                           |
| `components/ui/sheet.tsx`                                                                  | 复用底部弹层，`overlayClassName` 关闭 backdrop-blur。                                                |
| `conversationKeys.lists` 前缀失效                                                          | 新 query key 全部挂在该前缀下，现有写操作失效逻辑自动覆盖。                                          |
| 大厅摘要头像查找（`LobbySummaryLookup`）                                                   | 复用，避免逐行拉角色详情。                                                                           |
| 收藏/通知等 `miniapp_features` 表                                                          | 不复用：分组是对话内容的组织方式，见归属判断。                                                       |

## 2. 数据模型（migration `20261113_chat_folders.sql`，domain: experience）

**`experience.chat_folders`**：用户为自己的对话建立的分组。

- 列：`id uuid pk`、`user_id uuid not null → app_core.users(id) on delete cascade`、`name text not null`（trim 后 1–12 字）、`created_at`、`updated_at`。
- 约束：`unique(user_id, id)`（供复合 FK）、`unique(user_id, name)`（不重名）。
- 不变量：分组只属于一个用户；对话只能放进同一用户的分组；删分组不删对话。权威写入方：Backend 对话路由。
- **归属**：判定流程第 2 问——它组织的是用户核心互动内容（文本会话），与 `chat_sessions` 同生命周期、同消费者（对话页），属 `experience`。不是 `miniapp_features`：它不是独立可下线的功能状态投影，而是会话自身的属性（`chat_sessions.folder_id` 引用它）。不进 `app_core`：只有对话域使用。
- 生命周期：随用户删除级联；分组删除后对话 `folder_id` 置空；不做历史保留。
- 运行时消费者：Backend 列表/分组汇总/归拢查询；产品运行依赖（对话页标签）。缺失时列表仍可按全部展示。

**`experience.chat_sessions.folder_id uuid null`**：复合 FK `(user_id, folder_id) → chat_folders(user_id, id) ON DELETE SET NULL (folder_id)`，数据库保证「只能放进自己的分组」，删分组只清 folder_id 不动 user_id（PG15+ 列级 SET NULL）。新增可空列无默认值，仅改元数据。

**索引**：`idx_chat_sessions_user_folder_recent (user_id, folder_id, pinned_at DESC NULLS LAST, last_message_at DESC NULLS LAST, created_at DESC) WHERE deleted_at IS NULL AND folder_id IS NOT NULL`。同时覆盖 FK 的 SET NULL 查找。现存 2 万行/19MB，建索引时无匹配行，秒级完成。

**函数**（SECURITY DEFINER，`search_path=pg_catalog`，3s 语句超时，只授 service_role）：

- `experience.chat_folder_summary(p_user_id) → jsonb`：`{all, ungrouped, folders:[{id,name,session_count,created_at}]}`，口径与列表一致（未软删、message_count>0）。PostgREST 默认不开聚合，用函数一次往返。
- `experience.list_chat_session_groups(p_user_id, p_folder_id, p_ungrouped, p_limit, p_offset) → jsonb`：每角色一行，代表段为最新一段，`pinned_at` 为组内最近一次置顶；排序置顶角色在前、其余按最新一段时间；按角色分页，`{groups:[{session, session_count, pinned_at}], total}`。

**权限**：表 RLS 开启，REVOKE ALL FROM PUBLIC/anon/authenticated；service_role 授 SELECT/INSERT/UPDATE/DELETE（与 chat_sessions 一致，Backend 直写）。函数 REVOKE PUBLIC/anon/authenticated，GRANT EXECUTE service_role。迁移内 `$verify$` 校验 RLS、ACL、约束存在。

## 3. 接口（shared `api/conversations.ts` 扩展）

- `ChatSession.folder_id?: string | null`（可选：旧 fixture/旧后端不带也能编译）。
- `GET /api/v1/conversations`：新增 `folder=<uuid>|none`、`q`（对话名 ILIKE，1–30 字，转义 `%_\`）、`quick=short|idle`（≤2 轮 / 30 天未聊）。不带 `character_id` 且 `offset=0` 时附 `folder_summary`（与列表查询并行）。`limit` 上限仍 100。
- `GET /api/v1/conversations/groups?folder=&limit=&offset=` → `{groups, total, folder_summary?}`。
- `PATCH /api/v1/conversations/:id` 增 `folder_id: uuid|null`（与 title/pinned 合并成一次 UPDATE）；分组不存在或非本人 → 404 `folder_not_found`（FK 违例 23503 映射）。
- `POST /api/v1/conversations/batch` `{session_ids: uuid[1..100], action: 'move'|'pin'|'unpin'|'delete', folder_id?}` → `{updated}`。一次 UPDATE … WHERE user_id AND id IN (…) AND deleted_at IS NULL；非本人/已删的 id 自然被过滤，`updated` 反映实际行数。删除为软删，与单条删除口径一致。
- `POST /api/v1/conversation-folders {name}` → `{folder}`；超过 20 个 409 `folder_limit`；重名 409 `folder_name_taken`（23505）。
- `PATCH /api/v1/conversation-folders/:id {name}`、`DELETE /api/v1/conversation-folders/:id`。
- 请求体用 shared zod schema 校验；错误码 `ChatFolderErrorCode` 独立于 `ConversationErrorCode`，不改现有生成链路的穷举映射。
- 每条新路由保留 `@frontend-ready: true`；pino 记录 `conversation.folder.created/renamed/deleted`、`conversation.batch.applied`（userId、数量、action、耗时），不记分组名正文以外的敏感信息（分组名不记）。

## 4. 前端

- `lib/api/conversation-folders.ts`：`useConversationPages({folder,q,quick})`（useInfiniteQuery，key `['conversations','list','pages',…]`，`placeholderData: keepPreviousData` 切标签不闪）、`useConversationGroups({folder})`、`useCharacterSessions(characterId, folder)`（展开时才 enabled）、分组增改删、批量、移动 mutation；成功后按 `conversationKeys.lists` 前缀失效。分组汇总取自当前列表首页的 `folder_summary`，并在 queryClient 中保留最近一次，切标签期间标签栏不消失。
- 页面拆分（每个文件 <300 行）：`components/conversations/` 下 `conversation-list-page`（状态编排）、`conversation-toolbar`（搜索/按角色/管理）、`folder-tabs`（标签 + 当前分组行）、`conversation-row`（原行 + 分组小标签 + 多选态 + 移到分组）、`conversation-group-row`（叠卡 + N 段展开）、`folder-sheets`（移到分组/命名/删除确认）、`manage-bar`（管理态顶栏 + 筛选 + 底部操作条）。`app/(main)/chats/page.tsx` 只保留页面壳。
- **杂而不乱**：对话总数 <6 且无分组时隐藏工具行与标签；控件一律灰色，只有当前态用香槟金；分组改名/删除收进「⋯」；管理是独立模式（底部操作条覆盖底栏、顶部换成已选计数）；空分组给「挑选对话放进来」。
- 「按角色」默认开启，关闭记在 localStorage（try/catch，读不到按开启）；管理态与搜索结果强制平铺；归拢接口 404/503 时退回平铺（兼容迁移前与前端先于后端上线的窗口）。
- 返回原处：点开时把分组/搜索/展开角色/会话 id 记在模块内存（`chats-return.ts`），返回挂载时恢复，列表就绪后等目标行出现（最多约 1.5 秒）再居中并用共享 `ReturnFlash` 闪金边；找不到退回原有滚动位置恢复。展开状态由页面持有，才能随返回恢复。
- 翻页：列表底部哨兵 IntersectionObserver（rootMargin 600px）触发 `fetchNextPage`；失败行内「重试」。
- 启动骨架：`ChatsShellSkeleton`（页头 + 4 行占位，不读 storage/不发请求），`/chats` 加入早期 ready 路径。

## 5. 可靠性

- **超时/重试**：沿用 apiClient（GET 最多 1 次传输重试；写操作不重试）。函数 3s 超时；批量最多 100 条，一条 SQL。
- **幂等/并发**：移动、置顶、删除都是幂等的「设为」语义；重复提交结果一致。新建分组靠唯一约束防重名，并发超额由应用层计数 + 唯一约束兜底（极端并发可能到 21 个，可接受，不涉及钱）。
- **降级**：`folder_summary` 失败时列表照常返回、不带汇总（记 warn），前端标签栏隐藏；迁移未执行时（列不存在）列表查询退回无分组条件并记一次 warn，分组接口返回 503，前端隐藏分组入口——与 078 置顶的降级方式一致。
- **一致性**：写成功后前缀失效刷新；乐观更新只用于单条移动的行内标签，失败回滚并提示。
- **容量**：最大用户 709 段，汇总/归拢查询走 user_id 索引，单次 <10ms 量级；无新增定时任务。
- **可观测**：路由日志 + 现有 page.ready；新增 Faro 事件不做（先看页面访问与行为日志）。

## 6. 演进与发布

顺序：TEST 执行 migration → 验证 → 生产 migration（独立确认）→ Backend → Frontend。旧 Backend 不读新列，迁移先行安全。回滚：应用回退即可，保留表与列（不 DROP 用户数据）；数据库缺陷走 forward-fix。前端在 `folder_summary` 缺失时隐藏分组功能，因此 Frontend 先于 Backend 发布也不会坏。

## 7. 拒绝的方案

- 只在前端本地存分组：换设备/清缓存丢失，与置顶（服务端）口径不一致。
- `chat_sessions.folder_name` 文本列代替分组表：无法有空分组、改名要批量更新、排序不稳。
- 前端拉全量会话再分组/归拢：最大用户 709 段，落地页不可接受。
- 按消息正文搜索：需全文索引与 chat_history 扫描，超出本次范围。
