# M5 自研聊天 UI — 模块交接说明

> 面向：接手 M5 的前端开发　　
>
> 日期：2026-08-12　　
>
> 分支：`dev（需要包含M1-M3的实现）`
>
> 背景文档（需要查决策来龙去脉时看）：`docs/ST_remove.md`、`docs/ST_remove-MVP实施方案.md`
> 本文只说明**目的、约束、依赖是否到位**。

---

## 一、这个模块要解决什么

miniapp 现在的对话界面是嵌一个 SillyTavern（下称 ST）iframe。它的冷启动压在"点卡进对话"这条最高频路径上，导致耗时不达标（实测 P50 4.9s / P95 22.4s，目标 P50 ≤2s / P95 ≤5s），且优化见顶、无法根治。

因此整体方案是**自研一条对话链路把 ST 整体替换掉**。后端部分（数据模型、prompt 引擎、生成与计费出口、对话 REST + SSE）已经全部交付并本地验收通过。

**但线上 dev 环境验不了**：入口仍是 ST iframe，新链路在真实环境里没有任何入口，一次都没被真机点过。

**M5 的目的就是补上这个入口**——写一套完全自研、不依赖 ST 的聊天 UI，让新链路能在 dev 环境被真机验收。

---

## 二、范围边界

**做**：聊天页本体（消息区、输入、流式呈现、重生成）+ 会话列表 / 头部 / 模型切换这些壳组件的数据源改接新 REST

**不做**（属于 M6 或阶段三）：全局切换开关、登录去 provision 化、删除 ST 代码、压测、埋点对齐。

**明确不要的功能**（已拍板的决策，别自己加回来）：ST 的 swipe 多候选、世界书、正则、酒馆助手；存量 ST 聊天记录的迁移或展示（决策 1：不迁移，留档不呈现）。

一句话分工：**M5 让新 UI 能被访问到且好用；M6 决定它什么时候成为所有用户的唯一入口。**

---

## 三、实现原则（硬约束）

### 1. 不碰 ST 侧任何代码

以下在 M5 期间**只读**：

```
vendor/sillytavern/ · packages/st-extension/ · packages/bridge-protocol/
packages/frontend/src/lib/bridge/ · src/components/bridge/ · src/stores/st-mirror.ts
packages/frontend/src/app/providers.tsx（全局挂 iframe 的地方）
packages/backend/src/routes/bridge.ts · routes/chats.ts · routes/llm-proxy.ts · middleware/stProxy.ts
ops/nginx/ · ops/st-extensions/ · ops/sillytavern/
```

理由：ST 链路目前承载 100% 生产流量，M5 上线时它仍是唯一在跑的对话链路。它确实会被删，但删除时点在切换后的回滚窗口关闭之后，不是现在。改它是没有收益的纯风险。

### 2. 新 UI 对 ST 的依赖必须是零

新代码里不允许出现 `@/lib/bridge`（`platformAction` / `useSTEvent` / `useSTMirror` / `useBridgeStatus`）、`@miniapp/bridge-protocol`、`useSTMirrorStore`，也不允许调用 `/api/users/chats`、`/api/bridge/*`、`/api/platform/llm-proxy/*`。没有 iframe、没有 postMessage、没有 ST cookie。

自检：新增文件里 grep `bridge` / `platformAction` / `st-mirror` / `iframe`，应当零命中。

### 3. 新增一条并存的路由，不要改造现有聊天页

不要在 `/tavern/[characterId]` 里加分支，新建一条独立路由（如 `/chat/[characterId]`）与它并存。

这样 M5 合并上线时**生产行为完全不变**（没有用户会走到新路由），内部账号在 dev 手输 URL 就能验收；M6 切换时只需改大厅卡片的指向。反过来在现有页面里加分支，既容易踩坏 ST 链路，也让改动无法被独立 review 和回滚。

注意路由命名不要和 `next.config.mjs` 里会被重写到 ST 网关的路径撞车（`scripts` / `css` / `img` / `lib` / `characters` / `user` / `assets` 等）。

### 4. 对外数据形状一律走 `packages/shared/`

`ChatMessage` / `ChatSession` / `ConversationStreamEvent` 等类型从 `@miniapp/shared` import，不在前端就地重定义。契约需要改（缺字段、缺接口、错误码没法处理）**先提，由后端改 shared + 实现**，不要在前端多请求硬拼或直连 Supabase 绕过去。

### 5. 遵守 `packages/frontend/CLAUDE.md` 既有规则

组件内禁止直接 fetch（请求封装进 `src/lib/api/` 的 React Query hook）、禁止用 `useEffect` 取数、禁止 `any`、只用 Tailwind 原子类、UI 优先 shadcn/ui、引新依赖前先确认已有的能不能实现。

> 该文件里「iframe 集成与跨边界通信」整节是给 ST 链路写的，**不适用于 M5**。

---

## 四、依赖项状态：哪些已到位

