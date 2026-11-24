# 任务分解

- [ ] T1 迁移：`deleted_at` 列 + `mutate_creator_character` 的 delete 动作 + md5 前置校验 + 回滚说明
- [ ] T2 registry 备注
- [ ] T3 shared 契约 `DeleteCreatorCharacterData`
- [ ] T4 repository：list/get 过滤、remove()
- [ ] T5 路由 DELETE + 路由测试用例
- [ ] T6 SQL 测试断言（creator_characters.sql）
- [ ] T7 前端 mutation hook
- [ ] T8 「我的创作」封面⋯ + 删除确认 Sheet
- [ ] T9 模块文档更新
- [ ] T10 验证：typecheck / 测试 / lint:complexity / lint:db-contract / build / 本地预览截图
- [ ] T11 TEST 迁移与真实回放 → 生产迁移 → PR → 发布与线上核对
