# Design: capability-based scoped CSS policy

## Current facts and reuse research

- `compile-css.ts` 已使用 `css-tree` 解析、计数并在编译期 reparse scoped selector；继续复用，不引入第二套 parser。
- `css-model.ts` 已拥有 browser-safe artifact model、运行时复验和动态 scope serializer；扩展现有 model，不把 compiler 或 `css-tree` 带入 renderer 主路径。
- `validate-artifact.ts` 是 renderer 前的可信边界；继续对 selector/declaration 逐项复验。
- `reply-renderer` 已按 `messageKey + ruleId` 生成不可由运营指定的 scope class，并在 Worker 中统一序列化 CSS；继续复用。
- Admin Preview 与 Backend publish 都调用同一个 `compileTextPostprocessSource`；无需新增 Admin/Backend 私有策略。
- 未复用浏览器 sanitizer：浏览器没有可依赖的标准 CSS Sanitizer API，且字符串过滤无法替代现有 AST/canonical 边界。

## Contract and data flow

```text
Admin CSS source
  -> css-tree parse and budgets
  -> capability denylist and structured artifact
  -> Backend publish stores immutable artifact
  -> renderer validates structured artifact
  -> dynamic message/rule scope serialization
  -> final defense scan
  -> scoped <style> + contained slot wrapper
```

### Selector model

在现有 compound model 上兼容扩展：

- combinator 增加 adjacent/general-sibling；
- tag 支持安全 type selector 与 `*`；
- attribute selector 保存 name、matcher、ident/string value 与 case flag，attribute name 复用 HTML inert attribute 判定；
- 无参数 pseudo-class 使用受限 token 语法和危险名 denylist，`nth-child` 保留结构化范围；
- 每个 compound 最多一个 pseudo-element，名称仅允许规范 token；
- selector list 在 compiler 中逐 selector 拆分，serializer 对每一项独立添加 `.scope `，再 reparse。

不支持需要全局命名空间或难以安全重写的 selector/at-rule 形态时，按能力边界拒绝，而不是按视觉属性逐项放行。

### Declaration/value model

- property 从 enum 改为经过语法校验的字符串；自定义属性可用。
- token 的 function 名与 dimension unit 改为安全 token 字符串；保留递归深度、单声明 token 数和总 AST 预算。
- 默认接受 canonical value；只检查危险能力：resource-bearing/legacy executable functions、危险 property、fixed/sticky、z-index 上限、animation/global transition namespace 等。
- `!important` 仍拒绝：它会越过 renderer 为触控与可访问性设置的内联保障，不是视觉属性缺失问题。
- comments 由 parser 丢弃，不进入 artifact。

### Isolation

最终 CSS 只能匹配 scope wrapper 的后代。wrapper 增加 `contain: paint style`、`isolation: isolate` 和 `position: relative`，限制绘制和 stacking 影响；同时拒绝 `position: fixed|sticky`，形成编译期和布局期双层边界。

## Security and reliability model

- 外部资源：拒绝 `Url` AST、`url/src/image-set/cross-fade/element/paint/expression` 等函数以及 `@import/@font-face/@namespace/@charset`。
- 全局状态：除现有有界 `@media` 外不输出 at-rule；拒绝 keyframes/animation 和 view-transition/anchor 全局命名能力。
- 作用域逃逸：只接受结构化 selector，逐项 prefix 后 reparse；renderer 不接受 source CSS。
- 页面覆盖：contain/isolation 加上 fixed/sticky 拒绝和有界 z-index。
- 容量/DoS：沿用 source bytes、CSS units、AST nodes、selector/declaration/token/diagnostic 数量与 Worker deadline；不重试纯编译。
- 幂等/并发/事务：compiler 为确定性纯函数；发布 CAS、request id 与原子 snapshot 流程不变。
- 降级/补偿：artifact 或最终 CSS 任一复验失败时整条回复回退原始 Markdown；无部分样式、无补偿写入。
- 限流/容量：无新增网络入口或请求；沿用 Admin/Backend 限流与 Worker 预算。
- 可观测性：沿用结构化 diagnostics；为 selector、property、external resource、at-rule、value/overlay 分配明确 code 和位置。

## Compatibility, rollout and recovery

这是现有 schema/policy v1 的兼容扩展：旧 artifact 的字段形状仍是新 schema 的合法子集，因此新消费者可读取全部旧数据，不需要 migration。版本号不增加，避免把仅扩宽表达能力误作破坏性持久化迁移。

旧消费者无法识别新扩展字段时会 fail-open 到原始 Markdown，不会执行不理解的 CSS。发布顺序应为 renderer consumers（Frontend/Admin）先可用，再更新 Backend compiler，最后允许运营发布使用新语法的规则。若同一次 dev 发布存在短暂竞态，停止发布新 CSS 即可；回滚代码或回滚到旧规则版本都不会改写历史 snapshot。

## Minimal sufficient solution

- 不引入 iframe/CSP 子文档：产品目标不是任意 CSS，且这会重做交互、主题、尺寸与 choice 通信。
- 不把 `css-tree` 放进 renderer 主路径：维持当前 browser bundle 和可信 artifact 边界。
- 不建立通用 CSS parser/sanitizer 框架：只扩展现有 model、denylist 和 serializer。
- 不支持 keyframes 自动重命名：当前需求没有动画；全局名称重写会显著增加 artifact 与 serializer 复杂度。
- 不改数据库和 HTTP DTO 外形，只做 shared artifact 的兼容扩展。
