# 实施计划

1. 在 `generateImagePlazaImage` 的 edit 分支中按 `sizingMode` 和非 `fixed` 分辨率条件写入 `resolution`，保留其余请求字段。
2. 扩展现有 upstream 测试：保留 resolution 模型断言，新增 `aspect_ratio + fixed` 省略字段断言；运行定向测试。
3. 在 image-plaza worker catch 中复用现有 Sentry Logs helper写安全摘要，不改变 `markFailed` 顺序和错误吞吐。
4. 运行格式化检查、Backend typecheck、定向测试、Backend 完整测试及适用 lint。
5. 全量审查 diff：确认无 prompt、图片、响应正文、secret；确认无重试/结算/契约变化。
6. 更新受影响模块知识，整理验证结果和剩余真实上游风险；不自动提交或部署。

## 回滚点

- 步骤 1/2 失败：恢复请求组装和测试修改，不触碰数据。
- 步骤 3 发现 SDK 行为可能抛出：移除 Sentry 调用，保留 Pino 与核心兼容修复。
- TEST/Preview 仍返回 400：停止生产发布；检查参考图像素约束和脱敏 provider code，不自动重放付费请求。
