# 预设对话平台实施路线

本次只完成规划，不执行产品代码、migration 或生产操作。后续每阶段独立验证和回滚，默认只启用 test。

## A. 决策与核验

已确认：沿用 Admin Supabase 账号/角色表；会话和草稿私有；V1 预设单段；支持 test/prod 成组环境切换；正常可调用 OpenRouter 模型均可选；生产库允许独立 `preset_platform` 保存工作台数据；关键用户信息脱敏且不做内容审计。实施前仍需分别只读核验 test/prod 的 Admin 账号认证能力、`preset_platform` 目标 schema 可用性、角色字段、experience 历史、RLS/grant；核对 OpenRouter 真实目录字段；写 ADR 固化 V1 prompt、独立数据域、测试不计费、生产只读和部署拓扑。权限或环境差异无法解释则不进入生产实现。

## B. Shared 契约

新增 preset-platform Zod/DTO/SSE/errors 和测试。

```bash
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/shared test
pnpm -r typecheck
```

## C. Supabase `preset_platform` 独立域

扫描最新 migration 编号；创建 `preset_platform` schema 及其表/RLS/grant/index/comment 和原子发布/回滚/开轮/收口 RPC，migration 声明 `-- domain: preset_platform`。不得在 `admin` schema 新增 Preset Platform 表、函数或策略；认证复用与数据归属分离。先 test 单文件执行，验证 shape、归属、允许/拒绝、跨域只读边界、并发、幂等、分页 explain、锁/容量和回滚；生产独立确认。无数据可 drop，有数据后优先 flag-off + forward-fix。

## D. Backend 骨架

扩展 config/CORS/feature flags/限额；实现 operator auth、environment fingerprint、会话/草稿/预设/默认发布 repositories 和 routes；添加 `@frontend-ready`、Pino allowlist、审计及 401/403/409/429 映射。测试 ownership、角色矩阵、环境 mismatch、分页、重复写和版本冲突。

## E. 模型与生成

扩展运营鉴权模型端点和 refresh 限频；模型目录查询/搜索/选择参考 Admin 的 `openRouterModels.ts` 与 `ModelCatalogEditor.tsx`：按环境 API base 拉取目录、shared schema 校验、stale/同步状态、强刷、按名称/ID/描述/canonical slug 搜索、过期/不可用展示。在 generation 内新增 internal test purpose，跳过 quota/wallet/charge；实现 V1 composer、原子开轮、idempotency、busy、断线 drain、retry/恢复和内部流量隔离。

测试目录 fresh/stale/no-cache、上游 4xx/5xx/429/timeout、流前/流内失败、断线、重复/并发、重启后陈旧状态；断言钱包、免费额度、正式 chat_history 无变化。

## F. 当前环境测试素材与脱敏

实现当前环境角色安全摘要、按 ID 服务端取上下文、真实输入有界查询/关键用户信息脱敏/opaque ref；代码和数据库双重只读。首期不做内容审计或语义风险审核。使用人工 PII fixture 覆盖用户 ID、手机号、邮箱、TG、URL query、身份/支付样式、Unicode、超长；测试下架、无样本、权限、超时及 response/log/Sentry 无原文。发现未脱敏关键用户信息或线上写入立即 flag-off + revoke。

## G. 独立 SPA

创建包、路由、providers、环境/login/工作台；按会话 → 模型 → 预设管理（平台预设/预设库/草稿箱 Tab）→ 测试素材实现。对话测试页按参考 HTML 图 1 处理：左侧私有会话列表、中间对话流、右侧会话配置/当前环境角色卡/脱敏输入快捷区；模型用 OpenRouter 下拉选择；点击预设打开右侧抽屉，合并展示已发布预设和私有草稿。API hooks 统一，query key 含环境，SSE 关联 request/session/environment；覆盖状态、未保存拦截、生产确认、响应式和原子环境切换。

部署配置参考 Admin/CS Platform：新增 `packages/preset-platform/vercel.json`，使用 `framework: null`、`installCommand: pnpm install`、`buildCommand: pnpm --filter @miniapp/preset-platform build`、静态 `outputDirectory` 和 SPA rewrite。Vercel Preview 默认只配置 test Supabase 与 preview/development backend；production 项目才配置 prod 变量。不要新增前端 Dockerfile、GHCR 镜像或 Railway frontend service。

## H. 集成与灰度

Test 完成主路径、故障、隐私和零回写证明；新 Vercel Preview 仅连 test。Production 独立 shape/migration，backend flag-off 先发，再按 viewer → operator → publisher 灰度。体验终审后决定长期上线，否则关闭生产 flag。

CI/部署补充：在 `.github/workflows/ci.yml` 的 quality gate 中增加 `pnpm --filter @miniapp/preset-platform test` 和 `pnpm --filter @miniapp/preset-platform build`；根 `pnpm typecheck` / `pnpm lint` / import guard 已覆盖新 workspace。`.github/workflows/build-and-push.yml` 不新增 Preset Platform 镜像。`.railway/railway.ts` 不新增 service，仅把 `PRESET_PLATFORM_URL` 纳入 backend preserved env 清单，并在 Railway development/production/PR 环境中对齐 CORS origin；`railway-pr-env.yml` 继续只创建 backend `pr-{N}`，Preset Platform Vercel Preview 通过环境变量指向该 backend。

```bash
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend typecheck
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/preset-platform typecheck
pnpm --filter @miniapp/preset-platform test
pnpm --filter @miniapp/preset-platform build
pnpm -r typecheck
pnpm lint:imports
pnpm format:check
```

人工 smoke：环境登录/指纹隔离、A/B 私有会话、默认/固定版本、当前环境角色只读、脱敏输入、预设抽屉、预设管理 Tab、断线恢复、发布/回滚和 401/403/409/429/timeout。

## I. 文档与 Trellis

新增包 README 和 preset-platform specs；更新根 README、ARCHITECTURE、`docs/schema归属地图.md`、shared/backend/database specs，把数据库域口径由现有八域同步为包含独立 `preset_platform` 的新布局；记录规划偏差、验证命令、环境结果和剩余风险。
