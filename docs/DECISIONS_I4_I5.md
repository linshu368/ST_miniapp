# DECISIONS_I4_I5.md

> 产出时间：2026-06-24
> 适用阶段：阶段 4（业务功能落地：LLM 代理网关 + 自研工具栏/侧边栏）
> 前置文档：`ARCHITECTURE.md` / `落地阶段划分.md` / `SPIKE_RESULT.md`
> 文档定位：阶段 4 前置决议沉淀，作为 Cursor agent 实施输入

---

## 0. 决议状态总览

| 决议编号 | 主题                                 | 状态          | 影响范围                                   |
| -------- | ------------------------------------ | ------------- | ------------------------------------------ |
| I.4      | 模型切换实现边界                     | ✅ 已决议     | frontend 自研工具栏 + backend LLM 网关     |
| I.5      | 侧边栏数据源                         | ✅ 已决议     | frontend 自研侧边栏 + backend 新增聚合接口 |
| I.5-附1  | 置顶功能（pinned chat）              | ⏸ 阶段 4 不做 | 推迟到阶段 5 之后                          |
| I.5-附2  | `/api/chats/recent` 极限容忍度 SPIKE | ⏸ 留痕待办    | 阶段 4 实施期 + 阶段 5 之前必须完成        |

---

## 1. I.4 决议：模型切换走 bridge action（`changeModel`），不新增 backend REST 接口

### 1.1 核心结论

`setModelTier` UX 动作 = `platformAction('changeModel', { model: tier.modelName })`。**不调用 backend，不写 Supabase 业务表**。

### 1.2 数据流（标准链路）

用户点击 tier 按钮（自研工具栏）
│
▼
platformAction('changeModel', { model: 'gemini-2.5-flash' }) ← 阶段 3 已实现
│ postMessage via BridgeClient
▼
ST 内部（st-extension handler）

修改 oai_settings.<provider>\_model
DOM select.val(model).trigger('change') ← 触发 ST 联动逻辑
saveSettingsDebounced() ← 持久化
│
├─► ST 文件系统写 settings.json ④
│ │
│ └─► sync-engine watcher 上行
│ → st_users.user_st_settings ← 持久化镜像
│
└─► emit CHATCOMPLETION_MODEL_CHANGED
→ bridge event model:changed ③
│
▼
zustand store: st-mirror.currentModel
│
▼
useSTMirror(s => s.currentModel) ← 工具栏 UI 显示来源

### 1.3 扣费 / 通道路由的归属

扣费**不在 tier 切换时发生**，而在每条消息发送时由 LLM proxy derive：
ST 发起 LLM 请求
│ POST /api/platform/llm-proxy/v1/chat/completions
│ body = { model: 'gemini-2.5-flash', messages: [...] }
▼
backend LLM proxy

从 body.model derive → tier
tier → deduction_rate（查平台配置表）
tier → channel（未来扩展：3 组 API 配置 + 超时等）
扣费 + 路由 + 上游转发

**关键纪律**：扣费逻辑的输入完全包含在请求体里，不需要在 tier 切换时往 backend 写任何用户状态。

### 1.4 阶段 4 必须新增 / 修改的工作项

| 项                                | 位置                                                      | 说明                                                                                       |
| --------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 工具栏 tier 切换按钮              | `frontend/src/components/.../model-tier-switcher.tsx`     | 调 `platformAction('changeModel', ...)` + 用 `useSTMirror(s => s.currentModel)` 订阅显示态 |
| `model_name → tier / rate` 映射表 | backend 平台配置（`miniapp.runtime_config` 或硬编码常量） | LLM proxy 读取，用于扣费 derive                                                            |
| LLM proxy 扣费逻辑                | `backend/src/routes/llm-proxy.ts`                         | 从请求 body 读 model → derive tier → 调用钱包扣费                                          |
| LLM proxy userId 验证             | `backend/src/routes/llm-proxy.ts`                         | 阶段 4 必须补上（当前 dev 透传）                                                           |
| 按钮禁用态保护                    | `frontend/src/components/.../model-tier-switcher.tsx`     | 用 `useBridgeStatus()` 在 bridge 未 ready 时 disable                                       |

### 1.5 不做的事（明确边界）

- **不**在 frontend 调任何 backend REST 接口来切 tier
- **不**新增 `POST /api/users/model-tier` 之类的接口
- **不**让 backend 直接写 Supabase user_st_settings（这条路径属于 watcher）
- **不**在切换时做余额校验（余额校验在每条消息发送时由 proxy 做）

### 1.6 风险与缓解

