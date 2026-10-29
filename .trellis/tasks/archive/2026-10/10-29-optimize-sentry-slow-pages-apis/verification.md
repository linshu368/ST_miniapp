# 验收记录

## 静态与构建

- `pnpm --filter @miniapp/frontend typecheck`：通过。
- `pnpm --filter @miniapp/backend typecheck`：通过。
- `pnpm --filter @miniapp/ui-tests typecheck`：通过。
- `pnpm --filter @miniapp/frontend lint`：通过；仅 8 处任务前已存在的 `@next/next/no-img-element` warning。
- `pnpm --filter @miniapp/frontend build`：通过；最终 route table 见 `implementation.md`。
- `git diff --check`：通过。
- `pnpm exec prettier --check`（任务相关文件）：通过；需要格式化的文件已执行 Prettier。

本机 Next 安装在连续 production build 后曾两次出现包目录缺失 `dist/build/webpack-build/impl.js`；用 `pnpm install --frozen-lockfile --force` 恢复后构建成功，package 与 lockfile 未变化。该现象属于本地 pnpm/Next 安装完整性，不是代码编译错误。

## Frontend 测试

- 目标请求/路由/会话测试：25/25 通过。
- chat 组件与 session 相关测试：14/14 通过。
- 全量首次运行：62 个文件、564 项通过；`artifact-renderer.test.tsx` 的 esbuild beforeAll 在全量并发下超过 10 秒，2 项未执行。
- `artifact-renderer.test.tsx --hookTimeout=30000` 隔离复跑：2/2 通过，未修改测试阈值源码。

## Backend 测试

- support + telemetry 定向：16/16 通过；support 独立复跑 4/4 通过。
- 全量首次运行：104 个文件、1042 项通过；8 项在并发压力下失败，其中 4 项为 5 秒 timeout，1 项为超时后的 mock 调用污染，3 项为 primary/fallback 竞速顺序抖动。
- 四个失败文件使用 30 秒测试预算隔离复跑：99/99 通过。未修改 generation 业务或竞速断言。

## UI 与 fixture

- `pnpm test:ui:fixtures`：4/4 通过。
- `@roleplay`：首次 10/12 通过；2 项 android 受 Next dev 冷编译影响。保持 README 推荐的预览并预热 `/characters`、`/chat/:id` 后，失败项 2/2 通过；新增请求计数项 1/1 通过。
- `@chat`：8/8 通过；包含新增工具箱动态面板首次打开断言。
- `@drama`：41/41 通过；覆盖首页评论按需加载、分页、发表、删除、错误恢复、续播和窄屏。
- `@profile`：11/11 通过。
- 验收结束后确认 3130/3131 无监听进程。

## 失败路径证据

- API client：退避期间 abort 不再 dispatch 第二次 fetch。
- lobby route：入站取消传到上游 signal，且存在 5 秒 timeout。
- support：上游 throw 记录原始 err 与安全耗时字段，不含 path/userId。
- chat：现有首字、同批文字后错误、滚动不二报、余额不足和深度思考场景通过。
- dynamic UI：角色详情、首页评论、chat 工具箱在真实页面首次打开可用。

## 本地边界与发布后观察

- 本地 fixture 不证明真实 Telegram WebView、系统键盘、真实 provider、计费/支付、客服上游或生产数据库行为。
- Sentry 基线来自 2026-10-28 15:00 至 2026-10-29 15:00；页面与 support P95 是否下降必须发布后在同口径窗口复测。
- support 日志上线后先判断 identity/upstream/total 哪一段主导；若 upstream 主导，应在 `ST_cs_platform` 独立仓库继续处理。
- messages/regenerate 的 45.24s/32.28s 是完整流 P95；首字继续使用 `client_committed_v4` 和既有首字/计费测试验收。
