# `st_handle` 退场方案

> 状态：**代码侧已执行**（夹具改认领键、删 `st-bridge`、停止写入、guard 规则）。
> 迁移 `111` / `112` 文件已写好但**尚未执行**——按 §三 的顺序手动触发。
> 归属：降低项目复杂度专项 → 「彻底删除旧 schema + 删除所有兼容访问」子项的收尾件。

## 〇、方案修订记录（初版的认领键方案已否决）

初版提出用 `app_core.users.source_id` 当测试数据认领键。核对代码后**否决**，两条硬冲突：

1. **`source_id` 本身就是 invite-uat 的断言对象**：`scenarios.ts` 里有「被邀请人 source_id 记为 invite」「既有 source_id 未被覆盖」，还有专门的 `attribution_source_id_guard` 场景。拿它当测试标记会污染被测对象。
2. **`tg_id` 号段也不可用**，而且这是一条已有的明确决定。`invite-uat/fixtures.ts` 记着：曾用 `like('tg_id', '89________')` 扫整段，后来撤销了——「真实 Telegram id 是单调递增的外部序列，本库里已经出现 8_866_xxx_xxx 量级的真实账号」，按号段删会连人带钱包流水一起删掉。

删掉 `st_handle` 后，`app_core.users` 剩下的列（`tg_id` / `source_id` / `bot_entered_at` / `miniapp_entered_at` / `total_round` / 两个时间戳）**全是业务读取字段**，没有空位可借。

**最终采用**：把 invite-uat 已有的落盘登记表抽成 `scripts/pending-user-ledger.ts`，两套夹具共用；**所有**测试 tg_id 在建号请求发出前先同步落盘。零 schema 改动，认领仍是精确 `in` 匹配，不对任何号段行使删除权。

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

### 第 1 步：夹具换认领键（纯代码，与线上无关）— ✅ 已完成

`scripts/pending-user-ledger.ts` 抽出共用的落盘登记表，两套夹具接上：

| 夹具           | 登记表文件                                      | 改动                                                                                                                                                    |
| -------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mvp-regression | `packages/backend/.mvp-regression-pending.json` | `seedConversationFixtures` 建号前 `record`；`sweepOrphanFixtures` 改按登记表 `in` 查；`cleanupConversationFixtures` 收尾 `clear`                        |
| invite-uat     | `packages/backend/.invite-uat-pending.json`     | `createTestUser` 建号前 `record`；`sweepOrphanFixtures` 去掉 st_handle 那条认领路径；`ScenarioRecorder.user()` 把 tgId 记进 `pendingTgIds` 以便对称清理 |

两个文件都已进 `.gitignore`。`pending-user-ledger.test.ts` 覆盖了崩溃重开、幂等、脏文件、部分清理等 7 个用例。

**遗留的机制局限（沿用 invite-uat 原有取舍，不是本次新增）**：登记表是本机文件，换台机器或删掉它就扫不到上一轮的残留。这两个脚本本来就是对着 test 库本地跑的，可接受。

验收：`pnpm --filter @miniapp/backend mvp:regression` 与 `invite:uat` 全绿，且故意留下脏数据后 `sweepOrphanFixtures()` 能扫到。**这两项需要连 test 库，尚未执行。**

### 第 2 步：迁移 111 —— 放松约束（先上，不删列）— ⏳ 待执行

`packages/shared/migrations/111_users_st_handle_drop_not_null.sql`，只做 `DROP NOT NULL` 并自检。

此时新旧代码都能跑（旧代码继续写值，新代码不写也不报错），给部署留出安全窗口。

> **这一步必须先于第 3 步的代码上线。** 反过来做，所有新用户注册都会因 NOT NULL 违反而失败。

### 第 3 步：改代码，停止写入 — ✅ 已完成（待随 111 之后部署）

- 删 `packages/shared/src/st-bridge/`（含 `handle.test.ts`）与 `shared/src/index.ts` 的导出
- `lib/user.ts`：`MiniappDbUser` 去掉两个字段，insert 不再带 `st_handle`
- `schema.prisma`：`MiniappUser` 去掉两个字段
- `conversations.integration.test.ts` 造号不再带 `st_handle`

部署后观察一轮，确认新注册用户 `st_handle IS NULL` 且注册链路无报错：

```sql
SELECT count(*) FILTER (WHERE st_handle IS NULL)     AS 新号,
       count(*) FILTER (WHERE st_handle IS NOT NULL) AS 存量
FROM app_core.users;
```

「新号」应随时间增长；为 0 说明代码还没停写，不要往下执行。

### 第 4 步：迁移 112 —— 删列（观察期后）— ⏳ 待执行

`packages/shared/migrations/112_users_drop_st_handle.sql`，删 `st_handle` 与 `st_initialized_at` 并自检。

删列前**先导出留档**（与 087/088 处置平台预设时同一口径）：

```sql
\copy (SELECT id, tg_id, st_handle, st_initialized_at FROM app_core.users) TO 'st_handle_backup.csv' CSV HEADER
```

### 第 5 步：补 guard — ✅ 已完成

`scripts/check-legacy-references.mjs` 已加 `st-handle` 规则，禁止 `st_handle` / `st_initialized_at` / `deriveStHandle` / `st-bridge` 的新引用。

---

## 四、风险与注意

| 风险                                    | 处置                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------- |
| 先部署代码后跑 111 → 新用户注册全挂     | 严格按 §三 顺序：111 必须先于代码上线                                       |
| 111 与代码部署抢跑                      | 迁移手动触发（铁律 9），先跑 111、确认后再合代码                            |
| 登记表机制没验过就删列 → 测试库越积越脏 | 合并前跑通 `mvp:regression` 与 `invite:uat`，并验一次 `sweepOrphanFixtures` |
| `UNIQUE` 索引残留                       | `DROP COLUMN` 会连带删除 `users_st_handle_key`，无需单独处理                |
| 生产与 test 步调不一致                  | 两库都要走完；111 与 112 分两个文件，**不要合并成一个**                     |
| 迁移编号撞车                            | 111 / 112 避开了本地未提交的 110；合并前确认远端没有同号文件                |

## 五、当前进度

| 步骤                         | 状态                                     |
| ---------------------------- | ---------------------------------------- |
| 1. 夹具换认领键              | ✅ 代码完成，待连库跑回归验证            |
| 2. 迁移 111（DROP NOT NULL） | ⏳ 文件已写，待手动执行（test → 生产）   |
| 3. 停止写入的代码            | ✅ 完成，**必须在 111 之后部署**         |
| 4. 迁移 112（DROP COLUMN）   | ⏳ 文件已写，待观察期后执行 + 先导出留档 |
| 5. guard 规则                | ✅ 完成                                  |

---

## 六、相关

- `docs/ARCHITECTURE.md` §5.3（用户身份真相归属）、§10.2（`users.st_handle` 等遗留列）
- `docs/schema归属地图.md`（`app_core` 域归属）
- `packages/shared/migrations/001` / `002` / `028`（st_handle 的建列、回填与迁入 miniapp）
