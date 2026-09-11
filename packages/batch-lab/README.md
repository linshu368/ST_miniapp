# Batch Lab

内部预设批量调试 SPA。V1 由 Backend 返回权威来源环境，不提供环境切换或应用内登录。

## 本地开发

复制 `.env.example` 为 `.env.local`，然后运行 `pnpm dev:batch-lab`。

## Vercel

创建独立 Vercel Project，Root Directory 设为仓库根目录并使用包内 `vercel.json`。Preview 的
`VITE_BATCH_LAB_API_URL` 必须指向 development/PR Backend；Backend 同时将该 Preview 的精确
origin 配置为 `BATCH_LAB_URL`。变量在 Vite 构建期固化，修改后需要重新部署。
