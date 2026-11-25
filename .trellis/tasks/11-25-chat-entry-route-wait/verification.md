# 实施与验证（2026-11-25）

用户已批准开始实施，随后要求更细致考虑客户端缓存，并明确不进行本地UI测试。代码在fix_request_speed工作区；本轮未git add/commit/push/部署，也无数据库迁移、服务端接口或环境变量变更。

## 已实现

- 会话列表/叠卡的真实Link意图与单个空闲候选复用有界路由预热。隐藏/离线/省流/2G/导航安静窗不派发；失败不影响点击、不升级业务error；不预取可触发恢复写入的会话详情，不创建会话。
- 独立聊天loading壳只显示进度，不读业务或提前ready。自动模型、偏好、角色、语音、设置、状态组件和保活/返回预热在当前会话历史就绪后再放行；快速切换会话重新关门，显式面板仍可立即加载。
- 角色详情复用viewer/session key和60秒freshness，normal优先级；原聊天默认30秒，列表60秒，修正第30–60秒进入时额外刷新。公开摘要只复用现有内存，首屏不解析整份localStorage目录；冻结角色版本不用当前卡替代。
- 私有历史仍沿原内存展示/后台校验、staleTime=0、新建免重复GET、分页与同步恢复；不增加私有历史持久化，不改计费、余额、生成或配置权威来源。
- 同visit成功SPA聊天/列表成对输出导航到挂载、挂载到ready，保留原总耗时/ready口径、失败/离页/stall；后台时间扣除，合法0保留，缺字段与身份/URL拒绝。
- 原聊天page、顶栏、偏好、Splash和观测出口按职责拆小，收紧本次涉及的复杂度基线，不扩大其他存量例外。

## 已执行的代码验证

- `pnpm --filter @miniapp/frontend exec vitest run --maxWorkers=2`：84个测试文件、1001项通过（最新21:34:09开始的整包回归）。涵盖历史/创建缓存、请求取消/重试、模型/偏好写入保护及语音等既有测试；新增路由预热边界与现有缓存/阶段/观测测试通过。
- `pnpm --filter @miniapp/frontend typecheck`：通过；最终Splash拆分后再次通过。
- `pnpm --filter @miniapp/frontend lint`：退出0，原仓库存在其他页面img/Hook警告；新增Hook依赖警告已修正。最终涉及的Splash/顶栏/偏好/新偏好hook/入口和choice hooks单独eslint退出0，无警告；生产构建再次执行全包lint。
- `node scripts/complexity-budget.mjs check`：退出0。旧有其他模块增长警告保留，无本轮新增超限；运行update后只保留本轮文件的基线收紧。
- `git diff --check`：退出0。Windows CRLF提示是Git换行提示。曾以关闭autocrlf的临时diff造成CR被当成空白告警，已用仓库实际配置复核通过，未修改Git全局/仓库配置。
- `python .trellis/scripts/logging_planning_gate.py --task .trellis/tasks/11-25-chat-entry-route-wait`：通过。
- `validate_mobile_performance(task.json)`：通过；Android/iOS可见P95与未知样本数分开声明，未补零。
- `python .trellis/scripts/module_knowledge.py check .trellis/tasks/11-25-chat-entry-route-wait`：通过；两个模块知识载荷已同步，未覆盖其他模块。apply完成后刷新载荷的当前摘要，再check。
- `pnpm --filter @miniapp/frontend build`：最终源码复核后的生产构建退出0（output/chat-entry-build-reviewed-20261125.log），编译、全包lint/类型校验、静态页面生成及trace收集完成。前两次构建也通过；在后续拆分源文件后又按最终源码重建，避免用旧产物代替最终验证。构建前验证路径并将旧.next/standalone移动到仓库output/build-snapshots，避免递归清理junction误伤真实依赖；不删除/变更依赖，不改lockfile。

## 审核与限制

Trellis质量检查与React最佳实践复核已执行：统一Query owner与可取消请求保持，复用既有网络/导航保护；新context只携带当前聊天派生布尔值，不形成第二套服务器缓存。loading不冒充可用；预热失败与遥测失败不阻塞业务，有限字段经过采集和发送前两次白名单处理。会话切换、创建/失效草稿交接、分页、分支、点赞、choice与发送保存保护沿用原状态owner。

本轮按用户要求没有启动本地页面、浏览器、preview或Playwright/UI验收；jsdom属于既有代码级Hook回归，没有启动浏览器或界面。实际布局、系统键盘、Telegram回跳及真实网络手感未验收。既有@chat/@navigation可后续补缓存返回、快速切换、显式面板与失败恢复，但本轮不执行。

已发现另一个并行诊断任务目录11-25-chat-detail-p95-diagnosis在工作期间出现，本轮未修改。构建日志/standalone快照仅保存在本地output并本地排除，不进入源码交付。

## 发布验收与恢复

本次只交付可审核源码，未发布，因此无法宣布页面降到2秒。授权发布后稳定release完整48小时，Android/iOS分别按route、入口、cache与foreground观察，主cohort每组N>=100；页面P95目标2000ms，GET目标Android1300ms/iOS1200ms。与error/stall/page_left、历史完整性、恢复、发送和首字共同验收；不平均/相减独立P95，不把API总样本拆成虚构平台N。

预热派发前可取消，Next已派发不能可靠撤销；通过低数量和速率上限约束。无需DB回滚，撤回本次前端变更即可。页面P95回退>10%且>200ms、失败/离页上升或历史/发送异常则停止扩发并回滚。原11-23基础优化已观测在线上c046f213，不把本次未发布与其旧发布记录混为一谈。
