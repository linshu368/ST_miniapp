---
module_id: frontend.business.character-lobby
title: 角色模块发现与收藏
scope: frontend
category: business
status: active
owners: [frontend]
last_verified_task: .trellis/tasks/10-23-experience-continuity/
last_verified_at: 2026-10-23
---

# 角色模块发现与收藏

## 职责与边界

负责角色模块「发现」栏目的角色卡、详情、推荐顺序、最新标记和收藏交互；「对话」栏目承载跨角色会话，图片生成由独立影像模块承载。

## 当前状态

全局底栏为「角色 / 剧场 / 中央首页 / 影像 / 我的」；角色模块保留 `/characters` 发现与 `/chats` 对话两个栏目。发现页只将「发现／对话」栏目和搜索放在固定顶部区域，推荐/最新/已收藏筛选随内容滚动，不显示占用空间的 ROLEPLAY/角色标题；接着聊卡片位于普通滚动内容区。收藏角色已从原聊天页迁入发现筛选，收藏状态仍只读取 React Query/favorite cache。

发现、详情和会话数据继续使用既有 Backend API。详情按角色读取有效会话，有记录时主操作继续已有对话，并单列新对话；无记录时开始对话；历史读取失败显示重试，不能推断成无记录后默认创建。接着聊只从现有接口返回的有效历史中按活动时间选择，不保证全局最后一段。

从角色卡进入聊天前记录同文档短生命周期返回快照，返回发现时恢复排序、搜索、收藏筛选、角色 ID 顺序摘要、锚点卡和滚动位置；快照读入组件 state 后立即清理共享存储，后续只使用本次挂载副本。模块间切换另保存栏目、发现条件和滚动标量，不保存服务端角色或收藏 DTO。

## 入口与调用者

主导航「角色」恢复当前浏览器会话中最后使用的发现/对话栏目；当前已在角色模块时再次点击底栏角色入口会回到当前栏目顶部。发现中的角色卡打开详情，再明确继续或新开对话；进入聊天时携带有限来源 `from=discover`。聊天顶部、Telegram BackButton 与 Splash 退出共同返回来源栏目；系统 history 返回继续使用发现快照恢复现场。

## 涉及文件

| 路径                                                     | 职责                         |
| -------------------------------------------------------- | ---------------------------- |
| `packages/frontend/src/app/(main)/characters/page.tsx`   | 角色发现页面                 |
| `packages/frontend/src/components/characters/`           | 大厅卡片、详情与返回快照接线 |
| `packages/frontend/src/components/roleplay/`             | 固定栏目与接着聊内容卡片     |
| `packages/frontend/src/components/chat/chat-top-bar.tsx` | 聊天顶部返回来源栏目         |
| `packages/frontend/src/components/nav/bottom-nav.tsx`    | 角色入口与最后栏目恢复       |
| `packages/frontend/src/lib/api/characters.ts`            | 角色 query                   |
| `packages/frontend/src/lib/api/favorites.ts`             | 收藏 query/mutation          |
| `packages/frontend/src/lib/lobby-return.ts`              | 发现返回快照 helper          |
| `packages/frontend/src/lib/roleplay-navigation.ts`       | 有限来源、发现条件与栏目位置 |

## 关键实现链路

发现条件 → lobby/character/favorite query → 筛选与卡片 → 详情读取该角色会话 → 明确继续已有会话或新建 → 写入一次性返回快照并携带有限来源 → 返回发现 → Gallery 初始条件读取并清理共享快照、跳过一次强制 mount refetch → layout effect 以锚点/邻卡/scrollY 恢复。无卡片快照时使用模块滚动标量；收藏筛选需等待收藏 ID 完成初次加载再恢复，避免短加载区提前夹断滚动位置。收藏 mutation 与缓存失效仍走 favorites 现有链路。

## 数据、契约与外部依赖

消费 shared 角色/收藏契约与 Backend。

## 关键节点与约束

组件不得直接 fetch；空态、错误重试和图片降级需明确。返回快照只能保存 UI 条件、角色 ID 顺序摘要和定位标量，不保存完整角色 DTO、收藏状态、initData、token 或聊天正文；快照损坏、过期、刷新后 document token 不匹配或 sessionStorage 不可用时安全降级。

## 验证方式

`pnpm --filter @miniapp/frontend typecheck && pnpm --filter @miniapp/frontend test && pnpm --filter @miniapp/frontend lint && pnpm --filter @miniapp/frontend build`；人工 smoke 需覆盖固定顶部与搜索/筛选、收藏加载/失败/取消收藏、继续/新建、顶部返回/Telegram 返回/Splash 退出/history 返回、锚点下架兜底、发现/对话及影像切回后的栏目与位置恢复。

## 已知缺口与待核验项

本轮为本地界面预览；示例服务只在 `/tmp`，不能代替真实 Backend、Telegram WebView 或生产数据验收。真实数据排序观感需上线环境观察。大厅当前仍非分页接口；返回快照保存已加载 ID 摘要以便后续 infinite query 分支复用，但本模块未新增后端分页。

## 关联模块

`backend.business.character-lobby`、`shared.business.character-lobby-contracts`。

## 变更记录

- 2026-10-23：任务 `10-23-roleplay-module-navigation` 将发现、对话和收藏归入角色模块，补齐显式续聊/新建及有限来源返回；本地预览与真实环境验收边界分别记录。

## 连续试卡体验（2026-10-23）

发现卡片对已加载的有效历史显示轻量「聊过」；message_count 不计虚拟开场白，仅用户发起的轮次触发标记，未命中不得解释为从未聊过。退出不等于负反馈，不自动隐藏/重排/删除卡片或会话。接着聊缩成紧凑入口，发现主内容继续用于找角色。可见返回发现/对话沿有限来源；原筛选与卡片锚点恢复继续保留。快速ready直接进入，等待结束后开屏计时器停止。

收藏所有入口共享按角色pending与防重复；不同角色允许并发，失败仅回滚对应角色，最后一笔完成再刷新；独立临时提示宿主避免取消收藏移除卡片时吞掉失败。

- 2026-10-27：短剧首页改为根路由后，发现页机械迁移至 `/characters`；顶部、Splash、取消进入、聊天返回及滚动记忆同步新地址，内部布局与接口不变。

## 角色互动（2026-10-29，本地待发布）

角色卡底部显示点赞/收藏/评论三个独立入口与公开数量，封面进入介绍，评论按钮直接进入详情弹层评论tab。聊天顶部的角色标题与评论入口打开同一弹层，不卸载聊天、不切换会话。收藏仍由原 favorites cache 作为用户状态源；新增 social cache 按用户隔离、批量最多40项，卡片不逐个请求。乐观更新与失败回滚只改对应字段，等待在途互动结束再刷新计数。

评论草稿按用户和角色仅保存在短期内存；提交UUID允许丢响应后重试，不复制私人聊天。评论纯文本、分页、作者删除、举报确认。面板可视视口适配，固定底部输入。复用 `@character-social` 手机验收，覆盖独立互动、同步、分页发删举报、失败与草稿、生成中的对话不中断。后端迁移在隔离数据库通过后仍需发布时执行，当前未修改线上。

卡片辅助信息减重：列表标签最多前两项、一行展示，完整标签留在详情；compact互动栏计数为0时只显示图标，有数量时配低对比数字，保留原ARIA名称与44px触区。
