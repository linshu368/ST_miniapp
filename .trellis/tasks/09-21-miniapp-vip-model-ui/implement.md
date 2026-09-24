# 实施计划

> T0 已完成只读采集：父任务 `in_progress`，T0 = Done。test 目标 `zoqelpfhurwehlvypryl` 已 MCP 核验。子任务未启动。下一轮可进入 T1（Shared 契约）；T1 仍不写 migration、不连生产。详见 `research/t0-test-db-collection.md`。

## 阶段 0：评审、环境与配置门禁

1. 审核 `prd.md`、`design.md` 与复用调研，确认任务范围、数据归属、付费用户回滚原则和高级图片配置来源。
2. 明确 Supabase 连接目标为 test 后，只读采集相关 schema/table/function/index/RLS/grant/config shape；禁止读取业务行。Production 仅记录待核清单，不能用 test 结果代替。
3. 核验 test/production 的基础签到配置、模型原价、现有钱包字段和最后执行 migration；确认 `main_credits + bonus_credits` 守恒口径。
4. 确认 Railway test 服务、支付四路、Cron 配置以及高级图片 provider/model/price。高级图片配置不完整时保留关闭，不阻塞其余 VIP 能力实现。
5. 为 VIP 商品、提醒、新钱包语义和高级图片分别定义默认关闭开关；记录启用负责人和停止条件。

**门禁**：目标环境不明确、现有 schema 不满足 migration 前置、高级图片冒充可用、支付测试通路不可验证，或产品不同意“已售权益不可回滚”时停止。

## 阶段 1：Shared 契约与纯规则

1. 新增 VIP status/plan 契约；兼容扩展 payment order/plans、wallet/checkin/spending、models、notifications，并定义语音/图片共用的免费额度状态与稳定错误码。voice/images 领域 DTO 的实际接入由对应子任务完成。
2. 实现并测试单一文本定价纯函数：免费优先、原价、VIP 折扣率、四舍五入整数、非法配置拒绝；0.95 保留为首次 seed 与配置损坏时默认。
3. 定义稳定错误码和可判别联合，保证 UI 可区分 VIP 门禁、充值钱包不足、总余额不足、免费额度耗尽和高级图片未配置。
4. 保持旧响应字段；为新增字段提供向后兼容默认或可选策略，禁止 `any`。

**验证**：

```bash
pnpm --filter @miniapp/shared typecheck
pnpm --filter @miniapp/shared test
pnpm -r typecheck
```

## 阶段 2：数据库 additive migration 与自检

1. 新建兼容 migration：`billing.vip_memberships`、`vip_purchase_grants`、`feature_free_trials`、`wallet_refunds`；扩展 payment order、通知和用户设置。语音/图片 attempt 的领域快照列由对应子任务基于已稳定底座添加。
2. 添加 RLS/grants/check/unique/index；历史 payment order 回填为 credits，历史图片默认为 basic，不改历史钱包值。
3. 新增/扩展原子 RPC：钱包分配、原路退款、VIP 支付履约、媒体免费预留/释放、签到和 reminder 插入；旧调用签名在发布窗口可继续工作。
4. 每个 migration 加前置/后置自检、短 lock/statement timeout、跨 schema 依赖说明和独立恢复策略。
5. 在 test 一次执行一个文件，记录前后 shape、函数定义、RLS/grants、索引、表大小、锁等待、历史行 count/余额聚合守恒；不得自动执行 Production。

**数据库场景**：

- 轻量 main 足够、main 不足+bonus 补足、两钱包总和不足；标准/旗舰/媒体只有 bonus；全部必须零 partial。
- 同 debit 并发 20 次只出现一个 ledger；同 refund key/debit 重放只恢复一次且拆分一致。
- 同 VIP order 四路并发只履约一次；两张不同续费单串行累加；月卡 3000 一次入 bonus。
- 普通/VIP/临界到期签到与首次并发；免费 reservation 竞争、失败释放、超时回收、迟到结果。
- reminder 同周期重跑、多实例、续费竞态与时区边界。

**验证**：

```bash
pnpm lint:migrations
pnpm test:migration-ledger
```

