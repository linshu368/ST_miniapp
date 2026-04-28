# 前端技术栈约定

> 本文档作为 **与大模型（AI Coding）协作开发 miniApp 前端界面和交互逻辑** 时的前置背景。
> 所有代码生成和架构决策应遵循本文档约定的技术栈。
> 本文档不是穷举所有可能选项，而是明确当前项目的最优路径，减少每次讨论时的选型往返。

适用对象：PM（本地 Cursor 开发）、开发（接数据层并合并）、AI（代码生成）。

---

## 一、核心约束前提

这些约束是选型的不可谈判前提：

1. **PM 承担前端 UI 开发职责**，使用大模型（AI）在本地生成组件、页面和交互，提交 preview 分支后由工程师接数据层并合并。这意味着前端技术栈必须是 **AI 代码生成能力最强的那个**。
2. **产品形态是 Telegram Mini App**。当前阶段所有决策以 Telegram Mini App 为准，但保持「未来可迁移到独立 web」的设计意识。
3. **Bot 和 miniApp 是同一个产品的两个客户端**，共享用户身份、积分、支付等核心数据。两套后端通过共享的 Supabase PostgreSQL 数据库连接。
4. **快速迭代优先于架构完美**。任何引入「学习曲线陡峭」或「需要专门维护」的技术都应该被拒绝，除非它能带来决定性的效率提升。
5. **产品形态为 AI 角色扮演**，包含实时聊天、图片生成、语音播放。技术栈需要能原生支持流式数据、文件上传下载、移动端 WebView 环境。

---

## 二、前端技术栈

### 2.1 框架：Next.js 14+（App Router）+ React 18+

所有前端代码基于 Next.js 14 及以上版本，使用 **App Router**（不是旧的 Pages Router），React 18+。

**选择理由**：

AI 对 React + Next.js 的代码生成质量显著高于其他框架。这不是营销话术，是一个可验证的事实——Next.js 是目前 web 开发生态中文档、社区、示例代码最丰富的框架，大模型训练数据里 Next.js 代码样本的质量和数量都是最高档。用 AI 生成 Next.js 代码时，PM 几乎不需要反复纠正它的生成结果。

Next.js 的另一个关键优势是它本身就是标准 web 前端栈，和「未来独立 web 版本」之间没有任何架构差异。你今天写的 Next.js 代码，未来迁移到独立 web 时 90% 以上都可以直接复用。

**不选其他框架**：

- Vue / Nuxt：AI 生成质量次于 React，国内资源多不是决定性因素
- SvelteKit：生态小、AI 支持不稳定
- 纯 React + Vite：缺 Next.js 的文件路由、SSR、API Routes 等能力

### 2.2 语言：TypeScript（严格模式）

`tsconfig.json` 必须开启：

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true
}
```

**理由**：团队已经熟悉 TS，直接用严格模式发挥其全部价值。严格模式会在编译期拦下很多运行时错误，对 AI 生成的代码也会提供更强的类型约束。

### 2.3 样式：Tailwind CSS + shadcn/ui

**做法**：

- 所有样式用 Tailwind CSS 原子类
- 不写 CSS 文件（除了极少数全局样式和字体导入）
- 组件库使用 shadcn/ui，通过它的 CLI 按需添加组件：`npx shadcn-ui@latest add button`
- shadcn/ui 组件是「复制源码到项目里」的模式，可以直接修改

**理由**：

Tailwind 是 AI 生成样式时质量最高的方案，因为它在 React 生态里几乎是默认选择，训练数据密度极高。

shadcn/ui 比传统组件库（MUI、Ant Design）更适合：

- 源码在项目里，想改就改，不受 API 限制
- 体积小，只复制用到的组件
- 视觉风格中立，给你充分的定制空间
- AI 可以直接读取和修改组件源码

### 2.4 Telegram Mini App 适配：@telegram-apps/sdk-react

**使用的库**：`@telegram-apps/sdk-react`（Telegram 官方团队维护）

**可用能力**：

- `initData` 解析和验证（身份识别）
- 主题色自适应
- MainButton / BackButton 控制
- 原生弹窗（`showAlert`、`showConfirm`、`showPopup`）
- 分享能力
- HapticFeedback（移动端震动反馈）
- CloudStorage（Telegram 提供的用户级 KV 存储）

**关键注意事项**：

Telegram Mini App 运行在 Telegram 客户端的 WebView 里，不是普通浏览器：

- 不能依赖「独立浏览器窗口」的 API
- 移动端 WebView 性能比桌面浏览器差，复杂动画和大列表要做性能优化
- iOS 和 Android 的 Telegram 对 Mini App 支持有细微差异，每个 feature 上线前必须在两个平台真机测试
- 开发期可以用 `@telegram-apps/sdk` 的 mock 模式在普通浏览器调试，但正式测试必须在真机上

### 2.5 Telegram 调用的组织纪律（轻度要求）

**背景**：未来可能会做独立 web 版本（无 Telegram 依赖）。为了让那时候的迁移不痛苦，现在写代码时保持一个简单的意识即可。

**具体做法**：

在 `lib/telegram/` 目录下集中放置所有 Telegram SDK 的调用。业务组件优先通过这个目录里的封装来使用 Telegram 能力，而不是在组件里直接 `import { useMainButton } from '@telegram-apps/sdk-react'`。

比如：

```typescript
// lib/telegram/hooks.ts
export { useMainButton, useBackButton, useHapticFeedback } from '@telegram-apps/sdk-react';

