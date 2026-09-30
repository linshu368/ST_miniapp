# T1 shared 解析证据

日期：2026-09-28。只覆盖 T1 编码前对 shared 直接相关解析器的核对，以及随后写入 `@miniapp/shared` 的纯函数。本文件不把 Next/Vite renderer、Worker 打包、移动端预算或物理 Telegram WebView 记成已完成；那些仍以 T0 临时原型和后续 T4/T7 为准。

## 依赖核对

当前仓库原先没有 `parse5` 或 `css-tree`。本轮按 T0 冻结版本加入：

- `parse5@8.0.1`，MIT，自带类型。`parseFragment(html, { sourceCodeLocationInfo: true, scriptingEnabled: false, onParseError })` 在 Node 22 上返回 fragment、源码偏移和 parse error。HTML 元素的 `namespaceURI` 是 `http://www.w3.org/1999/xhtml`，SVG 是 `http://www.w3.org/2000/svg`。
- `css-tree@3.2.1`，MIT。实际子路径是默认导出：`css-tree/parser`、`css-tree/walker`、`css-tree/generator`。`parse(css, { positions: true, onParseError })` 会给出行列偏移；无法解析的值同时触发 error callback 并留下 `Raw` 节点。同一输入的 `generate` 输出稳定。
- 未安装 `@types/css-tree`。该 DefinitelyTyped 包是 2.x API，和 3.2.1 的子路径默认导出不一致。shared 使用本地 `css-tree-entries.d.ts` 描述实际用到的节点字段。
- `pnpm-lock.yaml` 锁定 `parse5@8.0.1` 与 `css-tree@3.2.1`。包声明 `"sideEffects": false`。编译入口是 `src/text-postprocess/compile.ts`，根 `src/index.ts` 不导出它，因此 MiniApp 主入口的静态依赖图不包含这两个解析器。

本机探针还确认了两个必须写进编译器的行为：

- `$<name>` 编码成 `$&lt;name>` 后，parse5 文本节点会解码回 `$<name>`。捕获替换只允许从文本节点生成 `CaptureRef`。
- `<table><tr>` 会插入没有 `sourceCodeLocation` 的 `tbody`；`<p><div>` 会拆树。缺位置的节点按解析器改写拒绝，运营表格必须显式写 `tbody`。

## 安全边界如何落地

HTML/CSS 白名单、选择器、属性和数值范围按 `research/t0-technical-validation.md` 执行，没有放宽标签、捕获组或外部资源规则。`Raw`、`url()`、`@import`、`!important`、非 allowlist 属性和负 margin 都会变成带规则 id 与位置的诊断，诊断正文不回显模板或 URL。

捕获组在属性、标签和 CSS 中失败关闭。命名捕获、`$1`–`$99`、`$&` 和 `$$` 只进入文本。模型原文不会被编成可信按钮；只有模板里的 `button` 会得到编译器固定的 `send-message`。

`applyTextPostprocess` 不读取时钟、随机数或环境。时间预算由调用方传入 `clock` / `deadlineAt`。单次正则执行内部仍不可被该函数打断，所以正式调度必须留在后续 Worker。

## 本轮未覆盖

- 没有重建 T0 的 Vite/Next 生产包，也没有测量 MiniApp 首屏体积。
- 没有在浏览器或 `worker_threads` 里执行 terminate。
- 没有跑 390×844 或物理 Telegram WebView。
- `packages/reply-renderer`、Backend、Frontend、Admin、CS 和 migration 都还没有接入这些类型。