| 依赖                                                             | 状态                                     | 位置 / 说明                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------- |
| 前后端数据契约                                                   | ✅ 完整                                  | `packages/shared/src/api/conversations.ts`，约 200 行带注释，**开工先通读**     |
| 对话 REST + SSE 接口                                             | ✅ 8 条全部就绪                          | `packages/backend/src/routes/conversations.ts`，全部标 `@frontend-ready: true`  |
| 会话 CRUD / 发消息 / 重生成 / 生成配置读写                       | ✅ 已覆盖                                | 会话列表直读 DB，不再反代 ST                                                    |
| 周边接口（角色卡、模型目录与切换、钱包余额、免费额度、用户资料） | ✅ 早已存在                              | 前端多数已有对应 React Query hook                                               |
| 后端质量                                                         | ✅ 173/173 单测通过，端到端回归 8/8 通过 | `pnpm --filter @miniapp/backend mvp:regression -- --seed-free-model` 可本地复跑 |
| 库迁移 069~073                                                   | 已**在 test 库执行过**                   | dev环境已到位                                                                   |
| 现有的 `apiStreamClient()`                                       | **不能直接用**                           | 见下方说明                                                                      |

**关于** `apiStreamClient()`：`src/lib/api/client.ts` 里有这个函数，早期文档写过"M5 可直接用"，**这个说法已作废**（相关文档与 shared 契约里的注释已于 2026-08-12 更正）。它按 OpenAI 风格解析 `{ content }` 分片、认 `[DONE]` 哨兵、回调累积全文，且对非 2xx 只抛状态码、丢掉响应体（而 402 的响应体形状特殊，必须读得到），与新链路对不上。

这一层由你写、形态你定——契约已经冻结在 shared 里，剩下的难点（AbortSignal、delta 攒批以免逐 token 重渲染、错误怎么冒泡、402 接充值跳转、跟 React Query 怎么配合）都是渲染侧的决定。它当前**零调用方**，删掉对 ST 链路无影响，建议在同一个 PR 里删掉，免得以后有人挑错函数。

---

## 五、现有代码状态：能复用的是壳和交互设计，代码要新写

**可以复用的是"壳"与已定型的交互设计**——聊天页的整体布局、开屏动画、侧边栏会话列表的形态、模型切换与工具菜单的交互框架、暗色主题与设计 token，这些产品形态已经跑过一轮验证，不用重新设计。

**但代码基本都要新写**。现有壳组件（`src/components/tavern/` 下的 header / sidebar / 工具菜单 / 模型切换）的数据源全部挂在 bridge 和 ST 反代上：会话列表来自 ST 的 recent 反代，当前会话 id 来自 ST 状态镜像，开/删/改名和新建对话都是 `platformAction()` 调用，列表刷新靠订阅 ST 事件。换数据源等于换血，且它们还要继续给 ST 页面用——**建议在新目录下另写一份，不要原地改**。

其余可直接复用的现成件：开屏动画组件（与 bridge 无耦合，只吃一个 ready 布尔）、shadcn/ui 组件、`globals.css` 里的设计 token（已有聊天专用变量）、`apiClient()`（鉴权与错误归一化已封装）、字号缩放 store 与闲置变暗 hook（都是为聊天页准备的，当前零消费方）、`showdown` + `dompurify`（已在 package.json，当前零 import）。

**一个环境干扰需要知道**：ST iframe 挂在 `providers.tsx` 里全站常驻，靠路径控制显隐。你在新路由上时它仍在后台 boot，DevTools 里会看到 ST 的网络请求——这是预期的，别去改它（M6 会摘掉）。两个后果：别被那些请求误导；这个阶段测出的首屏耗时不能代表最终值（后台 iframe 在抢带宽），所以 **M5 的验收不放性能指标**。

---

## 六、验收判据

在 Railway `development` 环境用真机 Telegram 打开新路由：建会话、发消息看到流式回复、刷新后历史完整、重生成、切换/重命名/删除会话、切模型——全部正常，且 **DevTools Network 里零 ST 请求、零 bridge 调用**（这条是本模块的核心判据）。

另有两条本地验不到、正好由这轮补上的：真实上游的流式时序（本地假上游按固定 chunk 切包），以及中间层会不会缓冲 SSE（后端已下发 `X-Accel-Buffering: no`，但 Railway 侧是否攒包只有真机能看出来）。**如果发现回复是整段吐出而非逐字，先反馈——那是基础设施要解的问题，不要在前端做假打字机糊过去。**

---

## 七、需要一起拍板的

| 问题                                                    | 我的倾向                                                                                     |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 新路由命名、是否带底部导航                              | `/chat/[characterId]`，全屏无底部导航（与现在一致）                                          |
| 进入角色时自动打开最近会话，还是每次新建                | 默认新建会话；只有从历史聊天点进去才是恢复旧会话；同时保留显式"新建对话"入口                 |
| 要不要"停止生成"按钮                                    | 先不做。后端在客户端断开后仍会跑完并照常扣费，这个按钮只能是"前端停止渲染"，语义容易误导用户 |
| 重生成的交互形态（决策 6 定了不保留 swipe，没定新形态） | 最后一轮回复气泡的下方贴一个按钮，原地替换内容                                               |

UX / 视觉 / 文案归 PM；接口行为、契约变更、库迁移和 dev 环境找林术；ST 侧任何东西都不要碰，有疑问先问。
