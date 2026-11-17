# 执行计划

1. 记录版本、复用现有模块，完成mobile_performance与module_impact门禁；按用户本轮明确实施授权进入in_progress。
2. 公共请求期限：将并发槽纳入单次期限，保留最大两次安全读取、外部取消、长任务bypass及分段计时；验证排队过期、body挂起、同步超期和重试退避。
3. 正文优先级：通知/客服/创作数据/心愿及必要媒体读取提升为critical，预取和附属面板保持background/normal，避免将所有请求一律critical。
4. 聊天入场：当前新建结果复用缓存，历史会话保持刷新，失败不重建无限循环；验证观察者与同key身份、取消和写入不自动重试。
5. 导航让路：扩展Android深路由Link/返回覆盖并让enrich遵循原窗口；保留初始归因挂载、成功/错误/4秒兜底及旧generation隔离；不修改ready埋点语义。
6. 代理恢复：大厅返回结构化取消/超时/网络失败，复跑成功latest缓存、推荐私密和取消传播用例。
7. `pnpm --filter @miniapp/frontend typecheck`、相关Vitest后Frontend全量tests/lint/build；`pnpm lint:complexity`及格式检查。只因新改动/失败重复相关验证。
8. 复用既有UI固定流程：按实际改动选取40项启动/导航、聊天历史与切换、创作数据/编辑、消息/心愿、影像、个人中心、短剧入场和失败恢复场景（390/320px）；执行fixture协议验证。初次广泛筛选184项已停止，最终命令与结果见implementation-report.md；明确未被模拟覆盖的Telegram、弱网、真实供应商、生产P95限制。跨包/部署变更另跑build与`pnpm -r typecheck`。
9. 用trellis-check审查改动，更新受影响module/spec和恢复说明；交付最终diff与验证结果，不git add/commit/push或部署。
