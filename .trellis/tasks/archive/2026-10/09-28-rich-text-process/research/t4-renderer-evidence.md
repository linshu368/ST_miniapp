# T4 renderer 证据

日期：2026-09-28。分支 `dev_rich_text_process`。本窗口只做 T4，没有 commit、push 或部署。T1 的 shared 未提交改动和 T2 的 migration 都原样保留，本窗口没有改 `packages/shared/src/**`、`packages/shared/package.json` 或 `packages/shared/migrations/**`。

建议状态：**Done**。物理 Telegram WebView 仍属于 T7，不在本项完成范围内。

## 交付

新建 workspace 包 `@miniapp/reply-renderer`（`packages/reply-renderer`）。它只依赖 `@miniapp/shared`；React 和 ReactDOM 是 peer dependency。公开入口是 `ReplyRenderer`。

```ts
interface ReplyChoicePayload {
  text: string;
  ruleId: string;
  start: number;
  end: number;
}

interface ReplyRendererProps {
  content: string;
  artifact?: unknown;
  streaming?: boolean;
  displayName?: string | null;
  theme?: 'light' | 'dark';
  choiceDisabled?: boolean;
  onChoice?: (choice: ReplyChoicePayload) => void;
  messageKey?: string;
  className?: string;
}
```

包内没有 HTTP、React Query、鉴权、环境选择、应用 store、消息发送或数据库逻辑。`onChoice` 不接收 DOM event，也不调用消息 API。

Frontend 和 Admin 只增加了 `workspace:*` 依赖。`packages/frontend/next.config.mjs` 的 `transpilePackages` 增加了 `@miniapp/reply-renderer`。根 `.eslintrc.json` 增加了 reply-renderer 的导入守卫：禁止应用包、`parse5`、`css-tree` 和 `text-postprocess/compile*`。聊天页面和 Admin 工作台都没有接入。

## 信任边界

1. Worker 对完整原文调用 shared 根出口的 `applyTextPostprocess`。未知 schema、未知 policy、非法 artifact、超时和 Worker 失败都返回整段原文，不保留半处理结果。
2. 主线程用调用方级的 128-bit 以上纯字母数字 nonce 走 `prepareSlotTransport`。nonce 固定 22 个 `[A-Za-z0-9]`，拒绝采样避免取模偏差。碰撞最多换 4 次，仍碰撞则整段回退。
3. 占位替换后的整段 Markdown 只 `makeHtml` 一次。Showdown 2.1.0 没有内置 `safeMode` 选项；渲染器注册了一个 output filter，去掉 script/style/iframe 等容器和 `on*` 属性。这只是纵深防御。DOMPurify 仍按现有聊天气泡白名单强制净化，且不允许属性和 ARIA/data 属性。
4. 净化后的 DOM 再转成 React 节点。inline slot 拆开 text node；block slot 只替换独占 `p` 或 `li` 的槽位；`code`/`pre` 恢复原文；block 落在不安全 inline 上下文时恢复原文。运营模板不走 HTML 字符串，只从 `resolveTrustedTree` 的结构化节点生成 React。capture 始终是文本。
5. `data-action` 不从 DOM 读取。只有可信树上的 `button` 且 `action.type === 'send-message'` 才绑定回调，payload 来自规则产出的 choice 文本和 source range。按钮强制 `type="button"`。
6. CSS 使用 shared 的 `serializeScopedCss`。scope class 由 `messageKey + ruleId` 派生，每条规则、每条消息隔离。序列化结果若出现 `url(`、`@import`、`@font-face`、`javascript:`、`http` 或 `</`，整段回退。页面资源检查只看到本包脚本和 Worker 脚本。

## Worker 生命周期

全页一个 lazy Worker，同时只执行一个任务。

- 同一 `messageKey` 的新任务会终止当前任务并立刻换新 Worker。不同消息按挂载顺序排队，每个 key 只保留最新请求。
- 超时使用 `TEXT_POSTPROCESS_LIMITS.messageBudgetMs`（1000ms）。到点 `terminate()`，销毁实例，下一次任务新建 Worker。
- 成功完成后可以复用该 Worker。错误、取消和超时都不复用。
- 响应必须同时匹配 `jobId` 和 `generation`，旧任务的迟到消息被丢掉。
- 组件卸载取消自己的任务；最后一个消费者离开时释放 Worker、timer 和 listener。
- Worker 创建失败时不在主线程跑正则，直接显示完整原文。

降级路径一律渲染完整原始正文的安全 Markdown：`NO_ARTIFACT`、`TIMEOUT`、`CANCELLED`、`SUPERSEDED`（仅旧 effect）、`WORKER_UNAVAILABLE`、`WORKER_ERROR`、`CSS_REJECTED`、`NONCE_COLLISION`、`SLOT_TRANSPORT`，以及 apply 返回的 `UNKNOWN_SCHEMA` / `UNKNOWN_POLICY` / `INVALID_ARTIFACT`。

## 验证

