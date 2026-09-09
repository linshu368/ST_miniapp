# 预设对话平台技术设计

## 1. 总体方案

采用“独立 SPA + 现有 Backend 专用内部 API + Supabase 分域存储”的最小方案：

```text
packages/preset-platform (Vite React)
  └─ HTTPS/SSE + Supabase access token
      → packages/backend /api/internal/preset-platform/*
          ├─ 运营鉴权/权限、会话/预设编排
          ├─ features/generation provider primitive → OpenRouter
          ├─ preset_platform schema：工作台会话、消息、草稿、发布、审计
          ├─ app_core：角色卡只读
          └─ experience：真实输入只读 + 服务端脱敏
```

浏览器不直连 OpenRouter、不读取原始 `experience` 消息、不持有 service role。Supabase browser client 仅负责登录/session；业务数据统一经 backend，确保脱敏和权限处于可信边界。

## 2. 包与模块

### 2.1 新应用 `packages/preset-platform`

技术栈建议：Vite 8、React 18、TypeScript strict、Ant Design 6、TanStack React Query、React Router、Zod、Vitest。

本需求有六个可直达页面、大量服务器状态及环境切换失效需求，因此使用 Router + Query，而不复制 Admin 的单文件 view 状态机。

```text
src/
├─ app/             # providers、router、guards、error boundary
├─ layouts/         # WorkspaceLayout、环境标识、侧栏
├─ pages/           # conversations/models/presets/default/materials/drafts
├─ features/        # auth、conversations、models、presets、materials、environment
├─ components/      # 稳定无领域/跨页面组件
├─ lib/api/         # 唯一 HTTP/SSE client 与 Query hooks
├─ lib/supabase/    # 每环境 client/session 生命周期
├─ lib/environment.ts
└─ styles/、test/
```

状态归属：URL 保存页面/筛选/选中 ID；React Query 保存服务器真相；表单/抽屉/输入框用局部状态；首期不引入第二个全局状态源。

### 2.2 Backend

新增 `routes/preset-platform.ts`、`features/preset-platform/{auth,conversations,presets,prompt,generate,redaction,errors}.ts` 和对应 repositories。Route 仅做鉴权、契约解析、feature 调用和响应映射；每个注册保留 `@frontend-ready`。

### 2.3 Shared

新增 `packages/shared/src/api/preset-platform.ts`：分页、预设 V1、草稿/发布、测试会话/消息、模型摘要、角色安全摘要、脱敏样本、SSE `start|delta|done|error` 和领域错误码。

V1 最小格式：

```ts
type PresetDefinitionV1 = {
  schemaVersion: 1;
  systemInstruction: string;
  sampling: { temperature?: number; topP?: number; maxTokens?: number };
};
```

参数服务端白名单、范围与总长度受限。V2 才考虑有序 prompt segments；V1 不接受任意 provider JSON。

## 3. 数据模型与真相

新建独立 `preset_platform` schema，首期全部工作台资产、数据访问函数和授权策略均归该域管理，**不归属 `admin` schema**。即使认证阶段复用 Admin 的 Supabase 账号，也只把它视为外部身份来源，不把 Preset Platform 的表、RPC、RLS、grant、审计或生命周期并入 Admin。若未来 MiniApp 正式消费，再用 migration 将已发布运行时快照投影到 `app_core`，现在不双写。

| 表                                   | 责任/关键约束                                                            |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `preset_platform.preset_definitions` | 稳定身份、名称、简介、标签、归档；内部以 UUID 身份。                     |
| `preset_platform.preset_drafts`      | 作者态 definition、schema_version、revision、owner；同名覆盖显式确认。   |
| `preset_platform.preset_releases`    | immutable version、payload_hash、发布人/时间、来源草稿；历史不 UPDATE。  |
| `preset_platform.platform_default`   | 单行 release pointer + revision；发布/回滚原子切换。                     |
| `preset_platform.test_sessions`      | operator、标题、model、default/pinned binding、角色快照、busy/revision。 |
| `preset_platform.test_messages`      | turn/role/content/status/request_id、模型/预设/角色快照、finish/error。  |
| `preset_platform.audit_log`          | 发布、回滚、覆盖、生产素材读取的安全摘要，不记正文/个人数据。            |

