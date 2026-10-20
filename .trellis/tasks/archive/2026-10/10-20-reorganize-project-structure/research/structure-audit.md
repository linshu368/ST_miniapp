# 结构归纳审计

## 执行范围

三路只读审计覆盖 Frontend/Admin、Backend/Shared/Reply Renderer、根脚本/ops/workflow/部署配置。审计同时搜索静态 import、`vi.mock`、Worker URL、`?raw`、shell repo root、package scripts、GitHub Actions、Railway IaC、README/spec 与活跃任务命令。

## 采纳项

- 根脚本归入 `checks/`、`database/`、`data/`；图片广场 runbook 归入 `ops/image-plaza/`。
- Admin 扁平组件按 view/config 归类，lib 按 API 和真实领域簇归类。
- Frontend 只归纳散落的聊天、支付、hook 和支付图标文件。
- Backend 只移动 Lobby、Notifications、聊天媒体存储；Shared 只移动 Lobby 契约和 rich-reply 协议。
- Reply Renderer 保持根出口，内部归入 rendering/worker/testing。

## 明确保留原位

- Next.js `app/`、Backend routes/repositories/线上 scripts、Shared migrations、Prisma。
- `.github`、`.railway/railway.ts`、Vercel 配置、Docker Compose、Supabase 配置、Trellis/Cursor 框架目录。
- 引用面大但没有明确单一所有者的 logger/sentry 与零散单文件工具。

## 判断

采纳项有明确所有者、消费者可穷举且存在对应自动验证；保留项受框架发现、仓库外配置、历史执行顺序或低收益高 churn 约束。本轮不追求目录形式上的完全对称。
