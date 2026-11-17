# 技术设计

## 边界与数据流

现有链路保持不变：报价快照 → attempt → worker 租约 → `generateImagePlazaImage` → Storage → 原子结算。改动只位于 Venice 请求适配和 worker 失败观测，不调整 route、shared DTO、runtime config、repository 或数据库。

编辑请求按已有 `sizingMode` 组装尺寸字段：

- 所有单图编辑继续发送 `aspect_ratio`，因为当前目录只开放 Venice 支持的比例。
- 仅当 `sizingMode === "resolution"` 且报价分辨率不是内部占位值 `fixed` 时发送 `resolution`。
- `aspect_ratio`/`pixels` 模型不再把内部 `fixed` 强行转换为上游 `1K`。

分辨率模型的现有 `1K`/`2K` 行为保持不变。生成端现有分支已采用同一判断原则，本次复用该语义，不新增模型白名单。

worker 在完成原有 `markFailed` 尝试后，通过现有 `sendBackendSentryLog` 写一条脱敏错误摘要。Sentry 是非关键观测，调用保持同步无 await/no-op 语义；即使 SDK 未配置或发送失败，也不得改变数据库失败终态。

## 复用调研

- 复用 `ImagePlazaGenerationInput.sizingMode`：它已由报价快照持久化并传入 worker，是权威尺寸策略；拒绝新增按 provider model id 的硬编码表。
- 复用生成分支的 `sizingMode === "resolution"` 判断：保持 generate/edit 一致。
- 复用 `sendBackendSentryLog` 与 `sanitizeTelemetry`：不新建 Sentry client、logger 或 telemetry adapter。
- 扩展现有 `upstream.test.ts`：不创建新测试文件；现有 edit case继续证明 resolution 模型兼容，新 case锁定 fixed 模型。
- 不改 shared contract、route、repository、Storage 和 migration，因为错误发生在内部上游请求组装。

## 可靠性设计

- 超时：沿用 Venice 请求的显式 `AbortSignal.timeout`，不调整预算。
- 重试：继续单次写调用；400 是明确拒绝，不自动重试，避免重复计费。
- 幂等/并发/事务：attempt 租约和结算 RPC 不变；请求组装无新状态源。
- 降级：不自动切换模型，避免改变用户报价/输出语义；紧急运营降级仍可通过现有模型目录关闭 i2i/edit。
- 补偿：400 继续写 `failed` 且不调用结算；未知网络结果继续 `failed_unknown`。
- 限流/容量：无新调用、队列或响应正文读取；Sentry 仅每个失败一条有界摘要。
- 可观测性：Railway 保留 `{ err }`；Sentry 增加 attemptId、providerModelId、mode、errorCode、outcomeUnknown，禁止 prompt/reference/body。

## 最小充分方案

只修改两个产品文件和一个既有测试文件。不引入 provider capability registry、动态模型同步、fallback、重试、数据库列或公开错误码。当前真实故障只需要纠正尺寸字段选择并补齐现有观测出口。

## 演进、发布与恢复

- 兼容：对 `resolution` 模型无行为变化；对 `fixed/aspect_ratio` 模型只移除 Venice 当前未声明的字段。
- 发布：Backend 单独部署即可，无 migration、consumer 顺序或旧数据处理。
- 观察：部署后在 TEST/Preview 使用合规 1K 参考图验证 Lite i2i；停止条件为仍出现 400，届时查看新增 Sentry 摘要并核对参考图尺寸/官方模型契约。
- 回滚：应用回滚即可恢复旧行为，无数据恢复；失败 attempts 不重放、不追扣。

## 可验证性

- 单测：fixed/aspect-ratio edit 不含 resolution；resolution edit 仍含 2K；非 2xx 仍分类为明确失败。
- 静态：Backend typecheck 与 lint。
- 全量：Backend 现有测试。
- 人工：TEST/Preview 上传像素数不低于 65,536 的图片，选择 Seedream V5 Lite 图生图，确认 ready；生产不由本任务自动试调。
