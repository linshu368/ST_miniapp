# Bug Analysis: 请求期限、创建缓存与导航调度的隐含边界

## 1. Root Cause Category

- **E / Implicit Assumption**：把“HTTP有timeout”误当成“用户等待有界”。普通client先拿槽后计时，排队没有自己的截止；实际owner顺序与deadline测试共同确认此问题。
- **D / Test Coverage Gap**：仅看query配置或mock useQuery不能覆盖disabled→新key的行为。实际QueryObserver证明新创建数据在staleTime=0时会重复GET。
- **C / Change Propagation Failure**：首次entry放行与BottomNav保护不能覆盖后续深层Link/返回；扩展原调度owner而非另建状态机。
- **B / Cross-Layer Contract**：代理fetch异常重新throw可能变为HTML，调用方仍按JSON消费，失败恢复信息被框架错误页遮蔽。

## 2. Why Fixes Failed

1. 仅用refetchOnMount=false不足以控制新key的stale查询；以真实观察者切key验证后改为当前创建确认对象的一次豁免。
2. 长期保持创建对象fresh会漏掉后来其他设备更新；首次订阅后即恢复staleTime=0，测试证明恢复不会多GET、之后焦点能刷新。
3. 根归因组件若直接使用导航级background开关，会反复卸载和重播；保留其启动级信号，只有次要读取跟随导航让路。
4. UI失败不能直接归因产品代码：首次聊天文档请求未返回而超时、既有PNG的IDAT CRC无效、依赖目录为空导致500，证据不同分别处理。保留原断言和锁文件。后续检查发现standalone中112个符号链接/junction指向真实workspace依赖，Next14 recursive-delete实现会stat并递归跟随这些目录链接，解释重复build期间依赖清空；构建前将自己生成的standalone移出清理路径。

## 3. Prevention Mechanisms

| 优先级 | 机制                | 已落地动作                                                        | 状态 |
| ------ | ------------------- | ----------------------------------------------------------------- | ---- |
| P0     | 原owner负责完整期限 | timedFetch内部拿槽、取消race、单调时钟超期检查                    | Done |
| P0     | 真实consumer验证    | QueryObserver覆盖key切换、一次豁免、focus、invalidation与缓存身份 | Done |
| P0     | 原错误契约          | 499/504/502标准JSON、禁止缓存、取消不冒充上游故障                 | Done |
| P1     | 有界调度            | 深层Link/返回、两帧idle释放、generation与4秒兜底                  | Done |
| P1     | 验收输入有效        | 纠正既有PNG校验码；复用常驻预览完成首次编译后验证                 | Done |
| P1     | 保留测量边界        | 不改ready；按release注明请求计时纳入排队                          | Done |

## 4. Systematic Expansion

- 检索并复用普通API client、直接timedFetch、短剧/通知prefetch与enrich/background调用。直接目录请求已有同类期限修复，保留；长生成/上传仍沿既有bypass预算。
- 不把所有请求标critical，不新建统一请求框架，不调整并发帽，不以长TTL替代身份与新鲜度规则。
- 目前深层导航捕获覆盖普通同源Link及popstate，程序式router跳转仍有边界；真实冷启动、媒体/CDN和独立客服链需要生产证据，不能推导为已解决。
- 对本机依赖异常以实际链接目标、清理函数源代码和时间顺序定位。恢复原锁定内容并隔离生成的standalone目录，最终构建后再次核对真实Next依赖完整；不更换Next版本或修改生产部署配置。

## 5. Knowledge Capture

- [x] 更新frontend testing-quality-and-deployment.md中的可执行断言和失败分类。
- [x] 5个模块的最终事实更新已写入module-updates.json，校验通过，归档时按项目流程应用。
- [x] 实施报告记录13页覆盖、生产观测与回退边界。
- 本应用仓库没有Trellis框架的 `src/templates/markdown/spec/` 源，不创建平行模板。未执行git add/commit/push；项目要求最终人工审阅后才允许暂存或提交。
