# 执行计划

方案已经用户批准；具体实现以此文档进行内部审查，不重复请求批准。

1. shared cancellation DTO；backend CAS cancel、settlement 竞争、abort 和残留恢复；frontend 取消/重新生成/有界等待及请求隔离。
2. 计费/并发风险认定需要回归测试：取消先赢、完成先赢、重复/迟到/越权取消、首字前、挂流、异常收口、旧回调隔离。优先扩展已有测试文件，仅缺失覆盖时新建必要回归。
3. prisma generate；shared/frontend/backend 现有测试、pnpm -r typecheck、frontend lint/build、backend build、diff check。
4. 更新 README/ARCHITECTURE 与受影响模块规范，记录真实设备/TEST未执行边界；交付未提交 diff。
5. 深度思考静默期：在 Backend 禁止深度思考的 4 秒 fallback，并将 6 秒取消降为观测事实；在 Frontend 禁止 6 秒观测回调自动取消。
6. 前后端统一取消普通模式 6 秒硬终止：保留普通模式 4 秒单次 fallback、两端 6 秒指标、显式取消及 110/120/150 秒期限；准备阶段使用独立 20 秒有限预算。扩展既有 first-token/lifecycle/hook 测试，覆盖普通与深度思考跨 6 秒后仍可交付。

人工回归：8 秒提示→取消→原消息下重新生成→新回复；有部分正文取消；刷新后孤儿 streaming；取消与最后 token 同时；断网恢复；失败不扣费/不消耗免费额度。真实环境检查需后续发布授权。

首字人工场景：开启深度思考后供应商 6 秒内无公开 reasoning、之后返回正文，不触发自动取消或连接中断；关闭深度思考时 4 秒触发单次 fallback，但 6 秒只记录指标，fallback 仍可在稍后交付；超过 8 秒仍出现等待提示并可手动取消；超过服务端绝对期限最终 interrupted 且不扣费。
