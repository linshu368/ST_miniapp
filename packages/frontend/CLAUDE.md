# 前端技术栈与代码规则

> 本文档是 AI Coding 协作开发前端时的**前置规则**。
> 所有代码生成和架构决策必须遵循本文档。放进 Cursor（`.cursorrules`）或 Claude Code（`CLAUDE.md`）即生效。

---

## 技术栈（不可谈判）

| 层       | 选型                                 | 备注                                             |
| -------- | ------------------------------------ | ------------------------------------------------ |
| 框架     | Next.js 14+（App Router）+ React 18+ | 禁止 Pages Router、禁止 class 组件               |
| 语言     | TypeScript 严格模式                  | `strict: true`、`noUncheckedIndexedAccess: true` |
| 样式     | Tailwind CSS 原子类                  | 禁止新增 `.css` / `.scss` 文件（全局样式除外）   |
| 组件库   | shadcn/ui                            | `npx shadcn-ui@latest add <name>` 按需添加       |
| 状态管理 | Zustand + React Query                | 见下方职责划分                                   |
| 表单     | React Hook Form + Zod                | 禁止原始 HTML form + 手写 `onChange`             |
| 包管理器 | pnpm                                 |                                                  |
| 代码格式 | Prettier                             |                                                  |
| 部署     | Vercel                               | 环境变量走 dashboard，不提交到 git               |

### 选型理由（给人看，AI 不需要每次重复）

**Next.js + React**：AI 代码生成质量最高的前端框架——训练数据中 Next.js 代码样本的质量和数量都是最高档。用 AI 生成时几乎不需要反复纠正。

**Tailwind CSS**：AI 生成样式时质量最高的方案，React 生态里几乎是默认选择。

**shadcn/ui**：源码在项目里可直接修改，体积小只复制用到的，视觉风格中立，AI 可以直接读取和修改组件源码。比 MUI/Ant Design 更适合 AI 协作。

**Zustand**：API 极简，学习成本接近零。90% 的场景用 Zustand + React Query 替代 Redux，代码量只有 1/3。

**React Hook Form + Zod**：Zod schema 同时产生运行时校验和 TypeScript 类型。前后端共享 schema 时定义一次、两端生效。

---

## 状态管理职责划分

| 场景           | 方案        | 说明                                                          |
| -------------- | ----------- | ------------------------------------------------------------- |
| 组件内局部状态 | `useState`  | 能用 `useState` 解决的就用 `useState`                         |
| 跨组件共享状态 | Zustand     | 当前选中项、侧边栏展开、输入框内容等                          |
| 服务端数据     | React Query | `useQuery` / `useMutation`，处理缓存、loading、重试、乐观更新 |

---

## 硬规则

### 数据获取

- 组件内**禁止出现 `fetch` / `axios` 直调**。所有后端数据获取必须封装在 `src/lib/api/` 目录下的 React Query hooks 里。**违反即 review 否决。**
- **禁止用 `useEffect` 做数据获取** → 一律改成 `useQuery`。
- 业务组件只调 `useXxxQuery` / `useXxxMutation`，不感知底层请求实现。

```typescript
// ✅ 正确：src/lib/api/characters.ts
export function useCharactersQuery() {
  return useQuery({
    queryKey: ['characters'],
    queryFn: () => apiClient.get('/api/characters').then(r => r.data),
  })
}

// ❌ 错误：在组件里直接 fetch
useEffect(() => {
  fetch('/api/characters').then(...)
}, [])
```

### 类型

- **禁止 `any`**。AI 生成的代码出现 `any` 时必须修正为具体类型。

### 样式

- 所有样式用 Tailwind CSS 原子类。
- **禁止新增 `.css` / `.scss` 文件**（全局样式和字体导入除外）。

### 表单

- 所有涉及用户输入的地方必须用 **React Hook Form + Zod**。
- **禁止原始 HTML form + 手写 `onChange`**。

### 依赖管理

- AI 建议引入新库时，**先确认已有的库能不能实现**。
- 不允许引入以下替代方案：Redux / Mobx / MUI / Ant Design / Chakra UI / styled-components / emotion / Socket.io / GraphQL / Redux Saga / RxJS。

---

## iframe 集成与跨边界通信(阶段二)

> 平台前端宿主一个 ST iframe(原生 JS + jQuery),所有 ST 功能调用通过 postMessage 协议跨边界。
> 本节规则不可与上方"硬规则"冲突,违反即 review 否决。

### 三类数据源与调用方式

| 数据/操作类型                                 | 调用方式          | 封装位置                                                             |
| --------------------------------------------- | ----------------- | -------------------------------------------------------------------- |
| 平台业务数据(用户、订单、计费)                | 平台后端 REST API | `src/lib/api/` 下的 React Query hooks                                |
| ST 功能调用(切角色、重生成、新对话等)         | postMessage RPC   | `src/lib/bridge/` 下的 bridge-client                                 |
| Supabase 只读查询(角色卡列表浏览等低敏感数据) | Supabase JS SDK   | `src/lib/api/` 下的 React Query hooks(与 REST 同级,组件无感知数据源) |

