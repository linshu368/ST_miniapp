# 轻量修复方案与审核

## 复用与边界

- 已检查 ImagePlazaConfigEditors、imagePlazaPricing、ConfigValueEditor、configSchemas、adminApi.saveDraft/getDrafts、shared image-plaza schema、Backend config route，以及 20261012 SQL validator。
- 标准价由 useState 空对象持有，未进入 onChange；shared 默认剥除未知字段。两处均需修改。
- 目录顶层新增可选 standard_prices，沿用 imagePlazaPriceKey 的模型/档位复合键与原计算器。公开 route 只投影 models/tags 等字段，不返回目录顶层元数据，故不改公开模型契约或后端。
- 复用原 JSONB 保存链路；仓库 SQL validator 不拒绝额外目录属性，直接保存 p_value，不需新表、RPC、migration 或依赖。不修改上一项白名单迁移。

## 风险与最小方案

- 元数据不是计费输入；仅用户显式重算改变 credits。标准价允许缺失/null；有效值须为有限正数、不超过 1,000,000、最多四位小数，与现有计算器一致。
- 受控 props.value 为唯一数据源，避免刷新、环境切换时局部副本残留。旧目录不补猜测值。
- 沿用保存事务、权限、环境隔离、失败反馈；不新增外部调用、重试、并发写入口或缓存，无新增超时/补偿/限流要求。保存失败不能声称已持久化。
- Admin 与 shared 同步发布；旧 Admin 保存时可能剥除新字段，避免新旧编辑器同时操作。历史恢复可恢复旧目录的空标准价，符合快照语义。回退 UI 不需数据库回退。
- 不扩展参数持久化、不建通用定价框架。轻量方案已按源码检查；用户要求授权此限定改动。

## 执行与验收

1. shared 增加可选标准价映射；编辑器改为受控读写，更新说明。
2. 在既有 shared/Admin 测试文件补充序列化回读、清空、旧值、非法值、重算保留回归，不新增测试文件。
3. pnpm --filter @miniapp/shared test；pnpm --filter @miniapp/admin test；pnpm -r typecheck；pnpm -r --if-present build；pnpm lint:imports；git diff --check。
4. 人工 TEST：保存→刷新→再次打开、清空后保存、发布后再打开、历史恢复、失败保留输入、viewer 只读、切换环境不串值。没有可访问 TEST 时明确未执行，不把本地测试当远端验收。

## 执行结果（2026-10-16）

- 已完成受控标准价、可选 shared 字段、既有测试回归用例与 Admin 文档更新。未改应用保存 RPC、数据库、依赖、App.tsx 或 adminNavigation.ts。
- Admin、shared、CS、reply-renderer typecheck 通过；全仓 typecheck 因 Backend 缺少 undici 失败，单独 Frontend typecheck 也失败（本地 Next 相关类型/模块错误）。
- shared/Admin test 均在 Vitest 启动前失败：magic-string 无法解析 @jridgewell/sourcemap-codec/index.js；本轮不能声称测试通过。
- 全仓 build 在 CS 缺少 lightningcss 时停止；单独 Admin build 仍被 worker 依赖解析阻塞。lint:imports 缺少 fast-deep-equal，无法启动 ESLint。
- git diff --check 通过；已按 Prettier 格式化修改的 TS。最终格式复核见命令输出。
- 未部署、未操作 TEST/Production，真实保存刷新验收待环境可用后执行。若目标库仍报 config_key CHECK，须先完成上一任务的兼容迁移；此次代码不能绕开数据库约束。
- 新元数据仅受 shared/Admin 校验，仓库 SQL 不校验该可选额外属性；直接 RPC 写入损坏元数据可能导致新 Backend 配置解析拒绝，须限制为现有受权管理流程并在发布前校验。此轮不扩大数据库变更范围。
