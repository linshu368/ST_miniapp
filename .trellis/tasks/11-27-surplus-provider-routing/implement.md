# 执行计划

1. shared：`provider-routing.ts` 加 `SurplusRoutingRuleSchema`、`surplus_rules`、`resolveSurplusRoutingRule`、报价 DTO `SurplusProviderMarketSchema`；扩展 `__tests__/provider-routing.test.ts`。
2. backend：
   - `surplus-route.ts` 加 `catalogSurplusRoute`；
   - `types.ts` `GenerationPreparation.surplusRoute`；
   - `generation-prepare.ts` 解析付费 Surplus 规则；
   - `generation-dispatch.ts` 首发回落到 prepared 规则、学拒绝改看白名单第一家；
   - `free-zone/surplus-market.ts` 加表现读取；`features/generation/surplus-provider-market.ts` 汇总；
   - `routes/admin-model-providers.ts` 加 market 路由与日志；
   - 扩展 `execute.test.ts`（命中规则带参数、钉 mistral 不发 reasoning、未命中不变）。
3. admin-client：`modelProvidersApi.ts` 加 `fetchSurplusProviderMarket`；configMetadata 描述更新。
4. admin-cli：`model-provider market <model>`，README。
5. admin：路由编辑器拆 OpenRouter / Surplus 两区，Surplus 规则子组件 + 报价面板；ConfigValueGroup2 传 Surplus 目录。
6. 验证命令：
   - `pnpm --filter @miniapp/shared test`
   - `pnpm --filter @miniapp/backend test -- execute provider-routing`
   - `pnpm --filter @miniapp/admin-cli test`、`pnpm --filter @miniapp/admin test`
   - `pnpm -r typecheck`、`pnpm lint`、`pnpm lint:complexity`、`pnpm lint:backend-logging`
   - `pnpm --filter @miniapp/admin build`
7. 失败路径与人工场景：报价簿 404 / 超时 → 502 提示；表现接口失败 → 只缺首字 / 可用率；规则写了不存在的供应商（Surplus 忽略未识别项，全不认识 400 → 兜底）；底线过高 → 404 → 兜底；旧配置无 `surplus_rules` 正常读。
8. 发布：PR → dev → 发布分支对齐 main → 合 main → 同步回 dev；Railway 确认部署；运营平台强刷；1017 规则 diff 给用户确认后发布，查 Railway 付费轮次供应商与兜底。
