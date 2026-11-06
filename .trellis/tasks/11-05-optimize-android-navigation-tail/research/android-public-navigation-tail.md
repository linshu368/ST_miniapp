# Android 五入口公共长尾调研

## 生产证据（2026-10-29 至 2026-11-05，Grafana production）

- 五入口 `page.navigation`：Android P50 280.75ms、P95 4067.06ms、N=2274、2秒达标率 85.532%；iOS P50 99.5ms、P95 2078.4ms、N=572、达标率 93.881%。
- `/profile`：Android P95 5278.4ms(N=819)、2秒率79.24%；iOS P95 2556.4ms(N=194)、2秒率91.75%。
- `/characters`：Android P95 3617ms(N=973)；iOS 2313.7ms(N=219)。
- `/dramas`：Android P95 1294.78ms(N=325)；iOS 650.2ms(N=117)。
- `/creation` 样本少：Android N=37、iOS N=12，不能据此下稳定结论。
- Android stall 近似比例约8.8%，iOS约4.4%；stall 与最终 ready 可能重叠，只能作为联合信号。
- Android 样本网络标签均为4g，iOS大量unknown，不能据标签推断 Android 物理网络更差。

## 代码事实

- `entry-phase.ts` 的 `backgroundReady` 在冷启动首次放行后终身为 true，后续 SPA 导航没有新的安静窗口。
- BottomNav 每次路由变化后最多串行预热两个 route chunk；`requestIdleCallback` 的 1500ms timeout 可在主线程持续忙时强制执行。
- BottomNav 在 `/profile` 立即启用通知和客服未读；Providers 在 profile/chat 启用 settings；Profile 首帧后同时启动签到、VIP、套餐，并在近视口启动邀请/社群。
- touch intent 同时预取 route chunk 与 Characters/Favorites/Wallet 数据。触摸到点击提前量很短，非 content-ready 数据可能与 route chunk 竞争。
- Profile content ready 已在 shell commit 结束，钱包另记 fresh；因此延后未读/settings/签到等不会篡改 ready 语义。
- API 并发帽为3，非 critical 保留一个关键槽，但网络下载、JS parse/compile、React commit 和多个 normal 请求仍可能共享 Android WebView 的有限资源。

## 结论

当前证据支持先做 Android-only 公共调度治理，而不是修改接口 timeout 或将页面 ready 再提前。最小方案是从真实底栏点击到目标 content ready/failed 之间暂停非关键工作、减少后台 route 预热数量，并在 paint+idle 后恢复；4秒兜底保证后台任务不会永久饿死。生产成效必须按新 release 复测，不能由本地测试推断。
