# MiniApp 流量归因 Supabase 交接说明

## 当前 Supabase 位置

- 项目：`ST_telegrambot`
- Project ref：`wbtsfzozlmurljvglhpn`
- 分支：`main`
- Schema：`miniapp_traffic`

这套配置用于 MiniApp 渠道流量归因。目标是让新统计链路不再依赖旧的 `public.botlinks`、`public.traffic_clicks`、`public.bot_users` 和 `public.payment_orders`，而是使用 MiniApp 相关的新表和新 Schema。

## 已创建对象

### `miniapp_traffic.botlinks`

用途：渠道配置表。`auto_generate.py` 后续应把生成好的 MiniApp 深链写入这张表。

字段：

- `id bigint primary key`
- `bot_link text`
- `source_id text unique`
- `created_at timestamptz default now()`
- `source_name text`
- `start_time date`
- `end_time date`
- `"Purchase_amount" integer`
- `"Procurement_days" integer`

说明：

- 未从 `public.botlinks` 迁移旧数据。
- `bot_link` 字段名为了兼容沿用旧名字，但现在里面应存 MiniApp 深链，不再是 Bot `/start` 深链。

新的预期链接格式：

```text
https://t.me/{BOT_USERNAME}/{MINIAPP_SHORT_NAME}?startapp={source_id}
```

旧链接格式：

```text
https://t.me/{BOT_USERNAME}?start={source_id}
```

### `miniapp_traffic.traffic_clicks`

用途：MiniApp 渠道入口/点击的按日聚合表。

字段：

- `id bigint primary key`
- `stat_date date not null default current_date`
- `source_id text not null`
- `clicks integer not null default 0`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

约束和索引：

- `unique (stat_date, source_id)`
- `(source_id, stat_date)` 索引

未从 `public.traffic_clicks` 迁移旧数据。

### `miniapp_traffic.increment_click(p_source_id text)`

用途：用于累加 `miniapp_traffic.traffic_clicks` 的 RPC / SQL 函数。

函数行为：

```sql
insert into miniapp_traffic.traffic_clicks (stat_date, source_id, clicks)
values (current_date, p_source_id, 1)
on conflict (stat_date, source_id)
do update set clicks = miniapp_traffic.traffic_clicks.clicks + 1,
              updated_at = now();
```

脚本或 MiniApp 后端在确认有效的 `startapp` 渠道来源后，应调用这个函数。由于这个函数每调用一次就会累加一次，所以调用位置决定了 `clicks` 指标的含义：

- 如果希望 `clicks` 表示 MiniApp 入口访问次数，应在每次有效进入时调用。
- 如果希望 `clicks` 表示新增归因用户数，应只在用户首次归因时调用。

旧的 `public.increment_click` 是在 SillyTavern Bot 创建新用户时调用的，所以旧表里的 `clicks` 更接近“渠道新增用户数”，而不是纯粹的链接点击 PV。

### `miniapp_traffic.traffic_daily_stats`

用途：替代旧的 `analytics.traffic_daily_stats` 视图。

这个视图保留旧报表的字段形态，但数据源改成新表：

- 渠道配置：`miniapp_traffic.botlinks`
- 每日点击/入口计数：`miniapp_traffic.traffic_clicks`
- 用户和激活数据：`miniapp.users`
- 付款数据：`miniapp.payment_orders`

重要字段映射差异：

- 旧用户来源：`public.bot_users.source_id`
- 新用户来源：`miniapp.users.source_id`
- 旧激活日期：`public.bot_users.created_at::date`
- 新激活日期：`coalesce(miniapp.users.miniapp_entered_at, miniapp.users.created_at)::date`
- 旧激活条件：`total_round >= 3`
- 新激活条件：仍然是 `miniapp.users.total_round >= 3`
- 旧支付状态：`public.payment_orders.payment_status = 'completed'`
- 新支付状态：`miniapp.payment_orders.status = 'completed'`
- 旧支付金额：`public.payment_orders.amount`
- 新支付金额：`miniapp.payment_orders.amount_cents / 100.0`
- 旧支付用户关联：`text` 类型 user id
- 新支付用户关联：`miniapp.payment_orders.user_id = miniapp.users.id`

## 预期数据流

1. 运营或脚本使用方在 `miniapp_traffic.botlinks` 创建或填写渠道行，至少包含 `source_name`，可选填写成本和日期字段。
2. `auto_generate.py` 扫描 `miniapp_traffic.botlinks`，找到 `source_name` 已填写且 `bot_link` 为空的行。
3. 脚本生成唯一的 `source_id`。
4. 脚本把 MiniApp 深链写入 `bot_link`。
5. 用户打开带 `startapp={source_id}` 的 MiniApp 链接。
6. MiniApp 或后端校验 `source_id` 是否有效。
7. MiniApp 或后端把用户来源记录到 `miniapp.users.source_id`。
8. MiniApp 或后端根据选定的统计口径调用 `miniapp_traffic.increment_click(source_id)`。
9. `miniapp_traffic.traffic_daily_stats` 汇总渠道成本、点击/入口数、激活用户和已完成支付。

## 脚本适配说明

脚本负责人需要更新 `auto_generate.py`，让所有表读取和写入都指向 `miniapp_traffic.botlinks`，不要再使用 `public.botlinks`。

推荐环境变量：

```dotenv
TABLE_SCHEMA=miniapp_traffic
TABLE_NAME=botlinks
BOT_USERNAME=<telegram_bot_username>
MINIAPP_SHORT_NAME=<telegram_miniapp_short_name>
```

如果当前 Supabase Python client 支持 Schema API，推荐这样访问：

```python
supabase.schema("miniapp_traffic").table("botlinks")
```

不要默认假设 `TABLE_NAME=miniapp_traffic.botlinks` 一定可用。只有确认当前安装的 Supabase Python client 支持 fully qualified table name 后，才建议这样配置。

唯一 `source_id` 的生成逻辑可以保持不变，但检查已有 ID 时必须读取 `miniapp_traffic.botlinks` 中的 `source_id`。

链接生成逻辑应输出：

```python
f"https://t.me/{BOT_USERNAME}/{MINIAPP_SHORT_NAME}?startapp={source_id}"
```

## 安全说明

`miniapp_traffic.botlinks` 和 `miniapp_traffic.traffic_clicks` 当前未开启 RLS。这符合本次“先完成基础搭建”的状态，但如果后续要通过 `anon` / `authenticated` Supabase client 暴露访问，需要先设计 policy，再开启 RLS。

设计好 policy 后，可以考虑执行：

```sql
alter table miniapp_traffic.botlinks enable row level security;
alter table miniapp_traffic.traffic_clicks enable row level security;
```
