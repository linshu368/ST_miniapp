# 执行计划

方案已经用户批准；具体实现以此文档进行内部审查，不重复请求批准。

1. shared cancellation DTO；backend CAS cancel、settlement 竞争、abort 和残留恢复；frontend 取消/重新生成/有界等待及请求隔离。
2. 计费/并发风险认定需要回归测试：取消先赢、完成先赢、重复/迟到/越权取消、首字前、挂流、异常收口、旧回调隔离。优先扩展已有测试文件，仅缺失覆盖时新建必要回归。
3. prisma generate；shared/frontend/backend 现有测试、pnpm -r typecheck、frontend lint/build、backend build、diff check。
4. 更新 README/ARCHITECTURE 与受影响模块规范，记录真实设备/TEST未执行边界；交付未提交 diff。

人工回归：8 秒提示→取消→原消息下重新生成→新回复；有部分正文取消；刷新后孤儿 streaming；取消与最后 token 同时；断网恢复；失败不扣费/不消耗免费额度。真实环境检查需后续发布授权。
