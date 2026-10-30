# 修复视频生成并优化工作室体验

## Goal

修复 `feat_video_park` / Railway PR-566 中视频提交进入 worker 后被 Venice 以 HTTP 400 拒绝的问题，并改善影像工作室首屏、长会话渲染、视频模型选择和窄屏标题栏体验。

## Requirements

- Venice `/video/queue` 请求必须符合当前官方契约；用户已被受理的生成不得因本次修复被自动重投。
- 保留现有 quote、预扣、幂等键、worker 租约、失败退款与 `failed_unknown` 语义，不改变 shared HTTP 契约和数据库结构。
- 工作室读取 conversation 后不得为已终态的视频 attempt 逐条追加 GET；进行中的 attempt 继续按现有有限退避轮询并在回前台时同步。
- 长会话中 assistant 消息对应的最近用户提示词应线性计算，避免每条消息重复 `slice().reverse().find()`。
- 图片设置、视频模型和视频设置面板按需加载；主工作室首屏不等待这些低频交互代码。
- 视频模型选择 Sheet 增加明确的标题/说明/列表内边距、卡片间距、选中态、触屏与 focus-visible 状态，并保留安全区与独立滚动。
- 顶部标题与副标题超长时省略；返回、新建、历史按钮保持固定尺寸，不得被文字挤压或变形。

## Constraints

- Frontend 服务端数据继续只通过 `src/lib/api/image-plaza.ts` 的 React Query hooks 获取。
- 不新增 `any`、依赖、全局 CSS、公开 API、数据库 migration 或新的状态源。
- 不记录 prompt、参考图签名 URL、Venice key、完整上游响应或其他敏感内容。
- 本任务不改变模型目录、价格矩阵、扣费规则或自动重试策略。

## Acceptance Criteria

- [x] `queueVideo()` 将内部秒数转换为 Venice 所需的 `<n>s` 字符串，现有 upstream 回归测试明确锁定 `duration: "5s"`。
- [ ] PR-566 的同类 5 秒视频请求不再因 duration 类型触发 `video_provider_http_400`；真实上游验证若受部署/额度限制需记录未覆盖风险。
- [x] conversation 查询把响应内 video attempts 写入统一 query cache；终态 attempt 首屏不再产生逐条 GET，进行中 attempt 仍轮询。
- [x] 工作室最近用户提示词映射为 O(n) 预计算，展示与重生成行为不变。
- [x] 三个低频设置/模型组件按打开状态加载，首屏不提前挂载。
- [x] 模型 Sheet 在窄屏下具有一致外边距与卡片间距，关闭/模型项有可见 focus 状态，列表不遮挡底部安全区。
- [x] 超长标题/模型名不会压缩返回、新建、历史按钮，标题和副标题正确截断。
- [x] 通过 backend upstream test、frontend typecheck/lint/build、相关既有测试与 `@image` UI 场景；记录真实移动端/Telegram WebView 尚需人工确认的部分。

## Notes

- Railway 证据：2026-10-30 06:08:39Z 创建 attempt 返回 202；06:08:40Z worker 记录 `video_plaza.submit_failed`，错误为 `video_provider_http_400`。
- 官方 Venice Queue 文档将 `duration` 定义为 `enum<string>`，示例与 Seedance R2V 均使用 `"5s"`。
- 本轮未部署 PR-566，也未自动发起会计费的真实 Venice canary；第二项验收需部署后由用户显式发起 5 秒视频确认。
