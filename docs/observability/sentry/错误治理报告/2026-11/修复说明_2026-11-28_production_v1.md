# 前后端现有改动修复说明｜2026-11-28

对应统计窗口：[2026-11-25 15:00:00，2026-11-27 15:00:00) +08:00，Asia/Shanghai。

来源：[错误报告v2](错误报告_2026-11-27_production_v2.md)、[修复情况报告](修复报告_2026-11-28_production_v1.md)及[任务技术证据](../../../../../.trellis/tasks/11-27-sentry-1127-report-remediation/repair-evidence.md)。原错误报告v1和历次修订保留。原窗46条Errors、13个Issue、16名已识别去重用户不重算；事件数不代表去重业务失败数，缺业务分母不报告比例。

## 当前交付范围

用户已要求停止继续修复，改为核查现有改动、生成说明并在检查通过后commit。本次只交付已有frontend/backend相关改动及文档，不新增产品补丁；不访问Vercel，不执行本地UI、Playwright、preview或浏览器验收，不推送或部署。此前要求提供Vercel连接的请求撤回，不作为本次提交条件。

代码基线为`fae9e1d066bd578c995b4b2c2f83a74a1de0bbc1`，分支`fix_request_speed`。本说明随现有改动一起提交；实际提交哈希以包含本文件的Git提交为准，不将基线哈希当成修复commit。尚无本次版本部署和生产验证证据。

## 已有行为修复与局部防护

### 1. 角色公开目录隔离可选封面失败（G12 / ST-MINIAPP-DR）

原公开列表对每张角色卡单独解析创作封面，任意一张封面的数据库读取或签名失败会使整个列表Promise失败。现改为复用已有公开批量封面helper，失败项返回空图片地址，其余角色仍按原顺序返回。

改动位于[characters.ts](../../../../../packages/backend/src/routes/characters.ts)。查询可见性过滤、列表顺序、推荐/最新缓存语义保持；私有详情和封面ownership校验继续使用原路径。列表、最新角标和详情注册按职责拆开，保留`@frontend-ready`注释。

既有角色路由与封面测试覆盖单封面失败、批量签名、普通头像和顺序。风险是依赖故障期间封面暂时为空。回滚以本次路由变更为单位，不清理资产或改权限。这属于局部依赖隔离，未确认原事件取消的发起者，也未证明原等待耗时消失；状态为**待上线**。

### 2. 生成配置读取去掉不使用的昵称依赖（G11 / ST-MINIAPP-HC）

原`getGenerationConfig`只返回配置，却通过`getGenerationContext`额外查询profile names；原HC堆栈包含该昵称读取失败。现提取同类私有`readGenerationConfig`，配置接口仅读取偏好和平台规则，完整生成context仍并行读取配置与昵称，任一必要读取失败仍拒绝。

改动位于[MiniappUserSettingsRepository.ts](../../../../../packages/backend/src/infrastructure/repositories/MiniappUserSettingsRepository.ts)。保留5秒偏好读取期限、原字段归一化/档位规则、传入规则快照复用及错误cause；没有写入默认偏好、新API或数据库变更。

既有repository测试覆盖配置读取不发起挂起的profile查询、偏好与平台规则失败仍报错、完整context仍读昵称且失败关闭。回滚限该repository变更，不改用户配置。此处修正了已确认的无用依赖放大；共享数据库慢等待本身仍未定因，状态为**待上线**。

### 3. 聊天流取消补齐三个竞态边界（G04 / ST-MINIAPP-EY）

[conversation-stream.ts](../../../../../packages/frontend/src/lib/api/conversation-stream.ts)已有三处局部改动：调用前signal已取消时不发送POST；fetch在取消后仍返回响应时清理其body；reader取消监听挂接后再次检查signal，补上两段异步步骤之间的取消间隙。

扩展既有测试并取得先失败后通过的证据。原网络错误、idle/deadline、402响应解析、生成幂等与服务端持久终态保持；没有新增重发生成或全局过滤AbortError。取消本地读流不能证明服务端未生成、未落库或未收费。

