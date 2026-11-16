# 执行与验收计划

1. 完成调研、规划审查与 mobile/logging/module 元数据，通过 task.py start 后改产品代码。
2. 实现根路径内部 rewrite；复用 landing helper 解析真实路由树、保护启动参数后更新规范 URL；让 HTML early-ready 支持根入口。
3. 为可见会话第一页增加显式 critical，分页保持 normal；修正 groups 指标分类与白名单。
4. 扩展既有 launch-url、API priority/timing、page-tracker 及 roleplay.spec 场景：有/无/无效 cookie、阻塞/恢复 JS、无 hydration、无第二文档/RSC、邀请/支付/深链、刷新和前进后退、冷启动原始时钟、失败恢复。用真实 hooks/队列检查第一页可占预留槽、分页不能抢槽、取消不再 dispatch。
5. 跑 frontend typecheck/test/lint/build、lint:complexity、日志规划门禁、相关 UI @startup/@navigation/@chats/@roleplay 和 API fixtures 检查。Next Windows 重复 build 前验证并移动 standalone 到仓库 output/build-snapshots，不递归删除 junction。
6. 同步 README/ARCHITECTURE、现行路由/性能 spec 和原位置专项 Markdown：机制、研究链接、验证、限制、线上验证/回滚步骤。生产测量需部署后真实采集，不填虚假提升数。

命令：`pnpm --filter @miniapp/frontend typecheck`、`pnpm --filter @miniapp/frontend test`、`pnpm --filter @miniapp/frontend lint`、`pnpm --filter @miniapp/frontend build`、`pnpm -r typecheck`（部署路由配置变化）、`pnpm lint:complexity`、`pnpm test:ui --grep '@startup|@navigation|@chats|@roleplay'`。测试都使用已有虚构 fixture，不操作生产。
