# 验证与审查记录

范围：本地冷启动候选，无提交、推送、上线或生产数据写入。原有周末报告/证据保持不变。

## 已通过

- `pnpm --filter @miniapp/frontend exec vitest run --maxWorkers=2`：72 文件、815 测试通过。涵盖真实 query hooks 的首屏/分页优先级与取消、既有请求槽/总期限、启动参数、Android/iOS native ready、root shell 与 document 零点、Faro finite classifier。
- `pnpm -r typecheck`：全部8个 workspace 包通过；包括 frontend/backend/shared/admin/admin-client/admin-cli/reply-renderer/ui-tests。
- `pnpm --filter @miniapp/frontend lint`：通过；保留既有 no-img-element 警告，没有禁用规则。
- `pnpm --filter @miniapp/frontend build`：Next14.2.35 production 构建通过，20个静态页面。`/chats` 和 `/characters` 仍为静态页面。
- `pnpm test:ui:fixtures`：12项通过，补齐邀请绑定公开终态与非法码。
- `pnpm lint:complexity`：通过。grafana 主文件拆至500行以下；startup shell 函数拆至120行以下，基线从30文件/102函数收紧到29文件/101函数。未放宽其他存量预算。
- `pnpm lint:backend-logging`：342运行时文件检查通过，后端实现未修改。
- `logging_planning_gate.py --task ...`、`module_knowledge.py check ...`、`task.py validate ...`：通过。模块事实以校验过的载荷同步，未自动提交。
- 原监控 schema 与抽出后的常量逐字符（忽略空白/export）比对：除新增 conversation_groups 外全部一致；原 exporter/脱敏回归通过。
- 生产构建本机3140 HTTP检查：新/回访/无效/再次回访/再次新用户五次交替请求全部200、无Location，返回正确的静态 shell。没有业务API调用；明细为 [build-observation.json](build-observation.json)。
- 最终 production-minified HTML 的真实 inline script 在 VM 中分别运行大厅/会话 × Android/iOS 四种组合，全部只发送一次ready，未依赖外部闭包/Next启动模块；见 [built-script-verification.json](built-script-verification.json)。这是编译产物完整性检查，不是原生WebView实测。

## UI 与失败路径

使用已存在的本地3130/3131真实页面/虚构API系统，扩展原 roleplay.spec.ts 和 server.test.ts，没有创建测试文件或临时mock。

`pnpm test:ui --grep '@startup|@navigation|@chats|@roleplay'`：完整61场景先有59通过、2个Android首次进入create/creators路由的断言超时；两个对应窄屏场景通过。原失败trace和摘要保留在忽略提交的 `output/performance/cold-start-first-ui-errors/`。

补齐History等待观测并预热既有路由后，执行 `pnpm test:ui --grep '@startup|@navigation @layout|@public-author-space'`：**20项全部通过**（Android与320宽），包含上述两个Android失败场景复测、全部冷启动组、邀请/支付、History受限降级及窄屏导航。最终同版单测815项、production build、UI-tests typecheck及复杂度复跑通过。没有跳过失败场景或延长断言超时。

已确认 root首文档200、无redirectedFrom；JS阻塞时有正确框架、恢复后无hydration；canonical更新没有第二document或目的页RSC；邀请code正确交付并进入终态；支付return进入原orders目标；浏览器返回/刷新、分组/管理/分页/取消等由既有场景覆盖。

PagePerfTracker显式接收真实语义路径，SDK就绪后即挂载；History降级等待也有document watchdog，业务仍等规范路径。最终代码没有重置冷启动时钟或把地址更新计作SPA。

首次执行曾发现：新增断言把Faro context写错层级（已修正）；邀请正常绑定接口缺少fixture（已补公开DTO终态与fixture测试）；高并发下既有artifact-renderer打包hook超时（降低至2 workers后全量通过）。首次Next dev编译还导致个别跨页断言超时，保留trace并按现行spec预热后复跑，不延长断言预算、不跳过业务检查。

## 代码与规范复核

trellis-before-dev / trellis-check 及 React性能清单：先规划并过门禁后实施；路由树负责初始shell，未在SSR render读cookie/storage；身份捕获在URL清理和规范化之前；History更新等待Next effect并使用框架集成入口。保留标准跨页Link/router导航，未将任意页面改成shallow History。没有新增依赖、公开业务API、私人缓存、并发槽、写入/数据库/计费/重试逻辑。

新增代码不含any/类型忽略/关闭监控；唯一有限字段表保持复用；新增运行时文件grafana-schema只承载原有常量，未建立平行出口。前端/后端边界及原错误显示、取消和信号保持。修改规范/README/架构并记录Android/iOS真实基线及日志接入。

## 产物与限制

构建/类型/lint/unit/复杂度本机日志和Playwright报告均为工作区产物，不提交。Windows重复构建按规范核验路径并移动standalone，未递归删除junction。

本次没有优化后生产P95。上线后按release/route/platform分别观察至少24h、N≥100，iOS样本不足延长48–72h；同时核对started/terminal/stall/left、错误率、入口CDN分流、真实Telegram Android/iOS弱网/后台恢复与供应商支付回流。groups新标签与历史detail混组不能直接比较。出现错页、hydration、身份/支付异常或同平台回退即停止推广并回滚前端版本。