**回滚点**：additive migration 或自检失败时不部署 Backend；事务内失败自动回滚，已提交对象用审核后的 forward-fix，不改写历史 migration。

## 阶段 3：Backend VIP、支付与签到

1. 新增最小 `features/vip` service/repository，统一服务端时钟下的资格读取与 DTO 映射。
2. 扩展 payment config、order repository、`RechargeUseCase` 和 `PaymentSettlement`；订单创建固化商品快照，四路仍共用现有 settlement。
3. 扩展数据库 `complete_payment_order` 调用与 mapper，区分 credit/vip；支付成功通知按商品生成，邀请首次付费规则保持并加回归测试。
4. 扩展 wallet/checkin route：总额+专项余额、60/120 响应、用户级并发去重。
5. 增加 VIP status、entry-viewed routes；所有 Fastify 注册保留附近 `@frontend-ready` 注释。
6. pino 只记录订单/用户内部 ID、商品类型、结算来源、履约前后截止时间摘要、奖励金额与耗时；错误按 `{ err }`。

**测试**：订单金额篡改、无效商品、支付创建失败、expired 迟到确认、四路竞态、数据库失败回滚、通知失败不回滚、周/月续费、签到过期边界。

## 阶段 3A：Admin「VIP策略」与运行时配置 forward-fix

> 这是 2026-09-22 新增需求。T2/T3 已在 test 落地，必须新增独立 migration 和兼容消费者，不得改写已应用文件。可与 T4 的本地实现并行，但 T4、T5、T6、T7 在最终验收前都必须消费该阶段稳定的配置契约。

1. 在 Shared 定义 `vip_plans_config`、`vip_text_discount_rate`、`vip_checkin_bonus_config`、`feature_free_trial_limits` 的 runtime schema、默认值和类型；现有常量降级为首次迁移/配置损坏时的兼容默认。
2. 新增 forward-fix migration：seed 新 key；把既有 `vip_purchase_enabled` / `vip_reminders_enabled` 与新 key 加入 Admin managed-key 白名单和数据库发布校验；演进 `feature_free_trials.ordinal` 的固定 1..3 约束以支持受控动态上限。一次只 apply 一个新文件，不修改历史 migration。
3. Backend 统一通过 `platform/runtime-config.ts` 读取已发布策略：创建 VIP 订单时固化商品快照；文本受理固化折扣；签到 RPC 原子读取加成策略；免费预留 RPC 按 feature 读取上限。配置缺失/损坏时按 design 的 fail-closed/安全默认规则处理。
4. Admin 新增业务 tab“VIP策略”，按功能开关、商品、文本折扣、签到加成、媒体免费次数分区；复用草稿/发布/版本/回滚和 test/production 环境隔离，不新增直写表路径。
5. 语音/basic 图片免费上限分别配置，统一限制为 `0..20` 的整数并默认 3；0 表示关闭对应功能的免费体验。上限调低保留历史事实并停止新增，调高后从最小可用 ordinal 继续。
6. 到期提醒提前天数、提醒文案、时区不进入 Admin；语音价格/开关/提示文案和高级图片完整配置也不在本阶段范围。

**测试**：Shared/Admin/DB 三层非法值；首次 seed 等价于当前规则；开关 fail closed；商品改价后的新旧订单快照；折扣改值后的进行中生成；签到两种模式；免费上限调高/调低、并发与重放；配置回滚不改历史事实；旧 Backend 在新 migration 后继续工作。

**门禁**：Shared、Admin 与数据库未统一执行 `0..20` 免费次数约束、Admin 发布 RPC 不能复用、配置读取会重定价历史业务、或新 migration 需要改写已应用 T2/T3 文件时停止。

## 阶段 4：Backend 统一计费、权限与退款

1. T4 已按冻结的 0.95 兼容默认完成 LLM billing plan 快照、权限、钱包分配与原路退款；动态读取“VIP策略”折扣及配置版本由 T3A additive 接入，不重开或改写 T4 已验收语义。
2. 模型 config/select/generation 三处均做后端 VIP 和可用钱包校验；到期选择解析为轻量，并 best-effort 修正设置。
3. 改造 `charge_llm_usage`：保留 finish_reason 与 sync-job 行为，取消新 partial，轻量 main-first+bonus，标准/旗舰 main-only。
4. 固化供媒体子任务调用的 allocator/refund 签名、测试夹具和失败语义；本阶段不进入 voice/image 状态机实现。
5. 明确 LLM“已扣后失败”的补偿入口和状态转换，不在 route 中手工加余额。

