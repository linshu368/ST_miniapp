# CS Platform 架构与文件地图

## 当前架构

React 18 + TypeScript strict + Vite 8；TanStack React Query 负责服务器状态；原生 CSS 负责三栏工作台。当前无 Router、全局状态库、表单库和 UI 组件库。

| 路径                                      | 职责                                                      |
| ----------------------------------------- | --------------------------------------------------------- |
| `package.json`                            | dev(3002)、typecheck、build、preview 及依赖；当前无 test  |
| `tsconfig.json`                           | strict/isolatedModules/bundler 配置                       |
| `vite.config.ts`                          | Vite React 构建                                           |
| `vercel.json`                             | SPA 静态部署和 fallback                                   |
| `public/favicon.svg`                      | 静态图标                                                  |
| `src/main.tsx`                            | QueryClient、根渲染和全局样式入口                         |
| `src/App.tsx`                             | 登录态、顶层业务切换和布局编排                            |
| `src/api.ts`                              | API base、环境 base、headers、请求封装和全部 `csApi` 方法 |
| `src/constants.ts`                        | 状态、筛选和稳定 UI 常量                                  |
| `src/styles.css`                          | 三栏布局、状态和响应式样式                                |
| `src/vite-env.d.ts`                       | Vite 类型声明                                             |
| `components/LoginPage.tsx`                | CS token/operator 登录                                    |
| `components/PersonaSidebar.tsx`           | 画像簇导航和刷新                                          |
| `components/UserListPanel.tsx`            | 用户筛选、选择、状态和导出入口                            |
| `components/ConversationPanel.tsx`        | Telegram 1V1 消息与 SOP 操作                              |
| `components/BroadcastModal.tsx`           | Telegram 群发确认与执行                                   |
| `components/PersonaModal.tsx`             | 画像簇查看/编辑交互                                       |
| `components/SpecialNoteModal.tsx`         | 特殊备注编辑                                              |
| `components/SupportWorkbench.tsx`         | MiniApp 客服环境、列表和选中会话编排                      |
| `components/SupportConversationPanel.tsx` | 站内客服消息查看、轮询和回复                              |
| `components/Badge.tsx`                    | 小型状态标签                                              |

## 放置与依赖

- `App` 只做编排；领域请求留在 `api.ts`，复杂派生逻辑提取为带测试纯函数。
- 只有职责、状态所有权和交互语义都稳定时才共享组件；两条业务流外观相似不构成合并理由。
- 新目录/层级必须解决当前复杂度；禁止预建 services/repositories 等空壳架构。
