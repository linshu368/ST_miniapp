# 执行计划与验证

## 状态与前置门禁

当前仅planning，尚未运行task.py start或改产品代码。根AGENTS、workflow与trellis-brainstorm要求最新规划摘要由用户后续消息批准后才能实现。Codex inline模式由主会话写代码；research代理只读，不派发implement/check代理。

## 顺序

1. 完成需求收敛与最新摘要审阅；确认task.json module_impact，再start。清洁feature分支基于origin/dev。
2. Shared先定义型号阈值默认4000ms/全局首token上限6000ms/人工超时率目标0.01及其校验、请求/attempt/first-token report/人工聚合DTO与导出；明确公开catalog omit内部字段。更新受理ResolvedModel快照。
3. 新增唯一forward SQL：catalog validator窄扩展、experience request/attempt及窄交付选择/回报写入、analytics projection/窗口聚合。先有八域说明，再写SQL；不改历史文件、不运行远端。
4. Repository复用getDomainDb与既有有限超时/幂等模式。新增事实写入、首次ID、选择交付及client report；仅交付attempt投影旧provider表。
5. generation execute内部实现有限primary/fallback、首token I/O前观测、固定兜底请求体、独立后台观察、整轮取消。保留precheck/quota/原价快照和单chargeId。
6. generate/settle/apply-charge/sync对接交付身份，测试OR→OR与Venice→OR、迟到观察、取消、重启恢复、同原报价结算。此步骤未经验证不得交付。
7. Admin新增每型号默认4s、全局6s/1%人工项及编辑/变更摘要；保存/发布/恢复使用现有链路，环境隔离保持。
8. Frontend在runTurn单调计时并独立执行6秒首token截止（不因fallback重置）；到期温馨提示重试并经既有取消确认避免重复发送。AssistantReplyBody可见首token绘制接缝上报；send/regenerate同口径，短回复done在前也能上报。通过lib/api，不在组件直接fetch。
9. 人工24h报表与Grafana导入JSON/SQL：分母、覆盖率、149/150、阈值分组、厂商对照和工程阶段。保留后续AI可读结构，不接AI/cron/自动写参数。
10. 运行下述验证，记录真实结果/限制；更新README、ARCHITECTURE、相关spec与module-updates；最后呈现diff与测试结果。未经单独授权不commit/push/迁移/部署。

## 自动回归矩阵

- 配置：旧字段缺省型号4000ms/全局6000ms/目标0.01；型号阈值须小于全局上限；新增/编辑/恢复保留；NULL/字符串/非整数/非正/超过整轮上限拒绝；公开catalog不泄露字段。
- 调用：全局6秒包含前置准备，准备慢时也按时取消；首发4秒后fallback仅用剩余预算；后台primary在5.5秒到token而fallback未交付仍在6秒终止；交付首token已出则后续生成不受6秒截止影响。首token在阈值前/同刻/后，headers/empty/reasoning不解锁；ID写慢不误判模型慢；fallback只一次且不继承首发routing/cache；首发已等于fallback不重复派发。
- 观察：fallback已开始后的primary token/错误/超时只更新attempt；不混字、不释放交付额度、不改变done；观察timer在用户回复收尾后仍有界；进程中断标unknown。
- 账务：原型号light/standard/premium、VIP、免费/付费、余额不足；一次chargeId、一次预留/结算；OR→OR与Venice→OR只一交付provider；重复sync不多扣；业务取消不被vendor stop覆盖。
- 客户端：send/regenerate、empty/control markup、实际可见文本、短回复done先于DOM、隐藏返回/离屏、请求替换、离页、重复回报、错误身份、回报失败；不把onDelta当已显示。
- 数据：同请求两个attempt去重；精确/删失/unknown与缺报NULL；149/150按型号总体；同日多阈值/目录版本；窗口边界/时区；分位数带n与coverage；主观察耗时不重复相加。
- SQL真实隔离回归：FK/unique/check/identity、invoker/RLS/REVOKE、最小service/reader ACL、交付CAS+provider投影原子性、配置draft/publish/recover完整路径、结果未知读回、迁移重复执行。