| 风险                                      | 缓解                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Bridge 未 ready 时按钮可点 → reject       | 用 `useBridgeStatus()` 做 disabled                                                                 |
| 切换后 user_st_settings 回流延迟          | UX 上信任 mirror state；回流延迟不影响下次消息（model 是从内存 oai_settings 读的）                 |
| `model_name` 与 tier 映射偏移（运营调整） | 平台配置表为权威源，proxy 实时查；前端 tier 按钮的 model_name 硬编码需与配置表保持同步（部署纪律） |

---

## 2. I.5 决议：侧边栏走"REST 读 + Bridge 写 + Event 失效"混合架构（路径 b2）

### 2.1 核心结论

**读取**：backend 新增 `GET /api/users/chats`，内部反代 ST `/api/chats/recent`（ST 已做跨角色聚合 + 时间排序），返回跨角色历史会话列表。

**写入**：复用阶段 3 已实现的 4 个 bridge actions：`openChat` / `newChat` / `deleteChat` / `renameChat`。

**失效**：`useSTEvent` 订阅 4 个 bridge events：`chat:created` / `chat:deleted` / `chat:renamed` / `chat:changed`，任一触发即 re-fetch `/api/users/chats`。

**不**扩展 mirror state schema 添加 `chatList`。**不**等待阶段 5 `user_st_chats` 回流。

### 2.2 为什么是 /api/chats/recent 而不是 loop 单角色端点

SPIKE 发现 ST `/api/chats/recent` 底层已经做了三个目录的全量遍历：单人角色 + 群组 + 无名根目录。被 `request.body.max` 截取后返回 "recent N 条"。这意味着：

- 一次 REST 调用即可拿到完整跨角色列表
- ST 自己做了时间排序
- backend 不需要决定 "loop 哪些角色"（之前我误以为需要的"角色范围"问题在这条路径下不存在）
- 单次延迟 << N 次单角色 REST 串行

只要 `max` 给得足够大（或后续加分页 cursor），就能拿到完整历史。

### 2.3 数据流

┌──────────────────────────────────────────────────────────────┐
│ 自研侧边栏组件 │
│ │
│ [初始挂载 / Event 触发失效] │
│ └─► fetch GET /api/users/chats │
│ │ │
│ ▼ │
│ backend → stProxy → ST POST /api/chats/recent │
│ body = { max: 200, pinned: [] } │
│ │ │
│ ▼ │
│ backend 包装：附加 character_name / character_avatar / │
│ tier_lable 等平台元数据 → 平台契约响应 │
│ │ │
│ ▼ │
│ zustand store: chatListCache │
│ │
│ [用户交互] │
│ ├─► 切换：platformAction('openChat', {...}) │
│ ├─► 新建：platformAction('newChat', {...}) │
│ ├─► 删除：platformAction('deleteChat', {...}) │
│ └─► 重命名：platformAction('renameChat', {...}) │
│ │ │
│ ▼ (ST 内部状态变化 → bridge event) │
│ │
│ [失效订阅] │
│ useSTEvent('chat:created') ─┐ │
│ useSTEvent('chat:deleted') ├─► 触发 chatListCache 失效 │
│ useSTEvent('chat:renamed') │ → re-fetch /api/users/chats │
│ useSTEvent('chat:changed') ┘ │
└──────────────────────────────────────────────────────────────┘

### 2.4 阶段 4 必须新增 / 修改的工作项

| 项                                      | 位置                                               | 说明                                                                                                                    |
| --------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| backend 聚合接口 `GET /api/users/chats` | `backend/src/routes/users.ts`（或新建 `chats.ts`） | 阶段 4 实现为反代 ST `/api/chats/recent`；阶段 5 内部切换为查 Supabase user_st_chats                                    |
| 平台契约 schema                         | `packages/shared/src/api/chats.ts`                 | 定义 `UserChatListItem`：file_name / character_name / character_avatar / mes_count / last_mes / file_size / is_group 等 |
| 自研侧边栏组件                          | `frontend/src/components/.../chat-sidebar.tsx`     | 渲染列表 + 4 个交互按钮 + Event 失效订阅                                                                                |
| 侧边栏 zustand store                    | `frontend/src/stores/chat-list.ts`                 | chatListCache + 失效/re-fetch 逻辑                                                                                      |
| 按钮禁用态保护                          | 同上                                               | mutations 类按钮用 `useBridgeStatus()` 做 disabled                                                                      |

### 2.5 平台契约 schema 草案（参考，最终以实现时调整为准）