**测试**：免费优先、目录价格变更后不重定价、过期中途、同步 job 重放、余额竞态、失败后退款、重复退款、只有 bonus 的媒体/高级模型拒绝。

## 阶段 5：媒体子任务交付与集成

1. 父 T2 在 test 通过后，向 `09-21-vip-voice-free-trials` 交付稳定 commit、migration/RPC、Shared 公共类型、开关和验证证据；语音无需等待 T3/T4。
2. 同一节点可向 `09-21-vip-image-free-trials` 交付 basic 免费体验底座；图片工程师可先实现 basic。
3. 父 T3 的 VIP status/entitlement 稳定后，再交付图片子任务的 advanced 门禁依赖；图片无需等待 T4。
4. 子任务分别完成领域 contract、attempt/audio 快照、状态机、失败释放和 UI；父任务不重复修改媒体模块。
5. 子任务交回 PR/commit、migration 与失败矩阵后，父任务按 `feature_free_trial_limits` 当前发布值执行语音/图片联合免费额度、钱包、权限和发布开关验收。

**集成测试**：两能力免费计数隔离、第 1/2/3/4 次、并发第三次、上游/Storage/failed_unknown、重复 job/audio、只有 bonus、高级图片 VIP/配置/到期和原路退款。

## 阶段 6：到期提醒与消息详情

1. 新增 reminder 脚本和数据库幂等插入 RPC，使用 `Asia/Shanghai` 日期窗口、有限批次和 advisory/row lock。
2. 先实现 dry-run 指标，再消费 Admin“VIP策略”中的 `vip_reminders_enabled` 启用写入；接入 Railway test Cron 配置，Production 配置仍保持关闭。提前天数、文案和时区不做运营配置。
3. 扩展通知 list/detail/read API：可见性校验、kind/action metadata；点击单 ID 才已读。
4. 增加消息详情页与实时 VIP 状态卡、续费入口；历史提醒正文不改写。

**测试**：3 天/当天、DST 不适用但跨 UTC 日期、重跑、多实例、续费前后锁顺序、越权详情、删除/未发布消息、单条已读与红点。

## 阶段 7：Frontend 页面与交互

1. Profile 星尘卡显示总额/专项余额、VIP 未开通/已开通/过期态和服务端持久化的一次性角标。
2. 新增 VIP 详情页，复用支付 mutation、外链打开、订单等待和回跳恢复；实现周/月互斥与组件渲染权益头卡。
3. Recharge 把 credits/vip 归入同一选中状态，金额和续费文案正确，避免两个区同时选中。
4. `ChatTopBar` 增加模型胶囊；复用并扩展 `ChatModelSwitcher`；从 `ChatToolsSheet` 移除模型行。
5. 面板展示后端价格视图、VIP 锁定弹层、剩余天数和输出中切换提示；API 错误按稳定 code 导航，不解析文案。
6. 语音/图片入口展示第 N/已发布上限次或原价；余额和权限仅为提示，最终结果服从后端。
7. 消息列表点击单条已读并进入详情；返回后 unread cache 一致。

**人工体验**：安全区、软键盘、长角色名、长模型名、小屏、慢网、请求竞态、返回/刷新、支付外跳、权益加载失败、非 VIP/VIP/刚过期三视角。

## 阶段 8：全量验证、文档与发布

1. 运行受影响包测试、typecheck、lint、Admin/Frontend build、全仓 typecheck、import/legacy/migration guards。
2. 在 test 执行 PRD 10 条必验路径和失败矩阵；分别核对 API、DB ledger、UI 与日志，不只验证 happy path。
3. 执行钱包守恒 SQL、payment source 分布、重复 business key、free ordinal、会员期限和退款拆分审计。
4. 更新 README、ARCHITECTURE、相关 spec 和模块知识；修复 Backend 规范中的失效 `docs/log_system.md` 引用。
5. 准备并审核 `module-updates.json`，运行 `module_knowledge.py check`；未经审核不得归档。
6. 按 design 的 migration → Backend → Frontend → smoke → 分项开关顺序发布 test。由产品终审并明确批准后才重复到 Production。