| 命令                                              | 结果                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm --filter @miniapp/reply-renderer test`      | 17 passed                                                                               |
| `pnpm --filter @miniapp/reply-renderer typecheck` | 通过                                                                                    |
| `pnpm --filter @miniapp/shared test`              | 114 passed                                                                              |
| `pnpm --filter @miniapp/frontend typecheck`       | 通过                                                                                    |
| `pnpm --filter @miniapp/admin typecheck`          | 通过                                                                                    |
| `pnpm --filter @miniapp/frontend build`           | 通过；清理临时路由后的产物不含 `/reply-renderer-probe`                                  |
| `pnpm --filter @miniapp/admin build`              | 通过（tsc + Vite 8.1.0）                                                                |
| `pnpm -r typecheck`                               | 通过。安装依赖时曾重建 `node_modules`，随后执行了 `prisma generate` 才恢复 Backend 类型 |
| `pnpm lint:imports`                               | 通过                                                                                    |
| `pnpm exec prettier --write`（仅本窗口文件）      | 通过                                                                                    |
| `git diff --check`                                | 通过（已跟踪 diff）                                                                     |

测试覆盖：普通 Markdown（强调、列表、段落、inline code、fenced code）、inline/block 合成、code/pre 恢复、nonce 碰撞与 token 不残留、恶意模型 HTML、恶意/未知 artifact、capture 纯文本、模型伪造的 `data-action` 不产生按钮、CSS scope 与外部资源字符串、真实 Worker 超时后 terminate 且下一任务换新实例、迟到结果不覆盖、连续请求、卸载后释放、无 Worker 时整段原文、details/button 键盘与 disabled、按钮和 summary 的 44px 热区。Worker bundle 含 `applyTextPostprocess`，主 bundle 不含它，两边都不含 `parseFragment` / `css-tree`。

### Next / Vite probe

临时页面验证后已删除，没有留在 Frontend 或 Admin 产品入口。

- Vite 8.1.0（Admin 的 Vite）生产构建：主 chunk 322.22 kB / gzip 101.48 kB，Worker chunk `postprocess.worker-*.js` 88.04 kB。Worker 含 `UNKNOWN_SCHEMA`，不含 `parseFragment`。主 chunk 只引用 Worker 文件名。
- Next 14.2.35：临时路由 `/reply-renderer-probe` 18.7 kB，First Load JS 230 kB。独立 chunk `5833.*.js` 34 KB，被该路由引用，含 `UNKNOWN_SCHEMA`，静态产物中没有 `parseFragment`。清理该路由后重新 `next build` 通过。

### 390×844

本地静态服务打开 Vite probe，Chromium 视口 390×844。结果：`data-reply-state=applied`；`strong` 跨 slot 保留；列表 2 项；fenced code 保留；按钮 44×44、`type=button`、文本 Yes，点击后回调文本是 `Yes`；summary 高度 44、宽度 374；Space 展开 details，随后点击收起；模型 `<script>` 没有变成脚本节点；`performance` 资源只有本页 JS 和 Worker JS。

## 未覆盖

- 物理 Telegram iOS/Android WebView、软键盘、安全区和真机字体缩放。按 T0/T7 保留，不用这次 Chromium 结果代替。
- T5 的会话发送、流式资格、余额和网络失败。
- T6 的草稿、发布和 Admin 模拟发送。
- Node `worker_threads` 发布校验属于 T3，不在本包。

## 剩余风险

- Showdown 2.1 没有官方 safeMode 开关。output filter 不是 sanitizer，安全仍依赖 DOMPurify 和结构化可信树。
- 单页一个 Worker。大量历史消息会排队；视口裁剪留给 T5。同一条消息的新内容会终止上一次正则。
- 首屏在 effect 之前渲染纯文本，避免 SSR 把未净化 HTML 送出去。客户端随后换成 Markdown 或可信树。
- reply-renderer 的 devDependency `esbuild@0.25` 与 Vitest 带入的 Vite 8 对 esbuild 0.27 的 peer 不一致。这只影响测试打包，不影响运行时 Worker。
- 安装时重建过 `node_modules`。Backend 类型依赖随后重新生成的 Prisma Client，没有改 Backend 源码。

## T5 / T6 依赖条件

已具备：两端的 workspace 依赖、Next transpile、可导入的 `ReplyRenderer`、浏览器 Worker 和 shared 运行时出口。T5/T6 需要自己传入稳定 `messageKey`、compiled artifact、`streaming`、`choiceDisabled` 和 `onChoice`。artifact 为空时保持现有 Markdown。本包不发送消息。

## T2/T4 收口审阅补充（2026-09-28）

独立审阅发现 details 的 `openStore` key 原先只有 rule/source range/path，没有 `messageKey`。同一个 `ReplyRenderer` 实例切换消息且规则和范围相同时，新消息会继承上一条消息的展开状态。现已把 `messageKey` 同时纳入组件 key 和状态 key；同消息 content 更新仍恢复原展开状态，换消息则使用新消息自己的默认值。

新增回归覆盖“同消息更新保留、messageKey 变化重置”。本窗口重新执行 renderer 17 项测试、renderer/shared typecheck 与测试、全仓 typecheck、导入/迁移静态检查、migration ledger、Frontend build 和 Admin build，均通过。没有接入聊天 UI 或 Admin 工作台，没有实施 T5/T6。
