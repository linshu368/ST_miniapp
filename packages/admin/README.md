# 蜜镜AI运营平台

运营平台包含配置与内容管理：配置编辑、草稿、发布、回滚、发布历史、角色卡与公告管理。

## 独立部署

Admin 使用独立 Vercel 项目。首次部署先在仓库根目录链接项目，后续执行：

```powershell
vercel deploy --prod --yes -A vercel.admin.json
```

当前生产地址：<https://st-admin-platform.vercel.app>

## 本地启动

1. 复制 `.env.example` 为 `.env.local`，分别填写测试和生产 Supabase URL、anon key 与后端 API URL。
2. 执行 `pnpm dev:admin`，默认端口为 `3003`。
3. 使用已加入 `admin.admin_users` 的 Supabase Auth 邮箱账号登录。

## OpenRouter 模型同步

模型目录页面通过对应环境后端的 `/api/platform/openrouter/models` 获取 OpenRouter
公开模型目录。选择模型后，后台按当前 `llm_pricing_config.exchangeRate` 与 `markup`
自动换算“星尘/万 token”展示价格，运营仍可调整展示值。真实对话扣费继续只使用
OpenRouter generation 返回的实际 cost。

保存或发布模型配置前，后台会拒绝不存在或已经过期的 OpenRouter 模型 ID；已发布
模型的内部稳定 ID 在页面中不可修改。

## 数据库初始化

执行 `packages/shared/migrations/035_admin_config_management.sql` 后，必须由
`service_role` 或 `postgres` 在每个数据库中设置唯一环境：

同时在 Supabase Dashboard 的 API 设置中将 `admin` 加入 Exposed schemas；
RLS 与受控 RPC 仍会限制实际访问权限。

```sql
INSERT INTO admin.environment_config (id, environment)
VALUES (1, 'test') -- 生产库改为 'production'
ON CONFLICT (id) DO UPDATE
SET environment = EXCLUDED.environment, updated_at = now();
```

随后将已有 Supabase Auth 用户加入白名单：

```sql
INSERT INTO admin.admin_users (
  user_id,
  email,
  role,
  can_access_test,
  can_access_prod
)
VALUES (
  '<auth.users.id>',
  '<operator@example.com>',
  'owner',
  true,
  false
);
```

生产库应只为确需线上权限的账号设置 `can_access_prod = true`。迁移与生产配置不会由前端自动执行。
