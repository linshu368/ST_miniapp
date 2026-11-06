---
module_id: frontend.business.character-lobby
title: 角色模块发现与收藏
scope: frontend
category: business
status: active
owners: [frontend]
last_verified_task: .trellis/tasks/11-05-optimize-android-navigation-tail/
last_verified_at: 2026-11-06
---

# 角色模块发现与收藏

## 职责与边界

负责角色模块「发现」栏目的角色卡、详情、推荐顺序、最新标记和收藏交互；「对话」栏目承载跨角色会话，图片生成由独立影像模块承载。

## 当前状态

全局底栏为「角色 / 剧场 / 中央首页 / 影像 / 我的」；角色模块保留 `/characters` 发现与 `/chats` 对话两个栏目。发现页只将「发现／对话」栏目和搜索放在固定顶部区域，推荐/最新/已收藏筛选随内容滚动，不显示占用空间的 ROLEPLAY/角色标题；接着聊卡片位于普通滚动内容区。收藏角色已从原聊天页迁入发现筛选，收藏状态仍只读取 React Query/favorite cache。

发现、详情和会话数据继续使用既有 Backend API。详情按角色读取有效会话，有记录时主操作继续已有对话，并单列新对话；无记录时开始对话；历史读取失败显示重试，不能推断成无记录后默认创建。接着聊只从现有接口返回的有效历史中按活动时间选择，不保证全局最后一段。

首次且没有已保存发现条件时默认展示「最新」；用户主动选择的推荐/最新仍在当前浏览器会话内保留。从角色卡进入聊天前记录同文档短生命周期返回快照，返回发现时恢复排序、搜索、收藏筛选、角色 ID 顺序摘要、锚点卡和滚动位置；快照读入组件 state 后立即清理共享存储，后续只使用本次挂载副本。模块间切换另保存栏目、发现条件和滚动标量，不保存服务端角色或收藏 DTO。

BottomNav 对角色入口只在明确 hover/focus/touch intent 时按当前发现条件预取角色 query，复用同一 query key、超时和在途去重；Android route chunk 优先角色后个人页，iOS 优先个人页后角色。预取失败不阻止导航，页面原 loading/error/retry 仍是降级路径。

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

Android/iOS 角色列表首批均限制为4张卡；Android 首图高优先级且平台识别后仅首图 eager，iOS 保留前2图 eager。水合兜底同样只挂4张，避免移动端缓存命中时先挂6张。已有缓存时优先等待首图结算，异常兜底刷新分别延后至 Android 3秒、iOS 2.5秒，避免后台校准请求竞争前2秒关键窗口；图片正常结算后仍立即允许刷新。生产关键视觉 P95 的2秒目标必须按发布 release、Android/iOS、cache/fetch 和 mount/spa 分组复验，低于100个有效终态只标低样本，不得以本地 fixture 宣称达标。

当前路由的会话史、角色社交批量和最新角标还需等待首张关键图成功、失败、无图或移动端兜底超时；应用级 entry-phase 在 SPA 导航后可能已经放行，不能单独作为大厅首屏门槛。视觉兜底必须记录 `page.critical_visual` timeout 终态。推荐自动 open 的入场读取使用1.5秒有限预算并沿既有目录/保存批次降级，用户明确触发的换批与撤回仍保留5秒预算且不自动重试。

## 关联模块

`backend.business.character-lobby`、`shared.business.character-lobby-contracts`。

## 变更记录

- 2026-10-23：任务 `10-23-roleplay-module-navigation` 将发现、对话和收藏归入角色模块，补齐显式续聊/新建及有限来源返回；本地预览与真实环境验收边界分别记录。
- 2026-11-03：任务 `大厅默认最新与移动端 P95 优化`（`.trellis/tasks/archive/2026-11/11-03-latest-lobby-mobile-p95/`）角色大厅新会话默认最新，并收紧 Android/iOS 首屏卡片与缓存重校准预算；commit：未记录。
- 2026-11-04：任务 `Optimize five-route mobile navigation readiness`（`.trellis/tasks/11-03-five-route-navigation-p95/`）增加角色入口显式 intent query 预取和五路由统一 ready 观测；2 秒目标仍以发布后生产样本为准。
- 2026-11-04：同任务二阶段将会话史、社交计数和角标后置到当前路由关键视觉结算，并为自动推荐读取增加快速降级；手动换批语义不变。
- 2026-11-06：任务 `治理 Android 五入口公共导航长尾`（`.trellis/tasks/11-05-optimize-android-navigation-tail/`）将 Android 目录 deadline 收紧为 1.8 秒，补齐 latest 代理公共缓存、公共首屏持久降级，并保留 450ms hedge 后迟到个人批次的有界完成与下次复用。

## 连续试卡体验（2026-10-23）

