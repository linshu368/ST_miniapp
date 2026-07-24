# 测试卡模拟通道 — Railway 部署进度与决策交接

> 分支：`feature/simulation-card-evaluation`  
> 更新时间：2026-07-23  
> Railway Project：`st-simulation-card-evaluation`

## 一、部署背景

测试卡模拟通道用于在角色卡正式上线前，由测试人员或模拟用户 Agent 通过 HTTP API
与角色进行多轮对话，并检查角色人设、上下文连贯性、模型和预设实际生效配置。

本地链路已经完成基础验收，但不适合作为长期测试环境：

- `127.0.0.1` 只能由运行服务的本机访问；
- Mac 关机、休眠或网络中断会导致服务不可用；
- 本地资源不足以稳定承载多个 Playwright 会话；
- 测试人员需要依赖开发者机器，无法独立、持续调用。

因此新增独立 Railway Project，在线运行 Backend、SillyTavern、Provision API、
Browser Worker 和 Chromium。测试人员只需要公网 API 地址、独立
`SIMULATION_SERVICE_KEY`、测试卡 `card_hash` 和接口文档。

## 二、目标部署拓扑

```text
测试 Agent
    │ HTTPS + SIMULATION_SERVICE_KEY
    ▼
Backend /api/platform/simulation/chat
    │ Railway 内网
    ▼
Provision API / Browser Worker
    │
    ├── Chromium / Playwright
    ├── SillyTavern
    └── Backend LLM Proxy
            │
            ▼
        LLM 上游

数据：
  miniapp.characters             测试卡与正式卡共用角色表
  miniapp_simulation.*           模拟会话及模拟聊天日志
  Supabase Storage               角色卡原始文件
```

Railway 当前包含三个服务：

- `backend`：Fastify API 和 LLM Proxy；
- `st-bundle`：SillyTavern、sync-engine、Provision API、Browser Worker、Chromium；
- `nginx`：模拟环境专用 ST 网关。

## 三、当前部署进度

截至 2026-07-23：

- Railway Project `st-simulation-card-evaluation` 已创建并稳定在线；
- `backend`、`st-bundle`、`nginx` 三个服务均已成功部署；
- Backend 公网地址为
  `https://backend-production-7bdc.up.railway.app`；
- Backend、st-bundle 均连接生产主 Supabase
  `wbtsfzozlmurljvglhpn`；
- 生产数据库已执行 054，`miniapp_simulation` 已加入 exposed schemas；
- Backend 已设置 `CHAT_HISTORY_SYNC_ENABLED=false`，启动日志确认 sync job 被禁用；
- st-bundle 已设置 `DISABLE_WATCHER=1`，启动日志确认 watcher 被禁用；
- nginx 根构建上下文及 `.dockerignore` 问题已修复；
- 已支持 `response_mode=async` 和按 `turn_id` 轮询，避免 Railway 公网长连接时限；
- 相关提交已推送：`0ccaa8c`、`64595ef`。

当前 main Supabase 测试卡：

- 名称：`圣海伦学院0.7`；
- Character ID：`e25b5bb5-e2c9-48ad-9cdd-05eab0a9730b`；
- Card Hash：`01a8c013eff334722254c8fcaec8d854128cf3cb2cb6bed174781e2a6c004c9e`；
- 状态：`is_test=true, enabled=false`。

## 四、数据库选型决策

### 最终决策

独立 Railway 模拟环境继续连接生产主 Supabase（main Supabase），不切换到 test
Supabase。

### 原因

未来计划将角色卡审核流程自动化：

```text
角色卡上传至生产 Supabase
  → miniapp.characters.is_test=true
  → miniapp.characters.enabled=false
  → Agent 自动模拟对话和评分
  → 审核通过
  → is_test=false、enabled=true
  → 直接成为正式角色卡
```

如果模拟环境连接 test Supabase，审核通过后还需要把数据库记录和 Storage 文件再次迁移到
生产 Supabase，不利于后续自动化，也会引入重复上传、ID 对齐和状态同步问题。

测试卡保存在生产 `miniapp.characters` 中，但必须满足：

- `is_test=true`；
- `enabled=false`；
- 普通角色接口不返回测试卡；
- 模拟接口只允许解析测试卡；
- 模拟聊天数据只写入 `miniapp_simulation`。

仅把 `is_test` 改为 `false` 不会自动上线，因为测试卡仍然是 `enabled=false`。审核通过后的
发布操作必须原子地设置：

```text
is_test=false
enabled=true
```

## 五、为什么必须关闭生产后台任务

模拟 Backend 使用的是完整 Backend 代码。默认启动后会运行
`chat-history-sync-job`：

- 启动约 10 秒后执行；
- 每 10 分钟执行一次；
- 扫描生产 `miniapp.chat_history` 最近 24 小时内的不完整记录；
- 查询 OpenRouter generation 信息；
- 更新生产聊天记录；
- 必要时执行钱包扣费对账。

如果正式 Backend 和模拟 Backend 同时连接生产 Supabase并同时运行该任务，就会形成两个
消费者并发扫描同一批生产聊天记录，可能造成重复上游请求、更新竞争、重复对账尝试及日志
混乱。

