# 设计

## 复用调研

- 复用现有 Next 前端和所有 React Query/API consumers，不造替代页面。
- 复用 shared 的公开 DTO/Zod schema 校验模拟数据与用户请求，不从生产导出 fixture。
- 现有 Vitest 主要是纯逻辑，无统一 E2E；旧 /tmp Python 服务仅覆盖 VIP，不能继续累积一次性实现。
- 复用 Playwright 的 webServer、fixtures、reporter、trace、mobile emulation；只增加开发依赖，不引入云平台/Storybook/新数据库。

## 最小充分方案

`packages/ui-tests` 提供本地Node模拟API、场景数据、场景选择页、启动器与少量用户路径；独立workspace包管理开发依赖与typecheck。固定手动端口3120/3121、自动端口3130/3131；每套串行共享状态、单轮前重置，避免账号隔离框架。Next仅增加显式本地开关控制的独立缓存和派生tsconfig，避免覆盖普通build缓存或改写原tsconfig。

调用链：真实浏览器 → 真实页面/API hooks → 本地模拟 HTTP/SSE → 真实渲染与缓存更新。模拟 API 不代理任何外部地址。MCP 直接访问预览地址；命令行自动验收使用相同数据与启动器。

## 故障模型与可靠性

- 端口占用：启动即报错，不终止未知进程；检查服务标识与目录后才能复用。
- 冷编译：启动等待有总时限；保留日志，失败停止自己的子进程。
- 数据漂移：shared 类型/schema 约束；未知接口返回 501 且记入报告。
- 状态串扰：自动检查 workers=1，每用例重新初始化；手动和自动服务独立。
- 请求失败/余额不足/取消：固定场景返回对应协议；SSE 有界延迟且断连清理 timer；未完成模拟图片不扣模拟余额。
- 重试：自动流程不默认重试；真实页面现有有限重试保持原样。
- 幂等：模拟签到不可重复领；图片幂等键避免重复扣模拟余额。无真实事务/迁移/补偿，不用新增限流基础设施。
- 访问边界：仅监听 loopback；控制接口仅接受本地来源；浏览器回归拦截外网且禁止静默转发。

## 演进与恢复

仅影响显式启动的本地工具；生产无新端点/页面/数据库。场景与断言随功能变化增补，日常按组检查，发布沿用既有 CI。移除脚本和本地 Next 开关即可回退。生成截图、trace、状态、缓存与报告不进 Git。

## 参考

- https://playwright.dev/docs/test-webserver
- https://playwright.dev/docs/test-fixtures
- https://playwright.dev/docs/network
- https://github.com/microsoft/playwright-mcp （MCP 手动观察，固定流程复跑可使用 CLI/Test）
