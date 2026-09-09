# 复用调研与当前状态

## 调研基线

已检索根 README、架构文档、Admin/Backend/Shared/Database specs 和以下实现方向：Admin 应用壳/环境/Supabase 会话/API helper/草稿发布；Backend 模型目录/OpenRouter/generation/prompt/admin auth/config/CORS；Shared models/envelope/Zod；数据库 admin/app_core/experience 域及 087/088 删除的 ST 通路。

本调研未连接 Supabase、未读取业务行。数据库结论来自源码、migration 和文档，实施前仍须分别核验 test/production 实况。

## 可复用与扩展

| 能力            | 位置                                                        | 决策                                                                            |
| --------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Vite React 基线 | `packages/admin/package.json`、`main.tsx`、Vite/Vercel 配置 | 复用版本、脚本、AntD locale/theme 和 SPA 部署方式，不复制业务大组件。           |
| 环境模式        | `packages/admin/src/lib/environment.ts`、`.env.example`     | 新包实现同约束环境模块；API/Supabase/session/cache 成组切换。                   |
| Supabase 登录   | Admin Supabase provider/LoginPage                           | 沿用认证协议和账号；不复制 token，不在 UI 承载授权。                            |
| 数据边界        | `packages/admin/src/lib/*Api.ts`                            | 保持“组件 → lib helper → backend/Supabase”。                                    |
| OpenRouter 目录 | `backend/src/platform/openrouter-models.ts`                 | 复用超时、缓存、并发合并、stale fallback；专用端点补运营鉴权和字段。            |
| 发布模型目录    | `backend/src/platform/model-tiers.ts`                       | 可作精选视图；全量模型仍以 OpenRouter 当前目录为准。                            |
| 流协议          | `backend/src/features/generation/upstream.ts`               | 扩展内部测试 purpose，复用 SSE tap/finish reason/provider request id。          |
| Prompt 纯函数   | `backend/src/features/engine/`                              | 复用规范化和 prompt cache；新增 preset composer，不改 MiniApp 默认语义。        |
| Shared 契约     | `packages/shared/src/api/*`                                 | 新增 preset-platform 契约、状态和错误码。                                       |
| 发布语义        | Admin 草稿/发布/历史/回滚                                   | 复用不可变发布、并发版本、审计、恢复思想；多资产不塞进 runtime_config 单 JSON。 |

复用 Admin 的认证协议、前端基线或发布语义只代表复用现有能力，不代表数据归属。Preset Platform 的业务表、RPC、RLS、grant 与审计应位于独立 `preset_platform` schema，Admin 不管理其数据生命周期。

## 需谨慎扩展

- Admin `App.tsx` 已高度耦合，只参考视觉/行为；不提前创建跨应用 UI 包。
- `GenerationService.execute()` 与用户设置、免费额度、钱包和正式历史耦合。应在 generation 域扩展 provider primitive，而非调用完整 MiniApp 计费事务。
- 当前全量模型接口的鉴权/强刷保护不足，新平台必须使用内部授权端点。
- 角色卡公共 DTO 不含 system prompt；UI 只取安全摘要，完整上下文由服务端按 ID 获取。

## 明确不复用

- 不复活 `st_platform.platform_presets`、旧 RPC、ST payload、宏、世界书和 prompt_order。
- 不复用 Admin 空壳 Refine resources 架构。
- 不在 `admin` schema 存放 Preset Platform 的预设、草稿、发布、测试会话、消息或审计数据；即使沿用 Admin 账号，也保持认证来源与数据归属分离。
- 不用 MiniApp `experience.chat_sessions/chat_history` 存测试工作台数据。
- 不允许浏览器直查 `experience.chat_history`；真实输入必须经 backend 脱敏。
- 不建立新 OpenRouter key、浏览器直连或第二套 runtime-config 入口。
- 不首期引入通用插件系统、消息队列、独立微服务或跨应用 UI 框架。

## 差异与风险

- 架构文档称 migration 最大编号 104，但工作区已有 105/108/109；创建 migration 前必须重新扫描。
- migration README 可能保留 ST 历史叙述；以 087–099 后实现和实库为准。
- test/production 不保证持续同构；上线前分别核验 shape、RLS、grant、RPC。
