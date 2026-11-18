# 实施与验证

## 发布顺序

1. PR → dev，Quality Gate 通过。
2. TEST：`Database Migration` workflow，apply `packages/shared/migrations/20261118_character_persona.sql`（ref = 本分支）。
3. TEST 验证：对象/约束/权限、人设与设定真实读写、一轮生成（prompt 快照里第二条 system 为用户设定）。
4. 合入 dev。生产：迁移 → 后端 → 前端，需用户单独确认。

## 已执行的验证

- `bash scripts/test-character-persona-migration.sh`（一次性 PG17）：上限、第一个自动默认、默认唯一、越权选用/修改/删除、互斥、超长、删除后回到默认、读取优先级、权限。
- backend：engine/conversations/routes 测试（含 `user-settings.test.ts`：空设置 prompt 不变、顺序、`{{user}}`、截断/压缩前后设定原样存在）。
- shared：`character-persona.test.ts` 请求体校验。
- frontend：typecheck、eslint、vitest 全量。

## 回滚

- 回退前端/后端即可，表保留；删除对象会丢用户设定，需用户同意后 forward-fix。
