# Task Breakdown

## Tasks

| ID  | Status | Task                                            | Files / Scope               | Verification                                         |
| --- | ------ | ----------------------------------------------- | --------------------------- | ---------------------------------------------------- |
| T1  | Done   | 实现 Android 导航安静窗口                       | frontend lib                | scheduler tests 通过                                 |
| T2  | Done   | 接入 BottomNav 与平台预热预算                   | nav/mobile policy           | policy tests + code review                           |
| T3  | Done   | 门控 Profile 公共次级读取                       | providers/profile           | typecheck + Android UI 9/10                          |
| T4  | Done   | 接入 ready/failed 结算                          | page-ready                  | existing + scheduler tests 通过                      |
| T5  | Done   | 执行全量适用验证                                | frontend                    | test/typecheck/lint/build 通过；范围外门禁阻断已记录 |
| T6  | Done   | 更新清单、模块事实与发布验收                    | docs/task/spec              | diff 与文档口径复核                                  |
| T7  | Done   | 固化推荐公共 hedge 并收紧 Android 目录 deadline | characters API              | policy/proxy/unit tests 通过                         |
| T8  | Done   | 复用 latest 公共缓存与 public head 持久降级     | proxy/characters            | cache 隔离与失败路径通过                             |
| T9  | Done   | 延后 Profile 非关键 chunk                       | profile                     | `@profile` 通过；route chunk 减少 19.8%              |
| T10 | Doing  | 完成第二阶段全量验证与生产发布门禁              | frontend/docs/observability | 本地门禁完成；待同 release 生产数据                  |

## Execution Log

- 2026-11-05：完成 Grafana 五入口 Android/iOS 7d 基线分析；用户明确要求开始处理优化。
- 2026-11-05：完成复用、可靠性、最小方案、演进恢复与移动端 P95 规划，待进入实现。
- 2026-11-05：完成 Android-only 导航安静窗口、4 秒兜底、单 route 后台预热和 Profile 次级读取门控；iOS/other 保持原调度。
- 2026-11-05：Frontend typecheck、63文件/712用例、lint、build 与定向14用例通过；Android UI 9/10通过，剩余 `/vip` 本地跳转超时单列风险。
- 2026-11-05：复杂度检查中本次 BottomNav/Profile 增长已消除，只剩范围外 `use-drama-scrub` 168行；模块知识检查被范围外 Admin 失效通配路径阻断。
- 2026-11-06：近72h Sentry/Railway 复核确认 Railway handler/容量不是主因；latest 后端公共缓存被同源代理丢弃。旧版自动推荐 1.5 秒中止已被 450ms 公共首屏 hedge 架构替代，定向验收确认硬中止会丢失迟到批次，因此保留有界后台完成。用户要求 Android WebView 专项把 `/characters` 与 `/profile` 稳定压到 2 秒内，启动第二阶段。Grafana MCP 因 OAuth 未授权，恢复前只能保留旧基线，不能完成发布验收或归档。
- 2026-11-06：第二阶段代码完成：Android 目录 1.8 秒 deadline、latest 60 秒公共缓存、公共 head 持久降级，以及 Profile 头像菜单/VIP/服务区次级 chunk。Profile 原始 route chunk 42481→34073 bytes（-19.8%）。Frontend typecheck、63 文件/715 用例、lint、build、复杂度和定向 11 用例通过。
- 2026-11-06：`@profile` 全量首轮 13/14，失败为本地冷编译下 `/vip` 导航未完成；对自动验收端口预热后该 Android+narrow 用例 2/2 通过。大厅两条回归首轮因 `/characters` 冷编译 35.6 秒导致文档请求被取消，预热同一服务后 2/2 通过，业务断言覆盖首 12 张、迟到个人批次缓存且不替换当前公共列表。
