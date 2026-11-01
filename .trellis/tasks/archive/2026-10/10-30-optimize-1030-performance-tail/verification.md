# 验证记录

## 实施结果

- BottomNav 的五个常驻 Link 全部使用 `prefetch={false}`，不再因进入视口自动下载 `/characters`、`/profile` 等非目标路由；mouse enter、focus、touch start 的明确意图仍调用既有 `router.prefetch`，`/`、`/dramas`、`/create` 仍受省流量和 2G 判断保护。
- Profile `CommunitySheet` 改为 Next dynamic import，用户首次点击“官方社群”时才挂载；首次打开后保持挂载，关闭动画和 mutation 局部状态不因重复开关丢失。
- Query Devtools 动态导入候选已撤回：production 构建证明其 production export 只是 260B `null` stub，动态化没有实际减载，反而增加 loader。
- 未修改 Backend、API、query key、轮询、页面 ready、数据库、配置、模型选择、回复长度、计费或恢复语义。

## 自动化检查

- `pnpm --filter @miniapp/frontend typecheck`：通过。
- `pnpm --filter @miniapp/ui-tests typecheck`：通过。
- `pnpm --filter @miniapp/frontend lint`：通过；仅有仓库既有的 8 处 `@next/next/no-img-element` warning。
- `pnpm --filter @miniapp/frontend test`：64 files / 683 tests 全部通过。
- `pnpm --filter @miniapp/frontend build`：通过。
  - `/`：272 kB First Load JS。
  - `/characters`：256 kB。
  - `/profile`：20 kB route、275 kB First Load JS。
  - shared：193 kB；与上一轮同 HEAD 约 192 kB 基线基本持平，没有虚构共享 bundle 收益。
  - 社群 Sheet 位于独立 `1572.*.js`，raw 6,758 bytes；未出现在 `/(main)/profile/page` 初始构建清单。
- `git diff --check`：通过，只有 Windows `core.autocrlf` 提示。

## 固定移动端场景

- `@profile`：首轮 11/12 通过；Android 未开会员场景在首次 `/vip` 动态路由等待处超过 12 秒，narrow 同场景通过。Android 定向复跑通过（1/1，37.4 秒）。
- `@roleplay`：首轮 11/12 通过；唯一失败与上一轮记录一致，为 Android 首次进入动态聊天路由超过 12 秒，narrow 同场景通过。Android 定向复跑通过（1/1，38.9 秒）。
- `@navigation`：扩展现有场景验证社群 Sheet 首次打开、标题、Esc 关闭。narrow 完整通过；Android 在原 90 秒全局上限内已通过社群和主要五入口步骤，后段被累计冷编译截断。场景总预算调整为 120 秒，单项断言超时不变，Android 定向复跑完整通过（1/1，约 96 秒）。
- UI 环境使用固定虚构数据和 Next dev 首次编译，不代表真实 Telegram、CDN 或生产 P95。

## 构建环境说明

- 首次 build 遇到本地 pnpm 中 Next `dist/build/webpack-build/impl` 缺失，与上一轮验证记录相同；使用 `pnpm install --offline --force --frozen-lockfile` 恢复，lockfile 未修改。
- 一次完整 build 已写出 `BUILD_ID`，但工具在 Next 自然退出前达到 180 秒上限；超时清理后包目录不完整。再次按冻结锁文件恢复后，最终 build 在 227.5 秒内自然退出并通过。
- Browserslist 数据过期提示和 `<img>` lint warnings 均为仓库既有问题，本任务未扩大。

## 发布后验证与停止条件

- 保持同一 production release 至少 24 小时，按 `browser.name=Telegram Android` 单独比较 `/characters`、`/profile`、`/`、`/dramas/:id` 的 count、P50、P95 和错误率；不得跨 release 或设备混合下结论。
- 同时检查 `startup.shell_ready.duration`、chunk load error 和慢导航资源 waterfall，确认非目标 RSC/route chunk 是否减少。
- 若首次底栏点击错误率上升或 Telegram 真机首次导航明显变慢，恢复相应 Link 的默认预取；若社群 Sheet 首开失败，恢复静态 import。
- messages/regenerate 的完整生成长尾继续按 provider/model/token/输出长度观察，本轮不把其变化归功于前端加载优化。

## 规范评审

- 已复核 `frontend.infrastructure.client-ui-foundation`。现有规范已经明确“默认关闭且非首屏必需的重型面板动态导入、首次打开后保持挂载”和 Telegram 真机/生产 bundle 复测边界。
- 本轮没有改变模块职责、契约、状态源或公开 API；BottomNav 的具体预取实现保留在本任务证据中，不新增重复规范条目，`module_impact=no_module_change` 保持成立。