数据库不变量：migration 文件头声明 `-- domain: preset_platform`；UUID/timestamptz、显式 check/FK/index/comment；release immutable；默认 pointer 只指有效 release；原子 RPC 锁 session 分配 turn；request ID unique；RLS/grant 按 viewer/operator/publisher；`SECURITY DEFINER` 固定 search_path、撤销 PUBLIC execute。Preset Platform repository 只能以按域 client/RPC 访问自有域，跨域角色卡与真实输入仍遵循只读 repository 边界，不直接 JOIN。

模型缓存首期复用进程内实现，只有多实例实测需要跨重启 stale fallback 时才新增表/Redis。

## 4. API 与关键数据流

建议端点：

```text
GET /api/internal/preset-platform/me
GET /api/internal/preset-platform/models
POST /api/internal/preset-platform/models/refresh
GET|POST /api/internal/preset-platform/sessions
GET|PATCH|DELETE /api/internal/preset-platform/sessions/:id
POST /api/internal/preset-platform/sessions/:id/messages   # SSE
POST /api/internal/preset-platform/sessions/:id/retry
GET /api/internal/preset-platform/presets
PATCH /api/internal/preset-platform/sessions/:id/preset-binding
GET|POST /api/internal/preset-platform/drafts
PATCH|DELETE /api/internal/preset-platform/drafts/:id
GET /api/internal/preset-platform/default
POST /api/internal/preset-platform/default/publish
POST /api/internal/preset-platform/default/rollback
GET /api/internal/preset-platform/materials/characters
GET /api/internal/preset-platform/materials/characters/:id/input-samples
```

环境不由任意请求参数自由选择。每个 backend 部署绑定唯一 Supabase project；SPA 切换的是成组 API base + Supabase project，服务端不可被诱导跨库。

### 一轮生成

1. 校验 operator session/角色/ownership/输入/idempotency。
2. 原子开轮并置 busy；不持 DB 锁等待 OpenRouter。
3. 发送时解析模型、角色卡；default binding 读取当前默认 release，pinned 读取固定 release。
4. 固定组装：preset system instruction + character system prompt + 成功历史 + 当前输入；用 golden test 固化。
5. 调用 generation 域内部测试入口，复用 OpenRouter timeout/SSE/prompt cache，跳过钱包/免费额度。
6. 上游 2xx 后开 SSE；逐片发送 delta。
7. 浏览器断开后服务端在 deadline 内 drain 并收口 success/failed/timeout。
8. 清 busy，记录 request/session/model/release/耗时/finish/error，不记正文。

默认预设会话每次发送才解析 pointer 并把 release ID 写进消息快照，因此“下一次发送”生效且历史可追溯。Pinned 会话固定 immutable release。使用可变草稿时保存 definition snapshot/hash，不能只引用 mutable draft ID。

### 真实输入脱敏

服务端按角色 + 时间 cursor 有界查询当前有效 user turn，仅取必要列。依次执行权限校验、丢弃空白/过短/系统内容、手机号/邮箱/TG/URL query/身份与支付标识脱敏、高风险无法安全处理样本拒绝、生成 opaque 临时引用。绝不返回 user/session/message ID。规则脱敏只能降低风险，必须同时使用最小窗口、拒绝、权限和审计。

## 5. 环境、鉴权与部署

SPA 公开变量：

```text
VITE_PRESET_TEST_SUPABASE_URL / _ANON_KEY / _API_URL
VITE_PRESET_PROD_SUPABASE_URL / _ANON_KEY / _API_URL
```

默认 test，目标配置不完整则不可选，禁止回退 production。Backend 扩展 CORS 加 `PRESET_PLATFORM_URL`；每个 Railway environment 仅持自身 `DATABASE_ENV/SUPABASE_*` 与现有 `LLM_*`，不让一个进程同时持两套 service role。

切换环境：处理未保存/生成中 → abort/忽略旧请求/SSE → 清 Query 和敏感 UI → 销毁旧 client 引用 → 恢复目标环境独立 session → `/me` 比较 environment/project fingerprint；不一致即阻断。