// lib/telegram/auth.ts
export async function getAuthData() {
  // 封装 initData 获取逻辑
}
```

然后业务代码写：

```typescript
import { useMainButton } from '@/lib/telegram/hooks';
```

**这不是硬规则**。如果某处直接用了 `@telegram-apps/sdk-react`，也不是 code review 的否决项。目的只是让未来想找「哪些地方用了 Telegram 能力」的时候，`grep @/lib/telegram` 比 `grep` 满仓库的 `@telegram-apps/sdk-react` 容易一些。

**保持这个意识的收益**：如果未来（5 人团队以后）真的要迁移到独立 web，工作量大概是 1-2 周，主要是替换 `lib/telegram/` 的实现 + 加邮箱密码登录流程 + 处理 MainButton 在 web 上的替代方案。业务代码、UI 组件、数据流、后端 API 基本不用动。

**不保持这个意识的代价**：迁移时要满仓库 grep 和修改 Telegram 调用，工作量膨胀到 1-2 个月。

但现在不必为此做任何过度设计。不要提前写抽象层，不要提前为 web 版本做架构兼容。只需要记住「Telegram SDK 的 import 尽量从 `@/lib/telegram` 走」这一条，其他一切按 Telegram Mini App 的最佳实践推进。

### 2.6 状态管理：Zustand + React Query

**职责划分**：

- **Zustand**：前端本地状态。比如当前选中的角色、侧边栏展开状态、对话输入框内容等。API 极简，学习成本接近零。**用 `useState` 能解决的就用 `useState`，需要跨组件共享才用 Zustand**。
- **React Query（TanStack Query）**：所有和后端交互的数据。它处理：
  - 数据请求和缓存
  - loading / error / success 状态
  - 自动重试
  - 缓存失效和重新获取
  - 乐观更新

**不选 Redux 的原因**：在两人团队的规模下过度设计。90% 的使用场景都可以用 Zustand + React Query 替代，代码量只有 Redux 的 1/3。

**强制纪律**：所有后端数据获取必须走 React Query 的 `useQuery` / `useMutation`。组件内部不允许直接出现 `fetch` 或 `axios` 调用。**这是 code review 的否决项**。

### 2.7 表单：React Hook Form + Zod

**做法**：

- React Hook Form 负责表单状态和验证流程
- Zod 负责定义校验 schema
- 通过 `@hookform/resolvers/zod` 集成

**强制纪律**：miniApp 里所有涉及用户输入的地方（注册邮箱、编辑个人信息、创作角色卡、设置偏好）必须用 React Hook Form + Zod。**不允许原始 HTML form + 手写 `onChange` 的写法**。

**Zod 的额外价值**：Zod schema 可以同时产生运行时校验和 TypeScript 类型。这在前后端共享 schema 时特别有用——定义一次，前端做表单校验，后端做 API 参数校验，类型自动一致。

---

## 四、部署和基础设施

### 4.1 前端部署：Vercel

**理由**：

- Next.js 原厂
- 每次 `git push` 自动部署，preview URL 自动生成
- PM→开发协作流程严重依赖 preview URL，Vercel 原生支持
- 免费额度对 MVP 够用

**配置要点**：

- 每个 `pm-xxx/feature-name-YYYYMMDD` 分支自动生成独立的 preview URL
- `dev` 是日常合并的真实分支；`main` 对应线上生产环境（由 `dev` 在版本节点 fast-forward 同步）
- 环境变量通过 Vercel dashboard 管理，**不要提交到 git**

### 4.2 后端部署：Railway（继续使用现有）

Bot 后端已经在 Railway 上，miniApp 后端也部署到同一个 Railway 项目，作为独立的 service。共享环境变量、共享数据库连接、方便管理。

### 4.3 数据库：Supabase（继续使用现有）

Bot 和 miniApp 共享同一个 Supabase 项目，通过表级别的划分隔离各自的业务数据（详见架构决策文档：身份和钱共享，业务表独立）。

### 4.4 开发环境

- **Node.js**：20.x LTS（通过 `.nvmrc` 锁定）
- **包管理器**：pnpm
- **代码格式**：Prettier
- **Lint**：ESLint + 推荐规则
- **Git hooks**：husky + lint-staged，commit 前自动格式化
- **IDE**：Cursor（AI Coding）

---

## 五、项目结构

### 5.3 前后端共享代码

**推荐方案**：pnpm workspace monorepo，一个仓库包含 `frontend`、`backend`、`shared` 三个 package。

`shared/` 下放前后端都用的类型定义、Zod schemas、常量等。修改一处两处生效。

> 本项目已按此结构初始化，目录位于 `ST_miniapp/packages/{frontend,backend,shared}`。

**工程纪律（不可谈判）**：

- 任何前后端交互的数据形状必须先在 `packages/shared/` 定义，才允许被任何一方消费。
- 前端不得在 `frontend/` 私定与 shared 并行的**业务类型**（纯 UI 状态如 `isExpanded`、`hoveredIndex` 除外）。

**谁写 `shared/`**：

- 功能发起人起草。本项目新功能多由 PM 发起，所以 PM 通常就是 `shared/` 契约的起草人——在分支里一次性提交 shared 类型 + mock + hook + 组件。
- PM 写的是「草案」，开发在 PR review 是最终裁决者。默认目标是**一来回定稿**（开发直接在同一 PR 内修 shared）。
- **复用优先**：类型已存在就直接消费，不要写并行版本；严重冲突时开发可打回 PM 重做（非默认但合法）。

**反推测字段**：PM 在 `shared/` 新增的每个字段必须在本次 PR 的前端代码里被实际引用，没用到的不许写（防止「将来会用」污染契约）。

**推论**：前端 AI 无需读 `packages/backend/`；只读 `packages/shared/` 即可获得所有契约。shared 与 backend 的一致性由 PR review 保证。

---

## 六、与 AI 协作的约定

这部分是给 AI 的具体指令，确保它生成的代码符合上述选型。

### 6.1 前端代码生成规则

- React 18 函数组件 + hooks，**不用 class 组件**
- 全 TypeScript，**严格类型**
- 样式用 Tailwind CSS 原子类，**不写 CSS 文件**
- UI 组件优先 shadcn/ui，缺少时再自己实现
- 状态管理：组件内 `useState`，跨组件 Zustand，服务端数据 React Query
- 表单用 React Hook Form + Zod
- API 调用封装在 `lib/api/` 下的 React Query hooks
- mock 数据集中在 `lib/mock-data/` **目录**下按模块拆子文件（`index.ts` 统一导出 / `shared.ts` 跨模块共享类型 / `characters.ts`、`chat.ts` 等按业务模块），**不允许硬编码在组件里**。业务代码只从 `@/lib/mock-data` 导入，感知不到物理拆分。
- mock / 真 API 切换由 `lib/api/mock-registry.ts` 按**模块粒度**决定，文件由 PM bootstrap 自动重算（规则见根 `CLAUDE.md` Step 2c）；人工维护的是 `mock-registry.config.ts`。组件永远只调 `useXxxQuery / useXxxMutation`，不感知切换。
- Telegram SDK 调用优先从 `lib/telegram/` 导入（非硬规则但推荐）

### 6.3 什么时候不相信 AI 的建议

- AI 建议引入新库时，**先问「已有的库能不能实现」**
- AI 生成的代码出现 `any` 类型时，**必须修正为具体类型**
- AI 建议用 `useEffect` 做数据获取时，**改成 React Query 的 `useQuery`**
- AI 建议直接用 `fetch` 时，**改成 React Query 或 `lib/api/` 下的封装**

---

## 七、明确不选的技术

- 不选 **Vue / Nuxt / Svelte / Solid**：AI 对 React 生成质量更高
- 不选 **Redux / Mobx**：Zustand 够用
- 不选 **Material UI / Ant Design / Chakra UI**：shadcn/ui 更灵活
- 不选 **styled-components / emotion**：Tailwind 更快
- 不选 **Express / Koa / Hapi**：Fastify 更现代
- 不选 **NestJS**：对两人团队过度设计
- 不选 **TypeORM / Sequelize**：Prisma 更好用
- 不选 **Passport / Auth0 / Clerk**：直接用 Telegram `initData`
- 不选 **Socket.io**：SSE 够用
- 不选 **Redux Saga / RxJS**：过度设计
- 不选 **GraphQL**：REST + React Query 更合适
