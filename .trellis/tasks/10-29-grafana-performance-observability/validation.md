# 本地实施验证与交接

日期：2026-10-29。范围：页面体验、角色扮演、短剧三个主线，API/服务下钻。代码分支 `codex/grafana-performance-observability`。无 git add/commit/push，无生产/TEST部署、数据库写入或 Grafana 写入。

## 已完成证据

| 检查                 | 结果                                                         | 证据边界                                                                                                               |
| -------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 代码基线             | dev=4e1ed2eb，main=eec9f3fd，同一代码树1843a02a              | 已fetch并与GitHub复核；不代替生产运行SHA                                                                               |
| shared测试           | 17文件185测试通过                                            | 无业务库或真实支付/模型                                                                                                |
| backend完整测试      | 107文件1037测试通过                                          | 最终首字前过滤/长度分类和headers超时修正之后运行                                                                       |
| frontend完整测试     | 61文件528测试通过；1文件5失败                                | 失败为原有media-cache mock陈旧，见下；不宣称全绿                                                                       |
| 全仓类型检查         | 通过                                                         | shared/backend/frontend/admin/reply-renderer/ui-tests                                                                  |
| imports lint / lint  | 最终复核通过，只有既有img提示                                | 不把提示当本次缺陷                                                                                                     |
| frontend生产构建     | 通过                                                         | 20页面模板，静态/动态页面全部构建成功；不是生产启用                                                                    |
| admin构建            | 通过，既有大chunk提示                                        | 管理端无产品代码改动                                                                                                   |
| 固定采集器语法       | grafana/alloy:v1.21.0实际validate通过                        | 仅假凭证，无远端外发；不证明Cloud认证                                                                                  |
| Faro真实SDK传输      | 401/429仅尝试一次；3秒挂起请求abort                          | 本地模拟fetch；队列/加载超时/敏感字段白名单专项通过                                                                    |
| Faro→Alloy→Loki      | 10条虚构测量，8成功/2错误，成功P95=1000ms；51条LogQL执行通过 | 实际event字段event*data*\*；kind不是自动索引标签。只验证本机固定接收器，不假设托管Cloud格式相同                        |
| Cloud PromQL只读预检 | 14条查询无语法错误，全部空数据                               | 当前24h st\_\*指标列表为空；没有把空图当接入成功                                                                       |
| Cloud Loki只读预检   | 本项目app流索引统计为空                                      | 仅查结构/索引统计，无真实聊天内容导出                                                                                  |
| 独立review           | 前端/后端各一轮，已知P2均修正                                | 无新增业务故障P1；最终修正由对应既有测试验证                                                                           |
| 手机UI               | 最终390/320尺寸63项中61项首轮通过；2项定向复跑通过           | 最终版本整轮不是全绿；短暂试看/刷新续看两例首次失败、同版本隔离复跑2/2通过。保留不稳定性，不无依据归因为本次遥测或基线 |

运行环境为本机 Node v25.7.0、pnpm9.15.9、Prisma6.19.3、Docker28.0.4。没有升级生产Node20镜像；CI Node22/生产镜像实际运行和同负载对照仍是启用门禁。OTel直接包固定2.10.0/0.220.0，Faro2.13.0带入独立transformer0.223.0/core2.12.0；锁文件的Sentry传递peer解析也变为core2.12.0，生产启用前需核验真实追踪启动，不宣称仅凭本地无token测试已证明线上Sentry等价。

## 既有失败，不混入本任务修复

`packages/frontend/src/lib/api/media-cache.test.ts` 5项严格期待 `apiClient(path)`；HEAD既有 `image-plaza.ts` 读取会话时已经传 `{signal}`。两个文件无本次diff，该测试完整mock client，不经过本次perf出口。单独与全量均复现。未修改断言、未删测试或通过排除来制造全绿。

`module_knowledge.py check` 会先因既有 drama-experience 模块缺必需标准章节失败。8项候选module-updates.json已单独验证，通过结构/原始SHA/证据路径检查；候选第8项保留原文并补齐章节。尚未apply/归档，未改spec，避免把未部署内容写成生产事实。

## 安全与计费不变量

- 新通用遥测不新增数据库 I/O；首字/attempt/赢家/检查点/恢复/额度/计费状态继续原owner持久化。
- 首字前filter/length新增遥测专用分类，原业务end_reason与返回/throw不变；系统timeout也仅保留观测原因，持久化user_cancelled优先。
- 原Sentry、短剧上传和经营SQL保留；不注册新全局tracer，不接管Pino，不把race_lost归供应商失败。
- 无正文、推理、URL/query、initData、token或用户/角色/请求ID标签。测试全部虚构、本机临时容器已自动清理。

## 待完成，任务保持in_progress

1. 工程审核最终diff；按仓库要求取得提交确认，推送/部署另审。
2. 明确单个稳定TEST Collector资源/费用，以及托管浏览器app、origin、摄取配额；在部署secret界面配置真实Cloud写入口与凭证，不在聊天/Git流转。
3. TEST真实SDK到Cloud往返；核验实际日志流/字段、Prom名称/标签、所有面板渲染和有/无遥测CPU/RSS/延迟/包体对照。现有本地烟测不是Cloud验收。
4. 真实Telegram/WebView后台/返回、首字commit、首帧、采集被拦与BFCache；保留未覆盖入口和分母限制。
5. 单独批准生产，记录真实运行SHA，24–48h基线后定体验预算；建议一周双轨，之后才讨论停旧纯分析路径。

实现、覆盖与回滚说明在 `docs/grafana/engineering-performance.md`；后端/Collector契约在 `ops/observability/README.md`。本轮不把 T2/T5/T6 或 AC4/AC5/AC7 记为全部验收通过。
