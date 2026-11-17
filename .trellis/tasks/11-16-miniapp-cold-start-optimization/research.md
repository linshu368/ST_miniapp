# 冷启动方案调研（2026-11-16）

## 现场证据

来源：相邻 `11-12-overnight-page-performance/analysis-and-remediation-2026-11-14-15.md` 与其脱敏 evidence。434 次 ≥4 秒停滞中 document 267 次；Android `/chats` 和 `/characters` 文档停滞合计 228 次。两个同次启动样本存在约 4.8/5.1 秒重定向区间，但尚不能证明全部区间由本项目 307 产生，也不能承诺移除后固定节省 5 秒。

现代码：Next14 根路径按 st_landing cookie 307；Providers 等 SDK 同步初始化后挂业务；HTML early-ready 已存在；调度总槽 3、普通槽最多 2，但会话列表/分组第一页未显式 critical。大厅和背景模块已分波、详情已动态加载；不重复建设。

## 一手来源与采用判断

| 来源                                                                                                                                       | 结论与本项目处理                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [web.dev：Optimize TTFB](https://web.dev/articles/optimize-ttfb)                                                                           | 建议减少可控制的同源文档跳转。采用内部 rewrite，仍需真实环境复验边缘/CDN/Telegram 上游跳转。                                                                                     |
| [Next14 rewrites](https://nextjs.org/docs/14/app/api-reference/next-config-js/rewrites)                                                    | 可按 cookie 匹配并代理现有静态路由，URL 不变。采用 beforeFiles，明确互斥 has/missing，避免后续规则覆盖；不引入动态 SSR 或 Middleware 网络依赖。                                  |
| [Next14 History API](https://nextjs.org/docs/14/app/building-your-application/routing/linking-and-navigating#using-the-native-history-api) | replaceState 可以同步 Router 且无需重新请求。用于启动参数捕获后的规范路径更新，复用既有敏感 URL 清理顺序。                                                                       |
| [GitHub #48110，维护者答复](https://github.com/vercel/next.js/discussions/48110)                                                           | 维护者确认原生 History 集成保持 Router 状态、避免额外服务端 fetch。实际版本仍以本仓库 Next14 回归为准；不能把任意跨页面跳转都改成 History API。此处服务端已 rewrite 到同一页面。 |
| [Next usePathname rewrite 注意事项](https://nextjs.org/docs/app/api-reference/functions/use-pathname)                                      | rewrite 下浏览器与服务端路径可能不同，不能直接替换配置而忽略 hydration。Providers 仅针对 `/` 从真实 layout segments 识别内部目的地；业务接管前完成规范 URL 更新。                |
| [Next14 useSelectedLayoutSegments](https://nextjs.org/docs/14/app/api-reference/functions/use-selected-layout-segments)                    | 读取当前实际路由树，包含 route group；只过滤 route group，且仅识别已有 chats/characters 两个静态入口。                                                                           |
| [Telegram Mini Apps ready](https://core.telegram.org/bots/webapps#initializing-mini-apps)                                                  | 基本界面可展示时尽早 ready。复用已验证 HTML shell/native transport，扩展 root alias；不提前发空页面 ready。                                                                      |
| [Telegram launch parameters 源码文档](https://github.com/Telegram-Mini-Apps/tma.js/blob/master/apps/docs/platform/launch-parameters.md)    | 参数在 hash，必须保护启动上下文。本项目只在内存捕获身份；不照搬持久化凭据方案。                                                                                                  |
| [Next14 lazy loading](https://nextjs.org/docs/14/app/building-your-application/optimizing/lazy-loading)                                    | 用于可选 UI。现有详情、增长、Replay 已延后；先审计产物，拒绝把关键列表延后为新的串行 chunk 瀑布。                                                                                |
| [Next14 optimizePackageImports](https://nextjs.org/docs/14/app/api-reference/next-config-js/optimizePackageImports)                        | lucide 已默认优化，重复添加配置没有证据收益；不升级框架、不新增缓存库/Service Worker。                                                                                           |

已检索 GitHub、官方 SDK 文档和论坛结果。论坛匿名经验只作线索，实施依据使用官方文档及原项目维护者答复；不采用“关闭监控/永久缓存 HTML/缓存 initData/无限预加载”等方案。