**最终命令基线**：

```bash
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/frontend lint
pnpm --filter @miniapp/frontend build
pnpm -r typecheck
pnpm lint:imports
pnpm lint:legacy
pnpm lint:migrations
pnpm test:migration-ledger
python3 ./.trellis/scripts/module_knowledge.py check 09-21-miniapp-vip-model-ui
```

不能运行的检查必须写入执行日志，说明原因、风险和可重复替代验证；不得用“计划运行”冒充通过。

## Consumer 校验清单

- Shared：新增联合类型、默认值、根出口和 VIP runtime schema；Admin 与 Backend 必须消费同一校验，CS 虽无 UI 改动仍需全仓 typecheck。
- Admin：新增“VIP策略”业务 tab，复用 managed config 草稿/发布/版本/回滚、鉴权与环境切换；不得直写 `runtime_config` 或展示密钥。
- Backend：payment 四入口、model select/generation、LLM sync、voice/image workers、wallet/checkin、notification/reminder 都消费同一规则。
- Frontend：profile、VIP、recharge/order、chat、voice/image、messages/detail 只通过 API hooks 获取服务端数据。
- Database：billing/app_core/experience/miniapp_features 的跨 schema 依赖、RLS/grants、旧函数签名和 migration ledger。
- Operations：Railway Backend、payment reconcile、payment expire、VIP reminder 的 test/production 开关与命令分开。

## 发布与恢复检查点

- 未出售 VIP 前可关闭所有新入口并回滚 UI/Backend到兼容版本。
- 一旦出现已履约 VIP，任何回滚都必须继续兑现有效期、折扣和权限；不能删除会员/订单/ledger 表。
- 计费异常先停对应能力和新购买，再用 debit ledger + refund RPC补偿；禁止手工更新钱包。
- Production migration 一次一个文件，失败立即停止；余额守恒、重复履约或权限绕过任一出现即停止后续开关。

## 2026-09-23 已审核 T7 修复计划

1. Shared VIP 展示契约 → Backend 配置映射 → Profile/详情统一消费（95%）。
2. 重建 VIP UI 和套餐选中态；所有状态展示完整权益，复用支付链路。
3. 顶部引擎档位胶囊与展开交互，保留下一轮生效与 VIP 门禁。
4. 媒体查询层补额度/钱包刷新，避免旧免费报价。
5. 对契约与错误报价风险，在既有测试中补回归；必要的媒体缓存回归可新增测试，不引入 DOM 测试依赖。运行 shared/backend/frontend tests、frontend lint/build、全仓 typecheck、import/legacy guards。
6. 人工复验首次角标跨刷新消失、非 VIP/VIP/过期权益、月卡默认与金额联动、模型锁定/输出中切换、两类媒体连续 1..4 次/失败/跨会话/慢网。无登录真机时明确待验，不标成已通过。

## 2026-09-24 PR 真机修正执行计划

1. 将媒体文案格式化拆为下一次报价与 attempt 快照两类；图片成功内容显示本次快照，图片/语音失败重试显示未消耗的本次序号。
2. 调整 VIP 详情四条权益文案，保留动态 95% 配置与动态签到、月卡赠送值。
3. 给顶部当前引擎胶囊增加绿色圆点；重做非 VIP VIP 专属弹窗，复用 VIP 状态及支付套餐 hooks。
4. 运行 Frontend 相关单测、typecheck、lint、build、仓库静态检查，并由质量检查代理复核 diff。
5. 在已确认 TEST 项目回读环境及旧 value/version 后，以旧值为条件开启 `vip_purchase_enabled` 并再次回读；Production 不操作。

失败路径：接口未返回权益或套餐时不伪造价格；媒体配置刷新失败时不把下一次报价当成本次消耗；TEST 配置发布任一步失败则停止并保留原值。此轮不改计费、免费额度或支付数据库结构。
