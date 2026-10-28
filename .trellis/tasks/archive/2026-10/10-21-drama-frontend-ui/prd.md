# 短剧前端列表/播放页与底部导航

> 方案来源：`docs/短剧视频接入方案.md` §3、§5.4、§6；父任务 `10-21-drama-video-integration`。
> **依赖**：子任务 `10-21-drama-api-contract-backend` 验收通过（`GET /api/dramas`、`GET /api/dramas/:id` 在 test 环境已用真实数据联调通）之后才能开始接真实接口；页面结构/占位态可以先用 mock 数据切 UI 并行推进，但最终验收必须接真实接口。

## Background

`drama_archive`（test 库）已有真实归档数据，backend 契约和接口已就绪（或即将就绪），现在需要在前端新增一个短剧入口，让用户能刷到短剧列表并点开播放。现有底部导航固定 4 个 tab（大厅/聊天/创作/我的），没有短剧位置；现有仓库里没有私有桶现签播放链接的前端消费先例。

原型视觉参考 `https://shunying-ai-drama.bagproectvwjo.chatgpt.site/`——方案文档写作时该链接抓取失败（WebFetch 503），细节结构需要用户后续补充截图/描述或重新抓取；本任务框架先定下来，视觉细节可以和功能联调并行推进，不阻塞功能本身。

## Goal

1. `components/nav` 从 4 列扩到 5 列，新增"短剧"入口。
2. `lib/api/drama.ts`：`useDramaListQuery()` / `useDramaDetailQuery(id)`，React Query hooks，不在组件里直接 fetch。
3. `app/(main)/dramas/page.tsx`：列表页，卡片展示标题 + 标签占位态 + 简介占位态。
4. `app/(main)/dramas/[id]/page.tsx`：播放页，原生 `<video>` 播放 `play_url`，`playable=false` 时给出"暂不可播放"提示。
5. 跑通父任务 §6 的全部 MVP 验收标准中涉及前端的部分（见下方 Acceptance Criteria）。

## Non-Goals

- 不做搜索、筛选、分页优化、多集/剧集导航、埋点、大厅推荐排序接入。
- 不重做现有 4 个 tab 的视觉或交互，只新增第 5 个。
- 原型视觉细节未确认前，先用方案文档描述的信息密度（标题/标签占位/简介占位）做最小可用 UI，不臆造原型没有验证过的具体样式；视觉精修可以后补，不阻塞功能验收。
- 不实现生产环境发布相关配置。

## Constraints（硬性规则）

- 服务端数据必须通过 `src/lib/api/` 的 React Query hooks 获取，业务组件不得直接 `fetch`，不得用 `useEffect` 取服务端数据。
- 对外 DTO 来自 `@miniapp/shared`（`DramaSummary`/`VideoItem`/`DramaDetail`），不得使用数据库行类型或重新定义一份本地类型。
- 关键交互必须覆盖 loading/error/empty/disabled/success 和移动端安全区——尤其是：
  - 列表为空（test 库暂无已归档数据）时的 empty 态；
  - 标签/简介为空时的占位态（不是空白、不是报错）；
  - 视频 `playable=false` 时的明确提示（不是静默失败、不是空白播放器）；
  - 播放页加载中/加载失败（签名链接过期或网络问题）的 loading/error 态。
- 未经需求明确，不重做 UX、文案、布局或视觉；原型细节未确认部分先用朴素占位实现，不展开臆测设计。
- 样式用 Tailwind 和现有 shadcn/Radix 组件，不新增 CSS/SCSS 文件，不引入新的 UI 库。
- `BottomNav` 已经是 `grid-cols-4` 的固定布局和 `NAV_ITEMS`/`HIDDEN_PREFIXES` 常量驱动，改动方式是扩展这两个常量和把 `grid-cols-4` 改成 `grid-cols-5`，不是重写整个组件。

## Acceptance Criteria（对应父任务 §6 MVP 验收标准中与前端相关的条目）

- [ ] 底部导航出现第 5 个"短剧" tab，点击可进入列表页；其余 4 个 tab 的现有行为（高亮、预取、未读红点）不受影响。
- [ ] 列表页展示至少几条真实（test 库里已归档、`upload` 成功的）短剧标题，无崩溃；`pnpm --filter @miniapp/frontend typecheck` / `lint` / `build` 通过。
- [ ] 标签/简介为空时，UI 是占位态（例如"标签生成中"/"简介整理中"）而不是空白或报错。
- [ ] 点击进入播放页，视频能正常加载播放（签名链接有效期内，用真实 test 环境数据实测，不只是 mock）。
- [ ] 某条视频不可播（`playable=false`）时，列表/详情有明确提示，不是静默失败。
- [ ] 列表为空（没有任何已归档短剧可展示）时有合理的 empty 态，不是空白页或报错。
- [ ] 全程检查不出现把 backend 内部字段（如果契约层不小心泄露）透传到 UI 的情况；前端始终只消费 `@miniapp/shared` 的 `DramaSummary`/`VideoItem`/`DramaDetail` 类型。
- [ ] 移动端安全区、Telegram WebView 和常规移动浏览器下人工验证页面可用（不需要窄屏/软键盘/reduced motion 全覆盖，但至少跑一遍基本可用性）。

## Open Issue（记录，不阻塞本任务）

原型 `https://shunying-ai-drama.bagproectvwjo.chatgpt.site/` 的视觉细节尚未成功抓取/确认。本任务先按最小占位实现完成功能闭环；视觉精修留待用户提供截图/描述后补做，不作为本任务验收条件。
