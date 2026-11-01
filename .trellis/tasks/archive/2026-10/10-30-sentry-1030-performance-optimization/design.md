# 技术设计：10 月 30 日性能回归优化

## 1. 证据与边界

| 信号                                         | 当前证据                                                                              | 结论                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `/characters` navigation p95 10.31s（n=330） | 普通 `/api/characters` 末桶 p95 约 98ms；首屏 6 张头像同时 eager/high                 | 主要排查前端资源竞争，不改后端角色 API                        |
| `/profile` p95 7.86s（n=280）                | 页面 ready 只等 wallet；短请求调度为非关键请求保留 critical 槽，但 wallet 仍是 normal | wallet 应声明 critical，避免保留槽空闲时仍排队                |
| `/create/studio/:id` p95 10.98s（n=45）      | 创建响应已写 conversation cache；Studio 仍首次读取 config                             | 在 create 首包后预热同一 config query，不持久化配置           |
| `/` pageload p95 15.30s、`/dramas/:id` 7.01s | `EpisodeSheet` 约 11.8KB 源码且初始静态导入，只在用户打开时需要                       | 仅拆该非关键面板；播放器、detail、playback 保持同步           |
| messages p95 59.16s、regenerate 51.03s       | Grafana 首字多为 2–6s，完整回复多为 10–60s；HTTP 5xx=0；10-30 已合入派发准备优化      | 长流 P95 不能直接当故障；仅优化确切的串行准备和 done 后尾处理 |
| support unread p95 276ms                     | 已有代理分段日志，接口健康                                                            | 不改                                                          |

## 2. 复用调研

- 组件：复用 `CharacterCard`、`DramaPlayer`、`EpisodeSheet`、现有 skeleton/Sheet；只改变加载时机和图片优先级，不新建表现组件。
- Hooks/query：复用 `useCharactersQuery`、`useWalletBalanceQuery`、`useImagePlazaConfigQuery`、`useImagePlazaConversationQuery`、`usePageReady` 与现有 query keys；不建立第二份 cache。
- Helpers：复用 `resolveRequestPriority`/`withRequestSlot`、`entry-phase`、`dynamic()`、`withConversationPreparationDeadline`。
- Contracts：现有请求/响应足够，不改 shared。
- Backend features/repositories：复用 `runConversationTurn`、已有幂等用户映射、`GenerationObservationRepository`、`ConversationHistoryRepository` 和 `TextPostprocessRepository`；诊断写入仍走原 repository。
- 数据库函数：开轮、终态、计费、首字竞争 RPC 均保持；本轮无 schema/migration。
- 不复用/不新增：不新增通用预取框架、持久配置缓存、工作队列、Redis、Service Worker、额外接口或监控指标。已有 entry-phase 是应用启动全局阶段，不把它误当每次 SPA 导航门禁。

## 3. 最小充分方案

1. 角色页把高优先级头像从 6 张收敛为移动端首行 2 张；其余仍有固定尺寸、占位与 lazy 加载。
2. wallet GET 显式 `queuePriority: critical`，使用现有第三槽；不串行化 Profile 其它查询。
3. `useImagePlazaConfigQuery` 接受 `enabled`，Create feed 首包成功/失败结算后挂载该 hook，使 Studio 复用 60 秒内存缓存。
4. `EpisodeSheet` 用 Next dynamic 加载。播放器内部按钮负责打开；只有首次打开后才挂载 Sheet，避免初始 chunk 包含选集、Sheet 与分页 UI。
5. `streamTurn` 同时启动 model catalog 与由 `tg_id` 唯一约束保护的幂等用户身份映射，二者完成后再做 session ownership；整体仍受首字准备截止约束。
6. `done`、`sink.close()` 与必需终态持久化完成后，富回复诊断以 best-effort Promise 继续；失败仍由原函数告警，缺 metadata 的下一轮继续 full 模式。

拒绝的过度设计：不改全局并发数、不关 GET 有限重试、不缓存钱包/价格到 localStorage、不拆播放器核心、不为完整回复设置更短总超时、不改变供应商或模型选择。

## 4. 可靠性设计

| 维度      | 设计                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| 超时      | 沿用 API/首字总截止；并行只读准备共用同一准备预算。诊断仍使用 repository 既有预算，不阻塞响应。                        |
| 重试      | 不新增重试；GET 沿用现有一次安全传输重试，写入行为不变。                                                               |
| 幂等      | 用户映射可能首次创建，但由 `tg_id` 唯一约束和回读保证幂等；富回复 metadata 写同一 history id，重复覆盖相同诊断可接受。 |
| 并发      | React Query 去重 config；用户身份已有 single-flight/唯一约束；并行 catalog/identity 相互独立。                         |
| 事务      | 开轮、终态、额度/计费事务不变；建议性 metadata 不属于回复成功不变量。                                                  |
| 降级      | config 预热失败由 Studio 原 query 重试/错误态承接；动态 chunk 失败不影响视频播放；诊断失败按 full 模式。               |
| 补偿      | 无业务数据迁移；诊断缺失无需补偿，下一轮保守运行。                                                                     |
| 限流/容量 | 不增加请求总数：config 由 Studio 前移到 Create；图片 eager 数减少；无新轮询。                                          |
| 可观测性  | 复用现有 page/API/generation 指标和安全日志；不新增 URL、正文或用户标识。                                              |

## 5. 演进与恢复

- 兼容：无契约/数据库变更，Frontend 与 Backend 可独立回滚。
- 发布：正常应用发布即可；不需要 producer/consumer 双阶段或 migration。
- 灰度/停止：上线后同 release 观察 2 小时错误与 chunk load failure；任一页面失败率升高或首次 Sheet 无法打开即回滚对应提交。
- 回滚：恢复头像数、wallet priority、Create 预热、静态 Sheet import、串行准备或 `await` 诊断即可；无旧数据处理。
- forward-fix：若动态 chunk 只在特定 WebView 失败，先恢复静态 import，不增加自制 loader。

## 6. 可验证性与测试必要性

- 不新增测试文件。请求优先级、query enabled、动态面板主要由既有 typecheck/test/build/UI 场景验证。
- 异步诊断改变时序，需更新现有 `generate-postprocess.test.ts` 用有限 `waitFor` 断言最终调用，锁定“回复不等诊断、诊断仍执行”。
- 失败路径：config 失败、conversation 失败、dynamic chunk 首次打开、catalog/identity 任一失败、诊断 read/save 失败。
- Consumer 校验：Frontend build 检查 route chunk；Backend tests 检查 SSE/计费/后处理；不改 shared，故无需 consumer contract 迁移。
- 人工场景：冷/暖进入 characters/profile/create→studio；首页/详情首次打开简介与选集；发送/重生成在 done 后立即可继续，诊断失败不改变回复。
