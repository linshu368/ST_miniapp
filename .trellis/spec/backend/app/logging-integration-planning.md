# 日志系统接入规划门禁

## 1. 范围与触发条件

所有新增功能、功能修改及问题修复的任务规划均须评估日志接入，包括 Frontend、Admin、Backend、后台任务与跨包调用。前端/管理端任务应明确对应服务端事件和请求关联方式，不把浏览器日志当作服务端排障证据。复用已有 HTTP、transport、job 或业务日志时，必须验证它们覆盖本次变化，无需为满足门禁重复打印日志。

纯文档、静态样式等不影响运行行为的工作可声明 `not_applicable`，必须给出具体理由。不能因为“改动小”“已有 logger”或“稍后补日志”而豁免功能变动。旧任务重新启动也须补齐声明；已归档及未触及的历史规划不做 CI 全量追溯整改。

运行时继续使用现有 Pino/observability，规范见 [数据、可靠性、安全与可观测性](./data-reliability-and-security.md) 和 [运行说明](../../../../docs/backend-observability-runtime.md)。Railway 捕获 stdout；不新增日志存储。日志告警默认关闭，开启后按配置匹配并通知，不改变业务执行结果。

## 2. 命令入口

```bash
# 创建时自动生成 logging_integration: {schema_version: 1, mode: "pending"}
python .trellis/scripts/task.py create "功能标题" --slug feature-name

# 填写规划后独立检查，不修改任务状态
python .trellis/scripts/logging_planning_gate.py --task .trellis/tasks/<task-dir>

# start 在状态、会话指针、hooks 变动前校验；包括无会话降级模式
python .trellis/scripts/task.py start .trellis/tasks/<task-dir>

# CI：检查 base 到 HEAD 触及的活动任务规划
python .trellis/scripts/logging_planning_gate.py --base <commit-sha>
```

独立检查成功返回 0，失败返回 1；`--task` 也接受 `task.json` 路径。`--base` 必须能解析为 commit。CI 使用 PR base SHA 或 push before SHA，缺失基线时失败；checkout 保留完整历史。

## 3. 元数据契约

声明位于 `task.json.meta.logging_integration`，设计理由写入 `design.md` / `implement.md`，PRD 保留需求和验收标准。`schema_version` 必须为整数 `1`。

| mode             | 必填字段与用途                         |
| ---------------- | -------------------------------------- |
| `pending`        | 创建后的占位状态，不能启动或通过 CI    |
| `not_applicable` | `reason`：具体说明为何不影响运行行为   |
| `required`       | 以下所有字段，描述新增或复用的接入方案 |

`required` 字段：

| 字段                           | 类型及约束                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `scope`                        | 非空字符串数组：涉及页面、接口、业务流程或任务                                                              |
| `integration_points`           | 非空字符串数组：复用/扩展的 logger、HTTP/transport/job 包装及代码位置                                       |
| `events`                       | 非空对象数组，每项具有下列事件字段                                                                          |
| `events[].event` / `operation` | 稳定名称，1–160 个 ASCII 字母、数字或 `_.:/-`，不得包含用户内容                                             |
| `events[].levels`              | 非空数组，取值 `trace/debug/info/warn/error/fatal`                                                          |
| `events[].outcomes`            | 非空数组，取值 `succeeded/rejected/failed/timed_out/cancelled/interrupted/degraded/skipped/unknown/pending` |
| `events[].fields`              | 非空字符串数组：允许输出的摘要、耗时、状态和错误码字段                                                      |
| `failure_paths`                | 非空字符串数组：本次相关拒绝、异常、超时、断流、重复/跳过、未知结果等；不适用的故障说明原因                 |
| `correlation`                  | 非空字符串：request/trace/span、业务关联和后台根上下文方案                                                  |
| `redaction`                    | 非空字符串：允许字段、敏感数据禁区及错误安全投影                                                            |
| `alerting`                     | 非空字符串：等级/规则、默认关闭、失败隔离；无新增规则也要说明                                               |
| `verification`                 | 非空字符串数组：可执行检查、关键断言和必要人工验收                                                          |

字符串不得为空或以 `TBD`、`TODO`、`pending`、`待定`、`待补充` 的独立词/冒号占位；数组不得有重复值。占位检查是有限语法检查，评审仍须核验内容真实性。

以下是复用 HTTP 终态的基础示例；涉及新业务步骤、外部调用或后台任务时必须补充相应事件与失败路径，不能原样复制代替评估：

```json
{
  "schema_version": 1,
  "mode": "required",
  "scope": ["GET /api/example 的查询参数校验调整"],
  "integration_points": ["复用 platform/observability/http.ts 的 HTTP 终态；不新增重复请求日志"],
  "events": [
    {
      "event": "operation.terminal",
      "operation": "http.request",
      "levels": ["info", "warn", "error"],
      "outcomes": ["succeeded", "rejected", "failed", "interrupted"],
      "fields": [
        "http_status",
        "public_error_code",
        "duration_ms",
        "request_id",
        "trace_id",
        "span_id"
      ]
    }
  ],
  "failure_paths": ["参数非法返回既有 400 契约；异常 500 和连接中断保留一次终态；不引入重试"],
  "correlation": "复用请求 ALS 上下文及响应链路头，业务步骤沿用 trace_id",
  "redaction": "仅允许状态、耗时及关联字段；不记录查询原文、token、initData、正文或敏感个人信息；原始错误交给 { err } 安全投影",
  "alerting": "沿用既有 HTTP 等级及规则，默认关闭；开启时匹配日志告警，投递失败不影响响应",
  "verification": [
    "运行现有 HTTP 观测测试及 Backend typecheck、lint:backend-logging；验证 400、500、断开连接的终态及敏感数据未输出"
  ]
}
```

