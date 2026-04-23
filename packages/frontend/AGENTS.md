# Frontend AGENTS.md（AI 硬规则速查）

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
- **数据获取**：组件内**禁止出现 `fetch` / `axios` 直调**。必须走「数据层」目录（见下文目录约定）下的 React Query hooks。违反即 review 否决。
- **禁止用 `useEffect` 做数据获取** → 一律改成 `useQuery`。
- **表单**：所有用户输入必须用 **React Hook Form + Zod**。**禁止原始 HTML form + 手写 `onChange`**。
- **Mock 数据**：集中在「Mock 目录」（见下文目录约定）按模块拆子文件，**禁止在组件内硬编码**。
- **Telegram SDK**：优先从「Telegram 封装目录」的 re-export 引入；不要满仓库直接 `import ... from '@telegram-apps/sdk-react'`（非否决项但推荐）。
- **环境变量**：不要提交到 git，走 Vercel dashboard。

## 目录约定（抽象原则，不枚举具体文件）

**原则**（规则本身，不随骨架膨胀失效）：

- **路由**：Next.js App Router 标准 — 路由文件放在 `src/app/` 下。
- **基础组件**：shadcn/ui 生成的源码放 `src/components/ui/`；业务组件放 `src/components/<模块>/`。
- **自定义 hooks**：放 `src/hooks/`。
- **跨组件状态**：Zustand store 放 `src/stores/`，按"领域"拆文件（UI 状态 / 业务领域各一份）。
- **数据层（后端交互）**：统一放 `src/lib/api/`，**每个业务模块一个文件**，对外只导出 React Query hooks；HTTP 客户端、QueryClient 工厂等基础设施也在此目录内部。
- **Telegram SDK 封装**：统一放 `src/lib/telegram/`，业务代码只从这里 `import`。
- **Mock 数据**：统一放 `src/lib/mock-data/`，按模块拆子文件；`index.ts` 统一导出；`shared.ts` 承载跨模块共享类型（多 PM 协调入口）。
- **通用工具**：`src/lib/utils.ts`（`cn()` 等），其他按主题在 `src/lib/` 下拆子目录。
- **参照模板**：`src/components/examples/` 存"该怎么写"的示范（如 RHF+Zod 表单模板）。

> AI 在本 package 下工作前，必须按根 `AGENTS.md` 的 Bootstrap 协议 Step 2 **现场扫描** `src/`，以现场结构为准；上面这些原则用来判定**新增代码应当放哪里**，而不是用来猜测**已有代码在哪里**。

## Mock / 真实数据切换

- 环境变量 `NEXT_PUBLIC_USE_MOCK=1` → `lib/api/*` 的 query hooks 返回 mock 数据
- 默认关闭 → 走真实接口
- 业务组件**永远**只调用 `useXxxQuery`，不关心背后是 mock 还是真 API

## AI 建议审查清单（出现以下苗头立即拦截）

1. AI 要新增依赖 → 先确认 **已有的库能不能实现**。
2. AI 生成 `any` → **必须修正为具体类型**。
3. AI 用 `useEffect` 拉数据 → **改成 `useQuery`**。
4. AI 直接写 `fetch(...)` → **移到数据层目录（见目录约定）并包成 React Query hook**。
5. AI 建议 Redux / Mobx / MUI / Ant Design / styled-components / Socket.io / GraphQL → **直接拒绝**（理由见完整文档第七节）。

## 与 PM 工作流的衔接

- 本地开发：`pnpm dev`（端口 3000）→ Chrome DevTools 手机模式自测。
- 提交分支：`pm-xxx/feature-name-YYYYMMDD`；Vercel 自动生成 preview URL。
- mock 数据和真实 API 走独立的 fetch/service 层，**两者不能互相污染**；开发接入时只改数据源，不动其他部分。
