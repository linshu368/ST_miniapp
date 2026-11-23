# 设计评审

## 已确认事实与复用

生产2026-11-23 16:42–19:42 CST：43次stale扫描失败；EXPLAIN Seq Scan+Sort，约45万行461MB无匹配索引；317次成功P95=3693ms。49次P0001原始数据库消息全部TOTAL_CREDITS_INSUFFICIENT。
检索并复用ConversationHistoryRepository、stale稳定游标、generation/precheck/settle/sync、begin_chat_generation_observation、save_chat_turn_quote、usage_charges、apply_wallet_debit、charge_llm_usage/reconcile_llm_usage、既有402错误、Pino安全投影和迁移执行器。无新公开API、队列、依赖或客户端余额缓存。

## 数据落位 CONTRACT §2.2

experience.chat*history原表只加索引。billing.usage_charges为M，active，增加两项reserved*\*\_credits，同一billing权威写方、报价/结算生命周期与相同用户外键；不另建任务或hold表。预留终结归零，账务行永久保留。原子预留/终态失败/触发器函数归billing，experience admission通过明确billing RPC调用。无新增外部读者、权限或JSON控制键；registry同步列语义。

## 并发/失败模型

开轮已有事务保存报价后reserve，同一钱包行锁下减去其他预留、专项优先或仅通用分配。其他统一扣款扣除其他预留；wallet BEFORE UPDATE保护直接写者。实扣先消费自己的hold，再更新真实余额，所有步骤同一事务和原流水唯一键。保护财务快照，允许合法fallback更新供应商身份。
零费/终账归零；明确upstream_error、timeout或清除charge编号释放。用户停止/成功保留到原计费闸门结算；不靠TTL释放活跃余额，重启复用stale恢复。容量：用户部分索引聚合，原stale查询50行与双来源并发不变。外部截止继续5秒，不为达到2秒目标制造超时失败。
扣费RPC在外层持有账单行锁，内层异常子事务回滚原扣费；只捕捉两个精确P0001余额消息，在同一RPC事务把未扣账单置failed/charged_credits=0/settled_at并释放预留，返回固定拒绝JSON。并发重放不能穿过异常回滚与失败提交之间。其他P0001重新抛出。旧SQL异常兼容调用专用失败RPC，异常持久化失败仍报error。
失败账单按现有archived结果重放；guard防旧回写改回quoted/free，充值不唤醒，不免除已成功实扣的并发账单。

## 演进 / 恢复

独立索引文件CONCURRENTLY，不包事务；建失败只在核对后清理同名invalid index，再通过账本重跑。财务迁移事务锁5s、语句120s，锚点形态守卫，重放标记幂等。先本地回归+TEST；发布兼容服务端错误处理，再启用财务migration；生产索引单独验证。应用与生产分支存在旧写方差异，发布只移植本次diff到当前main，不直接发布整个本地分支。应用回滚保留财务保护；财务缺陷forward-fix，不能抹除终账/活跃预留。索引可单独CONCURRENTLY回滚。

## 日志/性能/评审

已知余额拒绝info/rejected+INSUFFICIENT_BALANCE，balanceRejectedCount，未知故障仍error；金额/正文/秘密不进入日志。复用trace/span/user/session，不为日志加数据库读取。Android/iOS和发送API无真实样本，基线null；2秒是扫描及新增等待预算目标，不是LLM整轮生成目标。发布后独立验证。范围按用户最新要求复核：无充值后自动追扣机制。

## 余额扣款日志呈现补充

用户明确要求余额不足显示“扣款失败”，不呈现为普通失败且不进入循环重试。两个既有balance_rejected事件维持info/rejected/INSUFFICIENT_BALANCE；通过注入的事件结果映射将result固定为扣款失败，原因显示星尘余额不足。普通未知数据库错误仍为失败/error。后台汇总单独标出balanceRejectedCount，失败账单永久终结语义不变；真实logger测试覆盖两个事件、普通错误不被误分类及不登记退避。
