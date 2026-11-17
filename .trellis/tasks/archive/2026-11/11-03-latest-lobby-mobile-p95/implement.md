# 执行计划

1. 扩展 `readRoleplayDiscovery(defaultSort)`，保持有效存储选择优先，缺失/损坏时使用调用方默认值。
2. `CharacterGallery` 传入 `latest`，移除对 shared 默认值的依赖；按平台设置缓存重校准兜底延迟。
3. 收紧 `mobile-performance.ts` 的 Android/iOS characters 首屏预算，并更新既有测试断言，不创建新测试文件。
4. 验证 fresh entry、显式推荐记忆、详情返回、错误/空态、首图优先与增量渲染不回退。
5. 运行：
   - `pnpm --filter @miniapp/frontend typecheck`
   - `pnpm --filter @miniapp/frontend test`
   - `pnpm --filter @miniapp/frontend lint`
   - `pnpm --filter @miniapp/frontend build`
   - `pnpm test:ui --grep @roleplay`（环境允许时）
6. 更新角色大厅模块事实与任务验证记录；发布后按 PRD 的平台/窗口门禁复测，不把本地通过写成生产 P95 已达标。
