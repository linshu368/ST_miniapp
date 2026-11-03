# 设计与复用

- 复用features/lobby/ranking-stats.ts与ranking-score.ts、每日lobby-ranking-refresh-job、character_ranking_scores、原ranking-score/recommended-ranking/params测试。无新表、迁移、依赖、HTTP契约、配置控件或实时用户标签。
- 仍在现有专用连接/超时/advisory lock下离线运行，保留persist短事务和错误保留旧快照。把历史资格与D30/R48放到一次SQL快照，避免重复资格扫描及两次统计口径漂移。chat_history按九域规则属于存量明确豁免的跨域聚合路径，不开新出口。
- user-card首触取全历史最早发起轮次created_at（包括失败尝试），不以本轮表现决定是否纳入。有效资历要求status=success且用户输入、角色回复均非空；同(session_id,turn_index)只算一次，session/turn缺失的ST历史按id。分支继承只存在引用表，不重复计资历。
- 有效时间取首次成功revision的greatest(created_at, coalesce(llm_billing_settled_at,created_at))。现代记录尽量使用确认后的结算时刻，老记录缺独立完成时间用创建时间近似，已知秒级边界限制；禁止用后来重生成的成功回溯到旧的失败时间。
- 每个user求首次有效时间与第10个有效逻辑轮次时间。资格：user-card首触>=首次有效+24h，且严格晚于第10个有效时间。首触资格冻结为历史规则；平台最初试过的卡后续仍不参与其质量评分，这是已确认首次接触判定的保守取舍。
- 合格user-card全窗口内的发起轮次沿用原深度口径（包括已有失败占位口径，本次不额外改其含义），重生成去重；R48原30分钟会话与满48h观察规则保留，first_touch_lookback_days只影响原R48首触观察、不影响平台资格全历史计算。
- 窗口有原始活动但无合格用户的卡仍输出n=0,d30=null,k=0,r48=null，覆盖污染旧样本，按原不足20人冷启动处理；整窗口完全无活动仍走原空结果保护。成熟卡变少是口径变化，不能让空样本伪装成熟。
- 容量：只扫描所需标量/时间，正文仅在DB做非空判断，不输出；SQL不逐用户查DB。用隔离PG17跑实际生产函数参数化SQL、边界fixture和40万合成记录EXPLAIN，外部调用只有既有离线DB超时，无重试、资金、用户写入、补偿及新限流需求。
- 生效：未来发布后下一次成功刷新切换，非立即UI生效。无DB迁移；应用回退后重算可恢复旧口径，已有分数表保留。发布需确认刷新成功、qualified样本量与成熟卡数量，不自动发布或触发生产重算。

规划审核：lobby_score_core独立复核通过；要求全历史首触含失败、10th严格在先、空白含tab/newline、零样本left join保留活动卡。已于2026-11-02 task start。

## 最新 main 性能门禁补充

本子任务是每日离线评分资格计算，不新增页面或 HTTP 请求、不在大厅请求扫描聊天历史，因此 `meta.mobile_performance.mode=not_applicable`，说明具体边界而非补零。发布后的 Android/iOS 页面与推荐 API P95 由同批 `11-02-lobby-quality-rotation` 声明统一覆盖。离线 job 仍复用专用连接、互斥锁和超时；真实 PG17 与 EXPLAIN 验证 SQL 边界/相对成本，发布后核对 job 完成及数据库负载，不据此推断页面 P95。合入 main `7a9ddf27` 不触碰同事移动端资源调度或模型 provider 优先级。
