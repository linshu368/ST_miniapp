# Backend CLAUDE.md（AI 硬规则速查）

> 在 `packages/backend` 下工作时必须遵守本文件。
> 与前端 CLAUDE.md 对等，提供后端侧的约束和目录约定。
> 完整的跨角色协作流程见根 `CLAUDE.md` 的「Dev 提交前强制清单」和「数据契约纪律」。

## 必须（硬规则）

- **框架**：Fastify 5。
- **语言**：TypeScript 严格模式。**禁止 `any`**。
- **运行时**：Node.js 20.x，使用 tsx 执行。
- **数据契约**：所有前后端共享的数据形状必须定义在 `packages/shared/`，后端不得在 `backend/` 内部私定对外数据形状。
- **数据库**：Supabase PostgreSQL，与 Bot 共享。
- **环境变量**：不要提交到 git，走部署平台（Railway）管理。

## Dev 提交前强制清单（每次 `git commit` 前逐项核对）

> 本清单是根 `CLAUDE.md` 同名章节在 backend 侧的复述，两处保持一致。PR review 时 reviewer 也要盯。

### 1. 每一条路由注册上方必须有 `@frontend-ready` 注释

`packages/backend/src/routes/*.ts` 和 `src/app.ts` 里每条 `app.(get|post|put|delete|patch)(...)` 紧邻上方一行必须是以下两种之一：

```ts
// @frontend-ready: true
app.get('/api/characters', async (req, reply) => { ... })

// @frontend-ready: false — LLM 调用未接入
app.post('/api/sessions/:id/messages', async (req, reply) => { ... })
```

**判断 true / false 的标准**（存在灰色地带时就近决定，但要前后一致）：

- handler 能返回 `packages/shared/` 契约规定的完整数据、业务行为完整可用 → `true`
- handler 虽能响应，但业务逻辑是半成品（未接外部服务、未落库、stub 化、只返回假数据、字段未填等）→ `false — <一句话原因>`

原因字段需带业务含义（例如 "LLM 未接入"、"计费逻辑 stub"、"依赖 X 模块 merge"）；避免只写 "wip" / "todo" 这类无信息词。

这条注释是后端 → 前端的状态单向通道：PM bootstrap 的 Step 2c 会扫它，决定前端对应模块走 mock 还是真后端。漏写或状态错时，前端会按保守路径走 mock，PM 可能会在群里 @ 你确认。

### 2. handler 从半成品变完工时，默认在同一个 PR 里把 `false` 改 `true`

review 时这一行是重点检查项。确需拆成独立 PR（handler 改动过大 / 分步 review），在 PR 描述里交代接下来哪个 PR 切 `true`，避免悬空。

### 3. 不得删除或修改已被前端 mock 引用的 seed UUID

- `packages/shared/src/dev-fixtures.ts` 导出的 `DEV_SEED_*` 常量是前端 mock 数据的硬依赖
- 对应后端记录由 `packages/backend/prisma/seed.ts` 的 `upsert` 保证每次 dev 部署存在
- **不得**删除 `dev-fixtures.ts` 已有的 UUID 常量
- **不得**删除 `seed.ts` 里对应 UUID 的 upsert 语句
- **不得**修改这些记录的 `id` 字段
- 确需删减走流程：先通知 PM 改 mock 数据，PM 合并后才动 seed

### 4. 新增 / 修改对外数据形状，必须先定义在 `packages/shared/`

handler 的请求体 / 响应体类型全部引自 `packages/shared/`。shared 里没有的类型，**先在 shared 里定义、再写 handler**。

### 5. 不得动 `packages/frontend/` 下任何文件

`packages/shared/` 起草权双向（PM 也可起草，由 Dev 在 PR review 裁决）。其他前端目录完全不要动——包括 `packages/frontend/src/lib/api/` 下的 mock / 真后端分叉代码，那归 PM 维护（`shouldUseMock()` 分叉写在 PM 提的 PR 里）。如 Dev 发现 api hook 里真后端分支有 bug，在 PR 评论或群里提 PM，由 PM 改。

## Claude Code Dev 侧主动行为（命中条件时触发，Dev 不用记）

Dev 是技术角色，硬规则上面已经写清楚，这里只列**两个最容易踩的业务决策陷阱**，Claude 命中时主动帮你一把。其他场景按硬规则自觉执行即可。

#### D1. 新增/修改路由时，自动帮你写 `@frontend-ready` 注释

- **触发条件**：Claude session 里检测到 `routes/*.ts` 或 `app.ts` 新增或修改了 `app.(get|post|put|delete|patch)(...)`
- **Claude 问你**（业务判断，不涉及注释格式）：
  > "你这次加/改了路由 `POST /api/xxx`，它的功能完成度怎么样？"
- **选项**：
  - `完工可用（handler 能返回完整数据、业务行为完整）`
  - `半成品，原因是：______`（Claude 把你填的原因落进注释）
  - `只是调整参数格式，handler 实现未变`（沿用上方原有注释）