发现卡片对已加载的有效历史显示轻量「聊过」；message_count 不计虚拟开场白，仅用户发起的轮次触发标记，未命中不得解释为从未聊过。退出不等于负反馈，不自动隐藏/重排/删除卡片或会话。接着聊缩成紧凑入口，发现主内容继续用于找角色。可见返回发现/对话沿有限来源；原筛选与卡片锚点恢复继续保留。快速ready直接进入，等待结束后开屏计时器停止。

收藏所有入口共享按角色pending与防重复；不同角色允许并发，失败仅回滚对应角色，最后一笔完成再刷新；独立临时提示宿主避免取消收藏移除卡片时吞掉失败。

- 2026-10-27：短剧首页改为根路由后，发现页机械迁移至 `/characters`；顶部、Splash、取消进入、聊天返回及滚动记忆同步新地址，内部布局与接口不变。

## 角色互动（2026-10-29，本地待发布）

角色卡底部显示点赞/收藏/评论三个独立入口与公开数量，封面进入介绍，评论按钮直接进入详情弹层评论tab。聊天顶部的角色标题与评论入口打开同一弹层，不卸载聊天、不切换会话。收藏仍由原 favorites cache 作为用户状态源；新增 social cache 按用户隔离、批量最多40项，卡片不逐个请求。乐观更新与失败回滚只改对应字段，等待在途互动结束再刷新计数。

评论草稿按用户和角色仅保存在短期内存；提交UUID允许丢响应后重试，不复制私人聊天。评论纯文本、分页、作者删除、举报确认。面板可视视口适配，固定底部输入。复用 `@character-social` 手机验收，覆盖独立互动、同步、分页发删举报、失败与草稿、生成中的对话不中断。后端迁移在隔离数据库通过后仍需发布时执行，当前未修改线上。

卡片辅助信息减重：列表标签最多前两项、一行展示，完整标签留在详情；compact互动栏计数为0时只显示图标，有数量时配低对比数字，保留原ARIA名称与44px触区。

## 前几屏优质轮换（2026-11-02，本地未发布）

全体用户推荐行44px换一批、8秒撤回，无需启用开关或灰度；失败保旧且UUID重试；私有批次query/storage及发现筛选/返回snapshot按用户隔离。新文档或离开页面30分钟后open，24h由后端判定，聊天显式resume；同文档一直停在页面不定时洗牌。只按server ID投影，缺头部资料先校准公共目录再应用新批，失败保旧。曝光50%连续1秒，排除遮挡/后台/搜索/最新/恢复，600ms合并。撤回只有返回目标批才显示成功。packages/ui-tests @lobby-rotation为固定验收入口。

## 创作数据（2026-11-02，本地待发布）

从我的创作中暖金色「创作数据」入口进入 /creation/data，隐藏底栏。五块保持收益/使用、互动深度、作品表现、奖励记录、公开反馈的顺序；首页每类3条，全部面板4条分页，选卡8条，进入单卡再回总览保留来源页。通过lib/api/creator-analytics.ts读取本人真实契约数据，empty/error/loading明确，错误不替换为0。当前获赞/收藏不冒充周期增量；周期无评论文案区别从未有评论。Backend未就绪不回退虚构示例；固定样本仅在ui-tests fixture服务。

### 心愿墙（本地候选）

大厅搜索框右侧提供独立的「许个愿」入口，首屏可见并随搜索栏固定，与下一行的换一批分开；搜索空态保留直接输入入口。创作数据作品表现后与我的创作空态链接同一 /wishes 页面；不要给主导航新增独立槽位。只支持匿名公开，提交前明确所有人可见、不展示昵称头像。心愿来源独立保存在本地草稿元信息 sourceWishId，不得塞进 CharacterDraft 或system prompt。发布成功关联失败仍保留已发布结果，独立重试回应；原心愿不可用时允许返回我的创作。复用 @wishes 固定场景验收，入口不提前请求新API。

## 推荐首屏与试聊返回

推荐优先复用同账号批次和原卡锚点。冷首屏获取最多12张摘要，个人批次超过 450ms 时并行展示公共优质首屏，当次浏览保持已展示顺序；迟到的个人批次允许在原 5 秒有限预算内完成并只写入下次可复用缓存，不能替换当前公共列表。继续浏览尾部和搜索才读取完整目录。

Android/Android X 的角色目录请求使用 1.8 秒全阶段 deadline，iOS/other 保留 20 秒；timeout 不叠加 React Query 重试。无 selection 的 `latest` 成功响应允许复用 Backend 的 60 秒公共缓存头，同源代理只对白名单成功响应透传；推荐、指定 ID、失败响应仍强制 `no-store`。无 selection 的公共推荐首屏另存独立短期 localStorage 快照，损坏、过期或不可写时退回网络，不与个人批次缓存混用。

角色详情封面可点开全屏看完整原图，支持缩放、平移和退回原详情。
