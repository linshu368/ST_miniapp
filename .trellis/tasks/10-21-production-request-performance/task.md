# 任务分解

状态：规划文档待审核，未开始业务实现。已纳入 Sentry E18 慢问题排期。

## 当前交付

| ID  | 状态    | 工作/范围                                                      | 依赖 | 验证                                                         |
| --- | ------- | -------------------------------------------------------------- | ---- | ------------------------------------------------------------ |
| D1  | Done    | 规范/源码/依赖调研，主文档 E1–E17                              | 无   | 区分 CODE/DOC/HISTORY/GAP                                    |
| D2  | Done    | 主文档及 PRD/design/implement；补充四主线                      | D1   | 首载、进入会话、回复、连接治理及回滚                         |
| D3  | Done    | 前次补充后的文件静态验证                                       | D2   | 引用、格式、JSON、diff、边界                                 |
| D4  | Done    | **Sentry 生产归纳写入主文档 §1.1/E18/§7/§8 与 Trellis 规划** | D3   | R9 批次齐全；指标含快照；状态仍 planning                     |
| D5  | Done    | **Sentry 驱动优化设计**（`design.md` 分批方案 + 主文档 §9）   | D4   | 根因/首选改法/验收/回滚齐全；未写产品代码                    |
| G1  | Blocked | 用户审核 design.md §7 门禁、预算与测试范围                     | D5   | 审核后才允许 task start                                      |

## 后续候选任务（未授权；按 Sentry 优先级）

| ID            | 状态 | 工作/范围                                                                     | 依赖                        | 验证                                                              |
| ------------- | ---- | ----------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| P0-A          | Todo | 固化 E18 基线 + L/N/S/C 分段观测                                              | G1                          | 分阶段耗时/错误率、无秘密；Sentry 查询可复跑                      |
| P0-C          | Todo | 全服务连接容量表（含 PostgREST/≈300s）、异常释放与饱和保护                    | P0-A                        | 区分本地池/pooler/PG/HTTP 超时；审核 TEST 故障与恢复方案          |
| P0-B          | Todo | 大厅等待/取消/失败 UI，必要读 signal（防 60s 挂死）                           | P0-A                        | headers/body 挂起、总预算、写入未知                               |
| **P1-L-N1**   | Todo | **`/chats` N+1 API → characters/\***（ST-MINIAPP-1Y）                         | G1                          | Issue/请求次数下降；列表正确                                      |
| **P1-L-TAIL** | Todo | **characters / latest-badge / favorites 长尾 + Supabase users**               | P0-B 规划、慢 trace 抽样    | p95 长尾下降；p50/错误率不恶化                                    |
| **P1-N-DETAIL** | Todo | **`GET /api/characters/:id` 长尾 + N+1 Query**（ST-MINIAPP-3M）             | G1；可与 P1-L-N1 并行       | p95 与 Issue 同降；可见性不变                                     |
| **P1-S-HTTP** | Todo | **messages → current_chat_history Consecutive HTTP**（ST-MINIAPP-2G）         | G1；与 LLM 分段拆开         | 连续调用下降；计费/取消正确                                       |
| P1-N          | Todo | E14–E17 入口缓存/创建预算、开屏退场及旁路负载                                 | P0-A、交互/写入未知方案审核 | 新建/历史、请求次数、ready→可交互、防重复与恢复                   |
| P1-A          | Todo | 请求内配置/设置复用与条件更新                                                 | P0-A、prepare 段收益证据    | 版本一致、权限/计费不变；不把 LLM 总时长当收益                    |
| P1-B          | Todo | 排名缓存刷新合并/有限陈旧策略                                                 | P0-A、运营审核              | 并发、失败、空快照、随机化                                        |
| P1-C          | Todo | E9–E11 预算内连接/超时、后台竞争和异常清理；验收 supabase_rest_gt5s_count     | P0-C、TEST 对照             | 普通请求不被饿死、连接回落、PostgREST 慢调用同降                  |
| P1-S          | Todo | 首字之外的流速/绘制/终态定点优化                                              | P0-A、非 LLM 瓶颈证据       | 完整正文、流式节奏、终态/取消/计费正确                            |
| P2            | Todo | 有证据的 SQL/索引、隔离部署或容量调优                                         | 核心批次不足、另审设计      | 锁/容量/回滚、消费者校验                                          |
| **P2-X**      | Todo | **webhook / miniapp-entry 慢**（E18 旁路）                                    | 四主线核心后另审            | 不阻塞主线；单独范围                                              |

具体证据与指标见 `docs/production-request-performance-plan.md`（§1.1 / E18 / §7 / §8）。

## 执行记录

- 2026-10-21：task create --no-start 创建规划任务，保持 planning；业务文件未改。
- 2026-10-21：核实 Prisma/client 6.19.3；记录大厅超时缺口、AI 重复规则读取、排序事务及历史支付 P2024。
- 2026-10-21：前轮记录曾报告官方网页获取及 40 处引用等检查通过；本次不据此前声明认定补充后的文件通过，网页未重新获取，检查重新执行。
- 2026-10-21：按最新反馈补齐进入会话独立主线，回复覆盖完整流式周期；连接治理提升为 P0-C/P1-C 核心项。回读确认已有路由预取、创建缓存回填、详情 staleTime=0、开屏 240ms+720ms 定时器、空会话复用及 unlock 异常可能跳过关闭；均不冒充生产根因。
- 2026-10-21：本次验证有可见输出：Prettier check 通过；45 个去重绝对文件引用存在、缺失为零；JSON status=planning；task validate 通过（两个 manifest 均 0 条，仅证明上下文清单校验，不代表业务方案审核）；git diff --check 退出码 0，status 退出码 0 且仅本任务目录/主文档未跟踪文件。新增文档由 Prettier 与回读另查，不把 diff --check 当作未跟踪文件检查。初次引用命令受 shell 引号影响失败、第二次路径分隔符不一致得到 0 个引用，均未算通过；修正后以 45 个引用输出为准。未新增秘密/业务行或产品代码；应用 typecheck/test/build 和生产验证未执行，纯文档检查不代表性能已改善。
- 2026-10-21：**Sentry MCP**（`wangqiao/st-miniapp`，de，production，7d）归纳写入主文档与本任务：高优先 N+1/长尾/PostgREST 超时；新增批次 P1-L-N1、P1-L-TAIL、P1-N-DETAIL、P1-S-HTTP、P2-X；LLM messages/regenerate 标为业务特性低优先。状态仍 planning，未授权实现。
- 2026-10-21：**完善实现设计（D5）**：回读 `/chats` 逐行详情、characters 详情全量 id 扫描、favorites 全表金框、`getContextBeforeTurn` 双 GET、supabase 无 timeout；写入 `design.md` 首选改法与实施顺序；主文档增 §9。仍不实施、不 `task start`。
