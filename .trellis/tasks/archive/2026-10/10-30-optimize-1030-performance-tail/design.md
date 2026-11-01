# 技术设计：Telegram Android 共享加载长尾优化

## 1. 证据与边界

- 30 日 `/characters`、`/profile`、studio 的长尾集中在 Telegram Android；普通业务 API 多为亚秒级，Railway 无 CPU/内存压力，故本轮不继续改后端查询或扩容。
- 当前分支 `da70a3a3` 已完成首轮页面/API 优化，并通过 frontend build、64 files/683 tests、backend 110 files/1128 tests 和定向 UI 验收；重复修改会增加回归风险。
- 初始候选认为 Query Devtools 可能进入根 layout；实际 production build 证明该包导出的是 260B `null` stub，动态导入没有移走真实实现，反而增加 loader，因此保持静态 import。
- BottomNav 的注释要求不在大厅空闲预取其它 tab，但 `prefetch={!onNavigate || isHeavyRoute ? false : undefined}` 会让 `/characters`、`/profile` 等非重路由恢复 Next Link 默认的视口自动预取。底栏常驻意味着冷启动后可能下载非目标 RSC/route chunk。
- Profile 的 `CommunitySheet` 默认关闭，却静态引入 Radix Sheet 和社群验证 UI；符合现有“默认关闭重面板按需加载”的模块规范。

## 2. 复用调研

- 组件：复用 `BottomNavShell`、`CommunitySheet`、现有 Sheet/按钮，不新建表现组件。
- Hooks：复用 `useCommunityEntryQuery`、`useVerifyCommunityMembershipMutation` 和现有 React Query cache；动态挂载不建立第二份状态。
- Helpers：复用 Next `dynamic()`、`router.prefetch`、`canPrefetchHeavyRoute`；不增加自制 loader、Service Worker 或 prefetch manager。
- Contracts/API：不改 shared DTO、API client、query keys 和 Backend route。
- 上一轮优化：保留 `CharacterCard` 图片优先级、wallet critical、image config 预热、EpisodeSheet dynamic、chat preparation 并行及 rich reply diagnosis 异步。
- 不复用/不新增：不改 request-concurrency 全局槽位，不加缓存或依赖，不触碰 generation/计费/恢复链路。

## 3. 最小充分方案

1. BottomNav 所有 Link 统一 `prefetch={false}`，只由现有 mouse enter、focus、touch start 的明确意图调用 `router.prefetch`；重路由继续检查 `saveData/effectiveType`。
2. Profile 用 dynamic import 加载 `CommunitySheet`；增加“曾打开”标记，首次点击时挂载，之后保持挂载以保留关闭动画和局部 mutation 状态。
3. Query Devtools 保持现状；将“production null export”记录为被证据拒绝的候选，避免无收益改造。

拒绝的过度设计：不拆整个 Providers、不改变 Telegram ready 时机、不预加载全部 tab、不增加网络自适应框架、不改模型输出长度或流式截止。

## 4. 可靠性设计

| 维度      | 设计                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------- |
| 超时      | 无新增外部调用；导航仍由 Next 处理，dynamic chunk 使用框架默认错误边界。                           |
| 重试      | 不新增重试；路由预取失败后用户点击仍走正常导航。                                                   |
| 幂等/并发 | `router.prefetch` 仍由 Next 去重；社群 mutation 沿 React Query，Sheet 首次挂载标记只影响代码加载。 |
| 事务/补偿 | 无写入语义变化；不适用。                                                                           |
| 降级      | CommunitySheet chunk 失败不影响 Profile 钱包/签到/VIP 主页面；Devtools 生产行为不变。              |
| 限流/容量 | 减少冷启动下载，不增加请求或轮询。                                                                 |
| 可观测性  | 沿用 Sentry navigation/startup 和 build route size；不增加用户标识或正文。                         |

## 5. 演进与恢复

- 无契约、数据库、配置和依赖变更，可独立部署/回滚 Frontend。
- 发布后同一 release 先观察 2 小时 chunk load error 和页面错误率，再收集至少 24 小时 Telegram Android P50/P95。
- 若主导航首次点击失败或明显更慢，恢复目标 Link 的默认 prefetch；若社群 Sheet 首次打开失败，恢复静态 import。
- 高频发布会干扰冷缓存比较，验证窗口内应保持版本稳定。

## 6. 可验证性与测试必要性

- 不新增测试文件：改动是框架加载策略，扩展现有 `@navigation` 场景覆盖社群 Sheet 首次打开/关闭；其余由 typecheck/lint/build 与固定 UI 场景验证。
- 构建前基线来自同一 HEAD 的上一轮验证：共享 First Load JS 约 192 KB；本轮 build 记录新的 route table，并检查 Devtools 不在根初始加载链。
- 手工/固定场景：五个底栏入口首次点击与返回、角色滚动恢复、Profile 社群首次打开/关闭/重开、窄屏；运行 `@roleplay`、`@profile`，必要时定向 `@drama`。
- 失败路径：弱网重路由不主动 prefetch、dynamic chunk 失败由页面错误边界承接；生产真机和 CDN cache 只能发布后验证。
