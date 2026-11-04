# Design

## 方案

- 视频流页面从 `app/(main)/page.tsx` 移到 `app/(main)/watch/page.tsx`，组件 `DramaHome` 不变。
- `next.config.mjs` 增加 `redirects()`：`/` → `/characters`，`permanent: false`（307，避免浏览器缓存 308 后无法回改）。Next 默认透传 query；fragment 由浏览器按 Fetch 规范在跳转后保留，Telegram 的 `tgWebAppData` 在 hash 中。
- 代码中把「视频流 = `/`」的字面量统一改为 `/watch`：主布局沉浸播放判断、底栏、预取、启动骨架、early-startup HTML 框架、路由查询隔离、短剧计时/媒体/页面埋点、短剧库与详情页的回首页链接。
- 底栏 `NAV_ITEMS` 改为 放映(`/watch`) | 剧场(`/dramas`) | 秘境(`/characters`，中央) | 创作(`/creation`) | 我的(`/profile`)。
- 视觉：`<nav>` 仍是全宽 66px 带（`--app-nav-height` 与各页留白不变），内部放悬浮圆角岛；岛外铺静态渐隐，不用 backdrop-blur。选中光底只动 transform/opacity；中央 50px 星芒圆钮固定行高底对齐后向上溢出。有底部安全区时岛下沉最多 16px，避免 iOS 离 Home 条过远。图标为 `nav-icons.tsx` 一套 24 网格细线图标。

## 复用

复用现有 `DramaHome`、`CharacterGallery`、`BottomNavShell`、`EntryShell`（已有 `/characters` 骨架 `LobbyShellSkeleton`）和 early-startup 对 `/characters` 的 HTML 框架，不新增状态源；仅新增 `nav-icons.tsx` 放底栏图标。

## 契约与发布顺序

短剧计时报告的 `route` 枚举（`packages/shared/src/api/drama-timing.ts`）加入 `/watch`，同时保留 `/`：后端用它校验 `POST /api/telemetry/drama-timing`。前端（Vercel）若先于后端（Railway）上线，新报告会被拒到后端部署完成，影响仅限计时遥测；保留 `/` 让未刷新的旧客户端报告继续有效，避免 Cloudflare AB 期间丢样本。

## 拒绝的做法

- 客户端 `router.replace('/characters')`：冷启动会先下载并挂视频流 chunk、先发 `/api/dramas`，再二次导航，比现在更慢。
- `/` 直接渲染大厅（与 `/characters` 双路由）：底栏高亮、角色/聊天记忆、返回逻辑都要同时认 `/` 和 `/characters`，增加分支。
- middleware rewrite：`usePathname` 仍是 `/`，同样要双路由判断。
- 只改 BotFather 地址：行为在仓库外，无法审查与回归。

## 可靠性 / 性能

- 多一次 307：Vercel 在边缘处理 next.config redirects，开销为一次到边缘的往返；冷启动 page.ready 从导航起点计时，跳转时间已计入，可直接用 P95 观察。上线后可选把 BotFather Mini App 地址改成 `/characters` 去掉这次跳转（非必须）。
- 冷启动关键请求从 `/api/dramas` + 视频首帧变为角色大厅首屏（推荐/目录），后者近 7 天 SPA P95 安卓 2375ms、iOS 2112ms，不比当前视频流冷启动差。
- 回滚：revert 本 PR 即恢复 `/` 为视频流；无数据与接口变化。

## 观测

- 页面埋点路由 `/` → `/watch`；短剧计时 `route` 字段同步。`docs/grafana/st-five-route-navigation-ready.json` 路由正则加入 `/watch`（保留 `/` 以便对比历史）。线上 Grafana 看板在发布后同步。
