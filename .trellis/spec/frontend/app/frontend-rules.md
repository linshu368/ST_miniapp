# 前端应用规范

适用于 `packages/frontend`。

规则来源为根 `AGENTS.md`、`docs/ARCHITECTURE.md` 和本目录专题规范；包级 `CLAUDE.md` 已删除，ST iframe/bridge 只作为禁止恢复的历史边界。

## 开发前检查

- 阅读根 `AGENTS.md`、本目录入口及相关专题；不得恢复已退场的 ST iframe/bridge。
- 阅读 `docs/ARCHITECTURE.md` 的第 1、3、4、7 节。
- 搜索现有 `packages/frontend/src/lib/api`、`components`、`stores`、`app` 实现。
- 若改动跨越 backend / API / database，同步阅读 `.trellis/spec/guides/cross-layer-thinking-guide.md`。
- 规划实现时先审视现有组件、hook、store、页面与功能流，优先扩展现有能力。

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

## 已退场架构保护

- SillyTavern、ST iframe、postMessage bridge 和对应协议包已退场。
- 不得新增 `lib/bridge`、ST mirror、`platformAction`、`useSTEvent`、业务 iframe 或兼容层。
- 聊天能力使用当前自研页面、Backend REST/SSE 与 `src/lib/api/` 数据层。

## 架构与实现要求

- 优先考虑可复用性：先复用现有 `lib/api`、组件、store、hook，再决定是否新增抽象。
- 优先考虑可扩展性：新增实现应与现有模块边界一致，便于后续功能继续扩展。
- 优先考虑高可用性：关键交互需要考虑加载态、错误态、有限重试、取消、降级与恢复。
- 在满足以上目标时，保持实现简洁明了，不引入无用代码、无意义抽象或过度封装。
- UI、组件、页面改动需要尽量贴合现有结构与设计系统，不因为技术实现方便就擅自重做交互。
- 对复杂交互、业务编排、SSE/状态同步、非显然约束和边界条件，尽量补充解释“为什么”的必要且简洁注释；简单、自解释的方法无需注释。
- 若变更影响接入方式、用法约束、流程规则或模块组织，需要同步补充相关文档。
- 默认不因新增或修改代码自动创建测试文件；只有用户明确要求、审核后的验收标准确认需要，或已确认风险必须回归锁定时才创建。无论是否新建测试，现有相关测试与适用人工场景仍须执行。

## 目录与实现约定

- 新增服务端数据访问代码优先落在 `src/lib/api/`，并以 React Query hook 形式暴露。
- 新增业务组件按现有模块目录组织，不在 `components` 下堆放无归属的零散文件。
- Zustand store 放在 `stores/`；SSE 与 HTTP 请求放在 `lib/api/`，不要混入业务页面组件。
- 编写新代码前先现场扫描 `src/` 结构，以仓库现状为准，不机械套用模板。

## 质量检查

- 运行 `pnpm --filter @miniapp/frontend typecheck`。
- 触及有现成测试的逻辑、状态处理、数据转换或新增行为时，运行
  `pnpm --filter @miniapp/frontend test`。
- 视觉或页面交互改动需要检查桌面端与移动端状态。
- 检查组件中是否仍存在直接 `fetch` / `axios` 调用。
- 检查是否误用 `useEffect` 做数据获取。
- 检查是否误增了已退场的 ST iframe/bridge 或第二套 SSE/HTTP client。
- 检查是否直接使用了数据库行类型。
- 检查实现是否复用现有组件与功能结构，且没有明显无用代码或过度设计。
- 检查复杂逻辑的必要注释和相关文档；记录测试必要性判断，并确认适用验证已执行。
