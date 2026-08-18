# ops/env — 生产环境变量模板索引（方案 Y）

> 对外域名绑 **Vercel**（前端在边缘）；网关收敛后 Railway 只跑 `backend` 一个服务，
> 前端直连它。每个部署目标一份模板，列出该处要配的全部变量（含用途、是否必填、来源/典型值）。
> 真实值在各平台控制台注入，**不提交到仓库**。

| 模板                                                                 | 配在哪里                 | 对应服务         |
| -------------------------------------------------------------------- | ------------------------ | ---------------- |
| [`vercel.env.production.example`](./vercel.env.production.example)   | Vercel 项目 Variables    | 前端（Vercel）   |
| [`backend.env.production.example`](./backend.env.production.example) | Railway 服务 `stminiapp` | Fastify 平台 API |

拓扑与服务创建步骤见 [`../railway/README.md`](../railway/README.md)。

> ⚠️ backend 服务在 development / production 两个环境同名 **`stminiapp`**。原先需要
> `-pro` 后缀区分的 `nginx` / `st-bundle` 已随网关收敛与 ST 整包退场，控制台里的残留
> 服务清理步骤见 [`../railway/README.md`](../railway/README.md#️-网关收敛的手动收尾)。

## ⚠️ 两侧必须对齐的变量

前端与 backend 之间没有反代，跨域直连，因此这两项必须成对配好，配错即浏览器侧请求全挂：

| 变量                                | 配在哪里 | 取值               |
| ----------------------------------- | -------- | ------------------ |
| `NEXT_PUBLIC_API_URL`               | Vercel   | backend 的公网域名 |
| `FRONTEND_URL`（CORS allow-origin） | backend  | Vercel 的对外域名  |

> `NEXT_PUBLIC_*` 在 build 期固化进 bundle，改完必须 redeploy 前端才生效。

## 易错点速查

- **`PORT`（backend）**：必须与 Railway 路由到容器的端口一致，缺失/不符会 502。
- **`NEXT_PUBLIC_API_URL` 留空**：没有 rewrites 兜底，浏览器会把 `/api/*` 打到 Vercel
  自身域名上并全部 404。
- **密钥不入仓**：模板里全是占位/说明，真实密钥只在控制台注入。