- **Claude 行为**：按你回答自动写或更新 `// @frontend-ready: ...` 注释到路由正上方，格式它搞定

#### D2. 改过 routes 文件后，Claude 主动替你核对清单第 2 条

- **触发条件**：Claude session 里检测到本次已修改 `packages/backend/src/routes/*.ts` 或 `app.ts` 的**任意内容**（不限于路由注册行，handler 函数体、import、辅助函数都算）。**同一 session 内每个文件只触发一次**（避免刷屏）
- **目的**：Dev 提交前强制清单第 2 条要求「handler 完工时在同 PR 把 `false` 改 `true`」。但 Dev 只改 handler 函数体时容易默认跳过这条自查——Claude 替你把清单跑完
- **Claude 行为**：扫本次改过的文件里所有标 `@frontend-ready: false` 的路由，列出清单让你确认
  > "你本次改过 `routes/xxx.ts`。该文件里目前还有以下 `@frontend-ready: false` 的路由：
  >
  > - `POST /api/sessions/:id/messages` — LLM 调用未接入
  > - `POST /api/other/endpoint` — 计费逻辑 stub
  >
  > 其中有哪些本次已经完工、要切成 `true`?"
- **选项**（多选，或逐条告诉 Claude）：
  - `本次未改任何 handler 业务逻辑（只调了 DTO / 参数 / log / import），全部维持 false`
  - `全部仍半成品，无变化`
  - `逐条告诉你`（Claude 追问每条的状态；你说完工则自动改注释为 `true`，可选填一句完工说明）
- **范围约束**：Claude **只改被 Dev 确认完工的那几条注释**，不批量改、不猜。若文件里没有任何 `@frontend-ready: false` 注释，本步静默跳过
- 目的是把清单第 2 条从「Dev 脑内自查」降级为「Claude 替你过一遍」，防止"清单跑过了但漏了这条"

#### D3. 删/改 seed UUID 前，Claude 先扫影响面让你二次确认

- **触发条件**：Claude session 里检测到你要改动 `packages/shared/src/dev-fixtures.ts` 的 `DEV_SEED_*` 常量，或 `packages/backend/prisma/seed.ts` 里对应的 upsert
- **Claude 行为**：扫前端 mock 对这个 UUID 的引用，列出受影响的文件和行号，告诉你后果
  > "UUID `xxx-xxx-...` 被前端 mock 的 `mock-data/chat.ts:24`、`mock-data/characters.ts:15` 引用。删除或改 UUID 会导致这些 mock 数据在前端切真后端时 404。"
- **选项**：
  - `确认要改/删，我已通知 PM 同步改 mock 数据`
  - `先别改，我撤销`
  - `只是重命名常量名（UUID 值不变）`
- 目的：防止紧急 hotfix 或一时没想起来,误改了前端的硬依赖

## 与前端的边界

- 后端**不关心**前端的 UI 框架、样式方案、状态管理选型。
- 后端**必须关心** `packages/shared/` 里的类型契约，确保 API 响应与契约一致。
- 新增 API 端点时，先在 `shared/` 定义请求/响应类型，再写实现，再写 `@frontend-ready` 注释。

## Mock-Registry 自动同步（PM 侧机制，后端需要配合的部分）

PM 的前端 mock 切换基于本地 `src/routes/` 和 `app.ts` 当前注册的路由 **+ `@frontend-ready` 注释状态**——扫描规则见根 `CLAUDE.md` 的 Step 2c。

对后端开发的具体约束：

1. **`app.get/post/put/delete/patch('路径', ...)` 的字面量路径必须和 `packages/shared/` 契约约定一致**（路径参数用 `:id` 命名惯例）。
2. **每次注册路由必须带 `@frontend-ready` 注释**（见上面「Dev 提交前强制清单」第 1 条）。
3. **handler 业务逻辑状态变化时必须更新 `@frontend-ready` 值**（见第 2 条）。

满足这三条，PM 下次 bootstrap 会自动感知变化并切换前端 mock / 真后端，不需要线下通知。

## 永远不要做

- ❌ 路由注册上方省略 `@frontend-ready` 注释（哪怕只是小改）
- ❌ `@frontend-ready: false` 的 reason 只写 "wip" / "todo" 这类无信息词（需带业务含义）
- ❌ 动 `packages/frontend/src/lib/api/mock-registry.ts`（自动生成文件）
- ❌ 动 `packages/frontend/src/lib/api/mock-registry.config.ts`（PM 归属）
- ❌ 删或改 `dev-fixtures.ts` 已有的 UUID 常量
- ❌ 删或改 `seed.ts` 中对应 UUID 的 upsert 语句
- ❌ 在 backend 内部定义本该放在 shared 的对外类型
- ❌ 动 `packages/frontend/` 下除 `packages/shared/` 起草外的任何文件（含 `src/lib/api/` 的 mock 分叉代码，归 PM）
