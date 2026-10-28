# T0 技术验证结论

日期：2026-09-28。范围仅为隔离原型与本地验证；未修改产品代码、仓库依赖、数据库或远端环境。临时原型使用 Node.js v22.20.0、Next.js 14.2.35、Vite 8.1.0、React 18.3.1、Showdown 2.1.0 和 DOMPurify 3.4.1，以贴近当前仓库。

## 结论

T1 可以开始，但必须按本文锁定接口边界。HTML/CSS 编译器采用 `parse5@8.0.1` 与 `css-tree@3.2.1`；正则执行必须位于可销毁 Worker；发布快照携带结构化可信树，MiniApp 运行时不得重新解析运营 HTML/CSS，也不得直接信任或插入服务端 HTML 字符串。

原型发现并修正了两个会导致错误契约的点：

1. `$<name>` 会被 HTML parser 当成标签起始。编译器须先仅对合法 named-capture lexeme 的 `<` 做实体编码，并保留 transformed-to-source offset map；AST 文本节点解码后再生成 `CaptureRef`。捕获组在属性、标签、CSS 中一律非法。
2. 含 `_` 的内部 Markdown 占位符会被 Showdown 当作强调语法。渲染器只能使用调用方提供的 128-bit 随机、纯字母数字 nonce，先确认与完整原文无碰撞，再把结构化槽位临时映射进去；静态 token 或仅靠“罕见字符串”不合格。

T0 已解除 T1 的技术依赖。物理手机上的 Telegram WebView、主题/字体/安全区和弱机性能仍属于 T7 发布门禁；本轮只完成真实 Chromium 的 390×844 窄屏验证，不能把它描述为物理设备验收。

## 依赖与打包决定

- HTML：`parse5@8.0.1`。使用 `parseFragment(..., { sourceCodeLocationInfo: true, scriptingEnabled: false, onParseError })`，兼容浏览器与 Node，MIT。官方 API 明确支持 fragment、parse error callback 与节点源码位置。
- CSS：`css-tree@3.2.1`。只导入 `css-tree/parser`、`css-tree/walker`、`css-tree/generator`，不导入整包 lexer 数据，MIT。parser 的容错 `Raw` 节点必须当成错误，不得静默接受。
- `parse5` 与 `css-tree` 只进入 compile worker/Backend/Admin preview 路径。发布 artifact 是受版本化 schema 约束的可信树；MiniApp 主渲染路径只做轻量 schema/policy 再校验和树渲染，避免把编译器带入首屏。
- 选择性导入后的 compile 核心 Vite library 构建为 292.49 kB minified / 71.80 kB gzip；整包导入为 430.85 kB / 107.08 kB gzip，因此禁止 `import * as csstree from 'css-tree'`。
- 含 React、Showdown、DOMPurify、compile 核心和浏览器 Worker 的隔离 Vite 页面为 475.73 kB / 146.56 kB gzip；这是验证页整体，不是允许新增到 MiniApp 首屏的预算。
- Next 14.2.35 production build 成功：验证页 route 67 kB，First Load JS 154 kB；Vite 8.1 production build 成功，独立 Worker chunk 0.17 kB。

来源：

- parse5 官方 fragment 与位置 API：<https://parse5.js.org/functions/parse5.parseFragment.html>、<https://parse5.js.org/interfaces/parse5.ParserOptions.html>
- parse5 官方仓库/版本：<https://github.com/inikulin/parse5>、<https://www.npmjs.com/package/parse5/v/8.0.1>
- CSSTree 官方仓库/包结构：<https://github.com/csstree/csstree>、<https://github.com/csstree/csstree/blob/master/package.json>
- 浏览器 Worker 终止语义：<https://developer.mozilla.org/en-US/docs/Web/API/Worker/terminate>
- Node Worker 终止语义：<https://nodejs.org/api/worker_threads.html#workerterminate>
- Showdown 安全边界：<https://github.com/showdownjs/showdown/security>

## HTML 模板策略

最终首期 tag allowlist：

`p div span mark strong em b i del br hr section details summary ul ol li table thead tbody tr td th button pre code blockquote h3 h4`

属性规则：