模拟对话本身不依赖该任务，因此采用“代码保持一致、通过环境变量关闭后台任务”的方案。
不直接注释或删除任务代码，避免当前分支合并后误伤正式 Backend。

### Backend 已启用的开关

模拟环境设置：

```text
CHAT_HISTORY_SYNC_ENABLED=false
```

当前行为：

- 正式 Backend：缺省或显式设置为 `true`，继续运行同步任务；
- 模拟 Backend：设置为 `false`，启动时不调用 `startChatHistorySyncJob()`；
- 启动日志必须明确输出同步任务已启用或已禁用。

该开关已实现并在线上日志中确认生效。

### st-bundle 已有开关

模拟 st-bundle 必须设置：

```text
DISABLE_WATCHER=1
```

当前分支已经支持该变量。设置后 watcher 进程保持存活但不执行生产数据同步。

## 六、连接生产 Supabase 的安全边界

在模拟 Railway 环境连接生产 Supabase 前，必须同时满足：

1. 在生产 Supabase 执行 `054_simulation_card_evaluation.sql`；
2. Hosted Supabase API exposed schemas 加入 `miniapp_simulation`；
3. Backend 配置 `CHAT_HISTORY_SYNC_ENABLED=false`；
4. st-bundle 配置 `DISABLE_WATCHER=1`；
5. 测试卡始终以 `is_test=true, enabled=false` 导入；
6. 模拟接口继续使用独立 `SIMULATION_SERVICE_KEY`；
7. 模拟请求不创建 `miniapp.users`，不写 `miniapp.chat_history`，不调用钱包扣费；
8. 对外入口只暴露模拟测试所需接口，避免模拟 Backend 的其他生产业务路由成为额外入口；
9. 审核通过后的发布动作独立鉴权，并保留操作者、时间、评分和状态变更记录。

## 七、线上冒烟测试结果

公网异步接口已验证：

- POST `response_mode=async` 在约 `0.5～0.9s` 内返回 HTTP 202；
- 返回 `conversation_id`、`turn_id`、`status_url`；
- GET `status_url` 可返回 `pending`、`completed`、`failed`；
- 冷启动首次生成在约 180 秒后返回 `failed`；
- 复用同一 `conversation_id` 重试后成功，实测约 69 秒完成；
- 后续热会话成功，实测约 17 秒完成；
- 服务重新部署后，已有 `st_chat_id` 的会话约 43 秒完成；
- 成功结果包含非空 `assistant_reply` 以及完整
  `model_id/model_name/preset_id/preset_version/sampling`；
- `miniapp_simulation.chat_log` 正确记录 `turn_id`、轮次、metadata 和实际配置；
- 模拟输入在生产 `miniapp.chat_history` 中匹配行数为 0；
- 测试窗口内 `miniapp.users` 和钱包流水数量无变化；
- 同窗口生产 `chat_history` 总数因真实线上流量增加 1，但新增行不是模拟输入，因此不属于模拟污染。

异步接口解决了 Railway 公网连接约 90 秒被断开的问题，但没有消除 Worker
内部首次生成超时。

## 八、后续修复与优化方向

### 1. Worker 冷启动首次生成失败

现象：

- 新 BrowserContext 首次打开 ST 后，登录、角色加载、模型列表请求均成功；
- 日志中没有对应的 LLM chat completion 请求；
- `SillyTavern.getContext().generate('normal')` 最终触发 180 秒
  `ST generation timed out`；
- 保留同一会话和 Worker Session 重试后可以正常生成。

当前只能确认这是 ST 页面首次初始化与首次生成之间的 readiness 竞态；尚未定位到唯一根因。
后续应增加明确的连接状态、模型配置、角色/聊天状态 readiness 探针，而不是只等待
`window.__miniappSimulation` 出现。还需评估自动重试是否会重复写入用户消息。

### 2. 自动发现测试卡

增加受 `SIMULATION_SERVICE_KEY` 保护的测试卡列表接口，从
`miniapp.characters` 返回全部：

```text
is_test=true
enabled=false
```

至少返回 `character_id`、`name`、`card_hash`。测试 Agent 获取清单后逐张创建会话，
不再要求测试人员手工维护 card hash。

### 3. 批量编排与并发能力

当前实现仍是单轮 API 原语，不是完整批量筛卡平台。尚缺：

- 批次/任务实体及统一批次 ID；
- 多卡、多会话、多轮自动调度器；
- 全局并发上限、排队、重试、退避和取消；
- BrowserContext TTL、空闲回收和进程重启恢复；
- 每张卡的目标轮数和测试脚本/模拟用户 Persona 配置；
- 批次级状态汇总与统一查询入口；
- 成功、失败、运行中数量以及每个会话当前轮次；
- 失败原因和重试次数的持久化；
- 根据 `miniapp_simulation.chat_log` 生成评分、筛选结果和审核记录；
- 压力测试及 Railway CPU/内存容量基线。

在这些能力完成前，测试人员可以自行编写脚本调用列表、聊天和轮询接口，但还无法只执行
一个命令就完成可观测、可恢复的多卡并行筛选任务。
