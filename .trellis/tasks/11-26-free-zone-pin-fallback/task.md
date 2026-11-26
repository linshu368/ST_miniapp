# 任务分解

## PR1 保上

- [ ] shared 契约（status.pinned、pin 请求/响应）
- [ ] backend：lifecycle / repository / unroutable-guard / manual-pin / 路由 / admin-status
- [ ] 回归测试：保上跳过下架、手动下架清保上、保上顺手上架
- [ ] admin 按钮与标签、admin-client、CLI + coverage + README
- [ ] docs：ARCHITECTURE、registry 备注
- [ ] 验证命令全过 → 发布 → 列出旧保上标记给用户确认

## PR2 畅聊兜底通道

- [ ] 迁移（新重载 + 交付函数补丁）+ 本地 PG17 harness
- [ ] shared：free_zone_config.fallback
- [ ] backend：兜底目标可配置（首字兜底 + 重写）、Surplus 路由头/白名单/屏蔽渠道、思考参数、台账 ownsAttempt、成本补查
- [ ] 回归测试：畅聊兜底走 Surplus 且无折扣底线、付费不变、重写同目标、成本补查
- [ ] admin：畅聊兜底卡片、付费档位兜底改名
- [ ] TEST 迁移 + TEST 实测 → 生产迁移 → 发布 → 配置差异给用户确认后发布
