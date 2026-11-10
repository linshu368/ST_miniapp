# 执行计划（2026-11-10 已确认实施）

## 门禁与顺序

1. 用户审核prd/design/implement/task；module_impact/mobile_performance与上下文完整后start。
2. 超长execute/settle/sync/repository按触达职责提取request builder、供应商记录、response consumer/恢复；保持现有行为，不建通用框架。
3. 新增单份前向SQL：表/权限、validator、provider CHECK、交付三分支，保持旧数据/函数身份权限。
4. 先完成Surplus逐字段覆盖清单（来源/字段路径/类型边界/JSONB保存路径/投影/证据/排除理由），再实现mapper/repository：请求冻结、身份CAS/read-back、来源分区、非空事实保留、完整性诊断与128KiB有界响应。不得沿用通用helper的小型顶层名单充当完整覆盖。
5. 接入真实dispatch、SSE/non-stream、竞争/停止/取消/超时，include_usage与能力匹配。
6. 适配settle/sync：调用尝试与胜者分离、旧snapshot-only兼容、成本/请求详情补齐与收费独立；补齐保留各来源原始受控事实、冲突与缺失原因，不覆盖inline证据。
7. 扩展现有测试/隔离PG/PostgREST/@chat；因迁移/计费/竞争风险，允许新增专用mapper/repository测试与SQL场景。
8. 更新README/ARCHITECTURE/migrations README/spec/module-updates及逐环境发布恢复说明。
9. 全范围复查，提供final diff/验证/拟提交清单待人审；不自动远端迁移、部署、生产配置写入、git add/commit/push。

## 命令

```powershell
python ./.trellis/scripts/task.py validate 11-09-surplusintelligence-history
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend exec vitest run src/features/generation/execute.test.ts src/features/generation/settle.test.ts src/features/generation/sync-job.test.ts src/features/generation/upstream.test.ts src/platform/model-provider-directory.test.ts --testTimeout 15000
pnpm --filter @miniapp/backend exec vitest run --exclude '**/*.integration.test.ts' --testTimeout 15000 --maxWorkers 2
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

- TEST迁移错误补充：原文件不可变，新增完整compat入口；安装函数LF/CRLF × 输入SQL LF/CRLF四组合均须通过，同输入原文件CRLF必须重现旧错且回滚，未知语义分支继续拒绝，OID/owner/ACL及分支外逻辑不变。只修改迁移和SQL验收脚本时运行适用SQL回归、shared测试/typecheck和migration lint；不以本地结果声明TEST已执行。

- 配置surplus草稿/发布/回滚、未知provider拒绝、旧OR/Venice不变。
- 新表RLS/FK/级联/参数大小类型、正文/secret排除、NULL与0保真；迁移重放及未知前置shape安全拒绝。
- 覆盖清单中的实际合法字段逐项断言持久化路径/值/类型；覆盖深层usage扩展、choice非正文叶子、首帧独有字段、中间字段、末尾usage与脱敏SSE注释，不仅验证几个平铺列。
- header路由/适配/截断/限流/重试/脱敏状态、body/request_record来源与成本精度；身份冲突拒绝、非身份冲突留证据；后续null/空事件不清已知事实。
- 未知字段/非法类型/敏感嵌套/动态key/工具arguments/logprobs正文排除；校验完整性及受控丢弃原因，128KiB边界/多字节UTF-8/深度/数组/摘要数量边界和优先保留关键终态。
- 同一stream多次usage不能重复累计；源缺失/补齐403不伪标complete，旧metadata版本兼容；按50行批次验证不全量读取大JSON，避免新增首字阻塞与内存峰值。
- 同ID重放、不同ID冲突、写超时已提交读回、并发两个终态。
- SSE含/缺usage、非流式、缺ID、4xx/429/5xx、流断、空回复、仅reasoning、取消晚到stop、用户停止、绝对超时。
- Surplus赢/OR赢/输者晚到，generation ID与request ID不同；胜者唯一扣费。
- 微美元合法/超大/非法值，缺值不补零；详情403/404/5xx不热循环、不要求管理凭据。
- 免费额度/固定报价/创作者收益不漂移；账已结metadata缺、metadata齐账未结、旧无明细snapshot恢复。
- 真实repository经PostgREST读写、非superuser权限、现有@chat消费SSE与主表正文不变。

## 人工与发布

TEST真实小样本：目录→CLI草稿/diff/发布→生成/重生成/停止→核对主表正文/新表参数响应/账单额度；慢请求OR胜出检查两条调用事实和一次收费。真实调用前核对目标与授权，mock不能代替。

双端页面加载/首字P95、错误率与取消恢复，发布前后各24h按模型/版本分窗。无样本明确unknown；未跑远端或真实供应商不声明完成上线。
