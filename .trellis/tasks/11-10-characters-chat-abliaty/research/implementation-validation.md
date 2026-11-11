# 实施与验收记录（2026-11-11，进行中）

用户已要求开始执行，随后要求整项完成后自动归档。任务已 start；归档必须等待整项验收，不把本地实现完成、待发布或兼容 fallback 阶段当作 AC17–21 完成。

## 已实现

- B3/B1：两份 experience 扩展迁移、小投影、原 admission 原子维护、旧 writer 轻量失效、K+1 窄键分页、有限回填与写恢复脚本；专用 repository reads/mapping/billing，旧 facade 和公开 DTO 保持兼容。GET owner 在先，恢复/开场白并行，分页只读有限恢复和分段诊断。
- F1/F2/F3/F4：无 findLast 查找，引导在 enrich 动态加载，根错误原址 reload，清理 URL 前捕获原始签名身份，失效提示；Android 目录 4 秒总预算覆盖队列/fetch/body/解析，超时不落缓存。没有新增自动 POST 重试。
- B2：精确额外来源配置，合法预检、受控 403、无 Origin 与开发/TEST 行为；正式域名的部署配置仍需单独应用。
- 运维恢复位于唯一 migration 来源的 `maintenance/` 子目录，不加入 schema-ledger 队列。执行前确认环境和容量，不能通过 MCP 写库。

与设计补充：原 admission 是 SECURITY INVOKER，因此小表授予 service_role SELECT/INSERT/UPDATE，不能仅 SELECT；保持原函数安全模式优先于原规划中不充分的权限描述。小表为可重建数据，没有 DELETE 授权给 service。补丁及逆补丁统一 LF、严格唯一锚点，保留其他函数行为。

## 隔离 PostgreSQL 17

本机原无 Docker/psql，改用官方 PostgreSQL Windows 17.11 可执行文件，临时集群仅监听 127.0.0.1:55439。harness 每次创建随机数据库，结束删除；数据全是 fixture，不连接 Supabase，不调用模型或真实账务。

顺序与并发回归通过：原分支/当前 revision/继承/编辑删除/点赞/上下文，逐字段一致、所有页面无缺失重复，NULL 与 Unicode trim、原始 request 文本，真实 admission 的 placeholder→full→初始重放、失败后 history/投影/observation 原子回滚，旧 writer 及同值写入失效、行锁跳过后重访、有限回填、逆补丁撤回及重新启用、owner/权限/RLS、账户硬删除级联。新迁移重复应用亦通过。

运行命令：`ST_CHAT_PG_BIN=<portable-pg-bin> ST_CHAT_PG_PORT=55439 bash scripts/test-conversation-branches-migration.sh`；加 `ST_CHAT_BENCHMARK=1` 做基准。Windows 需使用 Git Bash，不能误用不可用的 WSL bash。

## 读取性能证据及限制

虚构 10/100/1000/10000 轮，每轮 128 KiB 高压缩 prompt、最新轮多个 revision，暖缓存，序列化整页结果；每个新路径组 100 次。下表为一轮与其他本地构建/页面测试有重叠的结果，不能作为严格无退化对照；单样本旧路径只报告耗时，不冒称 P95。

| 轮数  | 新页 P50 ms | 新页 P95 ms | 旧页样本数 | 旧页 P95 ms / 单次耗时 |
| ----- | ----------- | ----------- | ---------- | ---------------------- |
| 10    | 1.614       | 2.964       | 100        | P95 7.044 ms           |
| 100   | 2.906       | 5.285       | 100        | P95 22.404 ms          |
| 1000  | 3.138       | 5.728       | 100        | P95 130.402 ms         |
| 10000 | 2.700       | 5.042       | 1          | 单次 760.211 ms        |

该轮新路径 10000/100 轮 P95 比值约 0.95，低于 2；全分页访问到最早页，数量精确匹配。代表性选键计划为 Index Only Scan Backward → Group → Limit 26；最终计划读取 51 个索引候选（包含写入基准追加的 revisions），不存在整会话 JSON 投影前置。

最终复跑未并发构建，但前段与短 UI 复验重叠，仍不等于受控专用压测环境：新页 P95（10/100/1000/10000 轮）为 5.968/6.825/5.896/23.246 ms；旧页分别为 P95 8.084/32.485 ms、28 次中最大 360.598 ms、单次 639.442 ms。旧页不足 100 次的组不报告 P95。此次 10000/100 比值约 3.41，超过约定的 2；即使绝对 SQL 耗时低于 200 ms，也不能把增长比例门槛判为通过。需要进一步隔离负载、分析整页执行计划和采样分布，而非挑选较快的一轮结项。

此前一次相同 128 KiB fixture 的新路径 P95 为 10/100/1000/10000：11.228/9.573/8.249/8.402 ms，旧 10000 轮单次 2691.193 ms。另一轮 1 MiB fixture 的旧路径重复对照触发 180 秒整组 statement timeout，已停止；这不是某一次线上 SQL 的 180 秒耗时。结果说明机制和增长趋势，但硬件负载、压缩率/正文大小、连接和线上容量仍须分别评估。

## 写入性能门槛仍未通过

已将原 admission 函数体复制为仅本地 fixture 基线，交替采集原/新 admission+freeze 与 terminal+原 session-stats，各组 100 次。基线仍处在扩展 schema 下，包含失效 trigger 的空查找；且同期有构建负载，不能当作旧生产版本完整对照。

| 轮数  | 原/新 admission+freeze P95 ms | 原/新 terminal+stats P95 ms |
| ----- | ----------------------------- | --------------------------- |
| 10    | 7.948 / 9.314                 | 9.237 / 9.690               |
| 100   | 4.859 / 6.187                 | 7.042 / 6.846               |
| 1000  | 8.537 / 10.002                | 25.748 / 25.193             |
| 10000 | 14.866 / 20.182               | 245.005 / 314.916           |

