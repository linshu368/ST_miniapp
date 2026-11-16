# MiniApp 冷启动专项优化与整改落实

基线窗口：**2026-11-14 00:00—2026-11-16 00:00，Asia/Shanghai，结束不包含**。实施日期：2026-11-16。本地候选，尚未发布。沿用原报告“结论 → 口径 → 分平台数据 → 原因 → 整改 → 验证与后续”的结构。

## 结论

- 主要冷启动瓶颈在 **文档到达、脚本与首屏请求链**。434 次页面停滞中 document 267 次（61.52%）；Android 会话/大厅文档停滞合计 228 次，占全部停滞 52.53%。不能把 Telegram SDK 同步初始化视为这些样本的主要耗时。
- 本次移除应用可控制的 `/` 307 文档跳转，改为 cookie 条件的内部 rewrite；使用原有静态页面和 HTML 框架。启动上下文捕获后，以 History API 规范路径，不再请求一次落地文档/RSC。
- 修复会话列表/分组首屏没有使用预留 critical 槽的问题。第一页 critical，后续分页 normal；没有提高总并发或改变超时/重试。
- 修复 `/api/v1/conversations/groups` 被归到 conversation_detail 的指标分类。发布前后详情 P95 的口径变化需隔离，不能算作“请求提速”。
- 现有 HTML early-ready、后台分波、延后 Replay/增长模块、详情动态加载继续复用；未重复添加“预加载所有资源”、凭据持久化、Service Worker 或动态 SSR。

## 口径与限制

1. 页面来自既有 Grafana Faro 生产 `engineering_v1`、成功 ready、foreground 的 document launch。API 表为 Sentry 独立的成功请求样本，不与页面样本相减或相加。
2. 下表是 **变更前基线**，不是本地优化后的成绩。尚无本次 release 的线上数据，优化后 P95 留空；N<100 仅为低样本线索。
3. 两个同次启动样本的 redirect 区间约 5.06s/4.84s，确认最终文档前存在等待，但没有证明全部由本项目 307 耗尽。减少一跳不等于固定省下5秒，剩余 CDN、网络、宿主和脚本长尾需发布后继续验证。
4. HTML 框架可展示、Telegram ready 和完整数据可用是三个时刻；不能提前 content-ready 或降低统计范围来“达标”。

## 冷启动分平台基线

| 页面          | Android P95秒 / N |       iOS P95秒 / N | 第一阶段目标 | 本次发布后实测 |
| ------------- | ----------------: | ------------------: | -----------: | -------------- |
| `/chats`      |        8.28 / 436 | 6.15 / 81（低样本） |         ≤4秒 | —（尚未发布）  |
| `/characters` |        7.96 / 293 | 7.10 / 77（低样本） |         ≤4秒 | —（尚未发布）  |

| API                                | Android P95秒 / N | iOS P95秒 / N | 目标 |
| ---------------------------------- | ----------------: | ------------: | ---: |
| `GET /api/v1/conversations/groups` |       3.21 / 1360 |    3.18 / 189 | ≤2秒 |
| `GET /api/v1/conversations`        |       1.99 / 3736 |    2.01 / 482 | ≤2秒 |
| `GET /api/lobby-characters`        |       3.15 / 1398 |    5.89 / 270 | ≤2秒 |

上表数值四舍五入；精确值、查询与数据边界见 [周末分析](analysis-and-remediation-2026-11-14-15.md)、[周末统计](report-2026-11-14-15.md) 及其脱敏 evidence。本次没有用新窗口替换原基线。

## 原因与对应改动

### 入口与首次文档

原链路：`/` → HTTP307 → `/chats` 或 `/characters` → HTML/CSS/JS → SDK → 列表。

候选链路：`/` → cookie rewrite 直接返回原静态 HTML → 框架可展示/early-ready → SDK 捕获参数 → 原生 History 同步规范路径 → 列表。两条 rewrite 使用互斥 has/missing 条件，错误/缺少 cookie 回大厅；它只选择公开 shell，私人数据仍在鉴权后读取。

不能只替换 redirects 配置：rewrite 下浏览器最初为 `/`，服务端路由树已是目的页。Providers 用真实 layout segments 解析两种入口，维持 SSR/初次 hydration 的同一框架；HTML 脚本从该有限路径标记识别 root shell。SDK 保存启动身份、邀请/支付参数并清理敏感 URL 后，等 Next 初始化 effect 结束才更新地址，业务等待 pathname 同步。

Next14 传入带 `__NA` 的旧 history.state 会绕过 Router 同步，因此采用官方的 `replaceState(null, ...)` 入口，由 Next 自己复制内部状态。History 被限制时保留内存身份并走 SPA fallback；不重载已清理凭据的 URL。

### 首屏请求排队

调度总槽是3，普通/后台最多2，保留1个给关键请求。原 `conversation-folders.ts` 列表和分组 query 仅传 signal，带 query 的 URL 没有匹配详情 critical 推断，因而可能排在普通任务后。

