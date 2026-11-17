# 大厅默认最新与移动端 P95 优化

## Goal

角色大厅首次进入时默认展示“最新”角色卡，并降低 Android/iOS 首张角色卡可见长尾，以生产 `page.critical_visual` P95 不超过 2 秒为目标。

## Requirements

- 没有详情返回快照、也没有用户已记住的发现条件时，`/characters` 默认选中“最新”。
- 用户主动切换“推荐/最新”后继续记住选择；从角色详情/聊天返回时继续按既有快照恢复排序、搜索、锚点和滚动位置。
- 默认“最新”不得等待或请求个人推荐批次；推荐 tab、换一批、撤回和曝光行为保持原样。
- Android 与 iOS 首屏只挂载足以覆盖首屏的角色卡；第一张图继续保持唯一 high priority，避免旁路请求和缓存重校准在 2 秒目标窗口内争抢资源。
- 继续展示 loading/error/empty/图片降级，不通过隐藏失败、缩短监控范围或把占位当关键视觉来制造达标。
- 不修改 shared/backend API、数据库排序语义或其他调用方的 `DEFAULT_LOBBY_SORT`。

## Acceptance Criteria

- [ ] 清空本会话发现条件后首次进入 `/characters`，默认 tab 为“最新”，请求为 `sort=latest`，且不启动 recommendation 请求。
- [ ] 手动切到“推荐”后离开并返回仍保持用户选择；从详情/聊天返回保持原快照与滚动锚点。
- [ ] Android/iOS 初始只挂载 4 张卡；首张图 high priority，Android 只 eager 首张、iOS 保留两张可视卡 eager。
- [ ] 有缓存时首图未结算前，后台列表重校准不得在 2 秒目标窗内启动；最终仍会有界重校准。
- [ ] 既有 Frontend typecheck、测试、lint、build 通过；复跑 `@roleplay` 或说明环境阻塞。
- [ ] 发布后按 Android/iOS、release、cache/fetch、mount/spa 观察两个完整 24 小时窗；每组 N≥100 后关键视觉 P95 ≤2000ms 才能宣称达标。

## Android/iOS 性能 P95 门禁

- 受影响页面：`/characters` 默认最新列表与首张角色卡关键视觉
- 受影响接口：`GET /api/lobby-characters?sort=latest` → `GET /api/characters?sort=latest`
- Android 页面加载 P95：关键视觉基线 5907ms（N=75）/ 目标 2000ms
- iOS 页面加载 P95：关键视觉基线 2538ms（N=6，低样本）/ 目标 2000ms
- 接口 P95：Sentry `GET /api/characters` 基线 214ms（count=370；未按 sort 分开）/ 目标 1000ms
- 数据来源与观测窗口：Grafana Cloud Loki + Sentry production；2026-11-02 18:00 至 2026-11-03 16:00（UTC+8）
- 发布后验证、无可见样本/低样本及不适用说明：按 release 观察至少两个完整24h窗；平台/cohort N<100 只记低样本。`/api/lobby-characters` 无独立聚合基线，发布后需补查代理与上游两层；本地结果不得冒充线上达标。

规划完成后同步填写 `task.json.meta.mobile_performance`：有影响使用 `required`，确实不影响移动端页面加载和接口性能时使用 `not_applicable` 并填写具体理由。门禁未完成时 `task.py start` 会阻断。

## Notes

- “保证 2 秒”按可验证的生产目标处理；在缺少发布后真实样本前只能说明实现完成，不能声明已达成 P95。
