# Android 五入口公共长尾优化清单（2026-11-05）

## 结论

本次只调整 Frontend Android/Android X 的公共导航调度，不修改 Backend、接口 timeout、响应体读取、shared 契约或页面 ready 定义。目标是减少目标页面可见前的 route 预热、未读、settings 和 Profile 次级读取竞争；iOS 与普通浏览器保持原调度。

该改动预期不会抬高正常请求 P95：请求自身的 `api.total` 仍从 `apiClient` 调用开始，timeout 仍覆盖响应体读取；延后的只是非关键请求“何时发起”。Android 页面 P95 有下降可能，但必须发布后按 release 验证，代码和本地测试不能证明已达到 2 秒。

## 修改后清单

| 链路                          | 修改前                                           | 修改后                                               |
| ----------------------------- | ------------------------------------------------ | ---------------------------------------------------- |
| Android 五入口底栏点击        | SPA 导航没有重新关闭启动期 background 状态       | 点击到目标 content ready/failed 进入独立安静窗口     |
| 安静窗口恢复                  | 不适用                                           | 双 rAF + 有界 idle 后恢复；页面未结算时 4 秒强制恢复 |
| 后台 route chunk 预热         | Android/iOS 每轮最多 2 个                        | Android 最多 1 个；iOS/other 仍最多 2 个             |
| Android touch intent 数据预取 | Characters、Creation favorites、Profile wallet   | 只保留会影响 content ready 的 Characters 主查询      |
| Profile P0                    | 钱包立即读取                                     | 不变                                                 |
| Profile 次级读取              | 首帧后或近视口启动，但 SPA background 已永久放行 | Android 还需等待导航安静窗口；iOS 不变               |
| 未读/客服/settings            | 进入 Profile 即可启动                            | Android 目标页 paint 后启动；4 秒兜底                |
| 页面耗时口径                  | `page.navigation` 到 `usePageReady`              | 不变，没有提前 ready、删样本或补 0                   |
| API timeout/响应体            | 既有完整响应体约束                               | 不变                                                 |

## P95 基线与目标

数据来自 Grafana Cloud production，窗口 2026-10-29 至 2026-11-05（7d）：

- Android 五入口总体 P95 4067.06ms，N=2274，2秒达标率 85.532%。
- iOS 总体 P95 2078.4ms，N=572，2秒达标率 93.881%。
- Android `/profile` P95 5278.4ms，N=819；iOS 2556.4ms，N=194。
- Android `/characters` P95 3617ms，N=973；iOS 2313.7ms，N=219。
- `/creation` Android N=37、iOS N=12，低样本，不作稳定结论。

目标：Android 总体和各主入口 P95 向 2000ms 收敛；iOS 与普通 API 同 release P95 不回退超过 5%。

## 对系统 P95 的影响判断

- 页面：只减少 Android 目标页提交前的非关键竞争，P0 查询和 route chunk 不被安静窗口阻塞，理论上对 Android P95 是中性到正向。
- 接口：非关键请求最多延后到 content ready 后或 4 秒兜底；`api.total` 不包含 gate 前等待，因此正常请求 P95 不应上升，queue P95 反而可能下降。
- 功能可见性：未读、签到、VIP、套餐、邀请和社群可能比页面 shell 晚一个 paint+idle；这是有意的次级内容延后，4 秒兜底避免永久缺失。
- 风险：若某页面错误分支未调用 `usePageReady(... failed=true)`，后台工作会等到 4 秒兜底；若发布后 terminal/stall 或次级内容缺失率上升，应停止放量并回滚 gate。

## 验证结果

- `pnpm --filter @miniapp/frontend typecheck`：通过。
- `pnpm --filter @miniapp/frontend test`：63 个文件、712 个用例通过。
- 定向调度测试：3 个文件、14 个用例通过，覆盖 Android/iOS 隔离、paint+idle、4秒兜底和旧 generation。
- `pnpm --filter @miniapp/frontend lint`：通过；仅有仓库既有图片/Hook warning。
- `pnpm --filter @miniapp/frontend build`：通过。
- `pnpm test:ui --project=android --grep "@profile|@navigation"`：9/10 通过；剩余用例首次运行冷启动 `goto` 超时，单独复跑时页面、签到和 `POST /api/vip/entry-viewed` 均成功，但本地 Next 的 `/vip` 跳转未在 45 秒总预算内完成。该跳转不触发本次仅 BottomNav 生效的安静窗口，记录为本地 runner 残余风险。
- `pnpm lint:complexity`：本次新增的 BottomNav/Profile 增长已消除；仓库既有 `packages/frontend/src/components/drama/use-drama-scrub.ts#useDramaScrub` 168 行仍使全局门禁失败，非本次改动。

## 发布后验证

按新 `release` 连续观察两个完整 24h；每个 route/platform 终态样本 N<100 时延长到 7d并标记低样本：

1. 五入口 `page.navigation`：P50/P95、`within_2s` 比例和样本量。
2. `page.terminal` / `page.stall`：确认没有用延后后台任务换取更多失败或停滞。
3. `/profile`、`/characters` 分平台 P95：重点确认 Android 缩小与 iOS 的差距。
4. 通知、客服、settings、签到、VIP、套餐、邀请、社群的 `api.queue` / `api.total` 和请求量：不得出现 >5% P95 回退或异常缺流量。

停止条件：Android terminal/stall 上升、P0 被延后、次级内容 4.5 秒后仍缺失、iOS或普通请求 P95 回退超过5%。回滚只需回退 Frontend 导航安静窗口及其消费点，不涉及 Backend 或数据库。
