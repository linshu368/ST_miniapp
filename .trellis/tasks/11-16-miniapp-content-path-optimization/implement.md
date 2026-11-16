# 执行计划

1. 完成上述代码/规范调研及规划自审；填满mobile/logging/module元数据，task.py start通过后实施。
2. A：cache-only摘要入口与快照校验；会话lookup和补缺normal/短期用户-session内存缓存，真实QueryObserver/SSR hooks验证不拉全表、损坏/过期/storage拒绝、缺失角色及版本卡。
3. B：只读分组超时503映射；summary250ms预算与SDK取消；groups关闭额外transport重试。模拟RPC、Fastify inject验证成功、503、未知500、鉴权、慢summary/late rejection及flat复用。
4. C：拆出推荐transport/手动mutation，入口1500ms、手动5000ms；测试占槽释放、400兼容预算、取消、viewer切换与原幂等逻辑。
5. 运行frontend/backend/shared既有测试（mock DB，排除integration）、pnpm -r typecheck、frontend lint/build、backend logging及complexity；必要定向复跑，不启动UI。重复Windows Next build前核验并移动standalone到忽略的output/build-snapshots。
6. 同步README/架构/相关spec模块事实，原报告目录新增本批次实施记录；记录没有本地UI/线上P95、发布门禁和回滚。无自动stage/commit/push/deploy。
