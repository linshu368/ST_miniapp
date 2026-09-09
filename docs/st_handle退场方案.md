# `st_handle` 退场方案

> 状态：⏳ 待排期。本文只做方案，**未执行任何改动**。
> 归属：降低项目复杂度专项 → 「彻底删除旧 schema + 删除所有兼容访问」子项的收尾件。

---

## 一、为什么它还活着

ST 链路的代码、schema、部署单元都已退场（见 `docs/ARCHITECTURE.md` §9），但 `st_handle` 是唯一**还在被写入**的 ST 遗留物。它不是死代码，删它会打穿三处：

### 1. 数据库约束逼着代码必须写它

```sql
-- packages/shared/migrations/028_miniapp_users.sql
st_handle TEXT NOT NULL UNIQUE,
```

`NOT NULL` 且 `UNIQUE`。所以 `lib/user.ts` 建号时必须派生一个值填进去：

| 位置                                       | 用途                                             |
| ------------------------------------------ | ------------------------------------------------ |
| `packages/backend/src/lib/user.ts:52,59`   | `deriveStHandle(tgId)` → `insert({ st_handle })` |
| `packages/shared/src/st-bridge/handle.ts`  | `tg-<tg_id>` 派生 + `tg_<tg_id>` 历史格式解析    |
| `packages/backend/prisma/schema.prisma:24` | `st_handle String @unique`                       |

**只有写，没有读**：`parseTgIdFromHandle` / `isStBridgeHandle` 在业务代码里零调用方（只有 `packages/shared/src/__tests__/handle.test.ts` 在测），身份识别全部走 `tg_id`。

### 2. 两套回归夹具拿它当「测试数据认领键」

这是真正的阻塞点，不是顺手能改的。

| 位置                                                     | 依赖方式                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `backend/src/scripts/mvp-regression/fixtures.ts:270,413` | 造号写 `st_handle: '<前缀><tag>'`；`sweepOrphanFixtures()` 用 `LIKE '<前缀>%'` 扫上次异常退出的遗留用户                  |
| `backend/src/scripts/invite-uat/fixtures.ts:150,545`     | 同上；另有 `PENDING_LEDGER_PATH` 落盘登记，用于认领「接口层自己建出来的号」（那些 `st_handle` 是 `tg-<id>`，前缀对不上） |

夹具选 `st_handle` 而不是 `tg_id` 是有原因的：`tg_id` 要能被 `getOrCreateDbUser` 回查命中，不能塞测试前缀；而 `st_handle` 没有业务读取方，可以自由塞标记。**删列之前必须先给夹具换一个同样"业务无读取"的认领键。**

### 3. 存量数据

`app_core.users.st_handle` 全表有值（002 回填过 `tg_` 前缀，028 之后新号是 `tg-` 前缀）。删列即丢弃这份历史映射，虽然没有读取方，但属不可逆。

---

## 二、目标形态

- `app_core.users` 不再有 `st_handle` / `st_initialized_at`。
- `packages/shared/src/st-bridge/` 整目录删除（含 `index.ts`、`handle.ts`、`handle.test.ts`），`shared/src/index.ts` 去掉 `export * from './st-bridge'`。
- `lib/user.ts` 的 `MiniappDbUser` 去掉这两个字段，insert 不再带 `st_handle`。
- `schema.prisma` 的 `MiniappUser` 去掉这两个字段。
- 两套夹具改用新的认领键。
- legacy guard 加一条规则禁止 `st_handle` / `deriveStHandle` 的新引用。

---

## 三、执行顺序（必须按这个顺序，否则线上会 500）

`st_handle` 是 `NOT NULL`，**先删代码会让所有新用户注册失败**。所以必须先放松约束、再改代码、最后删列。

### 第 1 步：夹具换认领键（纯代码，可独立合并）

先做这一步，它和线上无关，但决定了后面能不能删列。

