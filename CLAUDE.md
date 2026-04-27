# ST_miniapp

Telegram Mini App（AI 角色扮演），与 Bot 共享 Supabase 数据库。  
monorepo 结构：`packages/{frontend,backend,shared}`，包管理器 pnpm。

---

## 新会话 Bootstrap（Claude Code 必读）

每次新会话开始，**按以下顺序**完成 bootstrap，再接受任务。

### 角色识别（Bootstrap 最先执行）

**不要预设用户是 PM 还是开发。** 根据用户自己的描述、提出的任务类型和上下文来判断角色，在不确定时直接询问。确认角色后：

- **PM**：主要做前端 UI，可在 `packages/shared/` 起草契约草案（由开发在 PR review 裁决），必读文档包含前端相关文档，遵守「数据契约纪律」。`packages/backend/` 按需读（例如判断某 endpoint 的实现完成度、排查联调问题），但**不以 backend 源码作为数据形状依据**（契约仍以 `packages/shared/` 为准，见「数据契约纪律」第 4 条）。
- **开发**：负责数据层和后端，只需读与后端/shared 相关的文档，前端技术栈约定为参考而非必读。

角色决定了 Step 1 中哪些文档是必读的（见「必读文档索引」中的角色标注）。

### Step 1 — 读完所有规则文档

1. 读本文件（项目根 `CLAUDE.md`）。
2. 根据已确认的用户角色，读「必读文档索引」中**对应角色**的文档，全文阅读。
3. 递归搜索整个 workspace 中所有 `CLAUDE.md`，**全部读完**。
   - **就近优先**：在某子目录工作时，离你最近的 `CLAUDE.md` 优先级最高；根 `CLAUDE.md` 提供全局约定。
   - 子目录 `CLAUDE.md` 与根冲突时，先指出冲突再等用户决策。
4. 读 workspace 根的 `package.json` 与 workspace 配置，确认包管理器、脚本约定、engines 要求。
5. 对本次任务将要接触的 package，读它的 `package.json` 了解已装依赖。

### Step 2a — 结构扫描（必做）

**只看目录树和文件名，不读文件内容。**

1. 列出 workspace 根目录、以及 `packages/` 下每个 package 根目录的一级文件和子目录。
2. 对每个 package，列出其 `src/` 的递归目录树（到文件名级别，不读内容）。
3. 如发现 `CLAUDE.md` 描述的结构与现场不符，判定为「文档过期」，在 Step 3 回复中指出。

### Step 2b — 按需精读（收到任务后进行）

收到具体任务后，只读**任务相关**模块：

- 任务直接涉及的模块；
- 这些模块依赖的 `packages/shared/` 里的类型和数据层；
- 任务不涉及的模块**不读**。

**复用优先**：地图里已有明显重叠的封装，主动指出并复用，不重写。

### Step 2c — PM 专属：Mock-Registry 自动同步（仅 PM 角色执行）

> **本步只在用户角色为 PM 时执行。开发角色跳过本步。**

**目的**：PM 以本地 `packages/backend/` 的 committed 代码作为"已实现接口"的唯一真相源。不管 dev 环境 Railway 上是什么版本、开发有没有在上面跑新功能测试，前端的 mock-registry 只依据本地 main 分支能看到的代码来判定哪些模块可走真后端。这样保证 PM 分支跟开发 dev 环境即使有漂移也不会出错。

**执行时机**：PM 身份确认后、Step 2a 结构扫描完成后，**在 Step 3 回复前**执行。每次新会话都执行一次——开发可能刚合了新 routes 到 main。

**算法**（必须严格按此执行，不要发挥）：

1. 读 `packages/frontend/src/lib/api/mock-registry.config.ts`，提取 `MODULE_CONFIG`
2. 扫 `packages/backend/src/app.ts` + `packages/backend/src/routes/*.ts`：
   a. 用 regex 匹配所有 `app.(get|post|put|delete|patch)('路径', ...)` 注册的路由，归一化为 `METHOD /path` 字符串列表
   b. 对每条路由，向上查找紧邻上方的单行注释 `// @frontend-ready: <true|false>[ — <reason>]`。记录每条路由的 `@frontend-ready` 状态（`true` / `false` / **缺失**）以及 reason（如有）
3. 对每个模块独立计算「intrinsic mock 状态」：
   - 若 `forceMockReason` 非空（PM 手动 override）→ **MOCK**（原因：forceMockReason 内容）
   - 否则，若任一 endpoint 不在第 2.a 步扫描结果中 → **MOCK**（原因：列出缺失的 endpoint）
   - 否则，若任一 endpoint 的 `@frontend-ready` 状态为 `false` 或缺失 → **MOCK**（原因：`METHOD /path` 标记 `@frontend-ready: false — <reason>`；缺失注释时原因为「路由 `METHOD /path` 未带 `@frontend-ready` 注释，视为未就绪」）
   - 否则 → **候选 REAL**
