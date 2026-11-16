# 实施与验证记录

日期：2026-11-16。代码基线：fde375a5。本轮为本地候选，未提交、推送或部署。

用户最终要求停止相关本地测试、优先完成修复。收到后未追加测试；检查当时未发现仍运行的本轮测试进程。没有启动本地UI、预览服务器、浏览器或Playwright。

## 已完成修复

- 会话页只订阅既有公开目录/公开头缓存，无缓存不触发大厅全表请求。缺失详情等待entry enrich及导航安静窗，再用normal优先级补齐。
- 公开快照沿用既有24小时TTL及storage key，校验结构、过期、非法/未来时间，保留真实savedAt；storage不可用时使用内存。用户+会话详情鲜活期60秒，不写入持久存储；历史版本会话不复用当前大厅摘要。
- 分组RPC自身3秒期限及57014/PGRST003映射既有503/folders_unavailable；明确的编程/权限错误和未知异常不伪装成可用降级。前端关闭groups额外传输重试，仍只对404/503回退平铺，保留用户偏好。
- groups/flat共用的可选summary使用250ms预算并向SDK传递取消信号；不配合取消的传输也不拖住主体，迟到拒绝被观察。SDK取消不等于已证明数据库执行终止。
- 自动推荐open/resume预算1500ms，手动操作及手动兼容open保持5000ms；400兼容请求共用总截止。保留450ms公开头hedge、旧batch、幂等UUID及viewer防串数据逻辑。
- 拆出会话数据hooks、推荐transport和手动mutation，保留原导出消费者；移除useLobbyRecommendation的旧超长函数豁免，没有放宽复杂度基线。

## 停止测试前的结果

| 检查                                | 实际结果                                    | 本地日志/说明                                                |
| ----------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| 全仓类型检查                        | 通过                                        | output/performance/content-path/typecheck.log                |
| Frontend生产构建                    | 通过                                        | build-final.log；初次漏导出已修复，最终构建通过              |
| Frontend lint                       | 通过，有原有图片相关警告                    | 没有新增hooks依赖警告                                        |
| Frontend全量单测                    | 74文件、834项通过                           | frontend-tests.log；之后只修正等价memo依赖及导出，未再跑全量 |
| Shared全量单测                      | 23文件、239项通过                           | shared-tests.log                                             |
| Frontend定向回归                    | 3文件、27项通过                             | cache/推荐预算/分组回退                                      |
| Backend首次定向回归                 | 5文件、155项通过                            | backend-targeted.log；之后加强自身期限与未知错误交界测试     |
| Backend最后全量串行                 | 166文件通过、2文件失败；1800项通过、2项失败 | backend-tests-idle.log，168文件/1802项总计                   |
| Backend最后定向复跑                 | 5文件通过、1文件失败；181项通过、1项失败    | backend-focused-final.log；本轮新增分组/汇总文件通过         |
| 复杂度                              | 通过，29个文件/100个函数存量豁免            | 比基线减少1个函数豁免                                        |
| Backend日志静态与告警规则           | 已通过                                      | 342文件；4条规则、1条启用，无新增告警通知                    |
| 规划日志门禁、模块知识和任务context | 通过                                        | module知识已同步4个模块                                      |
| 本地UI/真实数据库/发布后P95         | 未执行                                      | 用户排除UI；无真实业务行读取、无发布                         |

日志位于忽略目录output/performance/content-path。表格是已执行证据，不表示后端全量通过。

## 后端未通过项与剩余风险

最后全量串行失败为：

1. conversations-thinking.test.ts：compatible undefined cancel intent测试超过既有5000ms限制。
2. generation/upstream.test.ts：并发真实网络计时测试中，取消请求的bodySentMs没有取得数值。

最后定向复跑中，上述两个场景通过，但conversations-branch.test.ts的鉴权反馈场景超过5000ms。因此只能确认存在不稳定结果，不能在没有隔离基线证据时断言与本轮无关。更早两次全量还出现generation/execute.test.ts真实时钟窗口断言失败及超时后续调用干扰；这些文件及生成/计费运行逻辑没有在本轮修改。没有放宽断言或超时掩盖失败。按用户要求不继续本地复跑。

真实Telegram冷启动、弱网、后台恢复及头像补缺体验未做UI验收；上线前后仍需按原设计核对。建议后续复用packages/ui-tests现有会话/大厅场景补充冷缓存、版本卡、groups503与慢summary，当前不启动也不新增临时UI脚本。

## 发布与恢复

Sentry按fde375a5检索无匹配release；不能据此证明未部署，也不能证明已满足上轮24小时观测门禁。本轮没有发布或宣称线上P95下降。D预热、私人持久快照和E公共缓存头继续等待证据。

先确认上轮release及观测，再按A/B/C分批发布，后端先于前端。保持同route/platform/release来源、至少24小时和成功N≥100；iOS样本不足时延长48–72小时，同时查看error/stall/left及取消，避免仅统计成功请求。

发生身份/支付/错页异常、错误升高，或充分样本下同平台P95回退超过10%且至少200ms时停止推广并按批次回滚。无SQL迁移、无storage格式变更，不需清除用户分组数据。
