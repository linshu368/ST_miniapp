# 验证记录

## 自动检查

- `pnpm --filter @miniapp/frontend typecheck`：通过。
- `pnpm --filter @miniapp/frontend test`：通过，66 个测试文件、716 项测试全部通过。
- `pnpm --filter @miniapp/frontend lint`：通过；仅保留仓库既有的 `@next/next/no-img-element` 警告。
- `pnpm --filter @miniapp/frontend build`：通过；`/`、`/dramas`、`/profile/messages` 均成功生成生产构建。
- `pnpm test:ui --grep '@drama'`：通过，44/44。
- `pnpm test:ui --grep '@profile'`：通过，12/12。
- `pnpm test:ui --grep '@navigation'`：通过，2/2。

## 失败路径与修正

首次将短剧页首批挂载量设为 10 时，已有 UI 场景需要直接定位第 11、12 个剧目，导致 2 项回归失败。首批量调整为 12 后，定向复测 2/2、完整 `@drama` 复测 44/44 通过；后续仍按每批 10 项增量挂载。

本机 UI 预览结束后曾出现 Next 安装目录中的 `webpack-build/impl.js` 暂时缺失。确认 3130/3131 无残留监听、使用锁文件恢复依赖后，独立生产构建通过；未修改依赖声明或锁文件。

## 构建观测

- `/`：页面代码 3.07 kB，首载 273 kB。
- `/dramas`：页面代码 11.4 kB，首载 260 kB。
- `/profile/messages`：页面代码 5.21 kB，首载 233 kB。

## 剩余风险与上线验证

- 本地构建与固定虚构场景不能替代 Telegram WebView 真机、真实网络和生产数据量验证。
- 路由后台预热受网络状态、浏览器空闲调度及缓存命中影响；上线后需继续对比页面导航 P95。
- 短剧首批挂载和通知预取减少客户端等待与冷启动成本，但真实收益仍需使用下一周期 Sentry/Grafana 数据确认。
- 本轮未改变接口契约、数据库、计费或供应商行为，也未触碰工作区中已有的 SSE 观测改动。
