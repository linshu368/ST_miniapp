# 当前实现与复用调研

## 1. 事实来源

- 仓库：`README.md`、`docs/ARCHITECTURE.md`、相关 spec 与 2026-09-11 当前源码。
- 外部需求：`d:/download/批量调试平台 · V1 工程需求说明/批量调试平台 · V1 工程需求说明.md`。
- 外部原型：用户附件 `d:/飞书/batch-lab-prototype.txt`，内容为完整 HTML/CSS/JavaScript 原型。
- 本文件不把外部原型中的演示数据、模拟失败率、本地数组、50/500 上限或 2/3 轮选项视为生产规范。

## 2. 应用基座与 UI 复用

| 检索对象                                                       | 当前事实                                                                            | 决策                                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/admin/package.json`、`vite.config.ts`、`main.tsx`    | Vite + React 18 + TS + AntD 6 + Zod + Vitest，适合内部数据工作台                    | 新建 `packages/batch-lab` 时复用技术栈和配置模式                                                                            |
| `admin/vercel.json`、`cs-platform/vercel.json`、现有 Vite 配置 | 已有 monorepo 内独立 Vercel 静态 SPA 构建模式                                       | 复用部署结构与 SPA rewrite；Batch Lab V1 不复用登录/session，不直接 import 应用源码                                         |
| `admin/src/App.tsx`                                            | 有 Layout/Menu/Table/Descriptions/Modal/Tag 和配置差异逻辑；Refine 未形成必要资源层 | 复用 AntD 页面模式和必要纯函数，不默认引入 Refine/dnd-kit/dayjs                                                             |
| `cs-platform/src/main.tsx`、`src/api.ts`、`App.tsx`            | 已有 QueryClient、环境进入 query key、条件轮询、mutation 精确失效                   | 新平台服务端状态全部走 React Query；query key 必须含 source environment                                                     |
| `cs-platform/vercel.json`、admin Vercel 配置                   | 独立 Vite SPA rewrite/deploy 模式成熟                                               | 作为独立部署模板，增加独立 CORS origin                                                                                      |
| Frontend `components/chat` Markdown/DOMPurify                  | 有线上消息 Markdown 与清洗实现，但属于 frontend 应用内部                            | 不能跨应用 import；提取纯 browser-safe renderer/sanitizer 的可行性先评估，否则在 Batch Lab 实现协议兼容的最小适配并记录差异 |

不新建跨应用“通用后台框架”。只有环境类型、后处理协议等有两个以上真实消费者且不含应用状态时才考虑进入 shared。Batch Lab V1 不实现登录/session/角色。

## 3. Backend 与生成复用

| 检索对象                                   | 当前事实                                                                       | 决策                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `features/engine/*`                        | Prompt 组装大部分为纯函数，当前为 system prompt + 窗口历史 + 平台规则/用户输入 | 复用真实组装函数或抽取窄的离线调用接缝，禁止另写一套“近似线上”引擎                                                        |
| `features/generation/execute.ts`           | 唯一生成出口，含 120s 超时、SSE、免费额度、余额预检、计费、chat_history 落库   | 必须通过该 feature 扩展明确的内部 `batch_lab` 执行策略；不能伪造用户、扣钱包或写真实 chat_history                         |
| `features/generation/upstream.ts`          | OpenAI-compatible 上游、SSE tap 与 finish reason 已有                          | 可复用转发和终态解析；批量任务需要受控并发与非流式持久执行适配                                                            |
| `features/conversations/*` 与 repositories | 有 turn/revision、窗口历史、prompt 快照和并发守卫                              | 复用 turn 映射/历史读取语义；样本冻结和实验结果写入新域，不调用真实开轮 RPC                                               |
| `platform/runtime-config.ts`               | 模型目录、规则和平台运行配置唯一入口                                           | 模型/有效参数解析必须走现有入口，不建第二套 runtime config                                                                |
| Backend 定时任务                           | 现有任务为进程内轮询，没有通用队列                                             | V1 采用数据库租约/状态机 + 有界 worker；不因“后台任务”引入外部队列，除非容量验证证明单实例/租约不足                       |
| 日志                                       | Pino，原始错误 `{ err }`，已有生成事件                                         | 新事件仅记录内部 ID、source env、数量、轮序、状态、耗时、供应商 request id；不记录 SQL 参数敏感值、完整 prompt/原文或密钥 |

关键差距：现有生成服务强绑定真实用户计费和 chat_history；当前没有 Batch Lab 路由、任务、后处理版本、JSONL、任意 SQL 预览或调试免计费策略。这些必须显式扩展，不能宣称已存在。

## 4. Shared 契约

- `packages/shared/src/api/*` 是唯一 HTTP DTO 来源，已有 envelope/Zod 模式可复用。
- 新增单一 `batch-lab.ts` 契约域，按资源导出 request/response/status unions；不要把数据库 row 或任务实现暴露给 UI。
- 大文本详情与列表摘要分开，避免实验列表返回完整 prompt/结果。
- JSONL schema version 作为共享常量/schema；导出流本身由 Backend 生成。

## 5. 数据库与环境

- 当前八域由 `docs/schema归属地图.md` 管理，Backend `getDomainDb()` 只接受已登记域。
- 历史 `miniapp_simulation` 已删除，不恢复、不改写旧 migration。
- 新建 `batch_lab` 独立域，任何生产业务域不得依赖它；Backend repository 可从源域读取并写冻结副本。
- SQL 编辑器需要真实只读 SQL，不适合 Supabase REST query builder。实现前应提供专用最小权限只读连接/角色，事务设置 `READ ONLY`、statement timeout、行数/字节上限，并拒绝多语句和非 SELECT/WITH。不能复用具有写权限的 service-role 作为“只读保证”。
- 默认只连 test。来源环境由 Backend 部署变量选择；UI V1 只显示环境，不提供按钮。生产样本合规、脱敏和审批不在本期设计范围。
- `packages/shared/migrations/` 是唯一迁移源；PostgREST 暴露、`getDomainDb` allowlist、schema 文档和 deployment config 必须同批更新。

## 6. 原型功能盘点

原型包含：

1. 实验记录列表、新建实验、打开结果。
2. 样本集列表、SQL 模板/参数/编辑/预览/保存、样本详情。
3. A/B 模型、预设、后处理、整套复制、单轮/最后 X 轮、目的和确认规模。
4. 模型/预设/规则差异。
5. 运行进度、部分失败重试、逐样本、逐轮、上下文、A/B 原文/富文本、完整组合。
6. 后处理版本复制、JSON 规则编辑、测试文本、预览、保存、用于实验。
7. 结果中临时切规则、复用原文处理、保存新实验。
8. 备注、标签和 JSONL 导出。
9. 响应式/堆叠/紧凑演示设置；其中 Tweak 控件不是产品需求。

需求补足而原型仅演示的部分：全量样本、真实 SQL、冻结快照、任意 X、启动检查/排除、持久任务、逐尝试状态、服务重启恢复、幂等、有限自动重试、错误分类、来源血缘和完整导出。

## 7. 复用结论

- **直接复用技术/协议**：workspace、Vite/React/TS、AntD、React Query、Zod/shared envelope、Backend Pino/runtime config、engine、generation upstream、Supabase domain repository 模式。
- **扩展后复用**：生成出口（增加内部免用户计费策略）、会话快照读取、数据库租约任务、前端渲染/清洗纯能力。
- **明确不复用**：旧 simulation/ST preset、真实 chat_history 写入、用户钱包计费、Refine 资源层、跨应用源码 import、原型内存状态和任意 JS 执行。
