# ops/env — 生产环境变量模板索引（方案 Y）

> 对外域名绑 **Vercel**（前端在边缘）；Railway 跑 `nginx` / `backend` / `st-bundle`
> 三个服务。每个部署目标一份模板，列出该处要配的全部变量（含用途、是否必填、来源/典型值）。
> 真实值在各平台控制台注入，**不提交到仓库**。

| 模板                                                                     | 配在哪里                 | 对应服务                                    |
| ------------------------------------------------------------------------ | ------------------------ | ------------------------------------------- |
| [`vercel.env.production.example`](./vercel.env.production.example)       | Vercel 项目 Variables    | 前端（Vercel）                              |
| [`backend.env.production.example`](./backend.env.production.example)     | Railway 服务 `backend`   | Fastify 平台 API                            |
| [`st-bundle.env.production.example`](./st-bundle.env.production.example) | Railway 服务 `st-bundle` | ST + sync-engine（provision-api + watcher） |
| [`nginx.env.production.example`](./nginx.env.production.example)         | Railway 服务 `nginx`     | 内部分发网关（envsubst upstream）           |

拓扑与服务创建步骤见 [`../railway/README.md`](../railway/README.md)。

## ⚠️ 跨服务逐字一致密钥

以下两个密钥**必须 backend 与 st-bundle 两个服务完全相同**，否则鉴权 / 扣费链断：

| 变量                      | 作用                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `ST_USER_PASSWORD_SECRET` | 派生每个 ST 用户登录密码的 HMAC 密钥（Bridge 登录与 provision 建号两端用同一公式） |
| `LLM_PROXY_TOKEN_SECRET`  | 签发 / 验签 LLM 代理 token 的密钥（backend 签发写入 ST secrets，LLM proxy 验签）   |

> 两个模板（backend / st-bundle）顶部都对这两项做了醒目标注。设置时**逐字复制同一值**。

## 易错点速查

- **`PROVISION_API_BIND_HOST=0.0.0.0`**（st-bundle）：不设则 provision-api 仅绑
  127.0.0.1，backend 跨服务调不到（provision 全失败）。
- **内网服务名**：`stminiapp.railway.internal`（backend，监听 8080）/
  `st-bundle.railway.internal`，改服务名/端口要同步改 nginx 的 `BACKEND_UPSTREAM`/
  `ST_UPSTREAM`、backend 的 `ST_BASE_URL`/`ST_PROVISION_URL`、st-bundle 的 `LLM_PROXY_URL`。
- **密钥不入仓**：模板里全是占位/说明，真实密钥只在控制台注入。
