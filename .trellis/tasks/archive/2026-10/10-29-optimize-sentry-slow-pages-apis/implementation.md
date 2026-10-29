# 实现记录

## 结果

本任务在不改动 generation/provider/计费/数据库语义的前提下，收敛了可避免的页面入场成本、离页请求和 support 慢响应归因。Sentry 报告中的 messages/regenerate 时长继续解释为完整 SSE 生命周期，未把它们误当首字响应时间。

## 请求层

- React Query 默认 query retry 关闭，GET 的最多一次有限重试只由 `apiClient` 负责；POST 仍不自动重试。
- API client 的退避等待支持 `AbortSignal`，排队、退避、在途 fetch 任一阶段取消都不会再发下一次请求。
- characters、conversations、support 的目标 queryFn 均向底层传递 signal；conversation detail 的手工 `fetchQuery` 同样传递。
- lobby 同源代理同时继承浏览器取消与 5 秒上游 timeout。

## 页面与请求去重

- `/characters` 的“接着聊”改为父层已有会话与角色摘要的纯展示，不再订阅第二条 conversations query，也不再为列表内角色补打一条 detail。
- 删除 `<img>` 已经调度后追加同 URL preload/preconnect 的 effect。
- 角色详情、chat 角色详情/会话抽屉/消息图片与语音 footer/工具箱面板、首页评论面板按需加载；首次打开后保留挂载，维持动画和草稿。
- 播放器、聊天消息正文、输入框、发送/停止/重生成保持关键路径同步加载。

## Support

- unread 保留 30 秒 staleTime、20 秒前台轮询和前台恢复，重复挂载不再使用 `refetchOnMount: 'always'`。
- 五条 support route 补齐 `@frontend-ready: true`。
- 代理成功日志按固定 operation 记录 status、identityMs、upstreamMs、totalMs；失败保留原始 `{ err }`，不记录 userId、path、正文、secret 或完整 URL。
- 不新增结果缓存、重试、shared contract、数据库对象或 migration。

## 本地验收工具修复

- Windows 下 fixture 直接运行判断改为绝对路径比较，避免反斜杠导致服务静默退出。
- preview 子命令在 Windows 通过 shell 解析 pnpm，并在脚本收到停止信号时按已记录子 PID 清理进程树。
- 复用现有 chat/roleplay 测试，增加工具箱首次打开和角色页请求计数断言；未新建测试文件。

## 实测体积

| 路由                  | 基线 First Load JS | 最终 First Load JS | 基线独占 | 最终独占 |
| --------------------- | -----------------: | -----------------: | -------: | -------: |
| `/`                   |             283 kB |             281 kB |  2.98 kB |  2.92 kB |
| `/characters`         |             271 kB |             254 kB |   7.8 kB |  12.6 kB |
| `/chat/[characterId]` |             396 kB |             372 kB |   101 kB |  90.7 kB |

chat 首载减少 24 kB，独占减少 10.3 kB。独占仍比计划门槛高 0.7 kB；安全的默认关闭面板、媒体操作和工具箱均已拆出，继续拆分将触碰消息正文、输入框或生成控制关键路径，因此按验收条款保留实测证据并停止继续泛化。

## 请求计数

固定 `@roleplay` 场景新增断言并通过：首次 `/characters` 只有 1 条 `GET /api/v1/conversations`；打开详情前 `GET /api/characters/:id` 为 0。详情首次打开后的 detail 请求属于明确用户动作，不计入首屏。

## 未改动

- `packages/backend/src/features/generation/`、provider routing、first-token race、fallback、recoverable delivery、计费、额度和 CAS。
- shared contracts、Supabase schema/migration、生产或 test 数据。
- 独立客服仓库实现。
