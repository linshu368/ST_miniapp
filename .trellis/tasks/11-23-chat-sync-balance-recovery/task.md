# 任务进度

- [x] T1 stale部分索引与本地计划验证；生产2秒验收仍在T5
- [x] T2 原子预留、其他消费保护、终态释放；余额不足直接永久失败，移除充值恢复方案
- [x] T3 insufficient_balance/402/固定提醒，后台拒绝单独计数、不登记普通退避
- [x] T4 SQL语义回归、270项Backend回归、368项shared测试、全包typecheck及Admin/Frontend构建；日志/迁移/DB/复杂度检查与diff --check
- [ ] T5 TEST真实PG17多连接、正式迁移、生产2秒查询实测及部署观察（不自动push；生产独立确认）
- [x] T6 附加排查17:28–20:28生产7服务全部error：119条/98trace，原始安全字段JSON保存在仓库外；不把日志条数当故障次数

## 验证边界

本地WASM不证明多连接调度或生产2秒SLA。测试无创作者报价，创作者helper为本地空实现，不证明分成端到端。依赖目录缺文件造成一次测试/构建启动失败，按原锁文件offline force重装后已通过；lockfile和依赖版本无改动。DB lint的6条警告都来自既有20261118媒体生产迁移。复杂度仅移除本次拆分的settle.ts文件预算，未调整其他基线。

## 新排查结论

51余额P0001均TOTAL_CREDITS_INSUFFICIENT；45扫描失败含37stale/6metadata/2待结算；12记忆error=2会话6次执行；4图片Venice422；3首字超时日志=1请求；2turn_terminal中止最终complete；1主路网络失败被兜底成功；1Prisma P2010对应ops.llm_calls_attempt_id_key唯一冲突而请求最终complete。新截图问题仍是原线上代码；本次修复尚未发布。

## 预检到扣费复审

补测真实charge_llm_usage：main_only预留10后其他消费使用剩余5，本轮仍成功扣10；main_then_bonus 10与main_only 5两份预留刚好占满15，两笔均可成功结算。不是仅直接测试apply_wallet_debit。SQL回归通过。只读预检通过后原子预留仍可因并发拒绝，这应在供应商调用前返回402；不能把初步读取日志当作资金保证。真正资金保护从数据库预留提交开始，最终RPC仍可能因非余额基础设施错误失败。旧账未回填预留。最新生产只读结构复核：预留列0项、预留/失败函数0项，尚未启用本修复；TEST真PG多连接验证仍未执行。

## 日志结果补充验证

余额不足两个扣款事件通过注入字典显示result=扣款失败，outcome仍rejected且info级别；单独显示余额不足扣款失败计数。未知P0001继续普通失败/error。实际Pino/结算/钱包/同步任务4文件114项通过；同步测试明确assert无retry map项，后续轮询不再调用扣款RPC。
