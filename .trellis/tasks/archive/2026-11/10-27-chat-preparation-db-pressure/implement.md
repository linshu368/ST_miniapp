1. 添加并发部分索引及 shape 验证；取消轮询改窄读取并扩展已有测试。
2. 评审前置保存依赖，独立准备并行，统计移出串行等待；不改变扣费与恢复语义。
3. 运行 backend/shared/typecheck/migration lint/imports，TEST migration/真实 API 验收。
4. dev CI 合并，再 main 仅聊天发布，生产 migration 与计划、资源/耗时证据。