4. **命名一致性检查（轻量）**：对因「endpoint 缺失」而 MOCK 的模块，扫一眼 backend 里没被任何 PM 模块引用的路由（孤儿路由）。如果某条孤儿路由和模块期望的缺失 endpoint 同 method、路径明显共享关键字（靠常识判断，不走严格算法），报一条告警：`模块 X 期望 METHOD /api/a/b，backend 未找到；但发现孤儿路由 METHOD /api/a/c，疑似命名未对齐`。本步**不改 MOCK/REAL 判定**，只产出告警。无明显相似时不输出。
5. 生成 `packages/frontend/src/lib/api/mock-registry.ts`，必须包含：
   - 顶部 `⚠️ AUTO-GENERATED` 注释
   - 「最近一次同步」日期（当前会话日期，绝对日期格式 YYYY-MM-DD）
   - 「Backend 路由扫描结果」清单（每条 `METHOD /path` + 来源文件 + `@frontend-ready` 状态）
   - 「逐模块解析」清单（每个模块 → MOCK/REAL + 理由一句话）
   - `MOCK_MODULES` 集合与第 3 步结果一致
   - `shouldUseMock()` 函数保留 `FORCE_ALL_MOCK` 全局开关兜底
6. 如果重新生成的 `mock-registry.ts` 与磁盘上现有内容**实际内容不同**（忽略日期差异），在 Step 3 回复的「骨架地图」之后加一节「Mock-Registry Sync Diff」，列出变化；如果内容一致则声明「Mock-Registry 无变更」。第 4 步的命名一致性告警（如有）在 Sync Diff 之后另起一节「命名一致性告警」列出；无告警时不输出该节

**PM 新增功能的配合流程**（不需 PM 每次手动改 registry.ts）：

1. PM 在 `mock-registry.config.ts` 的 `MockModule` 联合类型和 `MODULE_CONFIG` 里加新模块（填 endpoints 即可，**不填 `forceMockReason`**——handler 完工性由 Dev 在路由注释里维护）。**提示**：起草新模块的 endpoints 路径前，在群里花 15 秒跟 Dev 对齐一下路径命名（例如 `/api/voice/tts` vs `/api/tts`），避免 PM 起草的路径和 Dev 后续实现的路径对不上导致 `mock-registry` 永远 MOCK
2. PM 写对应 `src/lib/mock-data/<module>.ts` 和 `src/lib/api/<module>.ts`（后者用 `shouldUseMock('<module>')` 分叉）
3. 下次会话 bootstrap Step 2c 自动扫 backend，发现新模块的 endpoints 不存在，标为 MOCK
4. 后端实现后 merge 到 main，PM 下次会话 Step 2c 自动把该模块从 MOCK_MODULES 移除 → 切到真后端

**协议约束**：

- 本步**只改 `packages/frontend/src/lib/api/mock-registry.ts` 一个文件**。不动 `mock-registry.config.ts`（那是 PM 源文件）、不动 backend、不动 shared、不动 mock 数据
- Sync 过程不产生疑问需要 PM 确认（算法是确定性的）；有变更就直接改、在 Step 3 里报出来；PM 看到 diff 觉得不对再人工干预
- 读不到配置文件或 backend 文件时直接告诉用户路径缺失，不要编造扫描结果
- 开发角色**绝不执行**本步。避免开发误改 mock 配置——mock 层是 PM 工作区

### 数据契约纪律

1. `packages/shared/` 是前后端共享数据形状的**唯一真相源**。
2. 前端需要的类型：已有 → 直接消费；没有 → 由**功能发起人**（多数情况是 PM）在 `shared/` 起草草案，开发 PR review 时裁决定稿。
3. 严禁在前端私自定义与 shared 并行的**业务类型**（纯 UI 状态类型如 `isExpanded` 留在 frontend 本地）。
4. 严禁为推测数据形状去读 `packages/backend/` 源码（其他目的如判断某路由的 `@frontend-ready` 状态、排查联调问题可以读，见角色识别一节）。
5. **反推测字段**：`shared/` 里新增的每个字段必须在本次 PR 的前端代码里被实际引用，没用到的不许写。
6. **Seed UUID 保护**：`packages/shared/src/dev-fixtures.ts` 导出的 `DEV_SEED_*` 常量是前端 mock 数据的硬依赖，对应后端记录由 `packages/backend/prisma/seed.ts` 的 `upsert` 保证每次部署存在。任何人**不得删除或修改**这些 UUID 常量及对应 seed 记录；确需删减先通知 PM 改 mock 数据，合并后才可动后端 seed。

