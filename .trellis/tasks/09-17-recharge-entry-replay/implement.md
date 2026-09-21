# 执行计划

1. 扩展 lifecycle/adapter：充值 context、事件顺序、停录和恢复、路径/空闲结束；保持聊天路径。
2. 集成支付 flow/页面：入口、充值页兜底、外链前停录、有效回流及 reload 恢复；处理 seen-key 过早标记。
3. 增补现有测试和规范；运行 frontend 测试/typecheck/lint/build 与全仓 typecheck。

失败路径：SDK 缺失/超时、无身份、重复点击、invalid URL、存储不可用、返回重复/过期、reload、新聊天覆盖。Consumer：profile、recharge、order、root owner 和 shared schema。
