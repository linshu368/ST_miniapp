# 本地验证（2026-10-30）

- 基底：origin/main 8cbd10fe4ca5d728648a0d2d3150cce70f0704ce；分支codex/checkin-midnight。
- shared：196项通过；wallet/VIP backend：25项通过；profile hooks：10项通过；固定fixture：7项通过。
- pnpm -r typecheck：全workspace通过。
- 隔离Docker PostgreSQL17：既有VIP计费套件、签到昨天不足24h/今天零点拒绝、VIP金额150、双请求仅1条签到/流水、迁移重复执行全部通过。没有连接远端数据库试领。
- pnpm test:ui --grep @profile：12项通过，覆盖安卓390和窄屏320，以及虚拟时钟到期回读。
- Frontend生产构建通过；已修复本次hook依赖警告，原有图片标签警告与Browserslist提示未纳入本次修改。
- lint:migrations、lint:legacy、git diff --check、bash语法检查通过。
- 远端只读确认：Production wbtsfzozlmurljvglhpn，PostgreSQL17.6；现有签到RPC为滚动24h，SECURITY DEFINER/search_path=pg_catalog/原ACL。没有读取用户业务行。
- TEST/Production迁移、远端CI与部署尚未执行；生产数据和线上规则仍未改变。