### Step 3 — Bootstrap 完成后按此模板回复

```
✅ Bootstrap 完成（Step 1 + Step 2a[ + Step 2c，仅 PM]）

项目理解：<2-3 句复述项目定位、技术栈、协作流程>

规则文档清单：<列出实际读到的所有 CLAUDE.md 和必读文档路径>

骨架地图：<关键 package 与其源码目录的树状结构，到文件名级别>

Mock-Registry Sync Diff（仅 PM 输出；无变更时写「无变更」）：
<列出 mock-registry.ts 的内容变化，或声明无变更>

命名一致性告警（仅 PM 输出；无疑似不一致时整节省略，不输出空节）：
<列出每条疑似 PM 与 Dev 命名未对齐的 MOCK endpoint vs 孤儿路由>

我已记住的硬红线：<列 5 条最关键的>

⚠️ 发现的问题/不一致（无则写「无」）：

等待任务指令。收到任务后按 Step 2b 精读相关模块再动手。
```

### 协议约束

- Step 1 + Step 2a（PM 再加 Step 2c）完成并按 Step 3 回复前，**不要**写代码、不要猜任务、不要主动建议引入新库。
- 文件读不到或路径不存在时，**直接告诉用户**，不要编造。
- 所有硬规则以现行 `CLAUDE.md` 集合与链接文档为**唯一真相源**。

---

## 必读文档索引

**通用（所有角色必读）**：

- 本文件（项目根 `CLAUDE.md`）
- 所有子目录 `CLAUDE.md`

**PM 必读**：

- **[前端技术栈约定](./docs/frontend-stack.md)** — 不可谈判的前端选型、代码规范、与 AI 协作约定
- **[前端联调 dev 后端环境配置](./docs/frontend-env-config.md)** — `.env.local` 三档环境变量、mock-registry 自动同步流程、Vercel Preview 配置

**开发必读**：

- `packages/backend/CLAUDE.md` — 后端硬规则与目录约定

**开发参考（非必读）**：

- [前端技术栈约定](./docs/frontend-stack.md) — 了解前端选型即可，不需要逐条遵守

---

## PM 开发前强制清单（PM 角色必做，每次开始新任务都跑一遍）

> 2 PM + 2 Dev 并行协作的基线：每次走完本清单，就不需要跟另一个 PM、Dev 做前置沟通。
>
> **心态**：PM 开发时看到的是 mock + 真后端按**模块动态混合**——某些模块走真后端、某些走 mock，这是 `@frontend-ready` 机制的预期产物，不是 bug 也不是需要修正的状态。PM 不用追求"全真"或"全 mock"，按 bootstrap 判定即可。真后端能用就用（更贴近用户场景），不能用时 mock 顶上（mock 已引真 UUID，切换无缝）。

1. **拉最新 main 起功能分支**
   ```bash
   git checkout main
   git pull
   git checkout -b pm-<代号>/<feature>-YYYYMMDD
   ```
2. **在项目根目录 `ST_miniapp/` 起 Claude Code 新会话**。不在子目录起，否则 bootstrap 扫不到全局
3. **等 bootstrap 跑完，认真看 Step 3 回复里的「Mock-Registry Sync Diff」**，重点看三件事：
   - 哪些模块从 MOCK 切到 REAL（对应 backend handler 完工了，标记从 `@frontend-ready: false` → `true`，或本次是补上缺失注释）
   - 哪些模块从 REAL 切到 MOCK（backend 新增未完工 endpoint 或回退）
   - 你本次任务涉及的模块当前是 MOCK 还是 REAL
4. **按任务模块当前状态选路线**（**所有路线都不阻塞，不需要前置等 Dev 回复**）：
   - 模块当前 REAL → 正常接真后端开发
   - 模块当前 MOCK → 正常用 mock 开发，mock 数据已引真 UUID，未来自动切真不会崩
   - 模块**上次会话 REAL、这次变 MOCK** → 继续用 mock 推进，不阻塞；顺手在群里 @ 一下对应 Dev 异步告知「某模块今早变 MOCK 了，确认下是否计划内」。Dev 回复前 PM 照常工作
   - **想直接瞥一眼真后端数据形态**（例如确认真 character 的 `description` 长度分布、真 session 的字段可空性）→ 不必改 `mock-registry.ts`，浏览器 DevTools Console 里直接 `fetch('https://stminiapp-development.up.railway.app/api/xxx').then(r=>r.json())` 即可
5. **动工**。后续前端硬规则走 `packages/frontend/CLAUDE.md`

### Claude Code 主动确认（命中条件时用 AskUserQuestion 问 PM，不命中不问；PM 不需要记忆这些规则，只要看到提问按选项选即可）

