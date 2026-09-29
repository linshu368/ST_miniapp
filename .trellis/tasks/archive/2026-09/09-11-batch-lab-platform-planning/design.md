# 技术设计：预设批量调试平台 V1

## 1. 总体架构

```text
packages/batch-lab (Vite React internal SPA)
  -> @miniapp/shared batch-lab DTO
  -> packages/backend /api/batch-lab/*
       -> source environment context
       -> batch-lab feature/services/worker
          -> source repositories (app_core / experience, read only)
          -> engine + generation controlled internal execution policy
          -> batch_lab repositories
       -> selected Supabase project: batch_lab schema
```

Browser 不直连 Supabase 业务表，不持有 service-role/数据库凭据。新应用、Backend、Shared 互不跨应用 import；只通过 HTTP 契约连接。

## 2. 前端设计

### 2.1 包结构

建议最小结构：

```text
packages/batch-lab/
  src/main.tsx
  src/App.tsx
  src/api/client.ts
  src/api/queries.ts
  src/pages/{Experiments,ExperimentWizard,ExperimentDetail,SampleSets,SampleSetEditor,Processors}.tsx
  src/components/*
  src/lib/{queryKeys,diff,download}.ts
```

- Vite + React 18 + TS strict + React Query + AntD；表单优先 AntD Form + shared Zod 边界校验，不引入另一套 UI 框架。
- `api/client.ts` 统一 API base、错误 envelope 解包和 source environment 响应校验；组件不直接 fetch。V1 不接入登录或 Supabase browser session。
- Query key 顶层为 `['batch-lab', backendEnvironment, sourceEnvironment, ...]`。V1 没有切换按钮，环境来自 `/api/batch-lab/context`，仍必须进入 key 和页面顶栏。
- 页面按原型信息架构实现，不新增原型外页面。URL 保存列表筛选、实验/样本 ID；服务器状态不复制到 Zustand。
- 备注/标签若按排期后置，入口可以不展示，不能以不可用假按钮冒充完成。

### 2.2 渲染安全

- 原文和代码始终文本渲染。
- JSON 正则规则由 Backend 权威校验和执行；浏览器预览可调用 API，不在 UI 内形成第二套处理真相。
- 富文本返回受控 HTML/结构化产物，只进入专门容器并再次使用 allowlist sanitizer；禁止脚本、事件属性、URL、iframe 和危险 CSS。
- 优先抽取 Frontend 已有 Markdown/清洗的纯 browser-safe 能力；若耦合应用组件，则做 Batch Lab 窄适配并保存 renderer protocol/version，UI 标注“兼容预览”而非精确线上。

## 3. API 与 Shared 契约

新增 `packages/shared/src/api/batch-lab.ts`，使用 Zod 定义并导出：

- `BatchLabContext`：backend environment、source environment 和必要 capability。
- SQL templates：列表；preview token、参数、最终 SQL、统计、排除摘要和分页样本。
- Sample sets：创建、列表、详情/样本分页。
- Processor versions：列表、校验/预览、创建。
- Experiments：创建草稿、启动预检、幂等启动、列表、详情、进度、结果分页、失败项重试、复制配置、复用原文创建。
- Annotations：upsert/list（可后置但契约应只在实施该项时加入，避免空 API）。
- Export：JSONL content schema/version；下载端点返回 attachment/stream。

路由建议统一 `/api/batch-lab/*` 并在注册附近标记 `@frontend-ready`. 列表仅返回摘要，完整 SQL、prompt、代码和结果按详情/分页读取，避免超大响应。

所有 mutation 接受 `Idempotency-Key` 或资源版本：保存预览使用一次性 `preview_id + digest`；启动使用 experiment ID + frozen revision；失败重试使用 attempt target + expected status。

## 4. 环境与最小配置

- V1 不实现用户登录、账号、角色、Bearer token 或应用内 authorization guard；访问控制依赖独立 Vercel项目/域名和现有基础设施，后续若需要身份能力另行设计。
- Backend 每个部署实例通过 `BATCH_LAB_SAMPLE_SOURCE_ENV=test|production` 选择唯一来源，默认 `test`；UI 只显示，不能修改。
- Backend 只增加满足当前需求的配置：`BATCH_LAB_ENABLED`、`BATCH_LAB_URL`、`BATCH_LAB_SAMPLE_SOURCE_ENV`、来源专用只读连接 secret，以及 SQL/生成/worker/processor 的少量硬上限。平台写库继续复用当前 Backend Supabase配置，不增加生产审批、合规、脱敏、项目 allowlist或通用多数据源配置。
- 配置缺失时拒绝样本 preview，不静默切换到其他环境。缓存、preview、样本和实验保留 `source_environment`，防止来源混用。
- 来源读取 client 与 `batch_lab` 写入 client 必须分离。来源凭据对业务 schema 只有必要 `SELECT`，无任何写权限；平台写入只进入 `batch_lab` schema。

