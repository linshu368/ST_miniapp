# 执行计划（待用户审核）

## 阶段顺序

1. 审核prd/design/task与移动性能声明；收到针对最新规划的明确同意后运行task.py start。当前不写产品代码。
2. 保存受影响入口构建/测试基线；只操作本次源文件，审计目录不混进产品提交。
3. 修复ChatGuide兼容并按既有enrich调度按需加载；回归无findLast环境。
4. 改全局错误恢复为用户主动文档重载，复用安全启动身份捕获；明确401提示，验证清理URL/SDK恢复/存储禁用。不能调用脱离Router Context的导航hook。
5. 修复目录总截止与分类，复用缓存/公共head，覆盖排队超时、body挂起、外部取消和慢成功。保持排序与访问资格。
6. 先抽取历史分页读取/GET编排，保留窄投影和所有消息语义；增加单次有界只读恢复与失败阶段诊断。若无法保持8秒总读取和取消不放大，停止该项并复核设计。
7. 只实施有生产构建证据且能保持原计时起点的首屏依赖拆分；禁止关闭监控/改ready语义。
8. 扩展现有固定UI场景；按改动范围运行检查并修复；同步模块spec与适用文档。完成后仅交付本地diff、结果和剩余风险，不自动commit/push/deploy。

## 回归测试必要性

这是已有生产故障修复，兼容、取消、身份与只读重试边界需要回归锁定。优先增加既有测试用例。若当前没有可覆盖ChatGuide兼容、错误重载或专用历史读取器的测试文件，允许新增最小、行为导向测试文件；不镜像实现、不引入新测试依赖。

## 必须验证的失败路径

- 缺findLast、非新人/跳过引导仍不崩溃；首次聊天/流式/编辑资格不变。
- JS/chunk根错误后一次手动重载有效，无reset二次异常/自动重载环；正常reload保留session/source、身份、邀请/支付上下文。
- 原始initData来自SDK/宿主/合法启动来源，缺失、空值、存储禁用、清理后重试分别验证；凭据不入URL/日志/新持久化。
- Android2.2秒目录成功；critical槽全部占用、response.json挂起、手动取消、缓存可用/无缓存、推荐恢复与最新目录、下架校准。
- 历史首次成功只1次SELECT；超时/网络首败后成功；两次失败；外部取消；权限/SQL错误不重试；分页has_more、开场白、继承、点赞、删除/编辑、streaming陈旧恢复不变。
- 401/403不以缓存成功、不自动重放创建；聊天失败后手动重试可恢复同session。
- 若拆短剧观测静态依赖，验证watch/dramas document与click原起点及离页，不能把模块加载后的时间当起点。

## 执行命令

- pnpm --filter @miniapp/frontend test
- pnpm --filter @miniapp/backend test
- pnpm --filter @miniapp/shared test（若触及shared或契约消费者边界）
- pnpm -r typecheck
- pnpm --filter @miniapp/frontend lint
- pnpm --filter @miniapp/frontend build
- pnpm --filter @miniapp/admin build（跨包验证）
- pnpm lint:imports
- pnpm lint:complexity
- node scripts/complexity-budget.mjs update（仅拆分后，检查diff只收紧受影响条目）
- pnpm test:ui --grep '@chat|@roleplay|@startup'（复用3130/3131）
- pnpm test:ui --grep @drama（仅改变短剧观测依赖时）
- git diff --check；受影响文件prettier检查；不使用生产用户/供应商进行本地测试。

## 发布后真实验证

同release，Android/iOS分别观察至少24小时及>=100成功样本，不足明确低样本。区分大厅document与SPA，聊天SPA；同步看N、error/stall、目录timeout、历史恢复attempt与失败率、401和chunk错误。不能以本地fixture或请求延长后成功数量代替P95达标。真实Telegram旧Android/iOS、存储禁用、刷新/重开、系统键盘由工程师验证。发布并不在当前授权操作内；无远端写入。