只有一个问题点——防"PM 起的路径和 Dev 实现的路径对不上导致永久 MOCK"的静默 bug。PM 不用记规则，看到提问按选项选即可。

#### PM 要加新功能模块时，确认路径命名已跟 Dev 对齐

- **触发条件**（Claude 自动判断，PM 不需要理解）：PM 提出要在 `mock-registry.config.ts` 新增模块
- **Claude 对 PM 说**：
  > "你要加的这个新功能，它的后端接口该叫什么名字（比如 `/api/voice/tts` 还是 `/api/tts/generate`），跟开发对齐过了吗？**这一步很关键**——如果你定的接口名和开发最后实际写的对不上，后端将来就算做好了，前端**也不会自动切到真后端**，会一直显示 mock 数据，而且不会有任何报错提示，你很难察觉。花 15 秒先对齐一下再动手，比事后排查省事得多。"
- **选项**：
  - `已经跟开发对齐过，直接开始起草`
  - `还没对齐，帮我拼一句简讯发群里`
  - `我自己去群里问`

---

以上提问只是**辅助确认**，不是通过 / 不通过的关卡——PM 选 `我自己去群里问` / `直接开始起草`，Claude 不追问、直接继续推进。

### 两 PM 并行改 `mock-registry.config.ts` 的冲突

两 PM 各自起分支后都在 config.ts 里加新模块（不同名），merge 时 git 冲突按常规解决；合完后随便哪一 PM 起一次 Claude 会话走 bootstrap，`mock-registry.ts` 自动重算，不需要手工合并那个自动生成文件。

### PM 禁区（强制）

- ❌ 跳过 bootstrap 直接开写（包括"只改一个文案"这种自认为的小改动）
- ❌ 手改 `packages/frontend/src/lib/api/mock-registry.ts`（自动生成文件，下次 bootstrap 会被覆盖）
- ❌ 在 `packages/frontend/src/lib/mock-data/` 里硬编码 character_id / session_id 字面量；**必须**从 `packages/shared/src/dev-fixtures.ts` 引常量
- ⚠️ `forceMockReason` 字段**默认不填**——handler 完工性由 Dev 的 `@frontend-ready` 注释维护。极个别临时 override 场景（例如 Dev 已改 `true` 但 PM 想临时测 mock 边界态）可临时用，用完立即清空

---

## Dev 提交前强制清单（开发角色必做，每次 `git commit` 前跑一遍）

> PR review 时 reviewer 也要盯以下每条。漏任何一条相当于把问题扔给下游 PM 排查。

1. **每一条路由注册上方必须有 `@frontend-ready` 注释**。`packages/backend/src/routes/*.ts` 和 `app.ts` 里每条 `app.(get|post|put|delete|patch)(...)` 紧邻上方一行写成：

   ```ts
   // @frontend-ready: true
   app.get('/api/characters', async (req, reply) => { ... })

   // @frontend-ready: false — LLM 调用未接入
   app.post('/api/sessions/:id/messages', async (req, reply) => { ... })
   ```

   判断 true / false 的标准（存在灰色地带时就近决定，但要前后一致）：
   - handler 能返回 `packages/shared/` 契约规定的完整数据、业务行为完整可用 → `true`
   - handler 能响应但业务逻辑是半成品（未接外部服务、未落库、stub 化、只返回假数据、字段未填等）→ `false — <一句话原因>`
   - 原因字段需带业务含义（例如 "LLM 未接入"、"计费逻辑 stub"、"依赖 X 模块 merge"）；避免只写 "wip" / "todo" 这类无信息词

2. **handler 从半成品变完工时，默认在同一个 PR 里把 `false` 改 `true`**。确需拆成独立 PR（例如 handler 改动过大、需分步 review），在 PR 描述里交代接下来哪个 PR 会把注释切到 `true`，避免悬空。
3. **不得删除或修改已被前端 mock 引用的 seed UUID**（见「数据契约纪律」第 6 条）。
4. **新增对外数据形状必须先在 `packages/shared/` 定义**。backend 内部私定对外类型即违规。
5. **`packages/frontend/` 主要由 PM 维护,Dev 因技术接入需要改前端完全允许**——例如 SSE / WebSocket client、API client 封装、`shouldUseMock` 分叉、shared 类型对齐、telegram 鉴权适配、bug 修复等,这些不算违规。原则:**Dev 不主导前端 UX 设计**(配色/布局/交互流/视觉风格的改动需先和 PM 对齐),技术性接入两边都可以动。

---

## 分支命名

```
pm-xxx/feature-name-YYYYMMDD     ← PM 功能分支
hotfix/xxx                       ← 线上紧急修复
main                             ← 线上生产，受保护
```

每个功能起新分支，合并后分支使命结束。
