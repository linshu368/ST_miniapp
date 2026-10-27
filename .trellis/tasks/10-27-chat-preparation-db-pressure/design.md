# 设计与内联审核

## 证据与复用
生产 chat_history 约 35.8 万行，含历史快照/索引共 23 GB（不是每次都读取 23 GB）。billing.chat_delivery_billing_gate 自 20261026_first_token_visible_billing 引入按 llm_charge_id 查找；TEST/PROD 均无索引。2026-10-27 EXPLAIN 为 Parallel Seq Scan；charge_llm_usage 是累计物理读取最多的 SQL。13:00 后上下文查询 p95 约 3–4 秒；服务 CPU 未饱和。累计统计不能冒充当前窗口或独占因果。

复用 ConversationHistoryRepository、现有取消轮询、现有 migrations workflow/账本；不新增框架、状态源、公开 API。先解决有直接证据的扫描及宽轮询；随后检查独立准备/观测可并行边界。

## 数据归属/容量/恢复
experience.chat_history 保持唯一事实源，新增非唯一部分 B-tree 索引 llm_charge_id IS NOT NULL，服务 billing 资格查询及后台结算；不改业务行、约束、权限、收费函数。CONCURRENTLY 两次有界扫描，不能包 BEGIN；lock_timeout 5s、statement_timeout 5min，maintenance_work_mem 32MB、禁并行维护以限制瞬时负担。索引失败/无效停止，先互证 shape/账本再审核恢复，不盲重跑或自动 DROP。旧应用兼容，回滚应用保留索引；确需移除单独 DROP INDEX CONCURRENTLY，不能锁表重写。

## 最小方案与正确性
取消只读取 status,llm_finish_reason，仍以持久化状态跨副本仲裁，保持原 1 秒间隔/5 秒单查询超时。不会以进程缓存替代取消真相。必需账单/额度/身份写仍须在外部调用前可靠保存；日志、用量补录不能重新进入首字路径。并行优化在现有 try/finally 内处理全部 Promise，失败不得产生未处理拒绝或越过计费门禁。

## 验证与发布
既有 repository/cancel/lifecycle 回归，backend/shared test/typecheck、migration lint/imports。TEST 单文件 migration 后检查 valid/ready/列/谓词，EXPLAIN 等值存在/缺失参数；真实 TEST 离页恢复、计费一次。CI 后 dev 合并→仅聊天 main；生产单文件迁移及版本/健康验证。异常停止，不修改上限掩盖问题。生产 before/after 用有界日志与计划，不扫业务表。内联审核：索引是必要当前修复；不引入缓存失效或数据重构。
