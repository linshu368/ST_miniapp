# Implementation plan

## Ordered work

1. 扩展 shared CSS contract：property/function/unit token、attribute/pseudo-element selector 和兼容 schema。
2. 将 compiler 的 AST 正向枚举改为 capability denylist，忽略 comments，转换新增 selector/value 节点并保留预算/位置。
3. 将 `css-model` 的逐属性视觉规则改为危险能力检查，更新 scoped serializer 与 runtime artifact revalidation。
4. 为 renderer scope wrapper 增加 containment/isolation，并强化最终 CSS resource scan。
5. 在既有 shared/reply-renderer 测试文件中加入完整运营示例、旧 artifact 兼容、危险能力拒绝和 scope/isolation 回归。
6. 更新架构与 shared spec，记录 denylist 边界、发布顺序和不支持的全局能力。

## Failure-path verification

- source parse/AST Raw、外部 URL/at-rule、危险 property/function、fixed/sticky、z-index、animation。
- 伪造 artifact 中非法 selector/property/token 必须被 `validateCompiledArtifact` 拒绝。
- scoped selector reparse 或 final defense scan 失败时返回完整原文。
- comment-only/empty CSS、旧 artifact、无匹配规则和 choice disabled 状态保持现有行为。

## Commands

```bash
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/reply-renderer test
pnpm --filter @miniapp/admin test
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend test
pnpm -r typecheck
pnpm --filter @miniapp/admin build
pnpm --filter @miniapp/frontend build
pnpm lint:imports
pnpm exec prettier --check <changed files>
git diff --check
```

## Review and rollback gates

- Gate 1：完整运营 CSS 编译通过，同时所有危险能力 fixture 继续失败。
- Gate 2：runtime 能读取旧 artifact，renderer 输出中每个 selector 都带动态 scope。
- Gate 3：consumer typecheck/build 通过后才允许提交。
- 回滚：代码可整体回滚；已发布的新 artifact 在旧 consumer 上安全回退原文。运营侧可回滚到上一规则版本恢复样式。