## 5. 样本 SQL 与冻结

### 5.1 SQL 安全模型

- 模板存于代码配置或 `batch_lab.sql_templates`；V1 无管理 UI。
- 最终 SQL 只能返回锚点键（至少 session ID + turn index/稳定 message ID）及可选采样字段；Backend repository 再按当前线上语义补齐完整快照，避免业务 SQL任意返回未经校验的伪快照。
- 使用目标环境专用 PostgreSQL 只读角色/连接。该角色对来源业务 schema 只有必要 `USAGE/SELECT`，无 `INSERT/UPDATE/DELETE/TRUNCATE/DDL` 和危险函数执行权限。每次预览单独事务：`READ ONLY`、明确 `statement_timeout`/`lock_timeout`、行数上限、响应字节上限。
- 拒绝多语句、非 `SELECT/WITH`、危险函数和不在 allowlist 的 schema；真正的权限边界是只读 DB role，文本检查仅作提前反馈。
- 模板参数使用绑定变量/安全模板编译，不做字符串拼接。直接编辑 SQL仍按只读事务执行。

### 5.2 Preview 一致性

预览完成后把锚点顺序、最终 SQL digest、参数、统计、随机策略/种子（可得时）、排除原因和短时 `preview_id` 写入独立 `batch_lab` schema。保存样本集只消费该 preview，验证未过期且 digest 一致，在平台写库事务中复制冻结内容；整个流程不得通过来源只读连接写任何表。修改任何输入使前端 preview 无效。零有效样本拒绝保存。

快照保存：来源环境、用户/会话/角色/anchor、窗口前历史和每轮用户输入、角色卡和动态输入、线上原始回复/模型（可得时）、还原策略、实际可用窗口。生产样本合规、脱敏和审批不在 V1 设计范围内。

## 6. 数据模型：`batch_lab` 域

物理表可在实施时按 migration 细化，但逻辑真相如下：

| 表                                         | 主要职责/不可变性                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `sql_templates`                            | 工程模板 key/version/body/parameter schema/enabled；无管理 UI                                                       |
| `sample_previews` + `sample_preview_items` | 短时预览与锚点/快照候选，保证保存不重抽                                                                             |
| `sample_sets` + `sample_snapshots`         | 冻结 SQL/参数/统计和完整样本；创建后不可更新内容                                                                    |
| `processor_versions`                       | name/protocol/code/digest/creator；不可变                                                                           |
| `experiments`                              | generation/reuse、名称/目的、样本集、mode/X、状态、source/generation source、幂等 revision                          |
| `variant_snapshots`                        | A/B 模型/provider ref/参数/完整预设/processor/renderer/context strategy；运行后不可变                               |
| `generation_attempts`                      | sample/variant/round/attempt、effective request、raw output、finish reason/status/error/request id/usage/timestamps |
| `display_results`                          | generation result + processor/renderer、sanitized artifact、status/error/match count                                |
| `annotations`                              | experiment/sample/optional round、tag/note/editor；可后置                                                           |

约束重点：

- 每个运行单元唯一 `(experiment_id, sample_id, variant, round_index)`；attempt number 单调递增。
- 同一单元最多一个 active lease；启动使用唯一 idempotency key。
- reuse 实验通过稳定 generation attempt/result ID引用原文，但保存自己的 processor 与 display result；禁止覆盖来源。
- 状态使用 check constraint/受控枚举，计数可缓存但可从任务真相重建。
- 大 `effective_request/raw_output/rendered` 评估 TOAST/容量和保留策略；V1 不自动清理不可变实验。
- service-role/Backend 是主要访问者；浏览器无表权限。创建 schema 后同步 PostgREST expose（若 repository 使用 supabase-js）、`DOMAIN_SCHEMAS`、schema 地图与 grants。

## 7. 生成与多轮编排

### 7.1 唯一生成出口

在 `features/generation` 内增加显式、窄类型的内部 Batch Lab execution policy：

- 复用模型解析、上游请求、timeout、SSE/finish reason 解析和日志。
- policy 明确 `billing: internal_research`、`persistence: batch_lab`，跳过用户免费额度/钱包/真实 chat_history，但记录研发调用和可获得 usage。
- 该策略只能由 Batch Lab 内部 worker 调用，不能由普通会话请求参数选择，防止绕过计费。
- 不复制 `upstream.ts` 到新 feature；如现有 `execute` 难以安全拆分，先提取“上游执行原语”，真实会话与 Batch Lab 各自编排。

