# Implementation Summary

## 已实现

- 新增 `mobile-performance.ts`，将 `android/android_x`、`ios`、其他平台映射到有界列表预算、首页海报策略和路由优先级；复用现有 Telegram 平台来源。
- `/characters` 与 `/dramas` 首批均收敛为 6 项；Android 角色以 6 项批次、200px 提前量扩展，iOS 短剧以 6 项批次、150px 提前量扩展。搜索、筛选和返回恢复 floor 保持原语义。
- 角色/短剧首行两张图片仍 eager，但只有第一张为 high；后续图片 lazy/low。角色卡增加 `content-visibility` 和固有高度占位。
- 首页复用同一 480×640 CDN 海报 URL 作为 video poster 和显式覆盖层，海报加载即形成真实可见关键视觉；视频 `loadeddata` 后隐藏覆盖层。移动端 embedded video 使用 metadata preload，明确 `play()` 仍负责实际媒体加载和自动播放。
- BottomNav 继续在 P0 后、网络允许时串行预取最多两个路由；Android 优先角色/首页，iOS 优先首页/短剧。
- 扩展现有 UI 验收的长列表滚动方式，测试连续触发分批挂载，不再假定末项首次就在 DOM。

## 未改变

- Backend/shared API、短剧签名与播放意图、React Query 数据源、Zustand store shape、数据库和计费均未修改。
- 没有提前结束 Sentry 自动 transaction；关键海报与视频 media ready 仍需分别观察。
- 未执行部署、commit 或 push。

## 构建结果

| 路由          |    Size | First Load JS |
| ------------- | ------: | ------------: |
| `/`           | 3.07 kB |        274 kB |
| `/characters` | 13.2 kB |        258 kB |
| `/dramas`     | 11.8 kB |        260 kB |

没有可用的同工作树可靠构建前基线：首次基线命令因本地 Next 安装缺失 `webpack-build/impl` 失败；使用锁文件强制恢复本地 `node_modules` 后构建通过，未修改依赖版本或 lockfile。
