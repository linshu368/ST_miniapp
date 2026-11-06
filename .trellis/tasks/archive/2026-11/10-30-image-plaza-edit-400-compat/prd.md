# 修复 Image Plaza Venice 编辑请求 400 兼容性

## Goal

修复 Image Plaza 使用 Venice 固定尺寸/宽高比模型进行单图编辑时稳定返回 HTTP 400 的兼容性问题，并确保同类 worker 失败可在 Sentry 中用安全字段检索。

## Requirements

- 固定尺寸或宽高比驱动的编辑模型不得被附加不属于其模型契约的分辨率档位。
- 明确支持分辨率档位的编辑模型必须继续发送用户报价快照中的分辨率，保持既有行为与价格语义。
- 不改变 Image Plaza 的报价、attempt、租约、失败终态、结算和“不自动重试”语义。
- provider 失败观测只能包含 attempt、模型、模式、状态码/内部错误码和结果是否未知等安全摘要；不得记录 prompt、参考图、完整响应正文、密钥或签名 URL。
- 不新增公开 API、共享契约、数据库对象、环境变量、依赖或通用 provider 抽象。
- 回归测试必须锁定固定尺寸编辑省略 `resolution`、分辨率模型仍保留 `resolution`，并运行既有 Backend 验证。

## Acceptance Criteria

- [ ] `seedream-v5-lite-edit` 对应的 `aspect_ratio + fixed` 编辑请求只发送支持的 model、prompt、image、aspect ratio、format 和安全模式字段，不发送 `resolution: "1K"`。
- [ ] `sizing_mode=resolution` 且分辨率为 `1K`/`2K` 的编辑请求继续发送相应 `resolution`。
- [ ] Venice 非 2xx 仍只执行一次调用、进入原有明确/未知失败分类，并且不进入图片结算。
- [ ] worker 的 provider/settlement 失败在 Railway Pino 日志之外同步生成一条脱敏 Sentry Log；Sentry 故障不影响 attempt 失败落库。
- [ ] 相关单测、Backend typecheck、Backend 完整测试和适用 lint 通过；真实 Venice 调用仅在 TEST/Preview 经人工授权后执行，不从本任务自动触发付费请求。

## Notes

- 生产 Railway 已观察到四次相同请求摘要的 400；Sentry 同期无事件是现有 worker 仅写 Pino 的观测缺口。
- Venice 400 响应正文可能回显用户输入，本任务不以记录完整正文换取诊断能力。
