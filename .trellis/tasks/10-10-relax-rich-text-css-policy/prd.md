# Relax rich-text CSS policy safely

## Goal

让运营在 Admin 回复后处理规则中使用常规展示 CSS，而不再因正向属性、函数和简单选择器白名单频繁要求发版；同时继续阻止外部资源、全局规则、跨消息作用域和覆盖页面的危险能力。

## Requirements

- CSS 仍必须经 AST 解析、canonical artifact、运行时 artifact 校验和逐消息逐规则 scope 后才能进入页面。
- 注释应作为无运行时语义内容忽略，不得导致编译失败。
- 常规属性、shorthand、自定义属性和无外部能力的 CSS 函数默认可用；不得再维护视觉属性正向枚举。
- 支持普通 attribute selector、无参数 pseudo-class、pseudo-element、相邻/通用兄弟组合器和现有响应式 media 条件。
- 明确拒绝外部资源与全局 at-rule、可执行旧式 CSS、animation/keyframe 全局命名空间、fixed/sticky 页面覆盖、过高 stacking、选择器逃逸和超预算输入。
- 运营给出的 `.rp-*` 示例 CSS（包括 `[open]`、`::after`、`::-webkit-details-marker`、`light-dark()`、`transform`、`opacity`、`cursor`、`font`、`content`、`border-left`、`transition`）必须完整编译。
- 旧 artifact 必须继续被新消费者读取；失败仍整段回退原始 Markdown，不渲染半份 CSS。
- 不改数据库 schema，不读取或修改 test/production 业务数据，不改变回复匹配、choice 发送和计费链路。

## Acceptance Criteria

- [ ] 完整 `.rp-*` 示例通过 shared compiler，无 CSS diagnostic。
- [ ] compiler 忽略 CSS comments，并为非法 selector/property/value 提供能力相关且带位置的 diagnostic。
- [ ] `url()`、`@import`、`@font-face`、未知/全局 at-rule、`expression()`、`behavior`、`position: fixed|sticky`、超限 `z-index` 和 animation 仍被拒绝。
- [ ] 所有生成 selector 在序列化后都位于动态 scope class 下，reparse 通过且无法通过 selector list 逃逸。
- [ ] renderer 的 slot wrapper 建立局部 paint/style containment 与 stacking context；现有 choice/details 交互不回归。
- [ ] 既有 v1 artifact fixture 继续通过 schema 与运行时校验；无需 migration。
- [ ] shared、reply-renderer、Admin、Backend、Frontend 的相关测试/typecheck 通过，Admin 与 Frontend build 通过。