这是局部竞态修复，不能据此断言原EY全部样本同因。回滚限流客户端单元；后续仍需核查原未处理Promise的所有者、新轮隔离及真实宿主结果。局部代码**待上线**，原Issue**未修复闭环**。

### 4. 草稿同值写不再重复通知（G03 / ST-MINIAPP-F4、G13 / ST-MINIAPP-1R）

[memory-draft-store.ts](../../../../../packages/frontend/src/stores/memory-draft-store.ts)在有效草稿文本与新文本相同时返回原state，不增加revision或触发新通知。已复现的缺陷是同步订阅者写回同一文本会继续通知；新用例验证通知只发生一次。过期草稿同值写仍刷新，真实A→B→A继续增加revision，旧提交不能清除新编辑。

保留账号、会话、模块隔离、空字符串覆盖、两小时TTL和64项容量边界。行为变化是未编辑的重复通知不再续期；回滚仅恢复该store改动，不清草稿。

原生产React递归反馈组件尚未复现，F4与1R继续保留独立映射，不能按共用store认定同根因。局部防护**待上线**，两个原Issue均**未修复闭环**。

### 5. 客服未读超时返回明确的失败语义（G09 / ST-MINIAPP-D5）

[support.ts](../../../../../packages/backend/src/routes/support.ts)仅对身份阶段完成后的unread上游`TimeoutError`返回503及`SERVICE_UNAVAILABLE`失败信封。保留原错误和日志，不返回`has_unread=false`或成功data。

消息发送、标记已读和其他操作继续走原错误路径；既有回归验证POST超时仍500且只调用一次。未新增重试、轮询或清徽标逻辑；前端已有错误/缓存处理继续生效。回滚限该代理分支。此改动不缩短上游等待，也不修复独立客服服务；本仓局部处理**待上线**，原上游故障**未修复闭环**。

## 诊断增强与测试支撑

G08 / ST-MINIAPP-HQ只有诊断增强：[events.ts](../../../../../packages/backend/src/platform/observability/events.ts)从Prisma P2010受限提取SQLSTATE到可选`database_code`，保留原`code=P2010`和二次安全投影。仅接受约定代码形状，不保存原SQL、参数、meta/message正文。既有真实Pino JSON测试覆盖有效码、二次投影、非法码和脱敏。

生产Supabase只读取证已确认两条成本写失败对应`25006`（只读事务写入失败），但触发只读的来源仍未知。没有修改成本SQL、任务重试、数据库设置、账本或钱包，没有把未知成本补0。诊断代码**待上线**，G08根因治理**未修复**；查询范围与完整性见[11-28调查](../../../../../.trellis/tasks/11-27-sentry-1127-report-remediation/investigation-2026-11-28.md)。

另有两项支撑改动，不计作额外业务修复：

- [creator-status-bar.test.ts](../../../../../packages/backend/src/features/generation/creator-status-bar.test.ts)每例清空并还原写稿provider选择Key，确保只走已有mock transport，避免本机环境把单测导向真实供应商；产品模型路由未变。
- [复杂度基线](../../../../../scripts/complexity-baseline.json)仅删除已拆小的`characterRoutes`和`readConversationStream`两项旧豁免，没有放宽其他预算；相关Frontend/Backend规格和日志README同步记录边界。

## 正常运行影响核查

代码审查未发现新增的阻断性回归。可见改动集中于失败隔离、无用读取和取消/重复通知边界；没有改变公开DTO、数据库schema、生成/支付/计费权威入口或鉴权规则。此结论仍需结合下列实际检查，不能解释为全部线上流程已验收。

2026-11-28本轮重新执行：

