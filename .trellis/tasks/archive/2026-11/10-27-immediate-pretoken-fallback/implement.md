1. 扩展首字 peek 的失败/终态识别，统一提前失败进入现有 fallback。
2. 在现有 fallback.test.ts 与 execute.test.ts 加失败/竞态/原价一次结算回归。
3. Backend 全量 test/typecheck、shared test、imports 与 diff 检查；CI构建及 TEST 真实 SSE。
4. 先合 dev 验收，再从生产 main 精确带入本修复，核对生产 SHA/health；同步模块知识与发布证据。
