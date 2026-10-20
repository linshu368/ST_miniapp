# T11 catch-up 生产超时恢复（2026-10-20）

## 范围与结论

用户要求检查并修复。只读核对生产/TEST、准备本地 forward migration 与验证；未远端写库、未提交/推送/部署。原Admin preview文档和问题汇总保持原样。

- Action [39367671410](https://github.com/linshu368/ST_miniapp/actions/runs/39367671410)，main/ca44cd17，Production，04:07:53Z BEGIN，04:08:04Z 前置DO完成，04:09:04Z 候选CTAS statement_timeout。失败尚未到 INSERT/UPDATE，业务事务回滚。
- Production ref wbtsfzozlmurljvglhpn 经 get_project 确认 ACTIVE_HEALTHY / PG17.6。catalog 主表估算351943、heap638074880B、total23810236416B；两专表 parent unique 索引都在，不能归因于缺失 JOIN 索引。
- 正式连接取自既有服务的production变量，进程内校验DATABASE_ENV/URL/ref，只读事务与15s statement/2s lock timeout；不输出连接串、业务ID、正文或raw JSON。
- Production 原catch-up无成功ledger/event；有同checksum claim，claimed_at=2026-10-20T04:05:37.065Z。TEST原catch-up已记账，checksum均9473b079cbd1922777fef8deb8764a3d3349ff99a8f10de513fcf4958e0d957a，不能修改。TEST主表DROP已于2026-10-19T03:01:25.352Z记账，checksum d1b410064f06b63a40a9c15a9b8148e3e43cf3cfdbadaba198b60fcbd7766852。

## 查询证据

原SELECT的EXPLAIN为主表PK Index Scan + OR parent unique Index Scan 的Merge Left Join，再Merge Anti Join Venice，估算候选约249837；实际SELECT在禁用merge join后7.403s完成，Hash Left Join/Hash Anti Join，实际2815候选。原计划的随机heap访问是主要可疑瓶颈，这是依据计划与替代实测的判断，没有重新执行原60s重查询取得逐节点实测。备选读取69727 shared blocks并使用12234 temp blocks，不能把hash join描述为零成本。

随后13.172s只读分类聚合（含客户端往返）：候选2815、全部有主表generation ID、无ID可靠归属0、未知无ID0、Venice snapshot冲突0。该数量是12:18左右的瞬时快照，不代表发布时覆盖或writer已退出。两环境不可视为同构；TEST原候选查询因列已删除返回42703，已确认其contract分支需要安全跳过。

## 本地修复

新增 `20261020_openrouter_retirement_catchup_recovery.sql`，取代本次生产原catch-up操作：

- 原SQL、账本工具、成功账本和失败claim不改；新文件成功只记自己的ledger。原claim同checksum不允许abandon_claim，不制造原文件成功记录。
- 候选阶段临时禁用merge/nested loop以使用已测hash计划，随后恢复原会话值；仅物化ID，LIMIT4001先做总预算检查，不把LIMIT误当扫描成本上限。
- 每批最多2000，最多两批，总数>4000拒绝；保留单事务60s、锁5s。总预算针对2815实况重新设计，原迁移2000上限不变；此本地方案需最终审阅，非生产执行许可。
- 只填canonical NULL，合法0保留，新事实优先；不搬raw JSON/业务终态/正文/账务。候选parent加share锁避免复制过程中被改；竞争的非空ID不覆盖，写后再次核对ID与provider重叠。旧writer退出仍为执行前提。
- 两批任一失败全部回滚；不自动重试。表/12列shape异常拒绝。12列全不在时，仅精确匹配已审阅DROP账本才跳过，便于当前TEST安全执行；部分删列或账本缺失/漂移拒绝。

## 验证

扩展既有 `scripts/test-openrouter-retirement-local.sh`，无新增测试文件。隔离PG17+真实PostgREST覆盖2815合成记录跨批（连既有3候选共2818）、第二批异常使第一批回滚、4001预算拒绝且无写入、ID/provider/snapshot冲突、NULL/0、重复运行保留canonical、未知归属不写、父行逐字段不变、真实双处DROP后的repository、DROP账本缺失/匹配/部分shape分支。原catch-up仍在同一harness执行，确保兼容。

本轮验证通过：`pnpm -r typecheck`、`pnpm -r --workspace-concurrency=2 --if-present build`、Shared 147测试/15文件、`pnpm lint`、`pnpm lint:migrations`、`pnpm lint:legacy`、`pnpm test:migration-ledger`、task validate、module_knowledge check、bash -n与git diff --check。Admin构建只有既有chunk体积提示。PG/PostgREST及ledger测试最初被沙箱拦截本机端口/socket，获准后重跑成功。未改Backend/Frontend/Admin产品代码，没有额外运行Backend全套单测；受影响数据库行为通过真实repository+PostgREST集成验证。

最终新增SQL checksum：5570fd84fcced55986a6b9ccec5852b4a56b90a6974eb202196eb886a70b4f9c；原catch-up checksum仍9473b079cbd1922777fef8deb8764a3d3349ff99a8f10de513fcf4958e0d957a。该本地成功不能证明生产整份恢复SQL已通过60s，也不能证明后续处置SQL的2000预算适用生产。

## 正式恢复顺序与停止条件

1. 人审最终文件/预算/验证后，单独授权提交推送与正式workflow。TEST当前已contract，会核对ledger后skip；历史pre-contract行为由隔离真实PG验证。
2. Production执行前独立确认目标、旧writer退出、candidate<=4000、无冲突、磁盘/WAL/复制与流量窗口；本轮未采集磁盘余量或复制滞后。
3. 正式workflow只apply新增恢复文件，force_rerun=false。不要再跑失败的旧catch-up，不abandon/删除同checksum claim，不改旧ledger。旧claim继续作为失败审计线索，与新恢复ledger一起解释。
4. 核对新增ledger/checksum/event、只读缺口/身份/provider与业务不变量、锁/耗时；再独立审阅provider views、历史JSON处置、别名及主表DROP。后续文件仍可能有各自超时/2000预算，不因本次恢复放行。
5. 超时、锁、>4000、冲突或结果未知停止，核对rollback/shape/ledger/claim；不force_rerun扩容、不补扣、不伪造结算。成功保留加法事实，回退应用只能使用已验证兼容schema版本。