新增投影存在写维护成本，原统计触发器成本也随长会话增长。**不能凭读取变快宣称正常回复不退化。**须在隔离负载下重新比较完整新旧链路及并发回填，再按证据优化；正式 provider/准备/首字与 Android/iOS 成对指标仍为未验证。现阶段不切换生产新读取，不归档。

最终复跑原/新 admission+freeze P95 依次为 8.521/12.742、8.385/10.028、6.594/9.311、4.885/6.699 ms；原/新 terminal+stats P95 为 9.917/13.023、13.148/13.807、25.981/22.296、81.105/82.816 ms。写准备的额外成本再次出现，严格无退化门槛仍未通过；较早一轮构建竞争不是全部原因。

## 应用检查进度

- Backend：默认范围（排除 integration）135 文件、1490 测试通过；在构建并发负载下重复子集曾出现首个 buildApp 导入超时和连带 mock 污染，无构建竞争的相关 5 文件 88 项复跑通过。随后补充精确投影身份/NULL/继承断言，所在文件 23 项通过。
- Frontend：68 文件、746 测试通过；截止预算/身份专项 20 项通过。Shared：18 文件、222 测试通过。
- 全仓 typecheck、Frontend lint、复杂度与 migration 命名检查通过；lint 仍有无关文件的既有警告。复杂度只收紧本次 app/repository/routes 条目。
- 全仓适用 build 已通过。重复构建时曾再次出现本地 Next `webpack-build/impl` 缺失；`pnpm install --frozen-lockfile --force` 从锁定依赖修复，锁文件未改。依赖文件为何缺失尚未定位，不归因于产品源码，也不作为性能验收证据。
- 最终源码状态的 Frontend 生产构建、全仓 typecheck、直接 ESLint import 检查、复杂度、migration 命名、模块知识载荷校验及 PG17 完整回归均再次通过。`pnpm lint:imports` 在本机 PowerShell 有既有引号参数问题，使用相同 ESLint 配置直接执行通过。
- Build manifest 确认 ChatGuide 两个 chunk 不在聊天初始 route 列表（当次大小 5498 + 7656 字节）；不把该构建结果当真实页面 P95 改善证明。
- 本地 UI `@chat|@roleplay` 共 62 项：全量一次 59 通过、3 个 Android 首次加载超时；针对性复跑恢复点赞与 200 轮完整历史用例。慢主调用用例另发现断言早于 SSE 终态落库，复用既有“取消本次回复消失”终态等待后，Android/窄屏 2 项均通过。合并全量及针对性结果覆盖 62 项，不能描述成单次全量无失败。200 轮零缺失/零重复、无 findLast、草稿保持与既有编辑/删除/分支/点赞/回复流程均已覆盖；不使用 fixture 宣称真机通过。

一次执行 Vitest 全目录时误包含默认排除的真库集成测试：目标核验为正式 TEST `zoqelpfhurwehlvypryl`，4 项因新 migration 未安装失败。该套件创建的虚构用户已由 afterAll 清理，按本次时间窗与专用 history-test 前缀核对剩余数为 0；未执行远端 migration 或生产写入。后续使用默认排除规则，不绕过正式 TEST 迁移流程。

## 剩余硬门槛

完整 prompt/压缩率/继承矩阵的独立性能对照、真实 PostgREST/GET P95、写入/统计成本不退化、构建前后严格基线、正式 TEST 逐文件及生产容量/覆盖、Android/iOS 同设备同网络及普通聊天/并发翻页/回填场景、真实键盘/provider/计费验收和发布后观测。样本不足保持 NULL；不把兼容 fallback 或缺迁移跳过测试当作完成。

本地临时 PG 集群已停止。没有提交、推送、远端迁移、部署或归档；`task.json` 保留 `in_progress`、`archive_after_completion: true` 和 `archive_ready: false`。下一阶段先定位读取比例波动及原子投影写成本，重新验证完整读写链路；硬门槛通过后再按正式环境流程验收，整项完成才执行归档。

## Follow-up validation status ? 2026-11-11

The user confirmed both 20261111 chat history migrations were applied to TEST; strict-TLS catalog preflight verified their presence. Earlier missing-migration failures above are historical, not the current blocker. The user chose to retain the direct network and ultimately changed local mobile sampling to 20 per platform/page/API/scenario with P95 <= 2000ms. Conditional lobby projection reads passed actual disposable local PostgreSQL 17 integration checks; the final Backend suite passed 138 files / 1513 tests, all workspace typechecks passed, and complexity checks passed. New dual-engine TEST run 2026-11-11T08-53-44-755Z is in progress; no performance acceptance, production deployment or archive claimed.

## Final scope update and completion review — 2026-11-11

User withdrew the local mobile performance mechanism and mandatory gates; 11-11 is paused. No further sampling is required through that mechanism. See completion-review.md for this task’s independent status. After removal: workspace typechecks, Python25, complexity, migration names and module/context checks passed. Frontend full run744 passed/2 setup-timeout skipped, then2/2 isolated passed; Backend1500 passed/4 failed during competing checks, then all51 tests in both affected files passed in isolation. No test deadline was changed. Core implementation remains present, while historical projection coverage, write/no-regression evidence and actual rollout remain unfinished. No production deployment or archive.

User clarification: mandatory future local performance runs are withdrawn, while pre-existing planning/quality gates and task-specific acceptance are preserved. Original task creation defaults and start declaration validation restored; 11-11 remains paused. Earlier broad gate-removal description is superseded.