- `class`：每节点最多 8 个 token；单 token 匹配 `[a-z][a-z0-9_-]{0,63}`。实际隔离 scope 由编译器/渲染器添加，运营不能控制。
- `open`：只允许在 `details`，布尔值。
- `title`、`aria-label`：仅纯文本，禁止捕获组；`aria-hidden=true` 只允许无捕获、无 action 的装饰叶节点。
- `colspan`、`rowspan`：只允许在 `td/th`，整数 1–20。
- `data-action` 不接受运营任意值。只有编译器识别的 `button` action 节点可生成固定 `send-message`；渲染器把点击内容交给受控回调，不生成 URL，不透传 DOM event。
- `button` 由渲染器强制 `type=button`。不允许运营设置 `id/style/name/value/form/disabled/tabindex/role`。
- 全局禁止 `on*`、URL 属性、任意 `data-*`、表单、SVG/MathML、media、iframe、script/style/link/meta、HTML comment 和 namespace。
- `$1`、`$<name>` 仅编译为文本节点中的 `CaptureRef`；`$$` 编译为字面 `$`。引用不存在的捕获组是发布错误。

结构预算：每模板最多 1,000 AST nodes、深度 32、128 个 capture refs、64 KiB 编译后文本；超过即整条规则不可发布。原型中 80 层/82 nodes 的解析 p95 约 0.63 ms，但仍限制为 32 层以控制布局、递归和可审查性；10,002 nodes 的模板解析 p95 约 12.37 ms，证明仅靠解析耗时不足以阻止 DOM 膨胀。

## CSS 策略

选择器只允许：allowlist tag、局部 class、后代/子元素组合器，以及 `:first-child`、`:last-child`、受限 `:nth-child()`、`:hover`、`:focus-visible`。禁止 universal/id/attribute/global/root/host/slotted/穿透选择器、pseudo element、`:has()`、未知 pseudo 和 sibling escape。每个 selector 由 AST 生成后强制前置版本/规则 scope，并再次 parse；禁止字符串拼接未经重解析直接发布。

首期 property allowlist：

- 文本：`color font-family font-size font-style font-weight line-height letter-spacing text-align text-decoration text-transform white-space overflow-wrap word-break`。
- 背景/边框：`background background-color border border-color border-style border-width border-radius box-shadow`；`background` 只允许纯色或最多 4 stops 的 `linear-gradient()`。
- 盒模型：`box-sizing width min-width max-width height min-height max-height margin padding overflow overflow-x overflow-y`。
- 布局：`display flex flex-basis flex-direction flex-grow flex-shrink flex-wrap align-items align-content align-self justify-content justify-items justify-self gap row-gap column-gap grid-template-columns grid-auto-flow place-items`。
- 列表/表格：`list-style list-style-position border-collapse border-spacing table-layout vertical-align`。
- 过渡：`transition-property transition-duration transition-delay transition-timing-function`，总 duration 不超过 300ms，只能作用于颜色、背景、边框、阴影和 opacity。

数值/值限制：禁止负 margin、viewport units、`calc/min/max/clamp/env`、外部或自定义 URL、未知 function、custom property 定义、`!important`、`position`、`inset/top/right/bottom/left`、`z-index`、`transform`、`filter/backdrop-filter`、`clip-path`、`content`、`cursor`、`pointer-events`、`user-select`、`animation*`。只允许消费代码内置主题变量。长度允许 `px/rem/em/%`，字号 12–32px 等价值、单侧 margin/padding 0–32px、gap 0–24px、border 0–4px、radius 0–32px、shadow blur 0–32px；宽高不能超过容器 100% 或 640px 等价值。首期禁止 `display:none`、`visibility:hidden` 和完全透明交互内容；需要装饰隐藏时由平台提供内置 helper class，不开放任意 CSS 隐藏。

At-rule 仅允许 `@media`，且只允许 240–1200px 范围内的 `min-width/max-width` 与平台明确支持的主题查询；禁止 `@import/@font-face/@keyframes/@supports/@container/@layer/@scope`。每条规则 CSS 最多 16,000 UTF-16 code units、64 selectors、256 declarations、3,000 CSS AST nodes。

恶意 fixture 中的 `body/html`、`position:fixed`、`z-index`、`url()`、`@import`、`!important` 均能带行列位置拒绝；100 条普通 CSS rules 的 Node p95 约 3.87 ms、最大约 6.47 ms。

## Markdown 与可信槽位

