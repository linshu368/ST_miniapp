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

---

# 附录 A：阶段 4 实施期追加决议（R1 / R4）

> 追加时间：2026-06-25
> 触发：阶段 4 实施期 agent 梳理出 R1（userId 识别）/ R4（cookie 获取）两个阻塞点，配套 SPIKE-R1 / SPIKE-R4 已完成。
> 决议范围：LLM proxy userId 识别机制 + 侧边栏 backend → ST cookie 获取机制。

---

## A.1 R1 决议：LLM proxy userId 识别走 JWT platformToken 方案

### A.1.1 核心结论

provision 时为每个用户签发一张 **JWT platformToken**，写入该用户 `secrets.json` 中替代真实上游 API key。ST 服务发起 LLM 请求时将该 token 放入 `Authorization: Bearer`，proxy 收到后验签 + 解析 userId，再用平台持有的真实上游 key 转发上游。

**真实上游 API key 不再下发到 ST 文件系统。** 平台只在 backend LLM proxy 进程内（环境变量）持有一份。

### A.1.2 解决的问题

| 问题                                     | 解决方式                                                       |
| ---------------------------------------- | -------------------------------------------------------------- |
| ST 发起 LLM 请求时不携带平台 userId      | JWT payload 编码 userId，proxy 验签后解析得到                  |
| 真实上游 key 散落在每个用户 secrets.json | 真实 key 仅在 proxy 进程内；用户文件系统中只有该用户专属 token |
| 无法做用户级撤销 / 风控                  | 单用户被封 → token 加黑名单 / 不再发新 token，不影响其他用户   |
| 无法做用户级配额 / 计费                  | proxy 解析 userId 后接入钱包扣费、限流等                       |

### A.1.3 数据流

[provision 阶段]
backend 生成 JWT platformToken
payload = { userId, iat, exp?, ver }
签名密钥 = LLM_PROXY_TOKEN_SECRET（新增环境变量）
│
▼
sync-engine 通过 provisioner 写入 data/<st_handle>/secrets.json
api_key_openai = <jwt> ← 或对应 provider 字段
（注：根据 R3 决议，platform 固定走 OpenRouter，
实际写入字段以 ST OpenRouter source 对应的 secret key 名为准）

[运行时]
浏览器 ST iframe
│ POST /api/backends/chat-completions/generate
▼
ST 后端进程（Node）
│ 读 settings.json → custom_url = /api/platform/llm-proxy/v1/
│ 读 secrets.json → api_key_openai = <jwt>
│
▼
HTTP fetch → backend LLM proxy
Authorization: Bearer <jwt>
│
▼
backend LLM proxy:

1. 解析 Authorization 头 → JWT
2. 用 LLM_PROXY_TOKEN_SECRET 验签 + 校验 exp
3. 从 payload 提取 userId
4. 余额预检（R5：余额不足 → 直接返回错误，不发起上游调用）
5. body.model → tier → upstream config
6. 替换 Authorization 为 LLM_UPSTREAM_API_KEY（真实 OpenRouter key）
7. SSE 透传上游
8. 流式响应正常结束后 → finalize 扣费（R5）
9. 流式中断 / 上游 5xx → 不扣费（reserve 自然释放）

### A.1.4 JWT 结构

header = { alg: 'HS256', typ: 'JWT' }
payload = {
userId: string, // platform 用户 ID（与 public.users.id 一致）
iat: number, // 签发时间
exp?: number, // 可选过期；MVP 不强制设过期，由撤销机制兜底
ver: 1, // payload schema 版本，便于未来扩展
}
signature = HMAC-SHA256(header + '.' + payload, LLM_PROXY_TOKEN_SECRET)

**为什么用 JWT 而非不透明 token**：

- 无状态：proxy 每次请求都需 derive userId，JWT 验签纯内存计算，避免引入 Redis/DB 往返
- 自描述：未来扩展 claim（如 tier、配额）无需迁移存储
- 签名密钥管理已有先例（参考 `ST_USER_PASSWORD_SECRET`）

### A.1.5 SPIKE-R1 引用

**结论**：ST 不对 API Key 做格式校验（不要求 `sk-` 前缀、不限长度）。

**关键证据**：

- `src/endpoints/secrets.js#readSecret()`：仅 `return activeSecret?.value || ''`，无任何校验
- `src/endpoints/backends/chat-completions.js`：获取 key 后仅做 `if (!apiKey)` 非空校验
- 全量代码库搜索无 `startsWith('sk-')` 或长度校验逻辑

**直接影响**：JWT 可直接作为 API key 写入 `secrets.json`，**无需前缀伪装**（如 `sk-platform.<jwt>`）。

### A.1.6 阶段 4 必须新增的工作项

