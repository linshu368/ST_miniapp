# 角色对话图片生成功能规范

> 状态：**代码与 test migration 已实现，运行时开关默认关闭；真实上游、真机和生产发布尚未验收**。不得把代码落地表述为现网已开放。技术取舍与评审项见 [`docs/chat-image-generation-review.md`](../../../docs/chat-image-generation-review.md)。

## 功能边界

- 仅最后一轮完整、非开场白的 assistant 回复显示“看看TA”。
- 先免费生成一句中文画面描述；用户确认或在面板内修改后才创建单张图片任务。
- 用户自定义内容只校验、审核和 trim，不二次润色、不静默截断。
- 图片固定绑定具体 `chat_history` message/revision，展示在正文下、语音上；每次重新生成创建新 attempt 并独立计费。
- 初版不做多图、参考图、图生图、编辑、相册、分享和审核后台。

## 跨层不变量

1. 对外 image DTO 先定义在 `packages/shared/src/api/images.ts`；Frontend 不使用数据库行类型。
2. Frontend 所有请求集中在 `src/lib/api/images.ts` React Query hooks；组件不得直接 fetch。
3. DeepSeek 与 Grok 上游适配位于 `backend/src/features/generation/image-upstream.ts`；image feature 只做任务编排，route 不直接调用 provider。
4. Runtime config 只从 `platform/runtime-config.ts` 读取；provider secret/endpoint 只从 `platform/config.ts` 读取，secret 不下发浏览器。
5. 图片是 message 旁支产物，独立表持久化 attempts；不扩张 conversation 消息本体，不与 audio 共表。
6. 余额预检不是扣费。Storage 结果已验证后，钱包扣款、ledger、幂等记录和 image ready/current 必须由单一数据库事务完成。
7. 同一 attempt 最多扣一次；同 message 至多一个 active attempt 和一个 current ready 图，正确性由数据库约束/RPC 保证。
8. 出图失败、内容拒绝、超时或状态未知不扣费。provider 请求进入模糊区后不得自动重投。
9. 已确认任务必须支持离页与进程重启恢复；初版使用 PostgreSQL claim/lease，不新增 Redis 队列或独立 worker。
10. 新增/修改方法在定义处增加中文注释，说明职责；涉及外部调用、任务或账务时同时说明超时、幂等、事务/补偿和失败语义。

## 状态与恢复

- 公开状态：`pending | generating | ready | failed | failed_unknown`；`leased/storing` 只在数据库内部映射为 generating。
- Frontend 只在存在非终态时条件轮询；终态或页面后台停止，回前台精确刷新。
- DB 内部可有 `leased`，但不暴露给用户；provider 前租约过期可重领，provider dispatch 后超时收口为 `failed_unknown`。
- 新 attempt 失败时保留旧 current ready 图；新图只在成功结算事务中替换 current。

## 安全、容量与日志

- 初版健康向；自动描述和用户 prompt 都走内容规则。拒绝不扣费。
- 一次只生成一张固定尺寸图片；限制 prompt 长度、响应字节、MIME 和任务并发；数据库不存 base64/二进制。
- 推荐私有 Storage bucket + 短期签名 URL；数据库保存稳定 storage path。
- 日志只记录 ID、阶段、状态、模型、尺寸、字节、耗时、错误码、provider request id；禁止 prompt、对话正文、图片、签名 URL、secret、initData。

## 配置与发布

- 价格、模型、尺寸、上限、提示和总开关由 runtime config 下发并在 attempt 创建时快照；前端不写死。
- 配置损坏/secret 缺失时 fail closed，停止新受理，不得用未知价格继续生成。
- 发布顺序：test migration/Storage → backend → frontend → test 开关验收 → production 同序灰度。
- 回滚先关功能开关、收口已受理任务、回退应用；账务和 attempt 审计记录不破坏性删除。

## 验证要求

按产品 PRD覆盖入口、免费描述、确认/编辑、成功计费、失败不计费、余额不足、重复提交、离页恢复、多次生成、大图与充值回跳。按需求可不新增测试文件，但不可跳过现有 shared/backend/frontend typecheck、test、lint/build 及 test 环境失败路径验证。
