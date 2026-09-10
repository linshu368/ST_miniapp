# Preset Platform 测试素材 UI

## Goal

实现测试素材页面：按当前环境选择/导入角色卡、展示脱敏真实输入并载入当前会话。

## Requirements

- 实现 Preset Platform “测试素材”页面 UI。
- 页面按当前环境加载角色卡，支持搜索、分页、选择和“用于当前会话”；test 读测试角色卡，production 读生产角色卡。
- 角色卡导入仅保存当前会话的只读引用/快照，不回写角色卡。
- 选择角色卡后展示该角色范围内的脱敏真实用户输入样本，支持刷新、分页、空态、权限错误、超时错误。
- 使用样本只把脱敏正文载入当前对话输入框，仍需用户主动发送；不自动生成。
- UI 不显示 user/session/message ID、Telegram 原始标识、联系方式或未脱敏正文。

## Acceptance Criteria

- [ ] 环境切换后角色卡列表和输入样本刷新且不串环境。
- [ ] 角色卡搜索/分页/选择/用于当前会话可用，下架或不可用角色有明确状态。
- [ ] 脱敏输入样本可载入当前会话输入框，不触发发送，不写生产业务域。
- [ ] 空态、权限不足、超时、无样本和脱敏服务失败均有明确反馈。
- [ ] `pnpm --filter @miniapp/preset-platform typecheck/test/build` 通过。
- [ ] 根据实现补充 preset-platform features/UI/state/testing spec。

## Notes

- 依赖 SPA shell、materials redaction backend 和 conversation UI。
- 该任务 package 暂标 `frontend` 是因为 Trellis 白名单尚无 `preset-platform`；实际目标是新增独立 workspace 包。
