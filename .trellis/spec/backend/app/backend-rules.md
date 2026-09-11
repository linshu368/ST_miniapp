# 后端应用规范

适用于 `packages/backend`。

规则来源为根 `AGENTS.md`、`docs/ARCHITECTURE.md` 和本目录专题规范；包级 `CLAUDE.md` 已删除，不得恢复第二套规则来源。

## 开发前检查

- 阅读根 `AGENTS.md`、本目录入口与相关专题，尤其核对路由标注、shared 契约、seed UUID 与跨包边界。
- 阅读 `docs/ARCHITECTURE.md` 的第 1、4、6、7、11 节。
- 涉及日志、错误、请求流或外部集成时，阅读 `docs/log_system.md`。
- 先搜索现有 routes、features、repositories、tests，再决定是否新增实现。
- 如果会改动对外请求/响应数据形状，必须先检查 `packages/shared/src/api/*` 是否已有契约；没有就先补 shared。
- 规划与实现时结合项目现有组件、能力与功能流，优先复用现有实现，不要脱离仓库结构另起一套。

## 必须遵守

- 使用 Fastify 5。
- 使用 TypeScript 严格模式，不新增 `any`。
- 运行时约束保持与项目一致：Node.js 22.x、`tsx`。
- 所有前后端共享的数据契约必须定义在 `packages/shared/`，不得在 `packages/backend` 私自定义对外数据形状。
- 用户鉴权使用 `requireTelegramAuth` / `X-Init-Data`；CS、admin、bot 端点沿用各自既有鉴权机制。
- LLM 生成与计费逻辑必须通过 `src/features/generation/`。
- 运行时配置必须通过 `src/platform/runtime-config.ts` 读取。
- 记录日志时保留原始错误对象，使用 `log.sys.error({ err }, 'message')` 形式。
- 需要业务/系统事件日志的路由使用 `requestLogger(request.log, module)`。

## 路由与前端联调规则

- `packages/backend/src/routes/*.ts` 与 `src/app.ts` 中，每一条
  `app.get/post/put/delete/patch(...)` 注册语句附近必须有 `@frontend-ready: true|false`
  注释。
- `@frontend-ready: false` 必须带清晰、带业务含义的原因，不能只写 `wip`、`todo` 这类无信息词。
- 当 handler 从半成品变为可联调完成态时，默认应在同一个 PR 中把 `false` 改为 `true`；
  如果故意拆到后续 PR，需要在任务或 PR 说明中交代原因。
- 新增 API 端点时，先定义 shared 契约，再实现路由，最后补 `@frontend-ready` 注释。
- 路由字面量路径必须与 `packages/shared/` 中的契约约定一致，路径参数沿用 `:id` 等既有命名惯例。

## 数据契约与 seed 保护规则

- 请求体、响应体、公开 DTO 类型全部优先来自 `packages/shared/`。
- 如果 shared 中没有需要的对外类型，先在 shared 定义，再写后端实现。
- 不得删除或修改 `packages/shared/src/dev-fixtures.ts` 中已被引用的 `DEV_SEED_*` UUID 常量。
- 不得删除或修改 `packages/backend/prisma/seed.ts` 中与这些 UUID 对应的 `upsert` 语句及记录 `id`。
- 如确需调整 seed UUID，必须先确认前端 mock、测试和文档引用已同步处理。

## 架构与实现要求

- 优先考虑可复用性：先扩展现有 feature、repository、contract、helper，而不是重复造轮子。
- 优先考虑可扩展性：新增规则与实现应能在现有目录结构和模块职责下自然扩展。
- 优先考虑高可用性：关键路径上的错误处理、日志、配置读取与回退策略要明确。
- 在满足以上目标时，保持实现简洁明了，不引入无用代码、无意义抽象或过度包装。
- 未经任务明确要求，不要顺手改动前端 UX、文案、视觉或页面结构；技术接入类前端修改除外。
- 对复杂方法、业务编排、非显然约束、关键状态转换和边界处理，尽量补充解释“为什么”的必要且简洁注释；简单、自解释的方法无需注释，不添加复述代码行为的注释。
- 变更若影响行为、契约、接入方式或协作规则，需要同步补充相关文档说明。
- 默认不因新增或修改代码自动创建测试文件。只有用户明确要求、审核后的验收标准确认需要，或已确认风险必须用回归测试锁定时才创建；无论是否新建测试，现有相关测试和其他适用验证仍必须执行。

## 质量检查

- 运行 `pnpm --filter @miniapp/backend typecheck`。
- 涉及后端逻辑时，运行 `pnpm --filter @miniapp/backend test`。
- 涉及对话/生成链路时，运行相关 backend 测试，并记录真实上游、SSE 时序等无法本地自动覆盖的人工场景。
- 检查改动过的 routes 是否仍与 shared 契约一致。
- 检查所有新增或变更的路由是否存在正确的 `@frontend-ready` 注释。
- 检查是否误删或误改了 seed UUID 相关常量、记录或引用。
- 检查实现是否充分复用现有能力，且没有明显无用代码或过度设计。
- 检查复杂逻辑的必要注释和相关文档；记录测试必要性判断，并确认适用验证已执行。
