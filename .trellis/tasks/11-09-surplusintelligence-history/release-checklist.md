# 发布与恢复清单

## 本轮范围

目标平台为 **Surplus Intelligence**，官方默认API为 `https://api.surplusintelligence.ai/v1`；现有内部provider值`surplus`保持兼容。新表为`experience.surplusintelligence_chat_history`。

本轮只实现代码与本地验证。未执行远端DDL/DML、生产运营配置发布、真实收费生成、部署、git add/commit/push。

## 发布前停止条件

- TEST/Production连接目标不明、前置shape/OID/ACL与预期不符、迁移账本存在冲突或运行中的旧writer未确认时停止，不盲重跑历史SQL。
- Docker PostgreSQL17/PostgREST及多连接并发验收仍需执行；已有PGlite PostgreSQL18.6 WASM证据不能代替。
- 没有真实Surplus/Telegram/钱包样本，不宣称接口P95、真实计费或真机已经验收。

## 顺序

1. 按仓库Database Migration workflow的inspect入口确认TEST目标、账本和前置函数/约束，采集结构/owner/ACL/RLS与索引；估算表规模和约束验证锁预算，不导出业务行。
2. 先在隔离PG17/PostgREST执行现有`bash scripts/test-first-token-fallback-local.sh`；检查新SQL场景、重复执行、RPC/关系查询、非superuser权限及并发重复身份/结算。
3. TEST一次执行`packages/shared/migrations/20261110_surplusintelligence_chat_history_compat.sql`；该文件完整包含原文件功能并修复LF/CRLF模板匹配。原文件保持不可变，不需要先执行成功；若此前整份原文件报错，先核对事务回滚及账本/结构。5秒锁/60秒语句预算，任何超时或结果未知先核对，不force rerun。
4. 验证新表唯一父键/同父attempt FK/RLS/最小授权、provider CHECK、catalog validator及交付三分支；确认PostgREST schema已刷新、实际repository/RPC读写成功。
5. 发布兼容Backend/shared/Admin；后端配置`SURPLUS_API_BASE_URL`和`SURPLUS_API_KEY`，不把凭据写入前端、Markdown或日志。
6. TEST真实小样本核对正常发送、重生成、停止、异常与OR兜底：会话正文仍在主表，新表字段完整且不含正文/secret；原报价/免费额度/创作者收益仅结算一次，输者保留明细但不收费。
7. 确认详情来源权限和真实ID格式；403/404/缺ID应明确不可用，不新增管理凭据、不用generation ID猜request ID。
8. Production独立核实目标、shape/账本、规模与锁预算；经独立发布授权后按同一单文件流程迁移，再部署兼容应用。
9. 生产模型启用通过仓库CLI：先`pnpm -s admin whoami --json`，再describe/get→draft set→diff；把本次具体差异给用户看，明确同意后才publish `--yes`，发布后get复核。代码实施批准不等于生产配置发布批准。
10. 双端按环境/release/provider/model分窗观察至少24小时，核对页面加载P95、首字P95、错误/取消/恢复、结算和元数据完整性；无样本保持unknown，不能填零。

## 恢复

- 出现身份归属错、权限泄露、重复收费、取消语义漂移或持续延迟/错误率升高时，先停止Surplus新流量，保留已记录调用事实。
- 使用经验证的兼容应用版本或受审阅forward-fix。不得恢复把所有非OR写进Venice的旧交付函数，不DROP新表、不改历史账单。
- 请求/响应ID写结果未知：确认读回与原charge key，不能重发收费POST作为恢复。
- 可选诊断写入失败不改变已确认业务终态；若进程在异步诊断确认前退出，缺失字段保持未知，只按可确认request ID补齐，不能伪造原响应。
- 应用回退保留新增表/约束兼容扩展；恢复生产配置仍走CLI草稿/diff/明确确认流程。
