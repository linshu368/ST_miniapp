# Admin 架构与文件地图

## 技术栈与边界

- React 18 函数组件、TypeScript strict、Vite 8、Ant Design 6。
- Refine 当前仅提供顶层能力和 Supabase data provider；`resources=[]`、`syncWithLocation=false`，不得将其描述为完整 Refine 路由/CRUD 架构。
- Supabase JS 用于会话和 `admin` schema/RPC；Zod 校验运行时运营配置；dnd-kit 用于可排序配置。
- 当前无 React Router、React Query 和全局状态库；工作区通过本地 `view` 与 AntD Menu 切换。

## 根文件

| 路径             | 职责                                        | 规则                                                   |
| ---------------- | ------------------------------------------- | ------------------------------------------------------ |
| `.env.example`   | 浏览器可见变量模板                          | 只写占位值；`VITE_*` 一律视为公开信息                  |
| `package.json`   | 依赖和 dev/typecheck/test/build 脚本        | 使用 pnpm；新增依赖需说明不能复用现有能力的原因        |
| `tsconfig.json`  | strict、isolatedModules、bundler resolution | 禁止放宽 strict 或添加 `any`                           |
| `vite.config.ts` | React/Vite 构建                             | 不在此硬编码环境 URL 或 secret                         |
| `vercel.json`    | SPA 静态部署与回退                          | 与项目 Root Directory、根 `vercel.admin.json` 一起核对 |
| `README.md`      | 包级运行和部署说明                          | 行为/变量变化时同步更新                                |
| `public/*`       | favicon、运营平台图标                       | 稳定静态资源，不放用户数据                             |

## `src` 文件地图

| 路径/文件组                                      | 职责                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `main.tsx`                                       | 创建 Supabase client/provider、AntD 中文 locale/theme、Refine 和根渲染 |
| `App.tsx`                                        | 登录态、环境、工作区导航和顶层编排；不应堆积领域解析算法               |
| `styles.css`                                     | 全局布局、响应式和组件补充样式                                         |
| `components/LoginPage.tsx`                       | 运营登录交互与错误反馈                                                 |
| `components/ConfigValueEditor.tsx`               | 配置值通用编辑入口和草稿交互                                           |
| `components/SystemInstructionsEditor.tsx`        | 系统指令配置编辑                                                       |
| `components/ModelCatalogEditor.tsx`              | 模型目录表单、排序和差异显示                                           |
| `components/WordCountTiersEditor.tsx`            | 回复长度档位编辑与排序                                                 |
| `components/LobbyPinnedCharactersEditor.tsx`     | 大厅置顶角色配置                                                       |
| `components/LobbyRankingParamsEditor.tsx`        | 大厅排序参数配置                                                       |
| `components/PaymentPromptDialogConfigEditor.tsx` | 支付提示弹窗配置                                                       |
| `components/RechargePageConfigEditor.tsx`        | 充值页配置                                                             |
| `components/InviteCenterConfigEditor.tsx`        | 邀请中心展示配置                                                       |
| `components/InviteRewardRulesEditor.tsx`         | 邀请奖励规则配置                                                       |
| `components/CharacterCardsView.tsx`              | 角色卡创建、布局、状态、删除/恢复和版本操作                            |
| `components/AnnouncementsView.tsx`               | 公告查询、编辑、发布和删除                                             |
| `components/InviteProgramView.tsx`               | 裂变计划配置与邀请关系查询                                             |
| `components/OutreachCreditGrantView.tsx`         | 定向回访星尘赠送                                                       |
| `lib/adminApi.ts`                                | admin 通用 HTTP/Supabase 管理调用                                      |
| `lib/announcementsApi.ts`                        | 公告 API 边界                                                          |
| `lib/inviteAdminApi.ts`                          | 裂变管理 API 边界                                                      |
| `lib/outreachCreditsApi.ts`                      | 赠送 API、输入和响应处理                                               |
| `lib/environment.ts`                             | 测试/生产环境模型、URL 和切换规则                                      |
| `lib/adminNavigation.ts`                         | 导航项与 view 纯逻辑                                                   |
| `lib/configSchemas.ts`                           | 运营配置的 Zod 组合与校验                                              |
| `lib/characterCards.ts`                          | 角色卡转换/排序等纯逻辑                                                |
| `lib/modelCatalogDiff.ts`                        | 模型目录差异计算                                                       |
| `lib/openRouterModels.ts`                        | OpenRouter 模型归一化/筛选逻辑                                         |
| `*.test.ts`                                      | 对应纯逻辑回归测试；与源文件邻近                                       |

## 依赖与放置规则

- 页面/组件只能调用 `src/lib` 暴露的领域操作；可复用纯逻辑放 `lib` 并测试。
- 只在两个组件“长得相似”时不得抽象；应在 props 契约稳定、状态所有权一致且确有复用者时提取。
- 单个组件同时承担请求、复杂转换、多个 Modal 与大段渲染时，应按业务能力拆分，而不是增加无语义 wrapper 层。
- shared 只承载跨包契约/稳定纯逻辑，不承载 Admin UI、session 或环境状态。