- `pnpm -r typecheck`：8个子项目通过。
- Frontend相关4个测试文件：81项通过，覆盖stream、草稿、生成配置消费和流消息合并。
- Backend相关5个测试文件：86项通过，覆盖角色路由、客服代理、生成配置repository、真实日志及创作状态栏测试隔离。
- 离线恢复依赖后复跑完整Frontend 84文件1007项、Backend 194文件2162项，全部通过；相关用例属于这些全量集合，不重复相加。
- Shared：29个文件422项通过。
- Frontend lint、跨包导入ESLint、复杂度、Backend日志静态检查通过；现存img/hook及复杂度基线警告保留，不表述为零警告。
- Frontend生产构建通过，完成20个静态页面生成和构建追踪；显式禁用Sentry上传和Next遥测，未触发本轮上传或部署。Backend日志规则校验通过（5条规则、1条启用）。
- Trellis上下文及日志规划校验通过，保留长文注入截断提示；`git diff HEAD --check`通过。两份任务jsonl的EOF空行已清理，仅文档格式调整。

前一轮相同产品改动已完成Frontend 1007项、Backend 2162项、Shared 422项及相关build/静态检查；这些是历史验证，未与本轮重复测试相加。

本轮首次构建在应用编译前因Next.js缺少`./impl`失败，日志规则校验因tsx无法解析本机esbuild失败。随后按已有lockfile离线恢复node_modules（`pnpm install --force --frozen-lockfile --ignore-scripts --offline`），复验均通过。lockfile哈希未变，未更新依赖版本或执行安装脚本；本轮运行时代码差异哈希保持一致。

核查结论：在本轮类型、全量单元测试、构建、日志与导入/复杂度检查覆盖范围内，未发现现有改动导致的阻断性回归，可提交本次候选改动。现存警告和下述未验证范围保留，不能承诺所有线上环境绝无影响。

未执行本地UI/真机、数据库写入集成、真实生成/扣费、生产部署或发布后P95；本地检查不能证明Telegram回调、系统键盘、供应商和线上连接状态均正常。

## 未完成项与恢复边界

完整窗口仍为必须处理10组、待核实3组、可暂缓0组；专项/小修标签不与处置数量相加。上述5项行为修复/防护及1项诊断增强也不能当成6个已恢复Issue。

G01/6D、G06/1H、G07/7Z仍待核实同次业务结果；G02/2缺宿主回调时序；G03/F4与G13/1R缺实际反馈组件；G04/EY缺原拒绝所有者；G05/34缺原故障资源请求与同次fallback结果；G08/HQ缺只读触发源；G09/D5上游原因未闭环；G10/H6缺原HTTP与精确业务回执关联。G11/HC、G12/DR虽有局部修复，原数据库等待或取消源也未全部确定。

G05原Worker与依赖当前返回200、隔离Node可发ready，仅说明当前资源和装配可用；已有启动预算、代际释放和完整原文回退没有重写。原事件breadcrumb返回100条且达到上限，只见后处理版本接口200，未获得故障chunk HTTP或错误后的fallback结果；其他请求成功不作恢复依据。不再要求访问Vercel。

以上问题不因本次提交而改成已解决。按用户要求先停止新增修复，后续若恢复工作，沿原13组映射补证，不吞异常、不伪造recorded、不自动重发生成。原报告补证复查安排为2026-11-28 12:00 +08:00；这是待落实的责任安排，本轮没有创建提醒或派发人员。

## 提交与上线说明

用户已授权在检查通过、生成说明后commit。提交范围仅本次前后端代码、既有测试扩展、配套规格/任务及脱敏报告；不混入其他改动，不自动push、合并或发布。代码本地通过而未上线仍记待上线，只有上线后同流程/平台/release验证通过才能记已修复。

后续发布可按上述单元整体回滚，无migration或数据清理。公开封面临时空图、草稿同值不续期、未读超时503是明确行为边界；若出现核心流程失败扩大、身份/隐私/资金/一致性异常，应停止扩发并由发布负责人跟进。双端P95没有有效样本时保留未知，不报告改善率。

历史执行附记：此前首次构建意外上传过Sentry sourcemap，已停止并记录；此前状态栏单测曾可能触达真实供应商，是否受理/收费未知，随后已补测试隔离。本轮复验构建明确禁用上传；详见任务证据，不将整段历史描述为完全无外部副作用。
