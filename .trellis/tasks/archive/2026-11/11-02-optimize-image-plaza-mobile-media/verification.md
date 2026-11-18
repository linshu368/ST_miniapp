# 验证记录

## 自动验证

| 检查                                                           | 结果                                              |
| -------------------------------------------------------------- | ------------------------------------------------- |
| focused Vitest：mobile policy、Supabase image、image-plaza API | 18/18 通过                                        |
| `pnpm --filter @miniapp/frontend typecheck`                    | 通过                                              |
| `pnpm --filter @miniapp/frontend test`                         | 67 files，730/730 通过                            |
| `pnpm --filter @miniapp/frontend lint`                         | 通过；仅项目既有原生 img 警告                     |
| import lint 等价命令（移除 Windows 下失效的 `--rule '{}'`）    | 通过                                              |
| `pnpm test:ui --grep '@image'`                                 | 最终状态 8/8 通过；Android 5 项、narrow 3 项      |
| `pnpm --filter @miniapp/frontend build`                        | 通过；`/create` 9.72kB/250kB，Studio 22.6kB/291kB |
| `git diff --check`                                             | 通过                                              |

## 交互覆盖

- 标签横滑与分组筛选布局。
- 广场用同款进入工作室、设置、图片生成、保存原图回退。
- 图片生成失败重试与余额不减少。
- 视频作品用同款进入视频创作、图片转视频、视频设置/模型、生成后编辑/重生成/下载/分享。
- 窄屏多行输入下设置和生成按钮保持可见。

## 已知工具链现象

`@image` 的 Playwright webServer 在 Windows 上强制结束 Next dev 后，本地 pnpm virtual store 两次缺失 Next `dist/build/webpack-build`。仓库预览脚本无显式删除 node_modules 逻辑；本任务未修改该基础设施。使用 `pnpm install --force --frozen-lockfile` 恢复后，单独 production build 通过。该现象不影响本次产品代码结论，但建议后续单独排查 UI preview 的 Windows 退出流程。

## 发布后验证

- Android/iOS Telegram 冷进入 `/creation -> /create`、深历史 Studio、多个视频滚动播放。
- Save-Data、2G/slow-2G、后台恢复与无 IntersectionObserver 降级。
- Sentry/Grafana 按 PRD 的 release、平台、样本门槛复核 P95、成功率和错误率。