建议的新认领键：给两套夹具的测试用户统一走 **`app_core.users.source_id`**（渠道归因字段，测试号本来就不该有真实渠道），值用 `regression-<tag>` / `invite-uat-<tag>`。

- 它已经存在、可为 NULL、业务只在归因链路读，且真实用户的 `source_id` 来自 botlink，不会撞。
- 扫描改成 `LIKE 'regression-%'` / `LIKE 'invite-uat-%'`。
- `invite-uat` 的 `PENDING_LEDGER_PATH` 机制照旧保留：接口层自建的号仍然拿不到前缀，还是得靠落盘登记。

> 若判定 `source_id` 会干扰归因用例的断言，退路是加一列 `app_core.users.test_tag TEXT`（仅 test 库需要，生产不建），但那样 test 与生产 schema 会分叉，不推荐。

验收：`pnpm --filter @miniapp/backend mvp:regression` 与 `invite:uat` 全绿，且 `sweepOrphanFixtures()` 能扫到故意留下的脏数据。

### 第 2 步：迁移 A —— 放松约束（先上，不删列）

```sql
-- domain: app_core
ALTER TABLE app_core.users ALTER COLUMN st_handle DROP NOT NULL;
```

只做这一件事。此时新旧代码都能跑（旧代码继续写值，新代码不写也不报错），给部署留出安全窗口。

### 第 3 步：改代码，停止写入

删 `st-bridge/`、改 `lib/user.ts` / `schema.prisma` / `MiniappDbUser`，合并部署。

部署后观察一轮：确认新注册用户 `st_handle IS NULL` 且注册链路无报错。

```sql
SELECT count(*) FILTER (WHERE st_handle IS NULL) AS 新号,
       count(*) FILTER (WHERE st_handle IS NOT NULL) AS 存量
FROM app_core.users;
```

### 第 4 步：迁移 B —— 删列（观察期后）

```sql
-- domain: app_core
ALTER TABLE app_core.users DROP COLUMN IF EXISTS st_handle;
ALTER TABLE app_core.users DROP COLUMN IF EXISTS st_initialized_at;
```

删列前**先导出留档**（与 087/088 处置平台预设时同一口径）：

```sql
\copy (SELECT id, tg_id, st_handle, st_initialized_at FROM app_core.users) TO 'st_handle_backup.csv' CSV HEADER
```

### 第 5 步：补 guard

在 `scripts/check-legacy-references.mjs` 加规则：

```js
{
  id: 'st-handle',
  pattern: /\bst_handle\b|\bst_initialized_at\b|\bderiveStHandle\b|st-bridge/g,
  message: 'ST 身份映射已退场，用户身份只用 app_core.users.tg_id',
}
```

---

## 四、风险与注意

| 风险                                          | 处置                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| 先删代码后放松约束 → 新用户注册全挂           | 严格按 §三 顺序，迁移 A 必须先于代码上线                                   |
| 迁移 A 与代码部署之间抢跑                     | 迁移手动触发（铁律 9），先跑迁移、确认后再 merge 代码                      |
| 夹具改键前删列 → 回归无法清理，测试库越积越脏 | 第 1 步必须最先做完并验证                                                  |
| `UNIQUE` 索引残留                             | `DROP COLUMN` 会连带删除 `users_st_handle_key`，无需单独处理               |
| 生产与 test 步调不一致                        | 两库都要走完 4 步；`DROP NOT NULL` 与 `DROP COLUMN` 分两个迁移文件，别合并 |

## 五、预估

第 1 步是主要工作量（改两套夹具 + 跑通两个回归），约半天。第 2~5 步各自都很小，但被两个观察期分隔，整体跨度取决于排期，不是连续工时。

---

## 六、相关

- `docs/ARCHITECTURE.md` §5.3（用户身份真相归属）、§10.2（`users.st_handle` 等遗留列）
- `docs/schema归属地图.md`（`app_core` 域归属）
- `packages/shared/migrations/001` / `002` / `028`（st_handle 的建列、回填与迁入 miniapp）
