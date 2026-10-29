# 验证记录（第一批）

日期：2026-10-29

## 静态与单元验证

- `tsc -p packages/frontend/tsconfig.json --noEmit --incremental false`：通过。
- `pnpm --filter frontend test`：64 files、619 tests 全部通过。
- 新增/相关目标测试：3 files、48 tests 全部通过。
- `pnpm --filter frontend lint`：通过；只有仓库既有/明确保留的 raw `<img>` 建议 warning。
- `pnpm --filter frontend build`：通过，16 个静态页面生成完成。
- `python -m json.tool docs/grafana/st-engineering-pages.json`：通过。
- `git diff --check`：通过。

## UI 验收

- `pnpm test:ui --grep @drama`：42 passed（android + narrow）。
- `pnpm test:ui --grep @roleplay`：12 passed（android + narrow）。
- 首轮 drama 验收发现新 catalog cache 改变 cold-error fixture 和 15 分钟 stale 语义；场景修正后两个目标测试分别通过，随后完整 42 条通过。

## 已验证失败路径

- catalog 冷缓存错误与空列表仍显示出口。
- 已有 catalog 时后台刷新失败不卸载播放器，用户可重试且观看位置保留。
- stale window 内不重复刷新，跨过窗口后恢复校准。
- 图片 external URL 不被改写；Supabase public URL 使用有限变体。
- 关键视觉只上报一次，并保留 loaded/error/absent 终态。
- 播放失败/重试、路由离开、长/窄视口和角色社交流程无回归。

## 待生产验证

- Cloud 导入更新后的 `st-engineering-pages.json`。
- 新 release 每 route/cohort ≥100 个终态样本。
- 24 小时 `page.critical_visual` P95 ≤2 秒；7 天滚动不回弹。
- `page_fresh`、drama `api.total/headers`、错误率和 page-left 同时满足 PRD 4.2。
- Supabase `cf-cache-status`、transform quota、真实字节数与 decode p95。
- Telegram iOS/Android 真机冷/暖缓存。
- Bunny TEST A/B 达到样本门槛后再决定生产灰度。