### 7.2 单轮与多轮

- 启动时从样本快照和 variant snapshot 构造 immutable run plan。
- 单轮只使用 anchor 前历史 + 当前用户输入。
- 多轮从 `anchor-X+1` 开始。每个 sample + variant 内串行；不同 sample/variant 在服务端配置的有界并发中运行。
- 每轮 effective request 在调用前持久化；成功原文在推进下一轮前提交。下一轮只读取同分支前序成功原文，不读取 display result。
- 分支失败将后续轮次置 `blocked_by_previous_failure`。重试先验证前序成功链并从失败轮新建 attempt，不重跑成功项。
- 动态记忆可重放时由真实引擎接缝按分支演进；无法重放时仅允许已审核的 fixed-start strategy 并清晰标记，否则排除样本。

## 8. 持久后台任务

V1 不引入新队列产品，采用数据库状态机 + 租约 worker：

1. 启动事务冻结配置、生成任务单元并把实验置 queued；唯一键保证重复启动返回同一实验。
2. Backend 进程 worker 用 `FOR UPDATE SKIP LOCKED` 等价 RPC领取任务，写 lease owner/expires_at/heartbeat。
3. worker 崩溃或服务重启后，过期 lease 可重领；已 success 的单元不再执行。
4. 每次上游调用都有 request/attempt ID。超时且上游结果未知标记 `unknown`，自动重试须保守，UI明确可能额外计费。
5. 自动重试仅用于配置允许且安全的网络/429/5xx，有限次数 + 退避；语法/参数/4xx 不自动重试。

容量验证若证明单 Backend worker 会影响线上请求，先用独立 Railway worker 进程复用同一 backend 包和数据库租约，而不是引入新的后端服务/API或队列协议。

## 9. 后处理

- 首版协议 `regex-json/v1`：name + 按顺序 rules(pattern, flags, replacement)，限制规则数、代码长度、输入/输出长度和单次执行预算。
- JavaScript RegExp 存在灾难性回溯风险。权威执行不得直接阻塞 Fastify event loop：使用受限 worker thread/子进程并设置硬超时；超时终止该处理任务并记录失败。
- replacement 生成内容进入 allowlist sanitizer；零匹配返回 success + hits=0。
- processor 和 renderer 均保存 protocol/version/digest。旧 display result 永不随 renderer 升级重写。
- “复用原文”批量创建 display tasks，不创建 generation tasks，计划调用数为 0。

## 10. 差异与导出

- 差异从冻结的 A/B snapshots 计算：模型/参数结构化 diff，预设和规则代码行 diff；不读取当前配置名称推断。
- JSONL 由 Backend 流式分页读取并逐行序列化，避免一次加载全实验；Content-Disposition 下载。
- 每行通过 shared `schema_version=1.0` schema，含失败/blocked/unknown。导出的是保存事实，不临时重新执行规则或补查线上数据。

## 11. 可靠性设计

| 关注点    | 方案                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| 超时      | SQL statement/lock timeout；LLM沿用明确上游 timeout；后处理硬 timeout；下载/分页请求预算                                 |
| 有限重试  | 仅幂等读取、租约领取和可安全分类的上游瞬时错误；指数退避/429；上限服务端配置                                             |
| 幂等      | preview digest、实验 frozen revision、启动 key、任务唯一键、attempt ID、重试 expected status                             |
| 并发      | sample+variant 内串行；数据库租约裁决；全局/每实验并发上限；不靠 UI禁用作真相                                            |
| 事务      | 保存 preview、冻结实验/建任务、状态汇总分别使用事务/RPC；LLM无法入事务，用 attempt 状态收口                              |
| 降级      | 单样本/分支/处理失败不拖垮其他任务；签名/富文本失败仍显示原文；只读源不可用时禁止新预览但历史可读                        |
| 补偿      | 不写真实业务，无需业务回滚；启动建任务失败事务回滚；未知上游结果保留人工重试决定                                         |
| 限流/容量 | SQL/行/字节/X/样本/导出上限由服务端配置；worker 有界并发；评估 prompt/output TOAST                                       |
| 可观测性  | experiment/sample/variant/round/attempt/source env、阶段、耗时、status、provider request id 和队列深度；敏感正文不进日志 |

## 12. 最小充分方案

新增一个 SPA 包、一个 shared API 文件、Backend 一个 batch-lab feature/route/repository/worker、一份（必要时按安全发布拆分的）正向 migration 和现有 generation 的受控接缝。拒绝微服务、通用工作流引擎、外部队列、复杂 RBAC、模板后台、多数据源框架、自动评分和任意 JS sandbox。