> 三种调用在组件层的形态都是 `useXxxQuery` / `useXxxMutation` / `platformAction()`,组件不感知底层是 fetch / postMessage / supabase-js。

### iframe 生命周期硬规则

- ST iframe 必须在**大厅页(用户登录后第一个落地页)就静默挂载并预加载**,通过 CSS `display: none` 隐藏。目的:用户进入聊天页时零等待。
- 进入聊天页只切换 iframe 的可见性(`display` / `visibility`),**禁止 unmount/remount iframe DOM 节点**。一次会话生命周期内 iframe 只加载一次。
- iframe 节点必须挂载在 React 组件树之外或通过 ref 持久持有,**禁止把 iframe 写在会被路由切换销毁的组件里**。推荐做法:在根布局(`app/layout.tsx` 或专用 Provider)中渲染,通过 Zustand 控制显隐。
- 用户从聊天页返回大厅时,iframe 重新隐藏而不卸载。

### postMessage 通信硬规则

- **禁止业务组件直接调用 `iframe.contentWindow.postMessage`**。所有 ST 调用必须经 `src/lib/bridge/` 下的 `platformAction()` 统一入口。
- **禁止业务组件直接 `window.addEventListener('message', ...)`**。所有 ST 事件订阅必须通过 bridge-client 暴露的 hook(如 `useSTEvent('generationStarted', handler)`)。
- 协议类型(action 枚举、event 枚举、消息结构)必须从 `@repo/bridge-protocol` 包导入,**禁止在前端就地定义 action/event 字符串字面量**。
- `postMessage` 第二个参数(targetOrigin)**禁止使用 `'*'`**,必须传入精确的 ST iframe origin(从环境变量读取)。
- 所有 RPC 调用必须由 bridge-client 内部生成 `requestId`、维护超时(默认建议 ≤30s)和错误回调,**禁止业务组件自行管理 requestId**。
- bridge-client 内部对 RPC 响应做异常归一化,业务组件用 try/catch 处理 `BridgeError`,不直接处理底层 `MessageEvent`。

```typescript
// ✅ 正确
import { platformAction, useSTEvent } from '@/lib/bridge'

await platformAction('regenerate')
useSTEvent('generationStarted', () => setLoading(true))

// ❌ 错误:绕过 bridge-client
iframe.contentWindow?.postMessage({ action: 'regenerate' }, '*')
window.addEventListener('message', e => { ... })

## 目录约定

```

src/
├── app/ # Next.js App Router 路由
├── components/
│ ├── ui/ # shadcn/ui 组件
│ └── <模块>/ # 业务组件，按模块分目录
├── hooks/ # 自定义 hooks
├── stores/ # Zustand stores
│ └── st-mirror.ts # 🆕 ST iframe 回传状态镜像
├── lib/
│ ├── api/ # React Query hooks，每个业务模块一个文件
│ └── utils.ts # 通用工具（cn() 等）
│ ├── bridge/ # 🆕 bridge-client:platformAction、useSTEvent、RPC 状态机

```

> 工作前必须**现场扫描** `src/`，以现场结构为准；上表用于判定**新增代码应放哪里**。

---

## AI 代码生成规则（总结）

1. React 18 函数组件 + hooks，不用 class 组件
2. 全 TypeScript，严格类型，禁止 `any`
3. 样式用 Tailwind CSS 原子类，不写 CSS 文件
4. UI 组件优先 shadcn/ui，缺少时再自己实现
5. 状态管理：组件内 `useState`，跨组件 Zustand，服务端数据 React Query
6. 表单用 React Hook Form + Zod
7. API 调用封装在 `lib/api/` 下的 React Query hooks，组件不直接 fetch
8. 不用 `useEffect` 做数据获取
9. 引入新依赖前先确认已有的库能否实现
10.ST 功能调用一律走 platformAction(),不直接 postMessage
11.ST 事件订阅一律走 useSTEvent(),不直接 addEventListener
12.action / event 名称从 @repo/bridge-protocol 导入,不写字符串字面量
13.iframe 节点持久挂载,切页面只改显隐,不 unmount
14.平台前端不直接写 ST 数据;Supabase 访问仅只读且封装为 React Query hooks

---

## 明确不选的技术

| 不选                                      | 理由                         |
| ----------------------------------------- | ---------------------------- |
| Vue / Nuxt / Svelte / Solid               | AI 对 React 生成质量更高     |
| Redux / Mobx                              | Zustand 够用                 |
| Material UI / Ant Design / Chakra UI      | shadcn/ui 更灵活             |
| styled-components / emotion               | Tailwind 更快                |
| NestJS                                    | 对小团队过度设计             |
| TypeORM / Sequelize                       | Prisma 更好用                |
| Socket.io                                 | SSE 够用                     |
| Redux Saga / RxJS                         | 过度设计                     |
| GraphQL                                   | REST + React Query 更合适    |
```
