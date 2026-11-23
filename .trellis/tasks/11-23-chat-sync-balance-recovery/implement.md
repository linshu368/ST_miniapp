# 执行计划

- 索引migration与财务migration分别单文件执行，既有schema/报价/幂等兼容；无旧账回填。
- 仓库归一SQL与返回JSON的余额拒绝；开轮走现有402结果，settle/sync永久失败，不登记普通退避；保持未知故障。
- 财务风险确认需要SQL与既有Vitest回归：预留幂等、超额第二轮/其他消费、零费/超时/失败释放、用户停止保留、失败与返回原子、充值后重放不收费、未知错误回滚、真实Pino脱敏/等级。
- 运行typecheck、相关Vitest、logging:validate、logging/DB/migration/complexity lint、shared测试、所有消费者typecheck、build及diff --check。
- 本地WASM只证明SQL语义/顺序，不冒充多连接并发或线上2秒；TEST需真PG17并发两会话只够一轮、RPC拒绝/充值/重放、未知错误、权限及失败回滚。
- 正式TEST/production走workflow，需先可审查commit推送；本次未获自动push授权，整理完整差异和验证后请求最终发布动作许可。生产必须独立确认。
- 生产观察至少1小时：索引valid/ready和执行计划、相同GET成功样本P95/最大/超2秒次数、stale超时与余额拒绝无普通error；异常停发版并forward-fix。
- 建议后续将两会话余额不足、充值后旧账不扣、超时释放纳入packages/ui-tests聊天组；模拟验收不能替代真库并发/资金测试。

## 余额扣款日志呈现补充

用户明确要求余额不足显示“扣款失败”，不呈现为普通失败且不进入循环重试。两个既有balance_rejected事件维持info/rejected/INSUFFICIENT_BALANCE；通过注入的事件结果映射将result固定为扣款失败，原因显示星尘余额不足。普通未知数据库错误仍为失败/error。后台汇总单独标出balanceRejectedCount，失败账单永久终结语义不变；真实logger测试覆盖两个事件、普通错误不被误分类及不登记退避。
