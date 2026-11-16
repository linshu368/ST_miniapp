# MiniApp 内容链优化：设计对应实施记录

实施日期：2026-11-16。状态：**本地候选，未提交/未部署；不代表线上P95已改善。**

依据用户指定的 [代码对照设计](code-grounded-optimization-design.md)。本轮另遵循两项指令：可以适当补充客户端缓存；修改后不启动本地UI验证。

## 结论与实施边界

- 已落实 A：会话页不再无条件拉大厅全表，优先复用公开摘要；缺失详情仅在首屏结算后走normal，按用户/会话短期内存复用。
- 已落实 B：分组自身期限/已知依赖超时返回既有503/folders_unavailable；未知500仍为错误。summary有250ms独立预算，迟到或失败不拖groups/flat主体。
- 已落实 C：自动推荐open/resume总预算1500ms，手动refresh/undo及兼容open保持5000ms；原450ms公开头hedge、旧批次和幂等UUID保持。
- 未新增预热、Service Worker、公共API缓存头、私人列表持久化或数据库迁移；并发帽、content-ready判定和鉴权/计费保持。
- 按用户要求未启动本地预览、浏览器或Playwright。自动化验证及未覆盖项见 [verification.md](../11-16-miniapp-content-path-optimization/verification.md)。

## 与设计批次对应

| 批次       | 实施                                                                                  | 边界与恢复                                                 |
| ---------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 已落地入口 | 保留fde375a5中的rewrite、规范URL、首屏critical和独立groups指标                        | 不重复修改入口，不叠加根路由/CDN逻辑                       |
| A          | cache-only公开摘要订阅；缺失详情normal；1分钟用户+session内存鲜活期                   | 没有目录快照也不发全表；不把历史版本卡替换为当前摘要       |
| B          | groups读期限/已知依赖超时503；summary250ms取消/省略；前端groups关闭额外transportRetry | 未知500、鉴权拒绝保留；已有404/503才退平铺，不改按角色偏好 |
| C          | 自动入口1.5秒、手动5秒、400兼容尝试共享总期限                                         | 保留旧批次/公开头；手动刷新即使转换open也不缩到1.5秒       |
| D          | 仅采用用户明确允许的低风险公开摘要复用和详情内存缓存                                  | 未新增后台预热、私人列表快照或用摘要冒充完整详情           |
| E          | 不实施                                                                                | 没有发布后的同次文档/边缘证据，不擅自加公共缓存头          |

## A：会话页旁路与客户端缓存

原先useLobbySummaryLookup无条件useCharactersQuery(recommended)，冷缓存会与groups争critical。现在只以disabled observers复用同一组characterKeys及既有快照；invalidate/focus不会使这些被动订阅自己发网。缓存可即时展示，读盘保留真实savedAt，不把读取时刻当成新数据。

| 数据                                    | 缓存位置                                            | 生命周期                              | 隔离与校验                                                                                            |
| --------------------------------------- | --------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 公开大厅目录/公开头                     | 复用已有React Query与v5/v4/public-head localStorage | 沿用原24小时持久TTL；不新增key/schema | CharacterSummarySchema校验；损坏、过期、非法/未来savedAt删除；storage拒绝只用内存；较新来源覆盖旧摘要 |
| 会话行角色详情                          | 既有React Query内存                                 | staleTime60秒，默认gc5分钟            | key继续包含角色、viewer和session；绑定版本会话只能读会话详情，不用当前大厅摘要                        |
| 私人会话列表/正文、余额、权限、支付真相 | 不新增持久缓存                                      | —                                     | 不扩大数据持久化范围，不提供鉴权或版本真相                                                            |

补缺详情保留pending闸门，等待entry enrich及导航安静窗，再使用normal。普通请求仍最多占2槽，总帽仍3槽；不会把N个补缺都提升为critical。其他进房详情调用的默认优先级/TTL未改变。

会话数据hook从行视图中抽到use-session-character.ts，保留旧导出兼容既有分组行调用者。没有将关键列表拆为串行动态chunk。

## B：分组故障与summary拖包

groups使用原3秒SDK读期限。已知57014/PGRST003或自身期限造成的取消，映射原folders_unavailable；保留cause。明确的编程/权限错误优先保留，即便恰好与期限同时到达；无自身期限的外部AbortError也不统一吞掉。HTTP鉴权仍先于仓储读取。

前端继续只接受原404/503不可用约定，未知500展示既有错误；groups额外传输重试关闭，避免先重复3秒RPC才降级。平铺回退复用旧Query数据，不清用户偏好、分组或位置状态。

readFolderSummary为groups和flat共用：250ms截止、向SDK透传AbortSignal，同时Promise race保证不合作传输不会拖住主体；错误和迟到拒绝有处理，响应已省略summary后不会再被迟到结果改写。没有另取一次全量会话列表。标签/管理入口在缺少summary时允许缺省。

取消信号只证明客户端/SDK传输收到取消，不证明PostgreSQL执行已立即终止。数据库真实执行时长与容量需发布后核对，本轮没有连接真实数据库。

## C：推荐预算与手动操作

自动open/resume明确传1500ms，包含排队和body消费；旧后端400兼容请求使用同一控制器，不能重开期限。原公开头hedge仍为450ms，可较早提供真实可展示内容；自动推荐失败继续保留安全旧批次/公开头，不改变ready定义。

手动refresh/undo与手动刷新无batch时的open保持5000ms；冲突兼容、失败重试UUID、并发防双击和viewer变更检查沿用。transport与mutation hook按职责拆开，useLobbyRecommendation收紧到120行以内，未增加通用状态框架。

## 发布门禁、性能与回滚

当前基线来自既有11/14–15窗口，不重算为新成绩：/chats Android P95约8.28秒/N436，iOS约6.15秒/N81；/characters约7.96秒/N293和7.10秒/N77。iOS为低样本。groups API成功样本约3.21秒/N1360与3.18秒/N189。阶段P95不能相加/相减；1500/250ms是配置预算，不是实测P95。

Sentry检索fde375a5未返回匹配release，不能据此断言没部署，也不能证明≥24小时门禁通过。仅准备本地候选；先确认上轮生产release及同口径观测，再按A/B/C分批发布。前后端兼容发布建议Backend先于Frontend。D预热与E边缘头继续等待真实数据。

上线后至少24小时、分route/platform/release成功N≥100，低iOS延长48–72小时；同时看started/error/stall/left、cache命中、cold/warm与API排队/头/body，避免只看成功幸存者。4秒内容与2秒普通API目标未被本地测试证明。

错页/hydration、身份或支付异常、错误升高，或充分样本同平台P95回退>10%且≥200ms时停止推广，按批次回滚。无storage格式或SQL迁移；回滚不必删除用户分组。真实Telegram交互、弱网/后台恢复和头像补缺体验未做本地UI验收，发布流程需另行核对。

## 关联材料

- [任务设计与可靠性审查](../11-16-miniapp-content-path-optimization/design.md)
- [实际验证结果](../11-16-miniapp-content-path-optimization/verification.md)
- [上轮冷启动说明](cold-start-optimization-2026-11-16.md)
- [Supabase取消信号](https://supabase.com/docs/reference/javascript/using-modifiers-abortsignal)、[PostgREST错误码](https://docs.postgrest.org/en/stable/references/errors.html)
