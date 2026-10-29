# 实施记录（第一批）

日期：2026-10-29

状态：代码与本地验收完成，等待部署后 Grafana 24 小时/7 天门禁；Bunny 生产灰度未开启。

## 已实施

### 1. Grafana 关键视觉口径

- 新增 `page.critical_visual` measurement 和 `page.critical_visual_terminal` event。
- 从真实 document/SPA 导航时钟计时，按 route、navigation type、cache、visibility 和 outcome 分层。
- `/` 以首页 video `loadeddata` 为成功证据；播放错误记录 error。
- `/characters` 以第一张可见头像 loaded/error/absent 为终点。
- `/dramas` 以前两张关键封面全部 settled 为终点。
- outcome/stage/source version 已加入 Faro 有限白名单；URL、对象路径、token、用户 ID 均不发送。
- `st-engineering-pages.json` 新增关键视觉 P50/P95（2 秒阈值）和全部终态分母面板。仓库源已更新，未把“文件存在”写成 Cloud 已导入。

### 2. drama catalog 持久缓存

- 新增版本化 key `miniapp:drama-catalog:v1`。
- 15 分钟 fresh window；24 小时最大可用年龄；最多 300 条。
- 读取时校验展示 DTO 的必要字段；损坏、超龄、超量缓存删除并回到网络。
- 缓存作为 React Query `initialData`，保留原保存时间；过 stale window 后后台校准。
- 网络成功后在 idle callback 写入，避免 JSON stringify 与首屏渲染争主线程。
- 不持久化 playback signed URL、详情、社交信息或用户数据。

### 3. Supabase 图片 CDN 变体

- 新增公共 helper，只改写 Supabase public Storage URL；其他 CDN/外链原样返回。
- 角色头像复用统一 360×480 q68 规格，不改变现有业务展示。
- 短剧广场封面使用 240/360/480 三个有限 `srcset` 规格，3:4、q68。
- 首页播放器 poster 使用 720×960 q72；相邻预览使用 360×480 q68。
- 仍直接访问 Supabase transformation/Smart CDN，不引入 Next 图片代理或 Bunny 图片 zone。

### 4. 角色列表校准调度

- 有本地/内存数据时不再在 mount 同帧立即校准。
- 第一张关键头像 settled 后启动后台校准；图片无法结算时 1.5 秒兜底。
- 无缓存时 React Query 仍立即请求，不延迟冷启动列表。
- `/chats` 摘要调用保持不在 mount 强制刷新。

### 5. 验收场景调整

- 既有 cold list error/empty 场景显式清理新 catalog cache。
- 既有后台目录失败场景跨过 15 分钟 stale window 后触发校准。
- 这两项只调整 fixture 前置状态，不降低错误、空态或播放器连续性断言。

## 未实施及原因

- Bunny production：现有 PR 525 只有功能证据，尚无每 provider ≥100 次 Telegram 真机性能样本；按规划门禁不直接放量。
- 直连 Railway characters：未取得 Telegram 真机相对 BFF ≥300ms 收益证据，不保留双路径。
- bundle 拆分：当前只完成构建量化，缺少 main-thread p95 >300ms 证据；不拆关键播放器或默认 tab。
- immutable/versioned 上传路径：上传权威方在外部归档流程，本任务不批量改历史对象。

## 构建体积

生产构建记录：

- `/` First Load JS：288 kB。
- `/characters`：258 kB。
- `/dramas`：259 kB。
- shared：193 kB。

相较父任务固定记录有小幅增加，主要来自已启用的统一工程遥测与本批 helper；未达到“用拆包换收益”的证据门槛。生产发布后需结合 long task/关键视觉 p95 决定是否进入条件式 bundle 阶段。

## 外部副作用记录

本地 `next build` 读取 `.env.local` 后仍执行了 Sentry sourcemap 上传，目标为组织 `wangqiao`、项目 `st-miniapp`、release `23724df8abcb9291343b1abd4384440b1c949245`。没有部署应用或切换生产流量；构建输出已明确记录，后续本地验证应使用不会加载上传凭证的环境文件或独立 build 配置。