数据库租约与受限 processor worker 是持久任务恢复和正则超时的必要复杂度，不属于提前泛化。

## 13. CI、部署、演进与恢复

### 13.1 Vercel 与 CI

- 参考 `packages/admin/vercel.json` 和 `packages/cs-platform/vercel.json`，新包提供 `packages/batch-lab/vercel.json`：`framework: null`、`pnpm install`、`pnpm --filter @miniapp/batch-lab build`、静态 `dist` 和 SPA rewrite到 `index.html`。
- 建立独立 Vercel Project。浏览器只配置公开 API base（如 `VITE_BATCH_LAB_API_URL`），不配置 Supabase key、数据库连接或供应商 secret。
- Vercel Preview 指向 development/PR Backend；Production 指向对应稳定 Backend。Backend CORS 精确加入 Batch Lab origin。
- `.github/workflows/ci.yml` 在现有 quality gate 显式增加 Batch Lab test/build；根 `pnpm typecheck`、`pnpm lint` 和跨包 import guard继续覆盖新 workspace。
- 不为 Batch Lab增加 Railway前端 service、前端 Dockerfile或GHCR镜像；Railway只继续承载 Backend，必要时增加同一 Backend包的 worker进程。

### 13.2 发布顺序

1. 先在 test 核对源表/turn语义和只读角色，做真实写权限负测；执行 `batch_lab` migration，验证 schema/grants/RLS/锁/容量/回滚。
2. 发布 Shared + Backend（路由可 feature flag关闭），确认旧消费者/真实会话链路无变化。
3. CI通过后发布 Batch Lab Vercel Preview，仅连接 test/development Backend，完成 SQL→冻结→小规模真实生成→失败恢复→导出验收。
4. 再做目标规模、重启恢复和 Vercel静态路由测试；观察 Backend延迟与worker资源。必要时把worker作为同包独立进程部署。
5. 环境来源切换仅通过 Backend部署配置完成；V1不建设生产样本合规、脱敏或审批流程。

停止条件：越权/跨环境串数据、SQL可写、真实会话或钱包被修改、重复调用失控、A/B 串分支、重启重复成功任务、日志泄露正文/密钥、正则阻塞 event loop、生产容量异常。

应用回滚：先关闭 Batch Lab feature flag/worker，再回滚 SPA；Backend 保持可读新增表。数据库不做紧急 destructive rollback，保留历史实验；确认无写入且已备份后，用独立审核回滚 migration 或 forward-fix。迁移不随应用部署自动执行。

## 14. 开工前决策门

- 对照真实源码确认内部免用户计费生成接缝的拆分方式。
- 只读采集 test/production schema shape，不读取业务行；确认 SQL 模板锚点和跨域 repository。
- 确认来源环境专用只读凭据，并通过写入负测证明不能修改任何来源业务数据。
- 确认线上 renderer/后处理协议能否提取；不能时明确兼容差异。

## 15. 子任务依赖图

```text
foundation
  ├─> data-samples ───────────────┐
  └─> postprocessing ──────────┐  │
                               ├──┴─> backend-execution
                               │         │
                               └─────────┼─> frontend-workbench
                                         │          │
                                         └──────────┴─> history-export

foundation + data-samples + postprocessing + backend-execution
           + frontend-workbench + history-export
  └─> integration-spec
```

- `foundation` 先提供可编译的新包、环境 context、统一 client、Vercel/CI配置和基础契约。
- `data-samples` 与 `postprocessing` 在 foundation 后可并行，但数据库表/RPC边界须在各自设计中互不覆盖。
- `backend-execution` 依赖冻结样本和 processor/display 稳定接口。
- `frontend-workbench` 只接入标记 frontend-ready 的稳定 API，不以组件 mock 代替后端完成。
- `history-export` 依赖稳定实验/result/display 和工作台详情壳层。
- `integration-spec` 只做集成与知识收口，不偷补兄弟任务未完成的产品能力。

## 16. Spec 演进设计

实施完成后新增独立包规范：

```text
.trellis/spec/batch-lab/app/
  index.md
  architecture-and-files.md
  api-and-environments.md
  samples-experiments-and-jobs.md
  postprocessing-results-and-export.md
  testing-deployment-and-recovery.md
  modules/index.md
  modules/business/experiment-workbench.md
  modules/infrastructure/client-environment-deployment.md
```

如实现证明数据库存储或 Backend execution 形成稳定独立职责，再新增对应 Database/Backend module fact；不得在实现前把规划推断写成“当前状态”。各子任务提供 `module-updates.json` 候选与事实证据，最终由 `integration-spec` 统一核对、运行 `module_knowledge.py check/rebuild-index` 并更新 README/ARCHITECTURE。
