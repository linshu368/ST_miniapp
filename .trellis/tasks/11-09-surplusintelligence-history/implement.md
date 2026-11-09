# 执行计划（待审核）

## 门禁与顺序

1. 用户审核prd/design/implement/task；module_impact/mobile_performance与上下文完整后start。
2. 超长execute/settle/sync/repository按触达职责提取request builder、供应商记录、response consumer/恢复；保持现有行为，不建通用框架。
3. 新增单份前向SQL：表/权限、validator、provider CHECK、交付三分支，保持旧数据/函数身份权限。
4. 新mapper/repository：请求冻结、身份CAS/read-back、非空事实保留与有界响应。
5. 接入真实dispatch、SSE/non-stream、竞争/停止/取消/超时，include_usage与能力匹配。
6. 适配settle/sync：调用尝试与胜者分离、旧snapshot-only兼容、成本补齐与收费独立。
7. 扩展现有测试/隔离PG/PostgREST/@chat；因迁移/计费/竞争风险，允许新增专用mapper/repository测试与SQL场景。
8. 更新README/ARCHITECTURE/migrations README/spec/module-updates及逐环境发布恢复说明。
9. 全范围复查，提供final diff/验证/拟提交清单待人审；不自动远端迁移、部署、生产配置写入、git add/commit/push。

## 命令

```powershell
python ./.trellis/scripts/task.py validate 11-09-surplusintelligence-history
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend exec vitest run src/features/generation/execute.test.ts src/features/generation/settle.test.ts src/features/generation/sync-job.test.ts src/features/generation/upstream.test.ts src/platform/model-provider-directory.test.ts --testTimeout 15000
pnpm --filter @miniapp/backend test -- --testTimeout 15000
pnpm --filter @miniapp/admin test
pnpm --filter @miniapp/admin-client test
pnpm --filter @miniapp/admin-cli test
pnpm -r typecheck
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin build
pnpm lint:legacy
pnpm lint:migrations
pnpm lint:complexity
pnpm test:ui --grep @chat
git diff --check
```

实现后追加新mapper/repository focused命令，运行修改文件ESLint/Prettier。拆分后 `node scripts/complexity-budget.mjs update` 收紧基线；无backend build脚本时记录实际运行方式，不编造通过。

扩展并运行 `bash scripts/test-first-token-fallback-local.sh`；适用时运行既有 `bash scripts/test-openrouter-retirement-local.sh` 验证删旧列兼容。当前本机缺docker/psql，先确认可用隔离环境，不改连共享远端库；执行不了明确记录。

## 必测失败与consumer矩阵

- 配置surplus草稿/发布/回滚、未知provider拒绝、旧OR/Venice不变。
- 新表RLS/FK/级联/参数大小类型、正文/secret排除、NULL与0保真；迁移重放及未知前置shape安全拒绝。
- 同ID重放、不同ID冲突、写超时已提交读回、并发两个终态。
- SSE含/缺usage、非流式、缺ID、4xx/429/5xx、流断、空回复、仅reasoning、取消晚到stop、用户停止、绝对超时。
- Surplus赢/OR赢/输者晚到，generation ID与request ID不同；胜者唯一扣费。
- 微美元合法/超大/非法值，缺值不补零；详情403/404/5xx不热循环、不要求管理凭据。
- 免费额度/固定报价/创作者收益不漂移；账已结metadata缺、metadata齐账未结、旧无明细snapshot恢复。
- 真实repository经PostgREST读写、非superuser权限、现有@chat消费SSE与主表正文不变。

## 人工与发布

TEST真实小样本：目录→CLI草稿/diff/发布→生成/重生成/停止→核对主表正文/新表参数响应/账单额度；慢请求OR胜出检查两条调用事实和一次收费。真实调用前核对目标与授权，mock不能代替。

双端页面加载/首字P95、错误率与取消恢复，发布前后各24h按模型/版本分窗。无样本明确unknown；未跑远端或真实供应商不声明完成上线。