## 适用命令（实现后运行）

```sh
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/admin test
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/backend exec vitest run src/features/generation/execute.test.ts src/features/generation/upstream.test.ts src/features/generation/settle.test.ts src/features/generation/sync-job.test.ts src/features/generation/apply-charge.test.ts src/features/generation/quota.test.ts src/features/conversations/generate.test.ts src/features/conversations/generate.lifecycle.test.ts
pnpm -r typecheck
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin build
pnpm lint:migrations
pnpm test:migration-ledger
```

Backend以tsx运行且无独立build脚本，使用typecheck和相关测试；Frontend/Admin执行build。必要时增补相关repository与高风险回归，避免为低影响默认值创建镜像测试。SQL复用scripts/test-openrouter-retirement-local.sh及admin harness的隔离模式，按需增加本功能最小bootstrap/fixtures，不改原测试含义。

## 浏览器人工场景

通过mock upstream/本地隔离环境核实首token可见观测、阈值切换、迟到首发、空白/Markdown控制片段、短回复先done、隐藏后返回、取消与重生成。用截图/录制与client report关联；Node单测不能证明真实layout/paint。真Telegram/真provider/TEST与Production验收分开标注，不能以mock代替。

## 当前限制与停止条件

- MCP当前可见项目不含仓库TEST ref；本轮无远端迁移授权。
- 本机Node v25.7.0、pnpm9.15.9；原生PG客户端缺失已由隔离Docker PG17替代，完成真实SQL/权限与既有账务、台账回归；PostgREST接线单独验证，绝不改连生产。
- 任意重复扣费、两provider冲突、取消覆盖、观察流进入用户内容、client缺报伪造0、provider单位不明仍硬做差值，均停止交付修复。
- 未作产品改动前不运行无关全量测试；本轮文档准备不冒称代码或SQL通过。

## 2026-10-23 追加执行

用户本轮已明确要求实现此扩展，沿用当前任务。顺序：共享与编辑契约 → 请求冻结/路由传递 → forward迁移 → 运营独立界面复用发布 → 既有测试与文档。迁移和供应商路由身份为高风险，扩展既有回归锁定；低影响界面只做构建和人工渲染验证，不新建测试文件。无远端操作、提交或部署。

## 追加执行：Grafana读授权与业务看板

沿用已审核设计和本轮明确授权：1) 角色/列级ACL只读前置核验；2) 原reader授权前向迁移、业务看板JSON、既有PG17 harness扩展；3) 实际PG17角色与全部SQL回归，静态检查；4) 呈现最终文件清单供仓库提交审核；5) 提交推送，正式workflow先TEST后production逐文件执行；6) 绑定既有数据源发布新看板，以Grafana真实查询和浏览器验证；7) 保留还原操作和准确数据覆盖说明。Supabase MCP仅做结构采集，不读业务行或执行DDL。

## 2026-10-26 执行补充

用户已明确授权实现4秒首发/2秒兜底/10秒用户硬限。先修契约/config冻结，再后端真实派发计时和硬限、前端可见检测与取消，最后补齐运营文案/分析口径。每次修改由主代理执行，研究代理只读评估。

验证：现有first-token-fallback、execute、conversation lifecycle/routes、FirstTokenObservation、use-conversation-turn、models/admin config测试；增加已知故障回归（延迟派发、阶段超时、全局截止、取消、reasoning、长textnode）。真实Chromium运行当前实现而非手抄替代逻辑。shared全部测试、各消费者typecheck、相关lint、frontend/admin build、migration本地数据库验证。检查长回复不被首字截止杀掉、额度仅一次释放/结算、早期fallback超时不伪称用户等满10秒。最后准备精确文件/摘要/验证清单，提交前按现有流程一次审核。