1. Worker 对完整原文执行规则，输出按 source span 排序的 `TextSegment | TrustedSlot`，不输出拼接 HTML。
2. 渲染器用调用方提供的 128-bit cryptographic nonce 生成纯字母数字 token，并对完整原文做碰撞检查；每个 token 与一个结构化槽位一一映射。
3. 完整 Markdown 只调用一次既有 Showdown，开启 `safeMode`，随后仍由 DOMPurify 净化。Showdown 官方明确说明其不是 sanitizer，因此 DOMPurify 不能删除。
4. 净化后遍历 text nodes：inline slot 拆分 text node 并插入受控 React/DOM tree；block slot 只能替换独占 `<p>` 或 `<li>` 内容的 token。block match 若位于行内上下文，保留原始 match 并返回 `BLOCK_SLOT_CONTEXT_UNSAFE`，不得破坏 DOM。
5. `<code>/<pre>` 内命中的 token 恢复原始 match 文本，不应用后处理，避免改写代码示例。普通强调、列表、代码和段落因此维持一次 Markdown parse 的语义。
6. token 仅是 Markdown transport，权威数据始终是结构化 slot map；模型无法预知随机 nonce，且碰撞检查失败会重新生成。静态 token、HTML comment token 和直接注入运营 HTML 都禁止。

390×844 Chromium 实测：跨槽位 `strong` 保留、两项列表保留、inline slot 1 个、block slot 2 个、code slot 恢复 1 个、最终 DOM 无 token。52,500 code units Markdown 的 Showdown + DOMPurify 约 31.4 ms；10,000 个隐藏 DOM nodes 创建约 6.8 ms。该数据用于收紧预算，不替代物理 Telegram 设备验收。

## Worker、预算与降级

- 浏览器：每个页面最多 1 个 lazy Worker；同一时刻只处理 1 个任务，后到任务取消前一个或排队上限 1。timeout 后立即 `terminate()` 并新建 Worker，不复用未知状态实例。
- Node：独立 `worker_threads` pool，默认最多 2 个 worker/进程、队列最多 64；确定性任务失败不自动重试。进程关闭须 drain/terminate；最终值以 T3 容量测试为准，不得无限建 worker。
- 实测 `^(a+)+$` 对 30 个 `a` 加 `!`：浏览器在约 50.9–51.3 ms terminate；Node 在约 52–58 ms terminate，主线程保持响应。`terminate()` 的非零退出码是预期终止信号，不当作应用崩溃。
- 每规则 pattern 2,000、template/CSS 各 16,000 code units；版本 source JSON UTF-8 256 KiB；最多 100 rules；消息正文 50,000 code units；options 8,000 code units。
- 每规则最多 1,500 matches，单消息全局最多 5,000 matches；单规则执行 100ms，单消息总期限 1,000ms。无额外 retry。
- 展开后最多 10,000 generated nodes、2,000 trusted slots，估算输出文本上限为 `min(input * 4 + 65,536, 262,144)` code units；任一限制命中即中止整条消息的派生结果并显示原文，不返回部分处理结果。
- 编译/执行失败、未知 schema/policy、Worker crash/timeout、slot transport 异常均 fail open 到原始模型文本，同时产生不含正文/模板/捕获内容的 code、rule_id、version_id、耗时和计数摘要。Admin 保存/发布则 fail closed，必须修正全部 error diagnostics。

## 执行证据

- `node node-probe.mjs`：合法 named/numbered capture 编译为结构化节点；恶意 HTML/CSS 被定位拒绝；容量与 Node terminate 通过。
- `pnpm build:vite`：Vite 8.1.0 production build 通过，Worker 独立成 chunk。
- `pnpm build:next`：Next 14.2.35 production build、lint/type validity、static generation 通过。
- 本地浏览器：真实 Chromium 正常视口与 390×844 均通过模板/CSS、Markdown 槽位、DOMPurify 和 Worker terminate probe。
- 临时原型仅位于 `/private/tmp/rich-text-t0.kmbTaB`，不属于交付物；仓库未增加依赖或产品文件。

## T1 强制接口边界

- contract 必须区分 `source`、`compiledArtifact`、`policyVersion`、`schemaVersion`；artifact 只含 allowlist tree/scoped CSS/diagnostics/stats，不能含可执行函数或原始 DOM event。
- compile API 返回 source-mapped diagnostics；apply API 只接收已验证 artifact，并返回 `TextSegment | TrustedSlot`、source span、计数/降级原因。捕获内容类型固定为 text。
- compiler 与 runtime validator/apply 拆文件，避免 MiniApp import compile parser；shared package 标记 ESM side-effect free 或提供等效可 tree-shake 边界。
- nonce/randomness、时间预算、Worker 生命周期由 caller 注入；纯函数不得隐式读时间、网络、数据库或全局随机数。
- T1 回归测试必须覆盖 named-capture HTML ambiguity、`$$`、attribute capture、Markdown underscore token、code/pre restore、block-in-inline fallback、malicious HTML/CSS、source locations、节点/深度/展开预算和 unknown version fail-open。
