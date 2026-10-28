# 本地修复验证

日期：2026-09-29。分支：`codex/hotfix-chat-stall-cancel`；基线：`origin/main` `aa5f241a2a9fd08f65779ea39e90449afec1b96d`。

## 完成的行为

- 保留 8 秒等待提示；客户端读取/总时长与服务端生成/残留恢复均有明确期限。
- 取消通过服务端标记和终态竞争实现；确认免费额度预留释放后才恢复操作，未确认则显示可重试状态。
- 失败/取消回复下显示“重新生成”，复用既有用户输入；成功消息仍使用“换一个回复”。
- 请求 UUID 精确定位首字前的本次请求，多设备同轮次并发不误取消。旧流回调不能污染新回复。
- 未新增 migration 或依赖；同步 README、架构、层级规格与模块知识。

## 已运行

- `pnpm --filter @miniapp/shared test`：11 文件、98 测试通过。
- `pnpm --filter @miniapp/backend test`：64 文件、561 测试通过；按既有脚本排除 integration。
- `pnpm --filter @miniapp/frontend test`：31 文件、214 测试通过。
- `pnpm -r typecheck`：shared/backend/frontend/admin/cs-platform 全部通过。
- `pnpm --filter @miniapp/frontend lint`：无错误或警告。
- `pnpm lint:imports`：通过。
- `git diff --check`：通过。
- Trellis context validate：implement/check 各 5 条通过；module updates 3 项通过。
- 只读代码审查：未发现剩余确定 P1/P2。回归覆盖取消/成功竞态、额度释放、过期恢复、迟到准备查询、首次点击等待定位、旧流隔离、多设备 UUID 绑定。

- `pnpm --filter @miniapp/frontend build`：生产构建通过。

Backend 没有独立 build 脚本，采用既有 typecheck/测试。

## 验证边界

未部署 TEST/Preview 或 Production，未执行真实数据库/钱包写入，也未调查用户 7508804246 的线上日志；不能据此宣称该用户已恢复。真实数据库 CAS/事务结果、上游 SSE、额度/钱包与 Telegram 设备场景按 manual-regression.md 验收。HTTP abort 不能证明数据库事务回滚，结果不明确时保留待确认状态。

工作区中的 `docs/PAYMENT_ALERTING_DESIGN.md` 为用户既有未跟踪文件，未修改。当前全部修复未提交、未推送。

## 2026-10-26 空回复计费闸门复核

- 静态审查发现固定档 RPC 只读取 `chat_status + finish_reason`，原应用层虽然标记 `reply_outcome=empty`，仍会把异常的 `success + stop + 空正文` 作为可扣费输入。
- 统一结算出口现将 finish_reason 已终结的空/纯空白回复降级为 `chat_status=stream_interrupted`；原始 `generation_status=success` 与 `reply_outcome=empty` 保留用于审计。finish_reason 尚未到齐时继续 pending，等待 sync 重入，不提前判死。
- 不改 RPC 签名、migration、状态源或依赖；已存在的 charged 行保持幂等，本改动不会自动退款。真实故障记录仍需 conversation/generation/trace/user ID 后人工核账。
- 六文件定向回归通过：`6 passed`、`104 passed`。覆盖终态空回复不扣费、部分回复取消释放额度、取消后迟到成功不能覆盖、自然完成先赢，以及 pending finish_reason 留待 sync 重入；自然 stop 的 sync 路径仍按先扣费后收口执行。
- `pnpm --filter @miniapp/backend typecheck` 通过；`git diff --check` 通过（仅两个 Markdown 工作区文件提示 Git 后续会把 LF 转为 CRLF，无 whitespace error）。
- 最终工作区仅包含本次 5 个预期文件：`apply-charge.ts`、对应测试、架构文档、backend 可靠性规范和本验证记录；未发现临时产物。未部署、未查线上业务行、未执行退款。

## 2026-10-26 深度思考静默首字复核

- 根因确认：公开 reasoning 首字原本已能解除快速首字等待；缺口是深度思考开启但供应商前 6 秒不公开可读文本时，4 秒 fallback 与 6 秒自动取消仍把静默推理误判为无响应。
- 该阶段先保持普通模式快速 fallback/首字取消，只让深度思考模式跳过 4/6 秒快速终止；后续 T7 已统一取消两种模式的 6 秒硬终止，最终行为以下一节为准。
- 未修改 shared HTTP/SSE 契约、数据库、migration、配置字段或计费状态源。reasoning 仍不进入正文/历史/计费；最终无正文、取消或绝对超时仍走 interrupted/non-billable。
- Backend 定向回归：3 文件、72 项通过；Frontend 定向回归：3 文件、53 项通过。覆盖普通模式 fallback、公开 reasoning 首字、静默思考跨 4/6 秒后返回正文、SLA 超时观测、不开自动取消及绝对流期限既有保护。
- Backend/Frontend typecheck、改动代码 Prettier、`git diff --check` 通过。未调用真实 OpenRouter/Venice、未部署 Preview/Production；真实静默推理时长、供应商成本和 Telegram WebView 行为仍需发布后观察。

## 2026-10-26 前后端统一取消 6 秒硬终止

- 最终行为不再区分普通/深度思考的 6 秒终止策略：Backend 到点只写 `first_token_timeout=true`，Frontend 到点只上报 `timed_out` 并结束当前 DOM 观测；两端都不 abort、不调用取消接口、不显示重试失败。滚动发布期间 Frontend 仍兼容旧 Backend 的 `first_token_timeout` 错误码。
- 普通模式保留每型号 4 秒单次 fallback；深度思考继续不快速 fallback。服务端只读准备使用独立 20 秒预算，110 秒执行截止、120 秒残留恢复、Frontend 150 秒读流期限、8 秒等待提示、显式取消、取消/完成 CAS、失败及空回复不扣费均不变。
- 既有回归扩展为普通/深度思考参数化场景：Backend 定向 3 文件 43 项、Frontend 定向 3 文件 54 项通过；覆盖普通模式 fallback 在 6 秒后仍可交付、持久化交付选择跨过 SLA、服务端指标继续记录、Frontend 不自动取消、显式取消保持。
- Frontend 全量 50 文件、376 项通过。Backend 全量 99 文件中 98 文件、847/848 项通过；唯一失败为无关 `notifications.test.ts` 的鉴权用例耗时 5050ms 超出固定 5000ms，单独复跑该文件 4/4 通过。需求相关 conversation/generation/取消仓储/execute/upstream/sync 回归均通过。
- `pnpm -r --workspace-concurrency=1 typecheck` 通过；Frontend lint 与 production build 通过，只有既有 `<img>`/Browserslist 提示。等价 import guard 与 `git diff --check` 通过。原 `pnpm lint:imports` 脚本在本机因 `--rule '{}'` 参数解析失败，改用同一 ESLint config/glob 且不传空规则覆盖执行成功。
- 本机 `node_modules` 起初缺失多个包文件，导致 lint/build/full test 出现模块加载错误；使用 `pnpm install --frozen-lockfile --force` 重建成功，未修改 lockfile 或源码。未调用真实供应商、未部署、未读取线上业务数据；上线后仍需观察延迟成功率、`fallback_triggered_ms`、`first_token_ms`、并发/成本和显式取消率。