| 项                                | 位置                                                                            | 说明                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_PROXY_TOKEN_SECRET` 环境变量 | backend + sync-engine                                                           | 两端必须一致（backend 签发、proxy 验签）。建议复用 backend 进程为签发方，sync-engine 通过 backend HTTP 接口拉取 token（避免密钥扩散） |
| Token 签发逻辑                    | `backend/src/lib/llm-token.ts`（新建）                                          | 提供 `signPlatformToken(userId)` 与 `verifyPlatformToken(jwt)`                                                                        |
| Token 签发触发点                  | `backend/src/routes/bridge.ts`（/api/bridge/st-session 鉴权桥首登流程内）       | 在 provision 之前签发；或新建 `backend → sync-engine` 接口供 provision 拉取                                                           |
| sync-engine 写入逻辑              | `sync-engine/src/provisioner/write-secrets.ts`（已存在的 secrets 写入逻辑扩展） | 用 platformToken 替换原 `api_key_openai`（或对应 OpenRouter source 的字段）                                                           |
| LLM proxy 验签                    | `backend/src/routes/llm-proxy.ts`                                               | 添加 JWT 验签中间件 → 提取 userId → 注入 `request.userId`                                                                             |
| Proxy 真实 key 注入               | 同上                                                                            | 验签通过后将 `Authorization` 替换为 `LLM_UPSTREAM_API_KEY`                                                                            |
|                                   |

### A.1.7 风险与缓解

| 风险                                                       | 缓解                                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| JWT 一旦签发无过期（MVP）→ 长期有效                        | 撤销机制（黑名单）+ 必要时强制 re-provision 重签                                               |
| `LLM_PROXY_TOKEN_SECRET` 泄露 → 攻击者可伪造任意用户 token | 与 `ST_USER_PASSWORD_SECRET` 同级管理（仅 backend / sync-engine 部署侧持有，不进仓库不进日志） |
| OpenRouter source 对应的 secret 字段名错误                 | 实施时核对 ST 源码 `src/constants.js` 中 `SECRET_KEYS.OPENROUTER`（或对应 secret_key 常量）    |
| token 长度过大影响日志 / 性能                              | JWT 典型长度 200~400 字符，对 SSE 流式无影响；日志侧规则上不允许打印 Authorization 头          |

### A.1.8 阶段 5 后的形态

R1 方案在阶段 5 后**继续保留**（每条消息扣费的基础设施）。阶段 5 与 R1 无直接耦合。

---

## A.2 R4 决议：backend → ST cookie 走 Redis 缓存 + fallback 重登

### A.2.1 核心结论

`/api/bridge/st-session` 鉴权桥流程内，backend 调 ST `/api/users/login` 拿到 `connect.sid` 后，**顺手写入 Redis**（key = `st_cookie:<userId>`，value = cookie 字符串）。后续 backend 调 ST REST（如 `/api/users/chats` 反代 `/api/chats/recent`）时：

1. Redis GET 取 cookie
2. 用 cookie 调 ST
3. 若 401 / 403 → 删 cache → 重新调 ST login → 重 cache → 重试一次

**这是阶段 4 临时基础设施。阶段 5 `user_st_chats` Supabase 镜像落地后整体下线。**

### A.2.2 解决的问题

| 问题                                   | 解决方式                                                   |
| -------------------------------------- | ---------------------------------------------------------- |
| backend 调 ST REST 时不持有用户 cookie | Redis 缓存鉴权桥流程已经拿到的 cookie                      |
| 每次都走 ST login 影响延迟             | 缓存命中跳过 login，仅 cache miss / 失效时回源             |
| Cookie 失效后无降级                    | 自动 fallback 到 ST 重登 + 重缓存（最多重试 1 次避免循环） |

### A.2.3 数据流

[首登 / cookie 缓存]
/api/bridge/st-session
│ TG InitData 校验 → Supabase upsert
│ provision（如需）
│ POST ST /api/users/login → connect.sid
│ Redis SET st_cookie:<userId> = <cookie> EX <TTL>
▼
返回 { st_url, st_cookie, is_new_user }（保持现状）

[后续 backend → ST REST 调用]
GET /api/users/chats
│ 中间件解析 userId（X-Init-Data → Supabase userId）
│
▼
cookie = await redis.get(st_cookie:${userId})
│
├─ hit → 用 cookie 调 ST /api/chats/recent
│ │
│ ├─ 200 → 包装响应返回
│ └─ 401/403 → 删 cache → 走 fallback
│
└─ miss → fallback
│
▼
POST ST /api/users/login → cookie'
Redis SET st_cookie:<userId> = <cookie'> EX <TTL>
用 cookie' 调 ST /api/chats/recent
│
├─ 200 → 包装响应返回
└─ 401/403 → 报错（避免无限循环）

### A.2.4 SPIKE-R4 引用

**结论**：ST session cookie 默认 TTL = 400 天（约 13 个月，RFC 6265 上限）。

**关键证据**：

- `src/server-main.js` 挂载 cookieSession 时使用 `maxAge: getSessionCookieAge()`
- `src/users.js#getSessionCookieAge()`：默认 `sessionTimeout = -1` → 返回 `400 * 24 * 60 * 60 * 1000`（毫秒）
- 默认 `config.yaml` 中 `sessionTimeout = -1`

