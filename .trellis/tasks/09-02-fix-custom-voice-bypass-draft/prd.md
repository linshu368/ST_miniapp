# 修复自定义语音绕过写稿模型

## Goal

确保自定义语音严格按用户提交并经既有确定性清洗后的文本合成，不再经过写稿 LLM；默认语音生成行为保持不变。

## Requirements

- `customText` 非空时直接作为最终 `spoken` 文本进入长度终检、落库与 TTS 合成。
- `customText` 为空时继续调用 `draftSpokenText(sourceText)`，由写稿模型提取默认台词。
- 保留现有 300 字终检、存储、计费、失败处理和日志行为。
- 不修改 API 契约、前端交互、数据库结构或上游默认写稿逻辑。
- 添加回归测试，明确区分默认与自定义两条分支。

## Acceptance Criteria

- [x] 自定义文本生成时 `draftSpokenText` 未被调用，TTS 收到自定义文本。
- [x] 默认生成时 `draftSpokenText` 被调用，TTS 收到写稿结果。
- [x] 自定义分支日志/计费 metadata 的 gate 为 `custom`。
- [x] 相关后端测试与 TypeScript 类型检查通过。

## Notes

- 本任务属于单文件编排回归修复，采用轻量任务流程，不需要额外设计文档。
