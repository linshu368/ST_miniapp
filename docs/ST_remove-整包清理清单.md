# ST 旧路径清理：整包丢弃清单

> 状态：**§2 / §3 已归档到 `legacy/st-removed/`（2026-08-14）。散文件 / 混用接线见 `docs/ST_remove-混用清理清单.md`，同日已执行。**
> **2026-08-18：`legacy/st-removed/` 整个目录已从工作区删除**（1260 个文件 / 1.2G）。下面两张表的「现路径」不再存在，
> 内容取回请用 `git show 6206f3a:<原路径>`——那一 commit 就是归档动作本身，它的父提交里还是原路径。
> 分支：`dev_ST_remove`
> 上游方案：`docs/ST_remove.md` §四。本文件覆盖其中两条「留」的口径，见 §1。

本份只列 **整包 / 整目录**。散文件、混用文件的归档与接线见混用清单。

---

## 1. 相对总方案的口径更新

| 原口径（`ST_remove.md`）                                                            | 本轮确认                                              |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `st_platform.platform_presets` 与 admin 预设通路保留，等 M4 自建格式                | **ST 预设相关全部删除**，运营台里和 ST 预设相关的也删 |
| simulation 及其与 ST 共用部分（st-bundle、sync-engine worker）不在 miniapp 删除范围 | **simulation 本身及其依赖不再维护，进入删除名单**     |

因此原先因「simulation 还要用」而不能整包丢掉的 `packages/sync-engine`，本轮升为整包可丢。

---

## 2. 整包（已归档）

确认：五项可归档。现路径均在 `legacy/st-removed/` 下保留原相对结构。

| #   | 原路径                      | 现路径                                        |
| --- | --------------------------- | --------------------------------------------- |
| 1   | `vendor/sillytavern/`       | `legacy/st-removed/vendor/sillytavern/`       |
| 2   | `packages/st-extension/`    | `legacy/st-removed/packages/st-extension/`    |
| 3   | `packages/bridge-protocol/` | `legacy/st-removed/packages/bridge-protocol/` |
| 4   | `packages/db-types/`        | `legacy/st-removed/packages/db-types/`        |
| 5   | `packages/sync-engine/`     | `legacy/st-removed/packages/sync-engine/`     |

`scripts/import-character.ts` 留下，根脚本改为走 `@miniapp/backend` 的 `tsx`；默认 `--env` 改为 `packages/backend/.env`。

`@miniapp/bridge-protocol` 已退出 workspace。混用清单执行后，frontend 不再用 `file:` 指向归档包。

---

## 3. ops 整目录 / 单文件（已归档）

确认：与 §2 一起挪。

| #   | 原路径                                     | 现路径                                                       |
| --- | ------------------------------------------ | ------------------------------------------------------------ |
| 6   | `ops/st-extensions/`                       | `legacy/st-removed/ops/st-extensions/`                       |
| 7   | `ops/sillytavern/`                         | `legacy/st-removed/ops/sillytavern/`                         |
| 8   | `ops/st-platform-assets/`                  | `legacy/st-removed/ops/st-platform-assets/`                  |
| 9   | `ops/s6/`                                  | `legacy/st-removed/ops/s6/`                                  |
| 10  | `ops/docker/Dockerfile.st-bundle`          | `legacy/st-removed/ops/docker/Dockerfile.st-bundle`          |
| 11  | `ops/env/st-bundle.env.production.example` | `legacy/st-removed/ops/env/st-bundle.env.production.example` |
| 12  | `ops/nginx/Dockerfile.simulation`          | `legacy/st-removed/ops/nginx/Dockerfile.simulation`          |
| 13  | `ops/nginx/nginx.simulation.conf`          | `legacy/st-removed/ops/nginx/nginx.simulation.conf`          |

`ops/nginx/` 其余文件当时仍留在原处（生产 nginx 还在给 backend 反代）；已于 2026-08-18
随网关收敛整个删除，见混用清单 §9。

---

## 4. 散文件（已交给混用清单，已执行）

下表当时不在本份范围，已由 `docs/ST_remove-混用清理清单.md` 归档并拆接线：

| 所在包              | 内容                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/admin`    | ST 预设：`PlatformPresetsView.tsx`、`platformPresetsApi.ts`、`presetValidation.ts` 及测试                                                                             |
| `packages/shared`   | `src/api/chats.ts`、`src/api/st-session.ts`、`src/api/simulation.ts`、`src/platform-presets.ts`                                                                       |
| `packages/backend`  | `routes/bridge.ts`、`routes/chats.ts`、`routes/simulation.ts`、`middleware/stProxy.ts`、`scripts/st-regression/`、`llm-proxy`（生成出口 `features/generation/` 留下） |
| `packages/frontend` | `lib/bridge/`、`components/bridge/`、`app/tavern/[characterId]`、`init-st-session` 等                                                                                 |
| `scripts/`          | `install-st-extension.mjs`                                                                                                                                            |

仍暂缓、不跟代码归档绑在一起：

| 项                                             | 原因                                                    |
| ---------------------------------------------- | ------------------------------------------------------- |
| ~~`chat_engine_mode` 及前后端开关接线~~        | 已于 2026-08-18 删除（含 migration 083），见混用清单 §8 |
| `users.st_handle` / `deriveStHandle`           | 列还在；停写要单独 migration                            |
| ~~`ops/nginx/nginx.conf`、`nginx.local.conf`~~ | 已于 2026-08-18 随网关收敛删除，见混用清单 §9           |
| ~~`.railway/railway.ts` 里的 `st-bundle`~~     | 已于 2026-08-18 随网关收敛删除，见混用清单 §9           |
| 历史 SQL（`006_platform_presets` 等）          | 只记账，不改已执行的 migration                          |

---

## 5. 确认记录

- [x] §2 五项整包可以归档
- [x] §3 与 §2 一起挪
- [x] 归档目录名：`legacy/st-removed/`
