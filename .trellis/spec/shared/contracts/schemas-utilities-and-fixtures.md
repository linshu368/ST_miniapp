# Shared Schema、工具与 Fixture

## 当前模块

- `dev-fixtures.ts`：开发 seed 的稳定 UUID；只能用于非生产 fixture。
- `lobby-featured.ts`：大厅前八位金框等纯计算。
- `png-parser.ts`：PNG 角色卡相关纯类型；不包含 Node 二进制 I/O。
- `telegram-avatar.ts`：头像 URL 归一化。
- `user-placeholder.ts`：`{{user}}` 替换和默认称呼。
- `config/database.ts`：环境到数据库配置的纯解析/校验。
- `st-bridge/*`：bridge handle 解析与类型。
- `telemetry/sanitize.ts`：敏感信息清洗。

## 硬规则

- 纯工具必须确定、无网络/文件/env 隐式访问；调用方显式传入时间、随机数或配置。
- runtime schema 提供安全默认值时必须有业务依据；解析失败不得静默吞掉导致危险回退。
- fixture 名称显式标记 dev/test，禁止真实用户、token、连接串或生产 ID。
- sanitization 采用 allowlist/明确敏感键规则，并测试嵌套、数组、循环/异常输入；不得把脱敏当成可记录任意对象的许可。
- helper 只共享稳定语义，不把应用 UI 文案、组件、数据库连接或 provider SDK 放入 shared。
