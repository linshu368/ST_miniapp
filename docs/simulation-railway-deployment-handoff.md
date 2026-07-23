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

| 项目                             | 状态       | 说明                                       |
| -------------------------------- | ---------- | ------------------------------------------ |
| 独立 Railway Project             | 已完成     | Project 为 `st-simulation-card-evaluation` |
| Backend 服务                     | 在线       | Railway 已生成公网地址                     |
| st-bundle 服务                   | 在线       | 已挂载持久卷，包含 ST、Worker 和 Chromium  |
| 模拟专用 nginx                   | 部分完成   | 旧部署在线，最新部署构建失败               |
| nginx 构建上下文修复             | 本地已完成 | commit `50ffa79`，当前尚未推送到远端       |
| st-bundle watcher 禁用能力       | 代码已完成 | 支持环境变量 `DISABLE_WATCHER=1`           |
| Backend 聊天记录同步任务禁用能力 | 尚未实现   | 需要新增环境变量开关                       |
| 线上完整 E2E 验收                | 尚未完成   | 尚未完成公网首轮新会话和多轮续聊验收       |

最新 nginx 构建失败原因为 Railway 使用 `ops/nginx` 作为服务构建上下文时，
Dockerfile 仍尝试复制 `ops/nginx/nginx.simulation.conf`，导致构建上下文内找不到文件。
本地修复已改为从当前服务上下文复制 `nginx.simulation.conf`。

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

### Backend 待增加的开关

建议增加：

```text
CHAT_HISTORY_SYNC_ENABLED=false
```

预期行为：

- 正式 Backend：缺省或显式设置为 `true`，继续运行同步任务；
- 模拟 Backend：设置为 `false`，启动时不调用 `startChatHistorySyncJob()`；
- 启动日志必须明确输出同步任务已启用或已禁用。

该开关目前尚未实现，是继续连接生产 Supabase 前的阻塞项。

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

## 七、当前卡点

按阻塞优先级排序：

1. **推送并部署 nginx 构建修复**  
   本地 `50ffa79` 尚未推送，Railway 最新 nginx deployment 仍然失败。

2. **实现 Backend 后台同步任务环境变量开关**  
   未实现前，不应让模拟 Backend 长期连接生产 Supabase。

3. **确认 Railway 环境变量**  
   Backend 与 st-bundle 的 `ST_USER_PASSWORD_SECRET`、`LLM_PROXY_TOKEN_SECRET`
   必须完全一致；同时配置生产 Supabase、LLM、ST 管理员和模拟服务密钥。

4. **设置 st-bundle 的 `DISABLE_WATCHER=1`**  
   代码已支持，但需要确认 Railway 服务变量实际生效。

5. **完成生产数据库前置操作**  
   执行 054，并在 Hosted Supabase 中暴露 `miniapp_simulation`。

6. **完成线上 E2E 验收**  
   至少验证测试卡导入、首次新会话、多轮续聊、模型切换、模拟日志完整性，以及
   `miniapp.users`、`miniapp.chat_history`、钱包数据零变化。

7. **验证并发承载能力**  
   当前实现没有 BrowserContext TTL、并发队列和会话数量上限。上线初期应限制并发并进行
   压力测试，不能直接承诺大量并发新会话。

## 八、建议执行顺序

1. 实现并测试 `CHAT_HISTORY_SYNC_ENABLED`；
2. 推送当前本地 nginx 修复及 Backend 开关；
3. 配置 Railway Backend 和 st-bundle 环境变量；
4. 在生产 Supabase 执行 054 并暴露 schema；
5. 重新部署三个 Railway 服务；
6. 检查启动日志，确认 Backend sync job 和 st-bundle watcher 均已禁用；
7. 导入一张 `is_test=true, enabled=false` 的测试卡；
8. 从公网 API 完成首轮及连续多轮对话；
9. 核对生产正常用户、聊天记录和钱包数据没有变化；
10. 通过小规模并发测试确定初始并发上限，再决定队列和 Worker 扩容方案。