两个可见查询的第一页显式 critical，后续页 normal；enabled 仍由当前视图控制。没有全局提高 conversations 家族优先级，没有加请求、并发或重试，也未修改响应契约。复用真实 React Query hooks 和既有队列测试验证第一页、翻页与取消。

### 脚本与资源

源码审计确认详情、增长、归因、Replay 已有动态加载/首屏分波；lucide 也在 Next14 默认 import 优化列表中。重复添加配置不能证明收益。本轮优先修复已有证据的跳转和排队，不把关键列表拆成新的串行动态 chunk。

为遵守复杂度约束，将原有 Faro 有限名称/字段表原样抽至 `grafana-schema.ts`，将 HTML native notify 独立序列化；出口和桥接仍各一套，grafana 主文件低于500行，启动函数低于120行。这是维护性调整，不宣传为 bundle 或线上速度收益。

生产构建审计：Next报告 First Load JS 为 `/characters` 276kB、`/chats` 289kB，共享199kB；根入口HTML分别引用27/28个静态script，独立gzip估算合计371727/384468 B。两种统计范围不同，不能相加或当成真实传输量，也没有同源变更前构建可声称体积下降。说明脚本长尾仍应继续按具体chunk与同次启动诊断跟踪。审计及五轮cookie分流结果见 [构建记录](../11-16-miniapp-cold-start-optimization/build-observation.json)。

## GitHub / 官方实践与采用结果

| 实践                                      | 本次采用情况                                                     | 来源                                                                                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 减少可控制的同源初始文档跳转              | 内部 rewrite 返回既有静态页                                      | [web.dev TTFB](https://web.dev/articles/optimize-ttfb)、[Next14 rewrites](https://nextjs.org/docs/14/app/api-reference/next-config-js/rewrites)                                                                         |
| 通过原生 History 同步 URL，避免额外 fetch | 仅用于已 rewrite 到同一页面的 root 规范化；不替换常规跨页导航    | [Next14 History](https://nextjs.org/docs/14/app/building-your-application/routing/linking-and-navigating#using-the-native-history-api)、[GitHub #48110 维护者答复](https://github.com/vercel/next.js/discussions/48110) |
| 处理 rewrite 的 pathname/hydration 差异   | 基于实际路由树呈现初始框架，参数捕获后同步 URL                   | [usePathname 注意事项](https://nextjs.org/docs/app/api-reference/functions/use-pathname)、[Next14 layout segments](https://nextjs.org/docs/14/app/api-reference/functions/use-selected-layout-segments)                 |
| 基本界面加载后尽早 ready                  | 扩展已有 HTML early-ready 到 root alias，继续验证可见性/通知去重 | [Telegram 官方 Mini Apps](https://core.telegram.org/bots/webapps)                                                                                                                                                       |
| 可选模块按需加载、控制首屏工作            | 复用现有分波和动态加载；不重复优化默认 lucide 配置               | [Next14 lazy loading](https://nextjs.org/docs/14/app/building-your-application/optimizing/lazy-loading)、[import 优化](https://nextjs.org/docs/14/app/api-reference/next-config-js/optimizePackageImports)              |

完整调研与拒绝方案见 [research.md](../11-16-miniapp-cold-start-optimization/research.md)。论坛检索结果只作线索，实施以官方说明、项目维护者答复与本仓库实测为准。

## 验证记录

最终执行结果集中记录于 [verification.md](../11-16-miniapp-cold-start-optimization/verification.md)。本地 UI 使用真实页面与独立3130/3131虚构接口；不能替代生产网络、原生 Telegram 或真实支付验收。

## 调整与后续整改

1. **本次候选发布**：先验证 `/` 无/有/错误 cookie 连续交替访问的实际 CDN 返回、缓存与状态；核对两种落地页、query/hash、邀请、支付回跳、刷新和返回。单独发布前端候选，不需要数据库或后端迁移。
2. **至少24小时真实观测**：同 route/platform/release/source，分别看 document content-ready、shell-ready、API queue/headers/body、started/terminal/stall/left 和错误率；每组成功 N≥100，iOS不足延长48–72小时。groups 单独建组，历史 detail 混有 groups，不能直接比较。
3. **若仍大于4秒**：基于同次启动的 redirect/pre-fetch/request-wait、脚本并集与长任务继续定位。首次文档仍慢才查边缘缓存/区域/宿主入口，JS仍慢才依据具体 chunk 分析；不凭独立 P95 相减决定迁移托管或删除监控。
4. **API服务端长尾另项整改**：分组 summary 的可选依赖隔离、详情/identity/DB 超时归因沿用原周末方案，需要各自规划和验证。本轮请求优先级调整不等于修复了后端500、RPC超时或计费异常。
5. **停止与回滚**：发现错页、hydration、签名身份/支付回跳异常、错误率升高或同平台 P95 回退即停止推广，回滚本次前端版本。没有数据迁移或私人缓存需要清除；保留新旧 release 的口径边界与失败样本。

固定本地验收已扩展现有 `@startup` 与 fixture，后续可反复使用；真实 Android/iOS Telegram 弱网、冷缓存、后台恢复以及支付供应商回跳仍需发布流程专项验收。
