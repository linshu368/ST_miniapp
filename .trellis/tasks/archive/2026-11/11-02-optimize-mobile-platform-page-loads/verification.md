# Verification

## 静态与单元验证

- `pnpm --filter @miniapp/frontend test -- src/lib/mobile-performance.test.ts`：通过，1 file / 6 tests。
- `pnpm --filter @miniapp/frontend typecheck`：通过。
- `pnpm --filter @miniapp/ui-tests typecheck`：通过。
- `pnpm --filter @miniapp/frontend test`：通过，67 files / 725 tests。
- `pnpm --filter @miniapp/frontend lint`：通过；只有仓库既有/允许的 `<img>` 性能建议，其中首页显式海报使用已有 CDN 变换 URL 并与 video poster 复用，不产生第二张原图请求。
- `pnpm --filter @miniapp/frontend build`：通过。首次执行因本地 Next 包文件缺失失败；`pnpm install --force --frozen-lockfile` 恢复 node_modules 后成功，lockfile 未变。
- `git diff --check`：通过。

## UI 验收

- `@startup`：7/7 通过（Android/窄屏，`/`、`/characters`、`/dramas` 无 JS 框架及原生 ready）。
- `@navigation`：更新长列表滚动脚本后 2/2 通过，覆盖五入口、首页、角色、短剧、长列表末项和深层页隐藏导航。
- `@roleplay`：完整首轮 11/12 通过；唯一 390px 失败为独立 Next dev 首次编译动态 chat 路由超过原 45s，窄屏同用例通过。按 UI README 的冷编译边界延长该用例开发预算后定向复跑 2/2 通过。
- `@drama`：完整首轮 42/44 通过；两项为同一用例直接定位第 12 部短剧，而新策略只首挂 6 部。改为滚动短剧容器触发分批挂载后定向复跑 Android/窄屏 2/2 通过。

## 失败与降级覆盖

- 平台 unknown 回退、Android X 归组、有界预算由单测覆盖。
- 图片错误、无海报、播放失败/重试、目录后台失败、退出释放媒体由现有实现和 `@drama` 覆盖。
- IntersectionObserver 缺失仍保留原全量兜底；返回恢复 floor 未被平台首批预算截断。

## Production 待验证

本地 fixture、Chromium 手机视口和生产构建不能证明真实 Telegram Android/iOS P95 已低于 3 秒。上线后必须按 release 与 `tg_platform` 分开观察，单平台单页面样本/估算计数 ≥100，连续两个完整窗满足：

- `/`、`/characters`、`/dramas` 导航及 `page.critical_visual` P95 <3s；
- 页面已知终态成功率 ≥99%，错误率不高于发布前；
- 首页 `drama media loadeddata/canplay` 独立报告，不以海报关键视觉代替完整媒体 ready。

该外部 KPI 验证不在当前未获授权的部署范围内；本任务归档仅表示实现与本地验收完成。
