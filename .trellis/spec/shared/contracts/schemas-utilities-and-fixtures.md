# Shared Schema、工具与 Fixture

## 当前模块

- `dev-fixtures.ts`：开发 seed 的稳定 UUID；只能用于非生产 fixture。
- `lobby-featured.ts`：大厅前八位金框等纯计算。
- `png-parser.ts`：PNG 角色卡相关纯类型；不包含 Node 二进制 I/O。
- `telegram-avatar.ts`：头像 URL 归一化。
- `user-placeholder.ts`：`{{user}}` 替换和默认称呼。
- `config/database.ts`：环境到数据库配置的纯解析/校验。
- `telemetry/sanitize.ts`：敏感信息清洗。
- `text-postprocess/`：source schema、HTML/CSS AST 编译、结构化 capture/slot、确定性 artifact 校验与分段 apply；无 React、网络、数据库或隐藏 Worker 生命周期。

## 硬规则

- 纯工具必须确定、无网络/文件/env 隐式访问；调用方显式传入时间、随机数或配置。
- runtime schema 提供安全默认值时必须有业务依据；解析失败不得静默吞掉导致危险回退。
- fixture 名称显式标记 dev/test，禁止真实用户、token、连接串或生产 ID。
- sanitization 采用 allowlist/明确敏感键规则，并测试嵌套、数组、循环/异常输入；不得把脱敏当成可记录任意对象的许可。
- helper 只共享稳定语义，不把应用 UI 文案、组件、数据库连接或 provider SDK 放入 shared。
- ST bridge、iframe/postMessage 协议与已退场包不得重新加入 shared。
- 文本后处理只允许经 schema/policy 版本化的正则、受限 HTML AST、作用域 CSS 和可信 slot。禁止脚本、事件属性、外部资源、任意 URL、Raw AST 与未绑定捕获组；规则数、输入/输出、节点、诊断和时间预算必须有界。
- compiler 输出必须确定；同一 source 生成相同 canonical artifact。运行时 apply 只消费 artifact，不读 source，不做网络请求；失败返回完整原文和结构化诊断，不返回部分污染结果。
