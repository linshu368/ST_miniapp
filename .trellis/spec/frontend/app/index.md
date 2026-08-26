# 前端应用规范

适用于 `packages/frontend`。

来源补充：
本规范同步承接 `packages/frontend/CLAUDE.md` 中与前端开发、bridge 集成与审查直接相关的硬规则。
当 `packages/frontend/CLAUDE.md` 更新时，需要同时评估本规范是否应同步更新。

## 开发前检查

- 阅读 `packages/frontend/CLAUDE.md`，尤其是数据获取、表单、样式、bridge/iframe、目录约定相关章节。
- 阅读 `docs/frontend-rules-template.md`。
- 阅读 `docs/ARCHITECTURE.md` 的第 1、3、4、7 节。
- 搜索现有 `packages/frontend/src/lib/api`、`components`、`stores`、`app`、`lib/bridge` 实现。
- 若改动跨越 backend / API / database，同步阅读 `.trellis/spec/guides/cross-layer-thinking-guide.md`。
- 规划实现时先审视现有组件、hook、store、bridge、页面与功能流，优先扩展现有能力。

## 必须遵守

- 使用 Next.js 14 App Router 与 React 18 函数组件，不使用 Pages Router 与 class 组件。
- 服务端数据统一通过 `src/lib/api/` 下的 React Query hooks 获取。
- 组件层不得直接调用 `fetch` / `axios`。
- 不使用 `useEffect` 做数据获取，统一使用 `useQuery` / `useMutation` 等既有数据层模式。
- 局部状态优先 `useState`，跨组件共享状态使用 Zustand。
- 表单统一使用 React Hook Form + Zod。
- 样式统一使用 Tailwind 与现有 shadcn/ui 组件；除全局样式入口外，不新增本地 `.css` / `.scss` 文件。
- 前端不得直接消费数据库行类型。
- 未经 PRD 或需求明确要求，不修改 UX、文案、布局、视觉风格或页面交互结构。
- 不新增 `any`。

## bridge、iframe 与跨边界通信规则

- ST 功能调用统一通过 `src/lib/bridge/` 暴露的 `platformAction()` 等入口，不得在业务组件内直接调用 `postMessage`。
- ST 事件监听统一通过 bridge 层暴露的 hook，不得在业务组件内直接 `window.addEventListener('message', ...)`。
- action、event 与协议结构优先从既有协议包导入，不在前端就地定义字符串字面量协议。
- `postMessage` 的 `targetOrigin` 不得使用 `'*'`，必须使用准确 origin。
- RPC 的 `requestId`、超时、错误归一化由 bridge-client 统一负责，业务组件不得自管。
- ST iframe 需要持久挂载并通过显隐控制复用，不要在页面切换中反复 unmount / remount。
- 大厅页预加载、聊天页复用 iframe 的既有生命周期约束不得被绕开。

## 架构与实现要求

- 优先考虑可复用性：先复用现有 `lib/api`、bridge、组件、store、hook，再决定是否新增抽象。
- 优先考虑可扩展性：新增实现应与现有模块边界一致，便于后续功能继续扩展。
- 优先考虑高可用性：关键交互需要考虑加载态、错误态、重试、降级与 bridge 异常处理。
- 在满足以上目标时，保持实现简洁明了，不引入无用代码、无意义抽象或过度封装。
- UI、组件、页面改动需要尽量贴合现有结构与设计系统，不因为技术实现方便就擅自重做交互。
- 修改复杂交互、bridge 约束、状态同步或边界条件时，补充必要且简洁的代码注释。
- 若变更影响接入方式、用法约束、流程规则或模块组织，需要同步补充相关文档。
- 若变更引入或修改关键逻辑、状态流或数据转换，需要补充相关测试，或明确说明当前无法补测的原因。

## 目录与实现约定

- 新增服务端数据访问代码优先落在 `src/lib/api/`，并以 React Query hook 形式暴露。
- 新增业务组件按现有模块目录组织，不在 `components` 下堆放无归属的零散文件。
- Zustand store 放在 `stores/`，bridge 能力放在 `lib/bridge/`，不要混入业务页面组件。
- 编写新代码前先现场扫描 `src/` 结构，以仓库现状为准，不机械套用模板。

## 质量检查

- 运行 `pnpm --filter @miniapp/frontend typecheck`。
- 触及有现成测试的逻辑、状态处理、数据转换或新增行为时，运行
  `pnpm --filter @miniapp/frontend test`。
- 视觉或页面交互改动需要检查桌面端与移动端状态。
- 检查组件中是否仍存在直接 `fetch` / `axios` 调用。
- 检查是否误用 `useEffect` 做数据获取。
- 检查是否绕过了 bridge 层、iframe 生命周期约束或协议约定。
- 检查是否直接使用了数据库行类型。
- 检查实现是否复用现有组件与功能结构，且没有明显无用代码或过度设计。
- 检查必要注释、相关文档与测试是否已补齐；若未补齐，需记录原因。