新建独立 Vercel Project。Preview 默认只能连 test；production 功能 flag 默认关闭，安全验收后按角色开放。

## 6. 可靠性设计

| 风险              | 措施                                                              | 不采用                 |
| ----------------- | ----------------------------------------------------------------- | ---------------------- |
| 模型目录超时/429  | 8s timeout、合并并发、15m fresh + stale cache、更新时间、强刷限频 | 无实测前不加 Redis/job |
| 生成超时/SSE 中断 | connect/overall deadline、2xx 后开流、终态落库、request ID 恢复   | 不建队列               |
| 重复发送          | idempotency key + DB unique，同 key 返回既有状态                  | POST 不盲重试          |
| 同会话并发        | 行锁/原子 RPC、busy、陈旧 streaming 收口                          | 不用进程 mutex         |
| 发布并发          | expected revision + release/pointer/audit 原子事务，409 刷新      | 不 last-write-wins     |
| 跨环境迟到响应    | 环境化 clients/query keys、AbortController、epoch、清缓存         | 不只靠 UI 标签         |
| 素材消失          | 历史保留快照，新发送重验并提示重选                                | 不修改生产数据         |
| 脱敏漏检          | 最小字段/时间窗、规则、高风险拒绝、权限/审计、禁日志              | 不声称完全匿名化       |
| DB 部分成功       | 同库不变量 RPC transaction；外部调用明确提交点/失败收口           | 不做分布式事务         |
| 容量              | 分页、长度/窗口/并发/时间上限、保留策略                           | 首期不建归档服务       |

建议初值（待确认）：单操作者 2 并发、同会话 1；20 次/分钟；输入 8 KiB、预设/回复 32 KiB；整体 120s；最近 50 轮或 token 预算先到。高价模型可按角色/allowlist 控制。

## 7. 安全、隐私与可观测性

- 浏览器不可信；权限、校验、只读约束落在 backend/repository/RLS/grant。
- 生产读取 repository 不提供 update/delete；数据库角色尽量只授 SELECT/RPC。
- 角色卡/输入均视为不可信文本，不解释为工具命令；首期禁 tool calling。
- Pino allowlist：环境、opaque operator、session/request/model/release、状态、耗时、计数；禁止正文、token、key、原始 sample ID。
- 审计发布、回滚和生产素材访问。

事件建议：`model_catalog.fetch`、`generation` 各阶段、`publish`、`material.read`、`environment_mismatch`、`rate_limited`、`session_busy`。出现未脱敏 PII、跨环境、未授权生产读取或业务表写入时，立即关闭 production flag 并 revoke 权限。

## 8. 发布与恢复

顺序：Shared V1 → test migration/RLS → backend flag-off → test SPA → 故障/隐私验收 → 独立核验 production → production migration → backend/CORS → viewer/operator/publisher 灰度。

SPA/backend 可回滚；数据库 expand-first，旧版本忽略新表。错误默认预设通过 pointer 回滚上一 release，不删历史。已有数据后 migration 优先 forward-fix。生产素材风险用 flag + revoke 立即止血。内部生成路由/限流隔离，不得耗尽 MiniApp 正式流量池。

## 9. 难点

1. 在 generation 唯一出口内复用 provider，又不触发 MiniApp 钱包/历史副作用。
2. V1 既满足质量验证又不重建 ST；建议固定顺序、单 system instruction。
3. 自由文本隐私无法靠正则保证，需最小化、拒绝、权限、审计和安全评审。
4. test/prod session、cache、迟到响应的原子隔离。
5. 默认预设变化、角色下架、模型退役下仍能重现历史，需每轮快照。
6. 生产业务域只读需 repository、grant/RLS、审计三层保证。

## 10. 文档与 Spec

实现时新增 `packages/preset-platform/README.md`；新增 `.trellis/spec/preset-platform/app/` 下 index、architecture、features、api-auth-environments、ui-state-accessibility、testing-deployment；更新根 README、`docs/ARCHITECTURE.md`、`docs/schema归属地图.md` 以及 shared/backend/database specs，正式登记 `preset_platform` 独立归属域，并同步更新现有“八域”口径。