**Redis TTL 决策**：

ST 侧 cookie 寿命极长（400 天），但 **Redis 缓存 TTL 不应跟随该值**。理由：

- Redis 缓存过期 ≠ ST cookie 过期。即使缓存过期，fallback 重登一次即可拿到新 cookie，对用户无感
- 缓存 TTL 越短，安全性越高（cookie 泄露的风险窗口越短）
- 阶段 4 是临时基础设施，过度延长 TTL 反而增加阶段 5 下线时的清理负担

**MVP TTL 推荐：24 小时**。

理由：

- 用户日活场景下 24h 内大概率会有侧边栏访问，缓存命中率高
- 24h 内即使 cookie 被横向访问，攻击窗口可控
- 用户长期不活跃后自然失效，下次访问走 fallback 重登

### A.2.5 阶段 4 必须新增的工作项

| 项                                 | 位置                                                                        | 说明                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Redis 客户端（如尚未注入 backend） | `backend/src/lib/redis.ts`（确认是否已存在；§8 提到 Upstash Redis 已在用）  | 复用现有连接                                                              |
| Cookie 缓存写入                    | `backend/src/routes/bridge.ts`（鉴权桥 /st-session 流程内 ST login 成功后） | `redis.set('st_cookie:'+userId, cookie, { EX: 86400 })`                   |
| Cookie 缓存读取 + fallback         | `backend/src/lib/st-cookie.ts`（新建）                                      | 导出 `getStCookie(userId)`：含 cache hit / miss / 401 fallback 逻辑       |
| `/api/users/chats` 反代实现        | `backend/src/routes/users-chats.ts`（新建，对应 I.5 §2.4）                  | 调 `getStCookie(userId)` → 用 cookie 调 ST `/api/chats/recent` → 包装响应 |
| ST `/api/chats/recent` 调用 body   | 同上                                                                        | `{ max: 200, pinned: [] }`（MVP 不做置顶，pinned 固定空数组）             |

### A.2.6 风险与缓解

| 风险                                                              | 缓解                                                                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Redis 不可用 → 缓存路径全 fail                                    | fallback 路径不依赖 Redis 读，但需要 Redis 写 cache。可降级为"Redis 写失败不阻塞"，每次都走 ST login（性能降级但功能正常） |
| 同一用户并发请求触发多次 ST login（cache miss 雪崩）              | MVP 不做分布式锁；阶段 5 下线前若出现实际问题再加                                                                          |
| ST login 接口本身故障                                             | `/api/users/chats` 返回 503 + 明确错误码；前端侧边栏降级为空列表 + 重试按钮                                                |
| `LLM_PROXY_TOKEN_SECRET` / cookie 同时泄露 → 可伪造请求并查询历史 | 两者属于不同信任域：token 验签密钥 vs ST session。同时泄露需要两条独立攻击链，风险可接受                                   |

### A.2.7 阶段 5 下线清单

阶段 5 `user_st_chats` 回流落地后，删除：

- `backend/src/lib/st-cookie.ts`（整体删除）
- `backend/src/routes/users-chats.ts` 内"调 ST cookie + 反代 /chats/recent"逻辑（替换为查 Supabase）
- 鉴权桥流程中 Redis SET cookie 的逻辑（保留 cookie 返回前端的现状）
- Redis 中已有的 `st_cookie:*` 键（清理脚本，一次性执行）

**`/api/users/chats` 平台契约保持不变**，前端代码无任何改动。

---

## A.3 阶段 4 实施前置 SPIKE 清单（已完成）

| 编号     | 主题                         | 状态      | 结论关键点                                           |
| -------- | ---------------------------- | --------- | ---------------------------------------------------- |
| SPIKE-R1 | ST 是否对 API Key 做格式校验 | ✅ 已完成 | 无任何格式校验，JWT 可直接作为 key 写入 secrets.json |
| SPIKE-R4 | ST session cookie 默认 TTL   | ✅ 已完成 | 默认 400 天；Redis 缓存 TTL 独立决策为 24h           |

---

## A.4 阶段 4 工作项汇总更新

在 §4.2 实施顺序基础上追加：
LLM 网关收敛（追加 R1 工作项）
├─ LLM_PROXY_TOKEN_SECRET 环境变量分发
├─ backend/src/lib/llm-token.ts（JWT sign/verify）
├─ sync-engine provisioner 写入 platformToken 替代真实 key
├─ LLM proxy 验签中间件 + userId 注入
└─ LLM proxy 真实 key 注入（替换 Authorization 转发上游）

自研侧边栏（追加 R4 工作项）
├─ backend/src/lib/st-cookie.ts（cache + fallback）
├─ 鉴权桥流程内 Redis SET cookie
└─ /api/users/chats 反代实现使用 getStCookie(userId)
