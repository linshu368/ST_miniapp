# 根因调研记录

## 生产证据

- Railway production deployment `96a9e81e-18e7-4dbb-bef0-e3b72ec062b9` 在 2026-10-29 21:07:07–21:10:22 UTC 记录四次 `seedream-v5-lite-edit` i2i HTTP 400。
- 四次请求摘要均为 `aspectRatio=1:1`、`resolution=1K`、`format=webp`、`promptLength=95`，耗时约 2.4–2.5 秒；表明是确定性上游校验拒绝，而非超时或连接错误。
- 同时间窗 Seedream V5 Pro/Lite 文生图返回 200；Lite 文生图按 `aspect_ratio` 模式没有发送 `resolution`。
- Sentry `st-miniapp` 近 7 天按错误类型、错误码和日志文案检索均为空。源码确认 image-plaza worker 只写 Pino，未调用现有 Sentry helper。

## 源码与配置差异

- Image Plaza 初始目录把 Seedream V5 Lite 定义为 `sizing_mode=aspect_ratio`、内部 resolution `fixed`、edit provider `seedream-v5-lite-edit`。
- generate 分支仅对 `sizingMode=resolution` 写 `resolution`；edit 分支却无条件把 `fixed` 改写为 `1K`。
- Venice 当前 `GET /api/v1/models?type=inpaint` 返回的 `seedream-v5-lite-edit` constraints 包含支持的 aspect ratios，但没有 resolution tiers；模型在线。

## 结论与限制

首要根因是 edit 请求忽略 sizing mode，把内部 UI/报价占位 `fixed` 转成上游分辨率档位。由于旧实现刻意不读取/记录可能回显敏感输入的 400 body，无法从历史请求取得 Venice 字段级错误码。参考图低于 Venice 65,536 像素是次要可能，但不改变本次尺寸字段兼容修复；若 TEST 仍失败再单独评估上传前像素约束。

## 资料

- Venice Image Edit：`https://docs.venice.ai/api-reference/endpoint/image/edit`
- Venice Error Codes：`https://docs.venice.ai/api-reference/error-codes`
- Venice live model catalog：`https://api.venice.ai/api/v1/models?type=inpaint`
