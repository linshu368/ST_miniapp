# 实施验证

1. 安全加载本地 TEST 配置，仅输出 catalog/计数；MCP 项目不可用，不读取业务行。
2. 模板复用 seed RPC，保存 tags/中文 snapshot，严格已有内容检查和 Storage 门禁。
3. 导出 SQL、Storage manifest、摘要至忽略目录；不覆盖旧输出。
4. node --check、pnpm lint:migrations、git diff --check、shared typecheck。若隔离本地 PostgreSQL 可用，验证实际 RPC、重复、冲突、空集、Storage缺失、中途失败全回滚；不在远端执行写入测试。
5. 核对 payload/manifest 条数、关联、总字节、sha256，不回显内容；不足的验证记录风险。
6. 人工生产场景（本次不执行）：模型启用、私有下载、feed/detail/标签/中文提示词/同款/点赞。无应用代码、跨包契约或部署行为修改，不做无关全量 build；不新增测试文件，使用临时本地验证。