## 4. 校验与错误矩阵

| 情况                                                                             | 行为                                         |
| -------------------------------------------------------------------------------- | -------------------------------------------- |
| 缺少声明、版本错误、`pending`、非法 mode                                         | start / 独立检查 / CI 拒绝                   |
| 缺字段、空数组、占位、非法等级/结果/事件名                                       | 拒绝并指出字段                               |
| 有具体理由的 `not_applicable`                                                    | 结构校验通过；评审检查是否确实不影响运行行为 |
| 旧任务重新 start，声明缺失                                                       | 拒绝，不沿用 mobile gate 的历史字段豁免      |
| start 被拒绝                                                                     | 不变更状态、会话指针或执行 hooks             |
| 本次新增/修改/重命名活动任务的 `task.json/prd.md/design.md/implement.md/task.md` | CI 校验对应 `task.json`；缺失或损坏即失败    |
| 只改验证记录、归档目录，或历史规划未触及                                         | 不纳入 CI 规划选择；独立 `--task` 仍可检查   |
| CI 基线不可用                                                                    | 失败，不能静默略过                           |

CI 规划门禁检查声明完整性，不证明实现已经接入，也不强制每个仅改源码的 PR 都携带任务文件。新增/修改功能仍必须按项目流程先规划；实现及评审需对照事件与失败路径，运行现有 `pnpm lint:backend-logging` 和相关验证。

## 5. Good / Base / Bad 场景

- Good：新后台任务复用 `runObservedJob`，明确独立根上下文、成功/跳过/失败摘要、脱敏与有限告警，测试重叠执行的关联隔离。
- Base：修改 API 校验，确认现有 HTTP 终态能覆盖新拒绝分支，记录复用位置、公开错误码和验证命令，不新增重复日志。
- Bad：规划只写“加日志”；用“已有 Pino”声明不适用；记录完整请求/响应正文；把内部错误码当作公开契约；声明后仍留下 raw fetch 或无上下文后台任务。

## 6. 必须验证的行为

```bash
python -m unittest discover -s scripts -p test_logging_planning_gate.py
python .trellis/scripts/logging_planning_gate.py --task .trellis/tasks/<task-dir>
node --test scripts/check-backend-logging.test.mjs
pnpm lint:backend-logging
```

规划工具回归须覆盖：创建默认 pending、required/N/A 正常路径、缺失/占位/非法内容拒绝、旧任务及有/无会话启动前无副作用、CI 文件选择与不可用基线。功能任务仍按影响范围运行 typecheck、既有测试和适用的构建/人工验收。日志验证应覆盖失败终态、原结果/错误不变、敏感值不输出及关闭告警无处理；不能以结构校验代替。

## 2026-11-14 接入与合并审查要求

声明完整只是第一步；实施/评审必须核对以下证据：

1. **来源与语义**：user_id 来自既有内部映射，telegram_user_id 来自已验签请求或已验证 webhook；对象目标可由固定路由/已知 DTO 的 UUID 字段识别，不代表 ownership 成功。聊天 session_id 与影像 image_conversation_id 分开；当前角色 creation_id 等于 character_id。禁止为了日志加查询。
2. **真实输出**：新业务事件使用稳定 event 和 biz/sys kind，结果摘要用白名单内有界标量。字段从 producer → EventFields/ALS → Pino formatter/serializer/redact → stdout 全链验证；调用点传字段不等于 Railway 实际能看到。数组/DTO 不放宽为任意输出，优先固定计数/布尔。
3. **并发与完成**：请求/任务根隔离；批量工作逐实体 withBusinessContext，子 span 继承明确的用户/对象。缓存命中、共享 inflight 等待者和已有会话读取必须各自绑定；HTTP finish/close/超时仍一次终态。后台 void resolved、HTTP 200、Telegram payload.ok=false 不能混为业务成功。
4. **出口与故障**：新增 fetch/SDK 使用既有 transport，独立 Prisma/Supabase/pg 客户端也逐一核对接线，不改变连接/锁/事务、timeout/signal/重试。原始错误以 { err } 安全投影；若 HTTP 200 内部业务失败，已有业务边界另报。新高基数 ID 不进入 Sentry 的独立 span/log/event/breadcrumb、指标标签或通知正文；离线报表 CLI 的 stdout 协议是明确例外。
5. **合并审查**：上游新增/变更的入口、定时任务、SDK、任务规划和字段白名单必须重查。AST guard 只能检查已定义的语法边界，不能证明语义覆盖；尤其不能用 mock route 注入字段代替真实 repository 绑定测试。缺失日志规划的触及任务应补声明，不能关闭门禁或修改上游性能样本。

验收复用既有测试，并按风险验证实际 JSON、失败/断开、原结果不变和并发隔离；跨包合并运行 shared tests、所有消费者 typecheck 与适用 build。部署后用正确环境的已知用户/对象查 Railway，再用 trace 关联身份解析前事件；无线上样本不宣称检索/P95 已通过。

## 7. 错误与正确做法

错误：`{"schema_version":1,"mode":"not_applicable","reason":"已有 logger，本次不新增日志"}`。结构检查无法判断这种理由的真实性，但功能规划评审必须拒绝。

正确：使用 `required`，列出已有日志接入位置、事件和本次新增失败分支的验证；如果已有事件不能定位问题，再补最小必要的受控摘要。只有明确不影响运行行为的任务，例如“仅修正文档错字，不涉及运行代码、配置或部署”，才使用 `not_applicable`。