```ts
// packages/shared/src/api/chats.ts
export interface UserChatListItem {
  fileName: string;          // 不含 .jsonl 扩展
  characterAvatar: string;   // ST 内 avatar 标识
  characterName: string;     // 平台元数据附加
  characterId: string;       // miniapp.characters.id 映射
  isGroup: boolean;
  lastMessage: string;       // 摘要
  lastMessageAt: string;     // ISO timestamp
  messageCount: number;
  fileSize: number;
}

export interface GetUserChatsResponse {
  items: UserChatListItem[];
  total: number;
  hasMore: boolean;          // 预留分页字段，MVP 可固定 false
}

2.6 时序保证
侧边栏初始 fetch 不依赖 bridge ready。backend 反代 ST 用的是 cookie 会话（登录鉴权桥时已建立），与 bridge 握手解耦。这满足"侧边栏只要有数据可展示就渲染列表"的产品要求。
Mutations 类按钮依赖 bridge ready。用 useBridgeStatus() 在 UI 层做 disabled，避免 reject。
Event 订阅依赖 bridge ready。但 bridge 未 ready 时 ST 内不会发生 chat 变化（用户连消息都发不出），事件失去窗口为空集。
2.7 阶段 5 迁移路径（设计意图）
阶段 5 user_st_chats 回流落地后：

仅修改 backend /api/users/chats 内部实现：从"反代 ST /chats/recent"切换为"SELECT FROM st_users.user_st_chats WHERE user_id = ?"
平台契约响应 schema 不变
frontend 代码不动（侧边栏组件 / store / Event 订阅全部原封不动）
bridge protocol 不动
这是混合架构的核心价值兑现：读取数据源是可替换组件。

2.8 不做的事（明确边界）
不扩展 STMirrorState schema 添加 chatList 字段
不在 frontend 循环调用 ST REST 端点（必须由 backend 聚合）
不为了支持单角色侧边栏额外建一套 API（统一走 /api/users/chats）
不等待阶段 5 user_st_chats 回流（混合架构允许阶段 4 独立交付）

2.9 风险与缓解
风险	缓解
ST /api/chats/recent 对超大 max 内存或性能问题	见 §3 SPIKE 留痕；MVP 用 max=200 应满足绝大多数用户；监控 backend 接口 P95 延迟
大量 chat 变更事件触发频繁 re-fetch	在 zustand store 层做 debounce（建议 300-500ms）
跨角色 chat 与平台 character 元数据映射	backend 在包装时根据 ST 返回的 avatar_url 反查 miniapp.characters 附加平台 characterId / characterName
群组 chat 处理	ST /api/chats/recent 同时返回群组 chat；平台当前业务模型主要是单角色，群组场景可在响应中 isGroup: true 标识，UI 侧暂不渲染或简单展示
3. 阶段 4 不做的功能（留痕）
3.1 置顶功能（pinned chat）
决议：阶段 4 不做。

原因：依赖三个独立改动，作为独立小项目更合理：

扩 STMirrorState schema 添加 pinnedChats 字段（破坏阶段 3 协议稳定性）
确认 pinnedChats 在 platform_settings.writable_paths 白名单内（sync-engine 配置问题）
新增 bridge action togglePinChat（需要 bridge-protocol 改动）
SPIKE 已知信息（阶段后期实施时复用）：

ST 置顶纯前端机制，状态存于 settings.json 的 pinnedChats 字段（由 AccountStorage 管理）
ST 前端类：PinnedChatsManager.toggle(recentChat, boolean)
后端 /api/chats/recent 接受 body 中 pinned: string[] 参数做排序加权
无独立的"置顶 REST API"
建议实施时机：阶段 5 user_st_chats 回流落地后，统一作为"侧边栏增强包"实施（含置顶 + 搜索 + 分组等）。

3.2 ST /api/chats/recent 极限容忍度 SPIKE
决议：阶段 4 实施时 MVP 用 max=200，不立即做极限 SPIKE。

待办内容：

测试 max=500 / 1000 / 5000 时 ST 端的响应延迟与内存占用
是否存在硬上限（ST 源码内是否有 max 上限保护）
大列表场景下 backend 包装层的性能（角色元数据反查是否需要批量 / 缓存）
是否需要在 backend 接口层加分页 cursor
触发时机（必须满足以下任一）：

触发条件 A（性能）：生产环境出现单用户 /api/users/chats 接口 P95 > 2s
触发条件 B（功能）：用户反馈"侧边栏看不到更早的历史"
触发条件 C（计划）：阶段 5 sync-engine 改造正式启动前（无论是否触发 A/B，都需在阶段 5 之前完成此 SPIKE，因为阶段 5 设计 user_st_chats 表索引策略时需要参考此数据）
留痕位置：建议在 docs/SPIKE_RESULT.md（如果不存在则在阶段 4 初始化时新建）单独记录此条，避免遗忘。

```
