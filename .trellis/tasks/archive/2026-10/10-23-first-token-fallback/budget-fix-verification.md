# 2026-10-26 首 token 预算修复验收（发布候选）

状态：本地实现/验证完成，尚未提交、推送、远端迁移或应用发布。旧版业务数据不能用来评价此候选效果。

## 已确认需求与交付

- 首发实际上游POST派发后默认最多4000ms；兜底自身POST后默认最多2000ms；浏览器提交到首个可见token默认10000ms硬限。
- 思考已开启时真正可见的思考算首字；静默思考不豁免。首发即兜底只请求一次，但首发上限仍执行。
- 总限优先。异常前置开销导致预算不足会缩短/跳过首发；切换/网络/显示仍可能耗尽总限，实际分段如实记录。
- 原价和权益一次结算，阶段/总截止释放免费额度；完成/取消并发仍走已有CAS。
- 运营平台统一配置兜底型号、首发/兜底等待、总上限及1%目标。代码默认10秒不会自动覆盖已有显式6秒，发布必须显式设置。
- 没有AI自动调参；默认兜底仍为deepseek/deepseek-v4.1-flash-1017，可人工修改。

## 主数据口径

1. 无字时间截断率：前台一个正文/已开启思考token都没有实际显示、因首发/兜底/用户总限制终止的请求，除以前台已知结果（已显示＋时间截断＋其他上游失败）。上游错误单列，不混入分子；主动取消、后台、离页和缺报不算成功。
2. 点击到首token分布：前台已显示记录的同一浏览器单调时钟时长，包含全部前置、网络、首发、切换、兜底与显示。0–1/1–2/2–3/3–4/4–6/6–8/8–10/10秒以上左闭右开，另保留各型号P50/P90/P95。
3. v2默认、v1历史独立。保留请求量、已知结果占比、回报覆盖率和缺报数量。无字不填0秒；不能只凭成功分布宣称改善，也不能凭缺报下界宣称达成1%。
4. 仅覆盖已受理的有型号请求；开轮前鉴权/配置失败或离线点击不冒称已覆盖。两帧DOM可见是浏览器显示近似，不是物理屏幕确认。

## 已执行验证

- 本轮前序全套：Backend 99文件852项、Frontend 50文件378项、Shared 17文件176项、Admin 13文件121项均通过（1527项）。之后补边界回归并重跑受影响测试；不能把前序计数冒充最终全套计数。
- 最后定向回归：Backend计时/计费/生命周期/错误/路由97项；Frontend hook/observer30项；Shared全套177项；Admin配置/差异17项。新增计时器迟到回归后，再跑计时/计费60项通过（含在前述97项中的既有用例，不重复加总）。
- `pnpm -r typecheck` 全5包通过；前端和Admin生产构建通过。lint、跨包import检查、历史引用守卫、migration命名守卫、差异空白检查通过。前端有既有img优化警告；Admin保留既有大包警告。
- PG17一次性容器实际执行新迁移两次，验证旧行NULL/身份冲突/首次回报/预算冻结/完整SQL与PostgREST repository集成4项；既有VIP/钱包/额度T2/T3/T4/T3A/T6/T5及migration ledger检查通过。没有读取env或远端业务数据。
- 所有Grafana面板SQL执行v1/v2与多选/全选参数。5请求对照：1显示7200ms、1兜底超时7200ms、1总截止10000ms、1上游错误3000ms、1缺报。断言已知结果4、时间截断率50%、所有无字失败率75%、缺报1、耗时分布6–8秒占100%。
- 实际Chrome155运行生产可见性函数7场景全部通过：短文、单文本节点长段尾部、思考自动滚动均可见；仅空白行、纯空白、display:none、opacity:0不算可见。截图保存在本机，不包含用户正文。
- 计时回归覆盖：前置/路由不吞POST后4秒、兜底POST后2秒、headers慢触发切换、总限优先、同型号只POST一次、静默思考切换、公开思考首字后长回复、阶段失败不扣费并只释放一次额度、长段可见性和晚绑定身份不延长测量。

本机日志：`/private/tmp/st-first-token-{backend-all,frontend-all,shared-all,admin-all,backend-final,stage-final,frontend-final,shared-final,admin-final,typecheck-release,lint-release,imports-release,frontend-build,admin-build,sql-release}.log`。截图：`/private/tmp/st-first-token-visibility-fixed.png`。

## 发布前只读核对

- dev分支仍为812273caa334756a98f2354a30843dcda4a29ffe；候选基于此分支，与原本地用户改动隔离。
- 生产Supabase ST_telegrambot为ACTIVE_HEALTHY；已确认新3列尚不存在，既有begin/report/analytics函数为security invoker。Grafana reader可读facts、不可读assistant_reply、不可UPDATE请求。
- Grafana线上仍是旧7面板，数据源健康检查返回Database Connection OK。新8面板尚未上传。
- Supabase connector无法访问TEST project（Project not found）；不能由此推断TEST已删除。正式Database Migration workflow既有TEST/production发布成功记录，发布时通过该工作流验证TEST，失败即停，不跳过TEST。

## 授权后执行顺序与停止条件

1. 按最终文件清单提交/推送修复分支，创建以dev为目标的PR；等Quality Gate通过，并完成下一步TEST迁移后再合并，防止自动部署先于数据库。
2. 新文件`packages/shared/migrations/20261026_first_token_stage_budgets.sql`只经正式Database Migration工作流先TEST执行并inspect，检查新增shape/ACL/关键RPC和新报告。
3. TEST部署Backend/Admin，运营配置仅将既有catalog的总限改10000、兜底预算2000；逐型号核对首发4000及默认1017，保留未授权的模型/定价/路由字段；部署Frontend并验证公开配置。
4. TEST实际发送/重生成、普通/思考、超时、安全取消、一次结算和客户端v2落表验收。真实模型可用性/真实WebView仍是发布验收项；本地mock不代替。
5. TEST通过后，先执行生产迁移并inspect，再合并/发布生产应用；顺序为Backend/Admin、运营显式配置、Frontend；核验实际部署SHA与生产公开10秒配置，确认新数据stage/visible/measurement_method一致。
6. 更新现有Grafana同UID看板，保留数据源凭据和只读权限，逐面板查询/秒数百分比/默认v2/单型号筛选验收。记录切换时间，供后续观察窗口使用。
7. 迁移/计费/取消/回报/可见性验收任一失败停止后续发布。保留新事实和列，不删业务数据；应用/配置回退沿已审核版本，不更改分支保护。延长到10秒与修正测量都可能改变统计，不能把阈值变更导致的下降全归因工程改善。

## 未完成及不能宣称

正式CI、TEST远端迁移与实际模型/WebView验收、生产发布、实时v2看板显示仍待授权后执行；当前不能宣称已经上线或达到1%。
