# Frontend CLAUDE.md（AI 硬规则速查）

> 在 `packages/frontend` 下工作时必须遵守本文件。  
> **完整技术栈约定与选型理由**见 [`../../docs/frontend-stack.md`](../../docs/frontend-stack.md)，有歧义时以完整文档为准。

## 必须（硬规则）

- **框架**：Next.js 14+ App Router + React 18+ 函数组件 + hooks。禁止 class 组件。
- **语言**：TypeScript 严格模式（`strict: true`、`noUncheckedIndexedAccess: true`）。**禁止 `any`**。
- **样式**：仅用 Tailwind CSS 原子类。**禁止新增 `.css` / `.scss` 文件**（全局样式和字体导入除外）。
- **组件库**：优先 `shadcn/ui`（`npx shadcn-ui@latest add <name>`），没有的再自己写。
- **状态**：
  - 组件内 → `useState`
  - 跨组件 → Zustand
  - 服务端数据 → **React Query（`useQuery` / `useMutation`）**
- **数据获取**：组件内**禁止出现 `fetch` / `axios` 直调**。必须走数据层目录下的 React Query hooks。违反即 review 否决。
- **禁止用 `useEffect` 做数据获取** → 一律改成 `useQuery`。
- **表单**：所有用户输入必须用 **React Hook Form + Zod**。**禁止原始 HTML form + 手写 `onChange`**。
- **Mock 数据**：集中在 Mock 目录按模块拆子文件，**禁止在组件内硬编码**。
- **Telegram SDK**：优先从 `src/lib/telegram/` 的 re-export 引入。
- **环境变量**：不要提交到 git，走 Vercel dashboard。

## 目录约定

| 用途                        | 路径                                                                     |
| --------------------------- | ------------------------------------------------------------------------ |
| 路由                        | `src/app/`（Next.js App Router）                                         |
| shadcn/ui 组件              | `src/components/ui/`                                                     |
| 业务组件                    | `src/components/<模块>/`                                                 |
| 自定义 hooks                | `src/hooks/`                                                             |
| 跨组件状态（Zustand）       | `src/stores/`                                                            |
| 数据层（React Query hooks） | `src/lib/api/`，每个业务模块一个文件                                     |
| Mock registry（人工配置）   | `src/lib/api/mock-registry.config.ts`（MODULE_CONFIG / forceMockReason） |
| Mock registry（自动生成）   | `src/lib/api/mock-registry.ts`（由 PM bootstrap 重算，勿手改）           |
| Telegram SDK 封装           | `src/lib/telegram/`                                                      |
| Mock 数据                   | `src/lib/mock-data/`，按模块拆子文件，`index.ts` 统一导出                |
| 通用工具                    | `src/lib/utils.ts`（`cn()` 等）                                          |
| 示范模板                    | `src/components/examples/`                                               |

> 工作前必须**现场扫描** `src/`，以现场结构为准；上表用于判定**新增代码应放哪里**，不用于猜测**已有代码在哪里**。

## Mock / 真实数据切换（按模块，自动同步）

切换粒度不是全局开关，是按**模块**独立判定：

- `src/lib/api/<module>.ts` 用 `shouldUseMock('<module>')`（来自 `mock-registry.ts`）分叉 mock / 真 API
- **mock-registry.ts 由 PM bootstrap 自动重算**，真相源是本地 committed 的 `packages/backend/src/` 代码——dev 环境上跑的新东西不算数
- 人工维护的是 `mock-registry.config.ts`（MODULE_CONFIG、forceMockReason）
- `NEXT_PUBLIC_USE_MOCK=1` 仍保留为**全局强制 mock 的应急开关**（全部模块走 mock）

业务组件**永远**只调用 `useXxxQuery`，不关心背后是 mock 还是真 API。

## AI 建议审查清单

出现以下苗头立即拦截：

1. AI 要新增依赖 → 先确认**已有的库能不能实现**。
2. AI 生成 `any` → **必须修正为具体类型**。
3. AI 用 `useEffect` 拉数据 → **改成 `useQuery`**。
4. AI 直接写 `fetch(...)` → **移到数据层目录并包成 React Query hook**。
5. AI 建议 Redux / Mobx / MUI / Ant Design / styled-components / Socket.io / GraphQL → **直接拒绝**。

## 与 PM 工作流的衔接

- 本地开发：`pnpm dev`（端口 3000）→ Chrome DevTools 手机模式自测。
- 提交分支：`pm-xxx/feature-name-YYYYMMDD`；Vercel 自动生成 preview URL。
- mock 数据和真实 API 走独立的 fetch/service 层，**两者不能互相污染**。
