# 只读研究与证据

## 已检索与复用

| 现有能力                                                    | 选择与原因                                         |
| ----------------------------------------------------------- | -------------------------------------------------- |
| shared ModelCatalogModelSchema / normalizeCatalogModelInput | 扩展单型号timeout并兼容缺省，不另建策略配置        |
| Admin ModelCatalogEditor / configSchemas / modelCatalogDiff | 补默认、编辑、摘要；复用草稿发布恢复               |
| model-tiers / runtime-config                                | 冻结目录版本与阈值，统一读取                       |
| precheck / quota / text-billing                             | 保留受理报价与权益，只执行一次                     |
| execute / upstream / SseTap                                 | 内部有限两attempt；在ID I/O前观测内容token         |
| ConversationHistory / OR / Venice repositories              | 业务终态与单provider契约保留，最终交付才投影       |
| settle / apply-charge / sync-job                            | 原chargeId幂等结算，只回捞交付调用                 |
| request_id / conversation-stream / merge-streaming-messages | 复用整轮关联；不新增第二用户发送                   |
| AssistantReplyBody / chat-markdown / action-tracker         | DOM提交后可见文本＋绘制机会；旧onDelta不足以称显示 |
| getDomainDb / managed config SQL validators                 | 新对象明确schema；窄扩展validator，不替换白名单    |
| isolated PG17/PostgREST与admin config测试脚本               | 复用真实权限/事务模式，缺依赖如实记录              |

## 拒绝的过度设计或错误复用

- 不写AI、Prompt、自动阈值、bandit/预测系统、每日cron或新策略服务。
- 不通过第二次execute重复预留/报价/扣款。
- 不把观察primary写旧OR/Venice一对一metadata，避免generationId/provider冲突。
- 不让晚到primary竞争交付或覆盖业务终态。
- 不用供应商latency或服务端收到delta补造用户显示耗时，不以完成整条回复代替首token。
- 不为Grafana另建每日快照表/重型ETL；先提供明确窗口聚合与导入产物。

## 本轮环境证据（不是业务数据）

- Supabase list_projects仅发现三个项目：包含生产ref wbtsfzozlmurljvglhpn，不包含仓库TEST ref zoqelpfhurwehlvypryl。未查询任何项目业务行或执行远端SQL。
- 当前机器存在node/pnpm/docker CLI，Node25.7.0、pnpm9.15.9；未找到本地PG/PostgREST可执行依赖。Docker CLI存在不代表daemon或镜像已可用。
- Codex配置inline，研究代理均只读，未派发实现/check代理。

## 外部口径依据（2026-10-23查阅）

- OpenRouter generation API保留latency等provider元数据：https://openrouter.ai/docs/api/api-reference/generations/get-generation
- OpenRouter activity公告说明latency可到首reasoning token，不能等同可见内容：https://openrouter.ai/blog/announcements/better-insights-faster-metrics-and-new-developer-power-tools/
- performance.now单调时间：https://developer.mozilla.org/en-US/docs/Web/API/Performance/now
- rAF在重绘前回调，不能单独证明显示：https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
