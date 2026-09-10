# Preset Platform 会话与模型 UI

## Goal

实现对话测试工作台、私有会话列表、OpenRouter 模型下拉与模型目录页。

## Requirements

- 实现对话测试工作台 UI，沿用参考 HTML 图 1：左侧品牌/新建会话/导航/私有会话列表，中间对话卡片与输入区，右侧当前会话配置、当前环境角色卡和脱敏输入快捷区。
- 支持私有会话创建、重命名、切换、归档/删除；会话 A/B 的模型、预设、角色卡、消息和迟到响应不得串线。
- 对话顶部支持 OpenRouter 模型下拉选择；另有模型目录页用于搜索、刷新、查看 stale/同步状态、过期/不可用状态。
- 模型目录查询/搜索/选择参考 Admin `ModelCatalogEditor` / `openRouterModels` 的交互和校验口径。
- SSE 展示生成中、done、流前失败、流内失败、断线恢复和 retry 入口；失败不能生成伪助手消息。
- 本任务不实现预设管理编辑页，也不实现素材 backend 脱敏规则。

## Acceptance Criteria

- [ ] A/B 私有会话切换后配置、历史、SSE 响应和输入框互不覆盖。
- [ ] 模型下拉正常选择 OpenRouter 可调用模型，目录页支持搜索 name/id/description/canonical slug。
- [ ] 模型目录 stale/同步/刷新/过期状态可见。
- [ ] 生成失败、超时、取消/断线、409 busy、401/403 均有清晰状态。
- [ ] `pnpm --filter @miniapp/preset-platform typecheck/test/build` 通过。
- [ ] 根据实现补充 preset-platform UI/state/testing spec。

## Notes

- 依赖 SPA shell、backend foundation、model generation。
- 该任务 package 暂标 `frontend` 是因为 Trellis 白名单尚无 `preset-platform`。
